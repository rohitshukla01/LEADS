"use client";

// Display-only "Forecast skill" card shown under a forecast answer. It reports FLARE's past
// skill (CRPSS % against climatology) at FCR 1.6 m for each forecast day 1..min(H, 21) of
// the question's horizon H, as a dot-and-interval figure: one column per day, the 95% CI as
// a grey line, and a mark whose shape carries the CI class (filled dot = more skilful, open
// dot = not distinguishable, grey square = less skilful). Days 22..H are a hatched "not
// scored" strip. It reads the static record (lib/skill/forecast-skill.json) through the same
// gate as the PDF and the evidence record, plus data already on the message, and does not
// touch the pipeline or the answer text. When no record applies (BVR, a depth other than
// 1.6 m, an unknown depth, an unscored variable) it shows a quiet "not scored" line instead
// of disappearing. Toggle with NEXT_PUBLIC_LEADS_SKILL_CARD_ENABLED=false.
//
// Linked forecast days: InsightPanel passes one shared cursor ({day, from}) to this card and
// to the chart above it. Pointing at a day here (mouse, tap or keys) shows the full readout
// here and a hairline plus a ring on that day of the chart; pointing at a forecast day on the
// chart adds "past skill" to the chart's tooltip and draws only a hairline and a ring here.
// Every such mark is data-transient, so no capture or print ever contains it.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import Icon from "./Icon";
import {
  getForecastSkill, skillClass, skillGapPhrase, skillUnscoredNote, skillVerdict, fmtSkillDate, fmtSkillNum, fmtSkillPct,
  SKILL_CLASS_PHRASE, SKILL_META, SKILL_RECORD_THROUGH, SKILL_SCORED_SCOPE, SKILL_VARIABLE_LABEL,
  type ForecastSkill, type SkillClass,
} from "@/lib/skill/forecast-skill";
import { layoutSkillPlot, SKILL_PLOT_COLORS as C } from "@/lib/skill/skill-plot";
import type { ForecastPoint } from "@/lib/insights";

/** Switch for the card and its link to the chart (NEXT_PUBLIC_LEADS_SKILL_CARD_ENABLED=false turns both off). */
export const SKILL_CARD_ENABLED = process.env.NEXT_PUBLIC_LEADS_SKILL_CARD_ENABLED !== "false";

// Inline font with a fallback, as in the chart: Geist on screen, Arial in any standalone copy.
const SVG_FONT = "var(--sans, Arial, Helvetica, sans-serif)";
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const EYEBROW: CSSProperties = {
  fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, color: C.muted, letterSpacing: "0.08em", textTransform: "uppercase",
};
const RULES: CSSProperties = { borderTop: `1px solid ${C.rule}`, borderBottom: `1px solid ${C.rule}` };
const SR_ONLY: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden",
  clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};

/** UTC midnight of the chart's first forecast day (the record's day 1), or null. */
export function skillDay1Ms(forecast: ForecastPoint[] | null | undefined): number | null {
  const raw = forecast?.[0]?.t;
  const m = typeof raw === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(raw) : null;
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** "d Mon" for forecast day k, or "" when the first forecast day is unknown. */
function dayDate(day1: number | null, k: number): string {
  if (day1 == null) return "";
  const d = new Date(day1 + (k - 1) * DAY_MS);
  return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The readout for one day: "Day 3 · 18 Oct: +47% (95% CI 35 to 58) · more skilful than climatology · 458 past forecasts". */
export function skillReadout(sk: ForecastSkill, k: number, day1: number | null): string {
  const date = dayDate(day1, k);
  const head = `Day ${k}${date ? ` · ${date}` : ""}`;
  const d = sk.days[k - 1];
  if (!d) return `${head}: not scored`;
  return `${head}: ${fmtSkillPct(d.crpss)} (95% CI ${fmtSkillNum(d.lo)} to ${fmtSkillNum(d.hi)}) · ` +
    `${SKILL_CLASS_PHRASE[skillClass(d)].full} · ${d.n} past forecasts`;
}

/** The mark for one class, centred on (x, y). Shape, not colour, carries the class. */
function Mark({ cls, x, y, r }: { cls: SkillClass; x: number; y: number; r: number }) {
  if (cls === "less") {
    const s = r * 1.75;
    return <rect x={x - s / 2} y={y - s / 2} width={s} height={s} fill={C.less} />;
  }
  if (cls === "same") return <circle cx={x} cy={y} r={r} fill="#fff" stroke={C.ink} strokeWidth={1.5} />;
  return <circle cx={x} cy={y} r={r} fill={C.ink} />;
}

const KEY_TEXT: Record<SkillClass, string> = { more: "More skilful", same: "Not distinguishable", less: "Less skilful" };

/** The forecast day pointed at, and which panel is pointing (the card or the chart). */
export type SkillCursor = { day: number; from: "card" | "chart" };

export default function ForecastSkillCard({
  variable,
  site,
  forecast,
  depthM,
  forecastHorizon,
  variableLabel,
  cursor,
  onCursor,
}: {
  variable: string;
  site: string;
  forecast: ForecastPoint[] | null;
  depthM: number | null | undefined; // the charted forecast's depth; unknown fails closed
  forecastHorizon?: number | null; // the question's horizon (as in the evidence record); 7 when none
  variableLabel?: string;
  /** Shared with the chart (linked forecast days); without onCursor the card keeps its own state. */
  cursor?: SkillCursor | null;
  onCursor?: (c: SkillCursor | null) => void;
}) {
  // Every hook runs on every render, before any early return.
  const [open, setOpen] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(760);
  const [localDay, setLocalDay] = useState<number | null>(null);
  // A touch on the plot: where it started, so a scroll that starts there is not read as a tap.
  const touchRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const uid = useId().replace(/:/g, "");
  const linked = onCursor !== undefined;
  // The day this card is pointing at (full readout), and a day the chart is pointing at (echo only).
  const cardDay = linked ? (cursor?.from === "card" ? cursor.day : null) : localDay;
  const chartDay = linked && cursor?.from === "chart" ? cursor.day : null;
  const setActive = (d: number | null) => {
    if (linked) onCursor!(d == null ? null : { day: d, from: "card" });
    else setLocalDay(d);
  };

  // Real-pixel width of the card, so text stays 12-13.5 px at every screen size.
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const cw = Math.round(el.clientWidth);
      if (cw > 0) setW((prev) => (prev === cw ? prev : cw));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  // A tap outside the card clears the active day (listener only while one is active).
  useEffect(() => {
    if (cardDay == null || !el) return;
    const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node)) setActive(null); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [cardDay, el]); // setActive only forwards to onCursor / setLocalDay

  if (!SKILL_CARD_ENABLED) return null;
  if (!forecast?.length) return null; // no forecast plotted: nothing to score
  const label = variableLabel || SKILL_VARIABLE_LABEL[variable] || variable;
  const sk = getForecastSkill(site, variable, depthM, forecastHorizon);

  if (!sk) {
    return (
      <div style={{ marginTop: 22, fontFamily: "var(--sans)" }}>
        <div style={EYEBROW}>{label} forecast skill</div>
        <div style={{ ...RULES, marginTop: 8, padding: "13px 0 14px", display: "flex", gap: 12, alignItems: "center" }}>
          <svg width={34} height={22} viewBox="0 0 34 22" aria-hidden style={{ flex: "none" }}>
            <line x1={1} x2={33} y1={11} y2={11} stroke={C.zero} strokeWidth={1} strokeDasharray="2 3" />
            <circle cx={17} cy={11} r={4} fill="#fff" stroke={C.ci} strokeWidth={1.4} strokeDasharray="2 2" />
          </svg>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: C.muted, lineHeight: 1.45 }}>
              Forecast skill: not scored {skillGapPhrase(site, variable, depthM)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const L = layoutSkillPlot({ days: sk.days, horizon: sk.horizon, width: w });
  const day1 = skillDay1Ms(forecast);
  const verdict = skillVerdict(sk.days);
  const unscoredNote = skillUnscoredNote(sk.horizon);
  const act = cardDay != null && cardDay >= 1 && cardDay <= L.axisDays ? cardDay : null;
  const echo = chartDay != null && chartDay >= 1 && chartDay <= L.axisDays ? chartDay : null;
  const readout = act != null ? skillReadout(sk, act, day1) : null;
  const classes = (["more", "same", "less"] as SkillClass[]).filter((c) => sk.days.some((d) => skillClass(d) === c));
  const clampDay = (d: number) => Math.min(L.axisDays, Math.max(1, d));
  // Reserve the readout's tallest state so the plot never jumps while the cursor moves.
  const longest = Math.max(
    verdict.length + (unscoredNote ? unscoredNote.length + 1 : 0),
    ...Array.from({ length: L.axisDays }, (_, i) => skillReadout(sk, i + 1, day1).length),
  );
  const readoutLines = Math.max(1, Math.ceil((longest * 6.9) / Math.max(120, L.width)));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = act;
    let next: number | null | undefined;
    switch (e.key) {
      case "ArrowRight": case "ArrowUp": next = cur == null ? 1 : clampDay(cur + 1); break;
      case "ArrowLeft": case "ArrowDown": next = cur == null ? 1 : clampDay(cur - 1); break;
      case "PageUp": next = clampDay((cur ?? 0) + 7); break;
      case "PageDown": next = clampDay((cur ?? 1) - 7); break;
      case "Home": next = 1; break;
      case "End": next = L.axisDays; break;
      case "Escape": next = null; break;
      default: return;
    }
    e.preventDefault();
    setActive(next);
  };
  // Pointer position -> axis day, in the SVG's own pixels.
  const dayFromPointer = (e: ReactPointerEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    const rect = svg?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    return L.dayAt(((e.clientX - rect.left) / rect.width) * L.width);
  };

  const plotRight = L.width - L.padR;
  const zeroRight = L.strip ? L.strip.x0 : plotRight;

  return (
    <div ref={setEl} className="skill-card" style={{ marginTop: 22, fontFamily: "var(--sans)", position: "relative" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", columnGap: 10, rowGap: 2 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={EYEBROW}>{label} forecast skill</span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={`${uid}-how`}
            aria-label="How forecast skill is calculated"
            style={{ alignSelf: "center", flex: "none", width: 24, height: 24, borderRadius: "50%", border: "none", background: open ? "rgba(26,26,24,0.06)" : "transparent", color: open ? C.ink : C.muted, lineHeight: 0, padding: 0, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="info" size={16} />
          </button>
        </span>
        <span style={{ whiteSpace: "nowrap", fontSize: 12.5, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
          vs climatology &middot; {SKILL_SCORED_SCOPE}
        </span>
      </div>

      <div style={{ ...RULES, marginTop: 8, padding: "10px 0 6px" }}>
        <p aria-live="polite" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.4, color: C.ink, minHeight: Math.ceil(readoutLines * 13.5 * 1.4), fontVariantNumeric: "tabular-nums" }}>
          {readout ?? (
            <>
              {verdict}
              {unscoredNote ? <span style={{ color: C.muted }}> {unscoredNote}</span> : null}
            </>
          )}
        </p>
        <div
          role="slider"
          tabIndex={0}
          className="skill-slider"
          aria-label={`${label} forecast skill by forecast day`}
          aria-valuemin={1}
          aria-valuemax={L.axisDays}
          aria-valuenow={act ?? 1}
          aria-valuetext={readout ?? `${verdict}${unscoredNote ? ` ${unscoredNote}` : ""}`}
          onKeyDown={onKeyDown}
          onBlur={() => { if (cardDay != null) setActive(null); }}
          style={{ marginTop: 4 }}
        >
          <svg
            aria-hidden
            width={L.width}
            height={L.height}
            viewBox={`0 0 ${L.width} ${L.height}`}
            style={{ display: "block", maxWidth: "100%", overflow: "visible", fontFamily: SVG_FONT, fontVariantNumeric: "tabular-nums" }}
          >
            {L.strip && (
              <defs>
                <pattern id={`${uid}-hatch`} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1={0} y1={0} x2={0} y2={6} stroke={C.hatch} strokeWidth={1} />
                </pattern>
              </defs>
            )}
            {/* hover column, behind everything */}
            {act != null && (() => { const col = L.colAt(act); return <rect data-transient="" x={col.x0} y={0} width={col.w} height={L.plotH} fill={C.hover} />; })()}
            {/* y axis as on a paper figure: spine, outward ticks, plain numbers, rotated title */}
            <line x1={L.padL} x2={L.padL} y1={L.ticks[L.ticks.length - 1].y} y2={L.plotH} stroke={C.axis} strokeWidth={1} />
            {L.ticks.map((t) => (
              <g key={`t${t.v}`}>
                <line x1={L.padL - 4.5} x2={L.padL} y1={t.y} y2={t.y} stroke={C.axis} strokeWidth={1} />
                {t.label && (
                  <text x={L.padL - 7} y={t.y + 4} textAnchor="end" fontSize={L.fs.tick} fill={C.tickText}>{t.label}</text>
                )}
              </g>
            ))}
            <text transform={`translate(12 ${(L.ticks[L.ticks.length - 1].y + L.plotH) / 2}) rotate(-90)`} textAnchor="middle" fontSize={L.fs.title} fontWeight={600} fill={C.ink}>CRPSS (%)</text>
            {/* days past the record: hatched, never a value */}
            {L.strip && (
              <g>
                <rect x={L.strip.x0} y={0} width={L.strip.x1 - L.strip.x0} height={L.plotH} fill={`url(#${uid}-hatch)`} />
                {(() => {
                  const cx = (L.strip.x0 + L.strip.x1) / 2, cy = L.plotH / 2;
                  return L.strip.chip ? (
                    <g>
                      <rect x={cx - 35} y={cy - 10} width={70} height={19} rx={3} fill="#fff" />
                      <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fill={C.muted}>not scored</text>
                    </g>
                  ) : (
                    <g transform={`translate(${cx + 4} ${cy}) rotate(-90)`}>
                      <rect x={-35} y={-13} width={70} height={18} rx={3} fill="#fff" />
                      <text x={0} y={0} textAnchor="middle" fontSize={12} fill={C.muted}>not scored</text>
                    </g>
                  );
                })()}
                {L.strip.label && (
                  <text x={(L.strip.x0 + L.strip.x1) / 2} y={L.dayY} textAnchor="middle" fontSize={L.fs.day} fill={C.muted}>{L.strip.label}</text>
                )}
              </g>
            )}
            {/* zero = as skilful as climatology; when the axis starts at 0 the x axis is the zero line */}
            {L.ticks[0].v < 0 && <line x1={L.padL} x2={zeroRight} y1={L.y(0)} y2={L.y(0)} stroke={C.zero} strokeWidth={1} />}
            {/* CI lines, then marks, then values */}
            {L.marks.map((m) => {
              const on = m.day === act;
              return (
                <g key={`m${m.day}`}>
                  <line x1={m.x} x2={m.x} y1={m.yHi} y2={m.yLo} stroke={C.ci} strokeWidth={1.5} strokeLinecap="round" />
                  <Mark cls={m.cls} x={m.x} y={m.y} r={on ? L.markR + 1 : L.markR} />
                  {m.beside && (
                    <text x={m.beside.x} y={m.beside.y} textAnchor={m.beside.anchor} fontSize={L.fs.value} fontWeight={500} fill={C.ink}
                      stroke={on ? C.hover : "#fff"} strokeWidth={3} strokeLinejoin="round" paintOrder="stroke">{m.label}</text>
                  )}
                </g>
              );
            })}
            {/* echo of a day pointed at on the chart: a hairline and a ring, nothing else */}
            {echo != null && (() => {
              const ex = L.x(echo), m = L.marks.find((mm) => mm.day === echo);
              return (
                <g data-transient="" pointerEvents="none">
                  <line x1={ex} x2={ex} y1={0} y2={L.plotH} stroke={C.hairline} strokeWidth={1} />
                  {m && <circle cx={m.x} cy={m.y} r={L.markR + 3.5} fill="none" stroke={C.ink} strokeWidth={1.2} />}
                </g>
              );
            })()}
            {/* x axis: spine with outward ticks, longer at labelled days */}
            <line x1={L.padL} x2={plotRight} y1={L.plotH} y2={L.plotH} stroke={C.axis} strokeWidth={1} />
            {L.marks.map((m) => (
              <line key={`xt${m.day}`} x1={m.x} x2={m.x} y1={L.plotH} y2={L.plotH + (L.dayLabels.some((d) => d.day === m.day) ? 4.5 : 2.5)} stroke={C.axis} strokeWidth={1} />
            ))}
            {L.dayLabels.map((d) => (
              <text key={`d${d.day}`} x={d.x} y={L.dayY} textAnchor="middle" fontSize={L.fs.day} fill={C.tickText} fontWeight={d.day === act ? 600 : 400}>{d.day}</text>
            ))}
            {L.valueMode !== "beside" && L.marks.filter((m) => L.valueDays.includes(m.day)).map((m) => (
              <text key={`v${m.day}`} x={m.vx} y={L.valY} textAnchor="middle" fontSize={L.fs.valueRow} fontWeight={m.day === act ? 600 : 500} fill={C.ink}>{m.label}</text>
            ))}
            <text x={L.padL + L.plotW / 2} y={L.titleY} textAnchor="middle" fontSize={L.fs.title} fontWeight={600} fill={C.ink}>Forecast day</text>
            {/* pointer target over the plot */}
            <rect
              x={L.padL} y={0} width={L.plotW} height={L.plotH} fill="transparent"
              style={{ touchAction: "pan-y", cursor: "crosshair" }}
              onPointerMove={(e) => {
                if (e.pointerType === "mouse") { const d = dayFromPointer(e); if (d != null && d !== act) setActive(d); return; }
                const t = touchRef.current;
                if (t && t.id === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) touchRef.current = null;
              }}
              onPointerLeave={(e) => { if (e.pointerType === "mouse" && cardDay != null) setActive(null); }}
              onPointerDown={(e) => {
                if (e.pointerType !== "mouse") touchRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
              }}
              onPointerCancel={() => { touchRef.current = null; }}
              onPointerUp={(e) => {
                // A tap (finger lifted within 8 px, no scroll) sets the day; the same day again clears it.
                const t = touchRef.current;
                touchRef.current = null;
                if (e.pointerType === "mouse" || !t || t.id !== e.pointerId || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) return;
                const d = dayFromPointer(e);
                if (d != null) setActive(d === act ? null : d);
              }}
            />
          </svg>
        </div>
        <table style={SR_ONLY}>
          <caption>{`${label} forecast skill, FCR ${SKILL_META.depth_m} m, vs climatology. ${verdict}${unscoredNote ? ` ${unscoredNote}` : ""}`}</caption>
          <thead>
            <tr><th scope="col">Forecast day</th><th scope="col">CRPSS (%)</th><th scope="col">95% CI</th><th scope="col">Compared with climatology</th></tr>
          </thead>
          <tbody>
            {sk.days.map((d) => (
              <tr key={d.day}>
                <th scope="row">{d.day}</th>
                <td>{fmtSkillPct(d.crpss)}</td>
                <td>{`${fmtSkillNum(d.lo)} to ${fmtSkillNum(d.hi)}`}</td>
                <td>{SKILL_CLASS_PHRASE[skillClass(d)].full}</td>
              </tr>
            ))}
            {sk.unscored && (
              <tr><th scope="row">{`${sk.unscored.from}–${sk.unscored.to}`}</th><td colSpan={3}>not scored</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 16px", marginTop: 9, fontSize: 12, color: C.muted }}>
        {classes.map((c) => (
          <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden style={{ flex: "none" }}><Mark cls={c} x={6} y={6} r={4} /></svg>
            {KEY_TEXT[c]}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
          <svg width={18} height={10} viewBox="0 0 18 10" aria-hidden style={{ flex: "none" }}><line x1={0} x2={18} y1={5} y2={5} stroke={C.zero} strokeWidth={1} /></svg>
          0 = as skilful as climatology
        </span>
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
        Dot: skill (CRPSS) of past FLARE forecasts vs climatology; line: 95% CI. Record frozen at {SKILL_RECORD_THROUGH}.
      </div>

      {open && (
        <div id={`${uid}-how`} style={{ marginTop: 12, border: "1px solid #e6e2d8", borderRadius: 8, background: "#fff", padding: "12px 14px" }}>
          <h4 style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, letterSpacing: ".08em", textTransform: "uppercase", color: C.muted, margin: "0 0 7px" }}>
            Forecast skill — how it&apos;s calculated
          </h4>
          <p style={{ fontSize: 13.5, color: "#3d3b36", margin: "0 0 9px", lineHeight: 1.55 }}>
            How FLARE&apos;s <b style={{ color: C.ink }}>past</b> forecasts compared with climatology (the historical average for that day of the year) on each forecast day, at {SKILL_SCORED_SCOPE}. Above 0 = more skilful than climatology; below 0 = less skilful.
          </p>
          <p style={{ fontSize: 13.5, color: "#3d3b36", margin: "0 0 9px", lineHeight: 1.55 }}>
            Each line is the 95% confidence interval. An open dot means the range crosses 0: on that day FLARE may be no better than climatology.
          </p>
          <p style={{ fontSize: 13.5, color: "#3d3b36", margin: "0 0 9px", lineHeight: 1.55 }}>
            This is the model&apos;s <b style={{ color: C.ink }}>track record</b>, not a score of today&apos;s forecast.
          </p>
          <p style={{ fontFamily: "var(--mono)", fontSize: 12, color: "#5f5f58", borderTop: `1px solid ${C.grid}`, paddingTop: 7, margin: 0, lineHeight: 1.5 }}>
            CRPSS &middot; {SKILL_META.model} vs {SKILL_META.baseline} &middot; paired by date, each forecast counted once &middot; 95% CI: {SKILL_META.ci.block_days}-day block bootstrap &middot; {fmtSkillDate(sk.coverage.from)} – {SKILL_RECORD_THROUGH}
          </p>
        </div>
      )}
    </div>
  );
}
