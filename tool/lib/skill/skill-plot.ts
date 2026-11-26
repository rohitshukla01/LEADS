// Pure geometry for the Forecast skill "dot & interval" plot: one column per forecast day,
// a 95% CI line, and a mark whose shape carries the CI class (filled circle = more skilful,
// open circle = not distinguishable, grey square = less skilful). The card
// (components/ForecastSkillCard.tsx) draws it at real pixels; the PDF (lib/report.ts) reuses
// skillScale() so the printed axis matches the screen. No DOM, no window, no state.

import { niceTicks } from "../insights";
import { fmtSkillPct, skillClass, SKILL_MAX_DAY, type DaySkill, type SkillClass } from "./forecast-skill";

/** The card's only colours (hex, not CSS variables, so a rasterised copy keeps them). */
export const SKILL_PLOT_COLORS = {
  ink: "#1a1a18",
  muted: "#54544e",
  ci: "#8f8b81",
  less: "#77736c",
  grid: "#eceae4",
  hover: "#f5f3ee",
  hatch: "#e8e4da",
  zero: "rgba(26,26,24,0.50)",
  rule: "rgba(26,26,24,0.72)",
  hairline: "rgba(120,113,108,0.45)",
  axis: "#1a1a18",       // axis spines and ticks, as on the forecast chart above
  tickText: "#33332f",   // tick numbers, as on the forecast chart
} as const;

/** Axis label as on a paper figure (the axis title carries the unit): "60", "0", "−40" (U+2212). */
export const skillTickLabel = (v: number): string => (v < 0 ? `−${Math.abs(v)}` : String(v));

/** y axis shared by the screen and the PDF: always includes 0 and every CI bound. */
export function skillScale(days: DaySkill[]): { ticks: number[]; yLo: number; yHi: number } {
  const lo = Math.min(0, ...days.map((d) => d.lo));
  const hi = Math.max(0, ...days.map((d) => d.hi));
  const ticks = niceTicks(lo, hi, hi - lo > 90 ? 5 : 4);
  return { ticks, yLo: ticks[0], yHi: ticks[ticks.length - 1] };
}

/** Estimated rendered width (px) of a short tabular label such as "+62%" or "−7%". */
export const skillLabelWidth = (text: string, fs: number): number => (0.6 * text.length + 0.25) * fs;

/** Keep values in order whose positions are at least `gap` apart; the last one always stays. */
function thin(items: number[], pos: (k: number) => number, gap: number): number[] {
  const kept: number[] = [];
  for (const k of items) {
    if (kept.length && pos(k) - pos(kept[kept.length - 1]) < gap) {
      if (k === items[items.length - 1]) kept[kept.length - 1] = k;
      continue;
    }
    kept.push(k);
  }
  return kept;
}

export type SkillMark = {
  day: number; x: number; y: number; yLo: number; yHi: number; cls: SkillClass; label: string;
  /** Value placement when values sit beside the marks. */
  beside: { x: number; y: number; anchor: "start" | "end" } | null;
  /** Centre of the value in the value row, kept inside the card. */
  vx: number;
};

export type SkillPlotLayout = {
  width: number; height: number; narrow: boolean;
  padL: number; padR: number; plotH: number; plotW: number;
  /** Scored days shown (1..D) and the axis length (D, or up to 35 when days past 21 were asked for). */
  D: number; axisDays: number; colW: number;
  x: (day: number) => number;
  y: (v: number) => number;
  /** Nearest axis day (1..axisDays) to an x position. */
  dayAt: (px: number) => number;
  /** The column a day occupies (scored days: colW wide; days past 21 share the strip). */
  colAt: (day: number) => { x0: number; w: number };
  ticks: { v: number; y: number; label: string | null }[];
  dayLabels: { day: number; x: number }[];
  valueMode: "beside" | "row" | "sparse";
  /** Days whose value is printed in the value row ("row": all; "sparse": the labelled days). */
  valueDays: number[];
  marks: SkillMark[];
  /** Days past 21: a narrow hatched zone after day 21 (x0 = x(21.5)); `chip` when a
   *  horizontal "not scored" label fits, otherwise the label runs vertically. */
  strip: { x0: number; x1: number; chip: boolean; from: number; to: number; label: string | null } | null;
  dayY: number; valY: number; titleY: number;
  /** Font sizes (px); none is under 12. */
  fs: { tick: number; day: number; value: number; valueRow: number; title: number };
  markR: number;
};

/**
 * Layout of the plot at `width` px for days 1..D (D = days.length) of a question with horizon
 * H. When H > 21, days 22..H are a narrow hatched "not scored" zone after day 21 that never
 * carries a value; it is kept narrow so the 21 scored days keep their full value row. The
 * keyboard and pointer still reach days 22..min(H, 35), which read "not scored".
 */
export function layoutSkillPlot(o: { days: DaySkill[]; horizon: number; width: number }): SkillPlotLayout {
  const { days, horizon } = o;
  const width = Math.max(200, Math.round(o.width));
  const narrow = width < 520;
  const fs = { tick: 12, day: 12, value: 12.5, valueRow: 12, title: 12 };
  const padL = 52, padR = narrow ? 6 : 10;   // room for the rotated y-axis title (centred at x = 12) and "−40" tick labels
  const plotW = width - padL - padR;
  const D = days.length;
  const unscored = horizon > SKILL_MAX_DAY && D === SKILL_MAX_DAY;
  const axisDays = Math.max(1, unscored ? Math.min(horizon, 35) : D);
  const stripW = unscored ? Math.round(Math.min(64, Math.max(40, plotW * 0.06))) : 0;
  const scoredW = plotW - stripW;
  const slots = Math.max(D, 3);
  const colW = scoredW / slots;
  const c = (1 + D) / 2;
  const nStrip = axisDays - D;
  const xScored = (day: number) => padL + scoredW * ((day - c) / slots + 0.5);
  const x = (day: number) => (day <= D + 0.5 || !nStrip ? xScored(day) : padL + scoredW + ((day - D - 0.5) / nStrip) * stripW);
  const colAt = (day: number) => (day <= D || !nStrip
    ? { x0: xScored(day) - colW / 2, w: colW }
    : { x0: padL + scoredW + ((day - D - 1) / nStrip) * stripW, w: stripW / nStrip });
  const dayAt = (px: number) => {
    if (nStrip && px > padL + scoredW) return Math.min(axisDays, D + 1 + Math.floor(((px - padL - scoredW) / stripW) * nStrip));
    return Math.min(D, Math.max(1, Math.round(c + ((px - padL) / scoredW - 0.5) * slots)));
  };

  const markR = colW >= 11 ? 4 : 3.2;   // marks never touch at 21 days on a 260 px phone
  const plotH = narrow ? 132 : D > 7 ? 164 : 140;
  const { ticks: tv, yLo, yHi } = skillScale(days);
  // 10 px above the top tick (its label clears the verdict line); the bottom tick sits on the x axis.
  const PT = 10, PB = 0;
  const y = (v: number) => PT + (plotH - PT - PB) * ((yHi - v) / ((yHi - yLo) || 1));
  const tickGap = tv.length > 1 ? (plotH - PT - PB) / (tv.length - 1) : plotH;
  const zeroIdx = tv.indexOf(0);
  // Every tick is labelled when there is room; otherwise every other tick counting from 0,
  // plus the top tick (above the highest dot) whenever its gap clears two 12 px labels.
  const ticks = tv.map((v, i) => ({
    v, y: y(v),
    label: tickGap >= 24 || (i - (zeroIdx < 0 ? 0 : zeroIdx)) % 2 === 0 || (i === tv.length - 1 && tickGap >= 14)
      ? skillTickLabel(v) : null,
  }));

  // Day numbers: every day when columns are at least 26 px, otherwise 1, 7, 14, 21 and D.
  const scoredDays = days.map((d) => d.day);
  const every = colW >= 26;
  const candidates = every ? scoredDays : [...new Set([1, 7, 14, 21, D])].filter((k) => k >= 1 && k <= D).sort((a, b) => a - b);
  const labelled = every ? scoredDays : thin(candidates, x, 22);
  const dayLabels = labelled.map((day) => ({ day, x: x(day) }));

  // Values: beside the mark when the column is at least 64 px wide (desktop, about a week);
  // otherwise a row under the day numbers, every day if they fit, else the labelled days only.
  const labels = days.map((d) => fmtSkillPct(d.crpss));
  const widest = Math.max(0, ...labels.map((t) => skillLabelWidth(t, fs.valueRow)));
  const valueMode: SkillPlotLayout["valueMode"] = colW >= 64 ? "beside" : widest + 2 <= colW ? "row" : "sparse";
  const valueDays = valueMode === "row" ? scoredDays : valueMode === "sparse" ? thin(labelled, x, widest + 6) : [];

  const y0 = y(0);
  const marks: SkillMark[] = days.map((d, i) => {
    const cx = x(d.day), cy = y(d.crpss);
    let beside: SkillMark["beside"] = null;
    if (valueMode === "beside") {
      const w = skillLabelWidth(labels[i], fs.value);
      const right = cx + markR + 8;
      const anchor = right + w > width - 1 ? "end" : "start";
      const ly = Math.abs(cy - y0) < 9 ? (cy <= y0 ? y0 - 5 : y0 + 13) : cy + 4.2;
      beside = { x: anchor === "start" ? right : cx - markR - 8, y: ly, anchor };
    }
    const vw = skillLabelWidth(labels[i], fs.valueRow);
    const vx = Math.min(Math.max(cx, vw / 2 + 1), width - vw / 2 - 1);
    return { day: d.day, x: cx, y: cy, yLo: y(d.lo), yHi: y(d.hi), cls: skillClass(d), label: labels[i], beside, vx };
  });

  // The strip's day-row label ("22–30") only when it clears the last day number.
  const strip = unscored
    ? (() => {
        const x0 = padL + scoredW, x1 = width - padR, from = SKILL_MAX_DAY + 1;
        const text = horizon > from ? `${from}\u2013${horizon}` : `${from}`;
        const lastLab = dayLabels[dayLabels.length - 1];
        const half = skillLabelWidth(text, fs.day) / 2;
        const fits = half * 2 <= x1 - x0 + 4 && (!lastLab || (x0 + x1) / 2 - half - (lastLab.x + skillLabelWidth(String(lastLab.day), fs.day) / 2) >= 6);
        return { x0, x1, chip: stripW >= 74, from, to: horizon, label: fits ? text : null };
      })()
    : null;

  const dayY = plotH + 17, valY = plotH + 35;
  const titleY = (valueMode === "beside" ? dayY : valY) + 20;
  return {
    width, height: titleY + 6, narrow, padL, padR, plotH, plotW, D, axisDays, colW, x, y, dayAt, colAt,
    ticks, dayLabels, valueMode, valueDays, marks, strip, dayY, valY, titleY, fs, markR,
  };
}
