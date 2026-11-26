"use client";

// LEADS Insights panel - recent VERA observations flowing into the FLARE forecast
// (10–90% band + mean), with the decision threshold and a seasonal-normal line.
// Self-contained hand-rolled SVG. Display only; knows nothing about the RAG pipeline
// (the optional ensemble-members view fetches its data on demand). Shown under an
// answer that has a chart.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SeriesPoint, ForecastPoint, ClimatologyBand } from "@/lib/insights";
import { calendarTicks, chartDepthLabel, fetchForecastMembers, niceTicks, siteDisplayName, trimToTrailingWindow } from "@/lib/insights";
import type { MemberSeries } from "@/lib/insights";
import ForecastSkillCard, { SKILL_CARD_ENABLED, type SkillCursor } from "@/components/ForecastSkillCard";
import { fmtSkillPct, getForecastSkill, type DaySkill } from "@/lib/skill/forecast-skill";
import Icon from "@/components/Icon";

// Chart text font (visual only). Set as an inline style with a fallback so the SVG reads the
// app's Geist on screen and, when the PDF report rasterises the chart as a standalone image
// (where the CSS variable does not exist), Arial as in the paper's Fig. 4a. Arial comes
// before Helvetica because Helvetica's micro sign is oblique.
const SVG_FONT = "var(--sans, Arial, Helvetica, sans-serif)";

// Publication styling, matched to the paper's Fig. 4a: black observations, Okabe–Ito blue
// ensemble mean, a neutral-grey 10–90% band, a vermillion threshold, the green dashed
// seasonal mean, left and bottom axes only with outward ticks, and no gridlines.
const OBSERVED = "#1a1a18";
const FORECAST = "#0072B2";
const BAND_INNER = "rgba(140,150,160,0.30)";
const THRESHOLD = "#D55E00";
const MEMBER_LINE = "rgba(80,80,80,0.2)";   // individual ensemble members (optional view)
const AXIS_LINE = "#1a1a18";
const AXIS = "#1a1a18";   // tick-label colour
const TEXT = "#1a1a18";
const MUTED = "#54544e";
const DANGER = "#b4453a";
const SAFE = "#2f6eb5";   // safe side of the threshold: the below-threshold blue of the paper's Fig. 4b violins
const SEASONAL = "#4e8b5a";
// Depth palette for full-profile charts (water extraction), surface to deep. These charts
// draw no forecast mean, band or seasonal mean, so reusing the forecast blue is safe; the
// middle colour stays out of the vermillion threshold's hue family (Okabe–Ito bluish green).
const DEPTH_COLORS = ["#1a1a18", "#009E73", "#0072B2"];

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
function fmtTick(n: number): string {
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 1 : 0);
}
const DAY_MS = 86400000;

/** Canonical UTC-midnight stamp for a daily record.
 *
 *  The two series arrive on different clocks: sensor rows carry
 *  "2026-07-29 00:00:00" (no zone, parsed as local midnight) while FLARE rows
 *  carry a bare "2026-07-28" (parsed as UTC midnight). West of Greenwich that is
 *  a 4–8 h skew. Pinning both to the calendar day named in the string puts every
 *  point on an exact daily grid and agrees with the PDF caption, which formats
 *  via toISOString (UTC).
 */
function dayStamp(raw: unknown): number {
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(raw) : null;
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(raw as string).getTime();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Date label in the journal style ("9 Oct"), used on the axis and in the tooltip. */
function axisDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

type Obs = { t: number; v: number };
type Fc = { t: number; mean: number; lower: number; upper: number; p10?: number; p90?: number };
/** One labelled observation trace. Full-profile decisions pass several (one per depth);
 *  every other chart uses the single implicit "observed" trace. */
type ChartSeries = { label: string; color: string; pts: Obs[] };
/** Linked forecast days: the shared cursor and the skill record the chart echoes. A forecast
 *  point at time t is forecast day round((t - day1Ms) / DAY) + 1. */
type SkillLink = {
  day1Ms: number;
  cursor: SkillCursor | null;
  onDay: (c: SkillCursor | null) => void;
  /** Scored days 1..min(H, 21) and the question's horizon H (days 22..H read "not scored"). */
  days: DaySkill[];
  horizon: number;
};

function UnifiedChart({
  width, height, observed, forecast, units, threshold, climatology, captureId, multi, yName, members, skillLink,
}: {
  width: number; height: number; yName?: string;
  /** Optional ensemble member trajectories on the plotted forecast days (members view). */
  members?: Obs[][] | null;
  observed: Obs[]; forecast: Fc[];
  units: string; threshold?: { value: number; label: string }; climatology?: ClimatologyBand;
  captureId?: string | number;
  multi?: ChartSeries[];
  /** Linked forecast days with the skill card (visible chart only, never the PDF copy). */
  skillLink?: SkillLink;
}) {
  // padL holds the rotated y-axis title plus tick labels; padT the "latest obs" label above
  // the axes; padB the date labels (the legend sits inside the plot). The viewBox stays
  // 860 x 260 because the PDF report places the captured image at that aspect ratio.
  const padL = 60, padR = 14, padT = 21, padB = 30;
  const iw = width - padL - padR;
  const ih = height - padT - padB;

  // Observations (VERA sensors) and the forecast (FLARE model) are separate data
  // sources whose values differ at the boundary. The forecast is plotted at its own
  // values for dates strictly after the last observation; the gap at the divider is
  // the real model-vs-sensor offset.
  // A full-profile chart draws one trace per depth; every other chart draws the single
  // implicit "observed" trace, so the two paths share all the geometry below.
  const isMulti = !!(multi && multi.length);
  const series: ChartSeries[] = isMulti ? multi! : [{ label: "observed", color: OBSERVED, pts: observed }];
  const anchor = observed.length ? observed[observed.length - 1] : null;
  const seriesT = series.flatMap((sr) => sr.pts.map((p) => p.t));
  const anchorT = isMulti ? (seriesT.length ? Math.max(...seriesT) : null) : anchor?.t ?? null;
  const fc = anchorT != null ? forecast.filter((p) => p.t > anchorT) : forecast;
  // Members view: the same anchor rule as the forecast, so member lines never appear on
  // days the chart does not plot (or left of the y-axis).
  const mem = fc.length
    ? (members ?? []).map((m) => (anchorT != null ? m.filter((p) => p.t > anchorT) : m)).filter((m) => m.length > 1)
    : [];

  const allT = [...seriesT, ...fc.map((p) => p.t)];
  const tMin = Math.min(...allT);
  const tMax = Math.max(...allT);
  // Half a day of margin at each end, so the first and last points sit off the axes.
  const tPad = tMax > tMin ? 0.5 * DAY_MS : 0;
  const xAt = (t: number) => padL + (tMax === tMin ? iw / 2 : ((t - (tMin - tPad)) / (tMax - tMin + 2 * tPad)) * iw);

  // Scale to observed + forecast mean + the inner 10-90 band + threshold + the
  // seasonal mean, not the extreme 2.5-97.5 tail, so the decision zone stays
  // readable instead of being compressed by a wide outlier fan.
  const ys = [...series.flatMap((sr) => sr.pts.map((p) => p.v)), ...fc.flatMap((p) => [p.mean, p.p10 ?? p.lower, p.p90 ?? p.upper])];
  if (threshold) ys.push(threshold.value);
  if (climatology) ys.push(climatology.mean);
  // Members view: the axis grows to show every member, so no trajectory is clipped.
  for (const m of mem) for (const p of m) ys.push(p.v);
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const yLo = ticks[0], yHi = ticks[ticks.length - 1];
  const yAt = (v: number) => padT + ih - ((v - yLo) / ((yHi - yLo) || 1)) * ih;

  const meanPts = fc.map((p) => ({ t: p.t, v: p.mean }));
  const pt = (p: { t: number; v: number }) => `${xAt(p.t).toFixed(1)},${yAt(p.v).toFixed(1)}`;
  const seriesLines = series.map((sr) => ({ ...sr, line: sr.pts.map(pt).join(" ") }));
  const meanLine = meanPts.map(pt).join(" ");
  // Forecast uncertainty = the 10-90% band (falls back to the outer band only if
  // the inner quantiles are missing). The 2.5-97.5% tail is not drawn: it fans
  // out wide enough to dominate the chart.
  const bandUp = fc.map((p) => ({ t: p.t, v: p.p90 ?? p.upper }));
  const bandLo = fc.map((p) => ({ t: p.t, v: p.p10 ?? p.lower }));
  const bandPath = fc.length
    ? `M ${bandUp.map(pt).join(" L ")} L ${bandLo.map(pt).reverse().join(" L ")} Z`
    : "";

  const dividerT = anchorT != null ? anchorT : fc.length ? fc[0].t : null;
  const thrInView = !!threshold && threshold.value >= yLo && threshold.value <= yHi;

  // Data the legend and the direct labels must not sit on: the observed traces and the
  // forecast mean (sampled along a span), the 10-90% band and the ensemble members.
  const dataLines = [...series.map((sr) => sr.pts), meanPts];
  const dataYAt = (pts: Obs[], x: number): number | null => {
    if (!pts.length) return null;
    const xs = pts.map((p) => xAt(p.t));
    if (x < xs[0] - 4 || x > xs[xs.length - 1] + 4) return null;
    if (pts.length === 1) return yAt(pts[0].v);
    for (let i = 0; i < pts.length - 1; i++) {
      if (x <= xs[i + 1] || i === pts.length - 2) {
        const f = Math.min(Math.max((x - xs[i]) / ((xs[i + 1] - xs[i]) || 1), 0), 1);
        return yAt(pts[i].v) + f * (yAt(pts[i + 1].v) - yAt(pts[i].v));
      }
    }
    return null;
  };

  // Legend inside the plot, as journal figures place it: a compact, frameless key in the
  // first clear corner (top-left, top-right, bottom-left, bottom-right), stacked, or as one
  // row if no stacked corner is clear. "Clear" = no observation, forecast mean, 10-90% band,
  // ensemble member, reference line or divider passes through it.
  const legendEntries: { kind: "obs" | "fc" | "band" | "members"; text: string; color?: string }[] = isMulti
    ? series.map((sr) => ({ kind: "obs" as const, text: sr.label, color: sr.color }))
    : [
        { kind: "obs", text: "observed" },
        ...(fc.length ? ([{ kind: "fc", text: "forecast mean" }, { kind: "band", text: "10-90%" }] as const) : []),
        ...(mem.length ? [{ kind: "members" as const, text: `members (n = ${mem.length})` }] : []),
      ];
  const LEG_FS = 12.5, LEG_CH = LEG_FS * 0.54, LEG_SW = 20, LEG_TXT_GAP = 6, LEG_ROW = 17, LEG_PAD = 6, LEG_ENTRY_GAP = 18;
  const entryW = (e: { text: string }) => LEG_SW + LEG_TXT_GAP + e.text.length * LEG_CH;
  const stackW = LEG_PAD * 2 + Math.max(0, ...legendEntries.map(entryW));
  const stackH = LEG_PAD * 2 + legendEntries.length * LEG_ROW - 3;
  const rowW = LEG_PAD * 2 + legendEntries.reduce((a, e) => a + entryW(e), 0) + LEG_ENTRY_GAP * Math.max(0, legendEntries.length - 1);
  const rowH = LEG_PAD * 2 + LEG_ROW - 3;
  const legendHits = (x0: number, y0: number, x1: number, y1: number) => {
    const m = 4;
    let hits = 0;
    for (let x = x0 - m; x <= x1 + m; x += 3) {
      for (const pts of dataLines) { const y = dataYAt(pts, x); if (y != null && y >= y0 - m && y <= y1 + m) hits++; }
      if (fc.length > 1) {
        const top = dataYAt(bandUp, x), bot = dataYAt(bandLo, x);
        if (top != null && bot != null && !(bot < y0 - m || top > y1 + m)) hits++;
      }
      for (const mm of mem) { const y = dataYAt(mm, x); if (y != null && y >= y0 - m && y <= y1 + m) { hits++; break; } }
    }
    for (const ry of [thrInView ? yAt(threshold!.value) : NaN, climatology ? yAt(climatology.mean) : NaN])
      if (ry >= y0 - m && ry <= y1 + m) hits += 50;
    if (dividerT != null) { const dx = xAt(dividerT); if (dx >= x0 - m && dx <= x1 + m) hits += 50; }
    return hits;
  };
  const LEG_INSET = 10;
  const legendCandidates = (["stack", "row"] as const).flatMap((layout) => {
    const w = layout === "stack" ? stackW : rowW, h = layout === "stack" ? stackH : rowH;
    return [
      { layout, x: padL + LEG_INSET, y: padT + LEG_INSET, w, h },
      { layout, x: padL + iw - LEG_INSET - w, y: padT + LEG_INSET, w, h },
      { layout, x: padL + LEG_INSET, y: padT + ih - LEG_INSET - h, w, h },
      { layout, x: padL + iw - LEG_INSET - w, y: padT + ih - LEG_INSET - h, w, h },
    ];
  }).filter((c) => c.w <= iw - 2 * LEG_INSET);
  const scored = legendCandidates.map((c) => ({ ...c, hits: legendHits(c.x, c.y, c.x + c.w, c.y + c.h) }));
  // First clear candidate in order; if none is clear, the stacked corner with the least overlap
  // (drawn on a soft white backing so it stays legible).
  const legBox = scored.find((c) => c.hits === 0)
    ?? scored.filter((c) => c.layout === "stack").sort((a, b) => a.hits - b.hits)[0]
    ?? scored[0]
    ?? { layout: "stack" as const, x: padL + LEG_INSET, y: padT + LEG_INSET, w: stackW, h: stackH, hits: 1 };
  const legItems = (() => {
    let cx = legBox.x + LEG_PAD;
    return legendEntries.map((e, i) => {
      if (legBox.layout === "stack") return { ...e, x: legBox.x + LEG_PAD, y: legBox.y + LEG_PAD + 12 + i * LEG_ROW };
      const item = { ...e, x: cx, y: legBox.y + LEG_PAD + 12 };
      cx += entryW(e) + LEG_ENTRY_GAP;
      return item;
    });
  })();
  // Direct labels (seasonal mean, threshold). Each sits on the outer side of the pair: the
  // higher line's label above it, the lower line's below it, so close lines never stack
  // their labels. A label that lands in the top margin moves to the right end if it would
  // meet the divider label there.
  const dividerLabel = anchorT != null ? "latest obs" : "forecast start";
  const divHalfW = dividerLabel.length * 3.5;
  const divCx = dividerT != null ? Math.min(Math.max(xAt(dividerT), padL + divHalfW), padL + iw - divHalfW) : null;
  const climY = climatology ? yAt(climatology.mean) : NaN;
  const thrY = thrInView ? yAt(threshold!.value) : NaN;
  const climOnTop = climY < thrY;                        // false when either line is absent
  const thrRoomBelow = thrY + 13 <= padT + ih - 2;
  const flipPair = climOnTop && thrRoomBelow;
  const climLabelY = flipPair ? climY - 6 : climY + 13;
  const thrLabelY = flipPair ? thrY + 13 : thrY - 6;
  const meetsDivider = (y: number, text: string) =>
    y < padT + 4 && divCx != null && divCx - divHalfW < padL + 6 + text.length * 7 + 6;
  // A label goes to the left end unless data or the legend is there and the right end is clear.
  const spanHitsData = (x0: number, x1: number, baseline: number) => {
    if (x1 >= legBox.x && x0 <= legBox.x + legBox.w && baseline + 5 >= legBox.y && baseline - 13 <= legBox.y + legBox.h) return true;
    for (let x = x0; x <= x1; x += 3)
      for (const pts of dataLines) { const y = dataYAt(pts, x); if (y != null && y > baseline - 13 && y < baseline + 5) return true; }
    return false;
  };
  const labelW = (text: string) => text.length * 6.8;
  const preferRight = (y: number, text: string) =>
    spanHitsData(padL + 6, padL + 6 + labelW(text), y) && !spanHitsData(padL + iw - 6 - labelW(text), padL + iw - 6, y);
  // A seasonal-mean label that would drop into the date row goes above its line.
  const climLabelYSafe = !flipPair && climLabelY > padT + ih - 2 ? climY - 6 : climLabelY;
  // Each label tries its usual side of the line (left end, then right end); if data or the
  // legend sits on both, it tries the other side of its line before settling.
  const placeLabel = (ys: number[], text: string, forceRight: boolean) => {
    for (const y of ys) {
      if (y < padT + 2 || y > padT + ih - 2) continue;
      const leftFree = !forceRight && !spanHitsData(padL + 6, padL + 6 + labelW(text), y);
      if (leftFree) return { y, right: false };
      if (!spanHitsData(padL + iw - 6 - labelW(text), padL + iw - 6, y)) return { y, right: true };
    }
    return { y: ys[0], right: forceRight || preferRight(ys[0], text) };
  };
  const climAlt = climLabelYSafe > climY ? climY - 6 : climY + 13;
  const climPlace = placeLabel([climLabelYSafe, climAlt], "seasonal mean",
    (climOnTop && !thrRoomBelow && thrY - climY < 30) || meetsDivider(climLabelYSafe, "seasonal mean"));
  const thrAlt = thrLabelY > thrY ? thrY - 6 : thrY + 13;
  const thrPlace = threshold ? placeLabel([thrLabelY, thrAlt], threshold.label, meetsDivider(thrLabelY, threshold.label)) : { y: thrLabelY, right: false };
  const climRight = climPlace.right;
  const thrRight = thrPlace.right;

  // Date axis: aim for a label roughly every ~6 days (bounded 5–9 ticks) so the gaps
  // stay small and each day's dot can be counted from a nearby date.
  // Ticks sit on whole UTC days, never on an even division of the time span (a tick at a
  // fractional instant would print the day before the point it marks). calendarTicks
  // counts back from the latest day on a fixed step, so the gaps are equal and every
  // label sits exactly on the day it names.
  const spanDays = (tMax - tMin) / DAY_MS;
  const wanted = tMax === tMin ? 1 : Math.max(5, Math.min(9, Math.round(spanDays / 6) + 1));
  const xTicks = calendarTicks(tMin, tMax, wanted);
  // Minor ticks on every day, so the daily granularity reads off the axis (Fig. 4a style).
  const dayTicks: number[] = [];
  if (tMax > tMin && spanDays <= 120) for (let t = tMin; t <= tMax + 1; t += DAY_MS) dayTicks.push(t);
  const axisTitle = yName ? `${yName} (${units})` : units;

  // Hover tooltip. Observed + forecast points form one hoverable set; on mouse-move the
  // pointer maps to viewBox X (height:auto keeps the SVG's aspect exact, so this mapping
  // is precise) and the nearest day is highlighted.
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // When the skill card takes over the day, drop the chart's own tooltip (one tooltip at a
  // time; a resting mouse or a finished tap would otherwise leave it up).
  const cardDriving = skillLink?.cursor?.from === "card";
  useEffect(() => { if (cardDriving) setHoverIdx(null); }, [cardDriving]);
  const hoverPts = [
    ...series.flatMap((sr) => sr.pts.map((p) => ({ t: p.t, y: p.v, kind: "obs" as const, label: sr.label, mean: p.v, p10: undefined as number | undefined, p90: undefined as number | undefined }))),
    ...fc.map((p) => ({ t: p.t, y: p.mean, kind: "fc" as const, label: "forecast", mean: p.mean, p10: p.p10, p90: p.p90 })),
  ];
  // Forecast day of a plotted time, and its past-skill row for the tooltip.
  const skillDayOf = (t: number) => (skillLink ? Math.round((t - skillLink.day1Ms) / DAY_MS) + 1 : null);
  const skillRow = (k: number | null): string | null => {
    if (!skillLink || k == null || k < 1 || k > skillLink.horizon) return null;
    const d = skillLink.days[k - 1];
    return d ? `past skill ${fmtSkillPct(d.crpss)}` : k > skillLink.days.length && k > 21 ? "past skill: not scored" : null;
  };
  const tellSkill = (idx: number | null) => {
    if (!skillLink) return;
    const p = idx != null ? hoverPts[idx] : null;
    const k = p && p.kind === "fc" ? skillDayOf(p.t) : null;
    if (k != null && k >= 1 && k <= skillLink.horizon && k <= Math.max(skillLink.days.length, Math.min(skillLink.horizon, 35))) {
      if (skillLink.cursor?.from !== "chart" || skillLink.cursor.day !== k) skillLink.onDay({ day: k, from: "chart" });
    } else if (skillLink.cursor?.from === "chart") {
      skillLink.onDay(null);
    }
  };
  const updateFromX = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg || hoverPts.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vbX = ((clientX - rect.left) / rect.width) * width;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < hoverPts.length; i++) {
      const d = Math.abs(xAt(hoverPts[i].t) - vbX);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best !== hoverIdx) { setHoverIdx(best); tellSkill(best); }
  };
  // The card is pointing at a day: echo it here as a hairline and a ring on that day's mean.
  const cardDay = skillLink?.cursor?.from === "card" ? skillLink.cursor.day : null;
  const hovered = cardDay == null && hoverIdx != null && hoverIdx >= 0 && hoverIdx < hoverPts.length ? hoverPts[hoverIdx] : null;
  const echoPt = cardDay != null && !hovered ? fc.find((p) => skillDayOf(p.t) === cardDay) ?? null : null;

  return (
    <svg
      ref={svgRef}
      data-report-chart={captureId}
      onMouseMove={(e) => updateFromX(e.clientX)}
      onMouseLeave={() => { setHoverIdx(null); tellSkill(null); }}
      onTouchStart={(e) => { const t = e.touches[0]; if (t) updateFromX(t.clientX); }}
      onTouchMove={(e) => { const t = e.touches[0]; if (t) updateFromX(t.clientX); }}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", width: "100%", height: "auto", maxWidth: "100%", touchAction: "pan-y" }}
    >
      {/* axes: left and bottom only, outward ticks, no gridlines */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + ih} stroke={AXIS_LINE} strokeWidth={1.1} />
      <line x1={padL} y1={padT + ih} x2={padL + iw} y2={padT + ih} stroke={AXIS_LINE} strokeWidth={1.1} />
      {ticks.map((tv) => {
        const y = yAt(tv);
        return (
          <g key={tv}>
            <line x1={padL - 4.5} y1={y} x2={padL} y2={y} stroke={AXIS_LINE} strokeWidth={1.1} />
            <text x={padL - 8} y={y + 4.5} textAnchor="end" fontSize={13} fill={AXIS} style={{ fontFamily: SVG_FONT, fontVariantNumeric: "tabular-nums" }}>{fmtTick(tv)}</text>
          </g>
        );
      })}
      {dayTicks.map((t, i) => (
        <line key={`mt${i}`} x1={xAt(t)} y1={padT + ih} x2={xAt(t)} y2={padT + ih + 2.5} stroke={AXIS_LINE} strokeWidth={0.8} />
      ))}
      {xTicks.map((t, i) => (
        <line key={`xt${i}`} x1={xAt(t)} y1={padT + ih} x2={xAt(t)} y2={padT + ih + 5} stroke={AXIS_LINE} strokeWidth={1.1} />
      ))}
      <text transform={`translate(14 ${padT + ih / 2}) rotate(-90)`} textAnchor="middle" fontSize={13} fontWeight={600} fill={TEXT} style={{ fontFamily: SVG_FONT }}>{axisTitle}</text>

      {/* ensemble members (optional view) - drawn first, under the band and the mean */}
      {mem.length ? (
        <g>
          {mem.map((m, i) => (
            <polyline key={`mb${i}`} points={m.map(pt).join(" ")} fill="none" stroke={MEMBER_LINE} strokeWidth={0.6} strokeLinejoin="round" />
          ))}
        </g>
      ) : null}

      {/* forecast 10-90% band (a one-day forecast has no area; it gets a range bar below) */}
      {bandPath && fc.length > 1 && <path d={bandPath} fill={BAND_INNER} stroke="none" />}

      {/* seasonal (day-of-year) mean: the ~±2-week climatological mean for this
          time of year at this depth, pooled across all years of the VERA record. Drawn
          above the band so it stays visible across the forecast; its label is drawn last. */}
      {climatology && (
        <line x1={padL} y1={climY} x2={padL + iw} y2={climY} stroke={SEASONAL} strokeWidth={1.6} strokeDasharray="7 4" />
      )}

      {/* observation / forecast divider. It marks the last observation, which is only
          "now" when the sensor feed is current, so it is labelled "latest obs". */}
      {dividerT != null && (() => {
        const dx = xAt(dividerT);
        // dividerLabel keys off anchorT, not `anchor`: in full-profile mode the traces
        // live in `multi` and `observed` is empty, so `anchor` would mislabel the
        // divider as "forecast start".
        return (
          <g>
            <line x1={dx} y1={padT} x2={dx} y2={padT + ih} stroke="#33332f" strokeWidth={1.1} strokeDasharray="3.5 3" />
            <text x={divCx ?? dx} y={padT - 6} textAnchor="middle" fontSize={12.5} fill="#1a1a18" style={{ fontFamily: SVG_FONT }}>{dividerLabel}</text>
          </g>
        );
      })()}

      {/* threshold line (its label is drawn last, with the other direct labels) */}
      {thrInView && (
        <line x1={padL} y1={thrY} x2={padL + iw} y2={thrY} stroke={THRESHOLD} strokeWidth={1.7} />
      )}

      {/* Direct labels: above the reference lines and members (the white halo keeps those
          from running through the text) but below the data, so no data point is hidden. */}
      {climatology && (
        <text x={climRight ? padL + iw - 6 : padL + 6} y={climPlace.y} textAnchor={climRight ? "end" : "start"} fontSize={12.5} fontWeight={500} fill={SEASONAL}
          paintOrder="stroke" stroke="#fff" strokeWidth={3} strokeLinejoin="round" style={{ fontFamily: SVG_FONT }}>seasonal mean</text>
      )}
      {thrInView && (
        <text x={thrRight ? padL + iw - 6 : padL + 6} y={thrPlace.y} textAnchor={thrRight ? "end" : "start"} fontSize={12.5} fontWeight={500} fill={THRESHOLD}
          paintOrder="stroke" stroke="#fff" strokeWidth={3} strokeLinejoin="round" style={{ fontFamily: SVG_FONT }}>{threshold!.label}</text>
      )}

      {meanPts.length > 1 && <polyline points={meanLine} fill="none" stroke={FORECAST} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
      {/* a one-day forecast: its mean as a dot with the 10-90% range as a bar */}
      {meanPts.length === 1 && (() => {
        const p = fc[0], x = xAt(p.t);
        const lo = p.p10 ?? p.lower, hi = p.p90 ?? p.upper;
        return (
          <g>
            {Number.isFinite(lo) && Number.isFinite(hi) && hi !== lo && (
              <g stroke={FORECAST} strokeWidth={1.1}>
                <line x1={x} y1={yAt(hi)} x2={x} y2={yAt(lo)} />
                <line x1={x - 4} y1={yAt(hi)} x2={x + 4} y2={yAt(hi)} />
                <line x1={x - 4} y1={yAt(lo)} x2={x + 4} y2={yAt(lo)} />
              </g>
            )}
            <circle cx={x} cy={yAt(p.mean)} r={3} fill={FORECAST} />
          </g>
        );
      })()}
      {seriesLines.map((sr) => sr.pts.length > 0 && (
        <polyline key={`ln-${sr.label}`} points={sr.line} fill="none" stroke={sr.color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {/* Observed days as solid dots when the window is short (≤35 points; long history
          would clutter). Daily minor ticks on the x-axis carry the forecast's daily grid, as
          in Fig. 4a. The latest reading keeps a white halo so it reads as emphasised. */}
      {series.map((sr) => sr.pts.length <= 35 && sr.pts.map((p, i) => (
        <circle key={`od-${sr.label}-${i}`} cx={xAt(p.t)} cy={yAt(p.v)} r={3.2} fill={sr.color} stroke="none" />
      )))}
      {/* Latest-reading emphasis. In full-profile mode each trace ends on the same day,
          so one filled dot would arbitrarily privilege a single depth - every trace gets
          its own end dot instead. */}
      {isMulti
        ? series.map((sr) => sr.pts.length > 0 && (() => {
            const last = sr.pts[sr.pts.length - 1];
            return <circle key={`an-${sr.label}`} cx={xAt(last.t)} cy={yAt(last.v)} r={3.9} fill={sr.color} stroke="#fff" strokeWidth={1.2} />;
          })())
        : anchor && <circle cx={xAt(anchor.t)} cy={yAt(anchor.v)} r={3.9} fill={OBSERVED} stroke="#fff" strokeWidth={1.2} />}

      {/* Edge labels anchor inward so they never clip. */}
      {xTicks.map((t, i) => (
        <text key={i} x={xAt(t)} y={padT + ih + 19} textAnchor={xAt(t) - axisDate(t).length * 3.6 < padL - 6 ? "start" : xAt(t) + axisDate(t).length * 3.6 > width - 2 ? "end" : "middle"} fontSize={13} fill={AXIS} style={{ fontFamily: SVG_FONT }}>{axisDate(t)}</text>
      ))}

      {/* legend - inside the plot, in the first clear corner (journal style, frameless) */}
      <g style={{ fontFamily: SVG_FONT }} fontSize={LEG_FS}>
        <rect x={legBox.x} y={legBox.y} width={legBox.w} height={legBox.h} rx={4} fill="#fff" opacity={legBox.hits ? 0.88 : 0} />
        {legItems.map((e) => (
          <g key={`${e.kind}-${e.text}`}>
            {e.kind === "band" ? (
              fc.length === 1 ? (
                <g stroke={FORECAST} strokeWidth={1.1}>
                  <line x1={e.x + LEG_SW / 2} y1={e.y - 9} x2={e.x + LEG_SW / 2} y2={e.y + 1} />
                  <line x1={e.x + LEG_SW / 2 - 4} y1={e.y - 9} x2={e.x + LEG_SW / 2 + 4} y2={e.y - 9} />
                  <line x1={e.x + LEG_SW / 2 - 4} y1={e.y + 1} x2={e.x + LEG_SW / 2 + 4} y2={e.y + 1} />
                </g>
              ) : <rect x={e.x} y={e.y - 8.5} width={LEG_SW} height={9} fill={BAND_INNER} />
            ) : e.kind === "members" ? (
              <g>
                <line x1={e.x} y1={e.y - 6} x2={e.x + LEG_SW} y2={e.y - 7.5} stroke="rgba(80,80,80,0.55)" strokeWidth={0.6} />
                <line x1={e.x} y1={e.y - 4} x2={e.x + LEG_SW} y2={e.y - 3} stroke="rgba(80,80,80,0.55)" strokeWidth={0.6} />
                <line x1={e.x} y1={e.y - 2} x2={e.x + LEG_SW} y2={e.y - 0.5} stroke="rgba(80,80,80,0.55)" strokeWidth={0.6} />
              </g>
            ) : e.kind === "obs" ? (
              <g>
                <line x1={e.x} y1={e.y - 4} x2={e.x + LEG_SW} y2={e.y - 4} stroke={e.color ?? OBSERVED} strokeWidth={1.5} />
                <circle cx={e.x + LEG_SW / 2} cy={e.y - 4} r={3.2} fill={e.color ?? OBSERVED} />
              </g>
            ) : fc.length === 1 ? (
              <circle cx={e.x + LEG_SW / 2} cy={e.y - 4} r={3} fill={FORECAST} />
            ) : (
              <line x1={e.x} y1={e.y - 4} x2={e.x + LEG_SW} y2={e.y - 4} stroke={FORECAST} strokeWidth={2.5} />
            )}
            <text x={e.x + LEG_SW + LEG_TXT_GAP} y={e.y} fill="#1a1a18">{e.text}</text>
          </g>
        ))}
      </g>

      {/* hover tooltip: nearest-day guide line, highlighted point, and a small
          panel with the exact date + value(s). pointerEvents:none so it never blocks moves;
          data-transient so the PDF capture strips it (lib/report.ts svgToPngDataUrl). */}
      {hovered && (() => {
        const hx = xAt(hovered.t), hy = yAt(hovered.y);
        const past = hovered.kind === "fc" ? skillRow(skillDayOf(hovered.t)) : null;
        const rows = hovered.kind === "fc"
          ? [`${axisDate(hovered.t)} · forecast`, `${fmt(hovered.mean)} ${units}`, ...(hovered.p10 != null && hovered.p90 != null ? [`10–90%: ${fmt(hovered.p10)}–${fmt(hovered.p90)}`] : []), ...(past ? [past] : [])]
          : [`${axisDate(hovered.t)} · ${hovered.label}`, `${fmt(hovered.y)} ${units}`];
        const tw = 172, rowH = 16, th = rows.length * rowH + 9;
        let tx = hx + 10;
        if (tx + tw > padL + iw) tx = hx - 10 - tw;
        if (tx < padL) tx = padL + 2;
        const ty = Math.min(Math.max(hy - th - 8, padT + 2), padT + ih - th - 2);
        return (
          <g pointerEvents="none" data-transient="">
            <line x1={hx} y1={padT} x2={hx} y2={padT + ih} stroke="rgba(120,113,108,0.45)" strokeWidth={1} />
            <circle cx={hx} cy={hy} r={3.6} fill={hovered.kind === "fc" ? FORECAST : OBSERVED} stroke="#fff" strokeWidth={1.4} />
            <rect x={tx} y={ty} width={tw} height={th} rx={5} fill="rgba(26,26,24,0.92)" />
            {rows.map((ln, i) => (
              <text key={i} x={tx + 8} y={ty + 15 + i * rowH} fontSize={12} fill="#fff" style={{ fontFamily: SVG_FONT }} fontWeight={i === 0 ? 600 : 400}>{ln}</text>
            ))}
          </g>
        );
      })()}

      {/* linked forecast day from the skill card: a hairline and a ring, no tooltip box */}
      {echoPt && (
        <g pointerEvents="none" data-transient="">
          <line x1={xAt(echoPt.t)} y1={padT} x2={xAt(echoPt.t)} y2={padT + ih} stroke="rgba(120,113,108,0.45)" strokeWidth={1} />
          <circle cx={xAt(echoPt.t)} cy={yAt(echoPt.mean)} r={6.5} fill="none" stroke={TEXT} strokeWidth={1.3} />
        </g>
      )}
    </svg>
  );
}

type Props = {
  variableLabel: string;
  units: string;
  site: string;
  loading: boolean;
  sensor: SeriesPoint[] | null;
  forecast: ForecastPoint[] | null;
  climatology?: ClimatologyBand | null;
  depthM?: number | null;
  threshold?: { value: number; label: string; direction?: "below" | "above" };
  variableKey?: string; // canonical VARIABLE_META key (e.g. "Chla_ugL_mean"), for the skill card
  forecastHorizon?: number; // chart's forecast horizon in days (clamped 7–35), for the subtitle label
  skillHorizon?: number | null; // the question's own horizon (unclamped): the days the skill card shows
  captureId?: string | number; // when set, stamps data-report-chart on the chart SVG for PDF capture
  /** Full-profile decisions (water extraction) pass one labelled series per depth. When
   *  present the chart draws them together against the threshold line instead of the
   *  single `sensor` trace, so the deciding depth is visible on the figure rather than
   *  only in the text. */
  depthSeries?: { label: string; points: SeriesPoint[] }[] | null;
  /** The plan's observation window (days). When set, the observed traces are trimmed to
   *  exactly N days at render time (see trimToTrailingWindow). */
  windowDays?: number | null;
};

export default function InsightPanel({ variableLabel, units, site, loading, sensor, forecast, climatology, depthM, threshold, variableKey, forecastHorizon, skillHorizon, captureId, depthSeries, windowDays }: Props) {
  // Observed traces are trimmed to the N-day window at render time as well as at fetch
  // time: a saved conversation stores the series as it was fetched, which can hold
  // N+1 days (8 points for a 7-day question).
  const observed: Obs[] = trimToTrailingWindow(
    (sensor ?? [])
      .map((p) => ({ t: dayStamp(p.t), v: p.v }))
      .filter((p) => Number.isFinite(p.t)),
    windowDays,
  );
  const fc: Fc[] = (forecast ?? [])
    .map((p) => ({ t: dayStamp(p.t), mean: p.mean, lower: p.lower, upper: p.upper, p10: p.p10, p90: p.p90 }))
    .filter((p) => Number.isFinite(p.t));
  // Full-profile traces, one per depth. Built here (not in the chart) so an empty or
  // absent list falls straight back to the single-series path. Each trace is windowed
  // from its own latest day, as the fetch windowed it (page.tsx fetches each depth
  // separately): a shared latest day would cut days off a sonde whose feed lags.
  const multi = (depthSeries ?? [])
    .map((sr, i) => ({
      label: sr.label,
      color: DEPTH_COLORS[i % DEPTH_COLORS.length],
      pts: trimToTrailingWindow(
        (sr.points ?? []).map((p) => ({ t: dayStamp(p.t), v: p.v })).filter((p) => Number.isFinite(p.t)),
        windowDays,
      ),
    }))
    .filter((sr) => sr.pts.length > 0);
  const isMulti = multi.length > 0;
  const hasAny = observed.length > 0 || fc.length > 0 || isMulti;
  const hasForecast = fc.length > 0;
  // End-of-horizon reads (10th percentile, mean, 90th percentile), shown only when
  // the forecast carries the inner 10/90 band.
  const lastFc = fc.length ? fc[fc.length - 1] : null;
  const showReads = hasForecast && !!lastFc && lastFc.p10 != null && lastFc.p90 != null;

  // Optional ensemble-members view. Fetched on demand, then shown only if the members
  // belong to the same run as the plotted forecast: their daily average must reproduce
  // the plotted mean. A newer FLARE run (e.g. a saved answer reopened days later) or a
  // different layer fails that check, and the chart says so instead of mixing runs.
  const [memberView, setMemberView] = useState<"off" | "loading" | "on" | "unavailable">("off");
  const [memberData, setMemberData] = useState<MemberSeries | null>(null);
  // The state belongs to the chart it was fetched for. A saved conversation can reuse this
  // panel for a different chart (message ids repeat across conversations), so a change of
  // chart resets it, and a fetch that returns after the chart changed is discarded.
  const memberSig = `${site}|${variableKey ?? ""}|${depthM ?? ""}|${fc.map((p) => `${p.t}:${p.mean}`).join(",")}`;
  const [memberFor, setMemberFor] = useState(memberSig);
  // Linked forecast days: one cursor shared by the chart and the skill card.
  const [skillCursor, setSkillCursor] = useState<SkillCursor | null>(null);
  if (memberFor !== memberSig) { setMemberFor(memberSig); setMemberView("off"); setMemberData(null); setSkillCursor(null); }
  const sigRef = useRef(memberSig);
  useEffect(() => { sigRef.current = memberSig; }, [memberSig]);
  // Offered only when the chart actually plots forecast days after the last observation.
  const lastObsT = observed.length ? observed[observed.length - 1].t : null;
  const canShowMembers = !isMulti && !!variableKey && fc.filter((p) => lastObsT == null || p.t > lastObsT).length > 1;
  const memberLines: Obs[][] | null = (() => {
    if (memberView !== "on" || !memberData || !membersMatchPlot(memberData)) return null;
    const plotted = new Set(fc.map((p) => p.t));
    const idx = memberData.dates.map((d, i) => ({ t: dayStamp(d), i })).filter(({ t }) => plotted.has(t));
    return memberData.members.map((row) =>
      idx.flatMap(({ t, i }) => (row[i] == null ? [] : [{ t, v: row[i] as number }])));
  })();
  function membersMatchPlot(d: MemberSeries): boolean {
    const meanByT = new Map(fc.map((p) => [p.t, p.mean]));
    let overlap = 0;
    for (let i = 0; i < d.dates.length; i++) {
      const plottedMean = meanByT.get(dayStamp(d.dates[i]));
      if (plottedMean == null) continue;
      const vs = d.members.map((r) => r[i]).filter((v): v is number => v != null);
      if (!vs.length) return false;
      const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
      if (Math.abs(avg - plottedMean) > 0.005 + 1e-4 * Math.abs(plottedMean)) return false;
      overlap++;
    }
    return overlap > 0;
  }
  const toggleMembers = async () => {
    if (memberView === "on") { setMemberView("off"); return; }
    if (memberView === "loading" || !variableKey) return;
    if (memberData) { setMemberView(membersMatchPlot(memberData) ? "on" : "unavailable"); return; }
    setMemberView("loading");
    const reqSig = memberSig;
    const d = await fetchForecastMembers(site, variableKey, depthM ?? null, Math.max(fc.length, forecastHorizon ?? 7));
    if (sigRef.current !== reqSig) return;   // the chart changed while loading
    if (d) setMemberData(d);
    setMemberView(d && membersMatchPlot(d) ? "on" : "unavailable");
  };

  // The chart echoes the skill card only when the card has a record (never for BVR, another
  // depth or a full-profile chart) and the first forecast day is known.
  const skillRecord = hasForecast && !isMulti && variableKey ? getForecastSkill(site, variableKey, depthM, skillHorizon ?? forecastHorizon) : null;
  const skillLink: SkillLink | undefined = SKILL_CARD_ENABLED && skillRecord && fc.length
    ? { day1Ms: fc[0].t, cursor: skillCursor, onDay: setSkillCursor, days: skillRecord.days, horizon: skillRecord.horizon }
    : undefined;

  const chartWidth = 860;
  const wrapStyle: CSSProperties = { width: "100%", marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--rule)", background: "transparent", fontFamily: "var(--sans)" };

  return (
    <aside style={wrapStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontFamily: "var(--serif)", fontSize: 21, fontWeight: 500, color: TEXT, letterSpacing: "-0.01em", lineHeight: 1.2 }}>{variableLabel}</div>
          {/* Site and depth through the same helpers as the PDF header and chart caption,
              so screen and paper name them identically ("FCR", not "FCRE"). */}
          <div style={{ fontSize: 12, color: MUTED, fontFamily: "var(--sans)", fontWeight: 500, letterSpacing: "0.07em", marginTop: 4, textTransform: "uppercase" }}>
            {[siteDisplayName(site), chartDepthLabel(isMulti ? { depthSeries: multi } : { depthM })].filter(Boolean).join(" · ")} · sensors{hasForecast && !isMulti ? " & FLARE" : ""}
          </div>
        </div>
      </div>

      {loading && (
        <div style={{ fontSize: 14, color: MUTED, marginTop: 20, fontFamily: "var(--sans)" }}>Loading insights…</div>
      )}

      {!loading && !hasAny && (
        <div style={{ fontSize: 13, color: MUTED, marginTop: 20, lineHeight: 1.6 }}>No sensor or forecast data for this question.</div>
      )}

      {!loading && hasAny && (
        <section>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, margin: "16px 0 8px" }}>
            <div style={{ fontSize: 12, color: MUTED, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--sans)", fontWeight: 600 }}>
              {isMulti ? "Recent observations by depth" : hasForecast ? `Observations → ${forecastHorizon ?? 7}-day forecast` : "Recent observations"}
            </div>
            {canShowMembers && (
              <button
                type="button"
                onClick={() => { void toggleMembers(); }}
                aria-pressed={memberView === "on"}
                disabled={memberView === "loading"}
                title="Plot every FLARE ensemble member behind the forecast mean"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7,
                  padding: "6px 13px", borderRadius: 999,
                  background: memberView === "on" ? "rgba(2,67,110,0.07)" : "#fff",
                  border: `1px solid ${memberView === "on" ? "#a9bfd2" : "var(--rule-strong)"}`,
                  cursor: memberView === "loading" ? "wait" : "pointer",
                  fontSize: 13, fontWeight: 500, fontFamily: "var(--sans)", color: "#02436e", whiteSpace: "nowrap",
                  transition: "border-color 0.15s ease, background 0.15s ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#02436e"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = memberView === "on" ? "#a9bfd2" : "var(--rule-strong)"; }}
              >
                <Icon name="members" size={15} stroke={1.5} />
                {memberView === "on" ? "Hide ensemble members" : memberView === "loading" ? "Loading members…" : "Show ensemble members"}
              </button>
            )}
          </div>
          {/* Full-profile mode drops the forecast layer and the single seasonal-mean line:
              both belong to one depth, and drawing a 1.6 m climatology across a chart of
              three depths would read as a shared baseline it is not. */}
          <UnifiedChart
            yName={variableLabel}
            members={memberLines}
            width={chartWidth}
            height={260}
            observed={isMulti ? [] : observed}
            forecast={isMulti ? [] : fc}
            units={units}
            threshold={threshold}
            climatology={isMulti ? undefined : climatology ?? undefined}
            captureId={memberLines ? undefined : captureId}
            multi={isMulti ? multi : undefined}
            skillLink={skillLink}
          />
          {/* The decision report always prints the standard chart, so the PDF never depends
              on whether the members view happens to be switched on. */}
          {memberLines && captureId != null && (
            <div style={{ display: "none" }} aria-hidden>
              <UnifiedChart
                yName={variableLabel}
                width={chartWidth}
                height={260}
                observed={observed}
                forecast={fc}
                units={units}
                threshold={threshold}
                climatology={climatology ?? undefined}
                captureId={captureId}
              />
            </div>
          )}
          {memberView === "unavailable" && (
            <div style={{ fontSize: 13, color: MUTED, marginTop: 6, fontFamily: "var(--sans)" }}>
              Ensemble members are not available for this forecast run.
            </div>
          )}

          {showReads && lastFc && (() => {
            // Pessimistic = the worst case for this threshold's direction. A bloom
            // threshold ("above", high is bad) makes the high 90th the worst case and
            // the low 10th the best; a hypoxia threshold ("below", low is bad) is the
            // reverse. Without a threshold the reads are neutral (lower / expected / upper).
            const d = threshold?.direction;
            const p10 = lastFc.p10 as number, mean = lastFc.mean, p90 = lastFc.p90 as number;
            const reads: [string, number][] =
              d === "above" ? [["pessimistic · 90th", p90], ["expected · mean", mean], ["optimistic · 10th", p10]]
              : d === "below" ? [["pessimistic · 10th", p10], ["expected · mean", mean], ["optimistic · 90th", p90]]
              : [["lower · 10th", p10], ["expected · mean", mean], ["upper · 90th", p90]];
            // A value "breaches" when it falls on the wrong side of the threshold (red); on the
            // safe side it is blue. Chlorophyll-a (bloom, "above") and DO (hypoxia, "below") swap
            // which percentile is pessimistic, so the colour always follows the risk, not the
            // column. Without a directed threshold the reads stay neutral ink.
            const breaches = (v: number) => !!threshold && (d === "above" ? v > threshold.value : d === "below" ? v < threshold.value : false);
            const readColor = (v: number) => (d === "above" || d === "below" ? (breaches(v) ? DANGER : SAFE) : TEXT);
            return (
              <div style={{ marginTop: 22 }}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontSize: 12, color: MUTED, letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "var(--sans)", fontWeight: 600 }}>Forecast outlook</span>
                  {threshold && <span style={{ fontSize: 12.5, color: "#54544e", fontFamily: "var(--sans)", fontVariantNumeric: "tabular-nums" }}>vs {fmt(threshold.value)} {units} threshold</span>}
                </div>
                {/* Journal-table frame shared with the Forecast skill block below: a thin dark rule
                    above and below, light rules between columns, no boxes. */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", marginTop: 8, borderTop: "1px solid rgba(26,26,24,0.72)", borderBottom: "1px solid rgba(26,26,24,0.72)" }}>
                  {reads.map(([lab, val], i) => {
                    return (
                      <div key={lab} style={{ padding: "11px clamp(8px, 2.4vw, 14px) 12px", borderLeft: i ? "1px solid var(--rule)" : "none", minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <div style={{ fontSize: 12, color: MUTED, fontFamily: "var(--sans)", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase", flex: "1 0 auto" }}>{lab}</div>
                        <div style={{ fontFamily: "var(--sans)", fontSize: "clamp(21px, 5.6vw, 28px)", fontWeight: 600, letterSpacing: "-0.02em", color: readColor(val), marginTop: 6, lineHeight: 1.05, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                          {val.toFixed(1)}<span style={{ fontSize: 13, color: MUTED, fontWeight: 400, letterSpacing: 0, marginLeft: 4 }}>{units}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Forecast skill: display-only past CRPSS vs climatology by forecast day (FCR 1.6 m,
              95% CI), under the outlook reads. Gated by the charted depth: a quiet "not
              scored" line when no record applies (BVR, another depth, unknown depth). */}
          {hasForecast && variableKey && (
            <ForecastSkillCard variable={variableKey} site={site} forecast={forecast} depthM={depthM} forecastHorizon={skillHorizon ?? forecastHorizon} variableLabel={variableLabel} cursor={skillCursor} onCursor={setSkillCursor} />
          )}
        </section>
      )}
    </aside>
  );
}
