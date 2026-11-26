// Pure, client-safe lookup for the "Forecast skill" record. The card
// (components/ForecastSkillCard.tsx), the PDF section (lib/report.ts) and the evidence
// record (lib/leads/orchestrator.ts) all read it through getForecastSkill(), so they always
// agree. The data is a static record (./forecast-skill.json) built offline by
// scripts/build-skill-table.py; nothing here fetches or computes a score at runtime.
//
// The record: CRPSS (%) of glm_aed_flare_v3 against climatology at FCR 1.6 m, per forecast
// day 1..21, each past forecast pair counted once and pooled over every scored forecast,
// with a 95% block-bootstrap CI. Values are stored to 2 decimals and shown as whole percent,
// matching the paper's Fig. 4d labels.

import table from "./forecast-skill.json";
import { VARIABLE_META } from "../insights";

export type DaySkill = { day: number; crpss: number; lo: number; hi: number; n: number };
/** 95% CI wholly above 0 | includes 0 | wholly below 0. */
export type SkillClass = "more" | "same" | "less";

export interface ForecastSkill {
  site: string;
  variable: string;
  depthM: number;
  /** The horizon asked for (7 when the question gives none); may exceed SKILL_MAX_DAY. */
  horizon: number;
  /** Days 1..min(horizon, SKILL_MAX_DAY). */
  days: DaySkill[];
  /** Days asked for beyond the record (22..horizon), or null. */
  unscored: { from: number; to: number } | null;
  /** First issue date to last target date of the pairs behind the record. */
  coverage: { from: string; to: string };
}

/** Provenance/meta for the card's info panel, the PDF caption and the checks. */
export const SKILL_META = table.meta;
export const SKILL_MAX_DAY: number = table.meta.max_day;
export const SKILL_DEFAULT_DAYS: number = table.meta.default_days;

type VarRecord = { coverage: { from: string; to: string }; runs: number; days: DaySkill[] };
const RAW = table as unknown as Record<string, Record<string, VarRecord>>;
const SCORED_SITES = Object.keys(table).filter((k) => k !== "meta");

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * A variable's days count only when complete and well-formed: exactly SKILL_MAX_DAY days,
 * day === i+1, finite values, lo <= crpss <= hi and an integer n > 0. Anything else is
 * treated as "not scored" (fail soft), never an exception.
 */
export function validateSkillDays(days: unknown): DaySkill[] | null {
  try {
    if (!Array.isArray(days) || days.length !== SKILL_MAX_DAY) return null;
    const ok = days.every((x: DaySkill, i) => !!x && x.day === i + 1 && fin(x.crpss) && fin(x.lo) && fin(x.hi) &&
      x.lo <= x.crpss && x.crpss <= x.hi && Number.isInteger(x.n) && x.n > 0);
    return ok ? (days as DaySkill[]) : null;
  } catch {
    return null;
  }
}

// Gate
// The record is scored at one depth (meta.depth_m) for the sites it lists. A 9 m or
// full-profile forecast must not be shown, or given to the answer as evidence, the
// surface score; an unknown depth fails closed. The gate enforces the record's own
// metadata for every caller; nothing here names a question or a value.

/** FLARE layers sit exactly on the sensor depths (lib/leads/guardrails.ts
 *  DEPTH_ZONE_MAPPING, 0.000 m gap), so this only absorbs float noise; it never lets a
 *  neighbouring layer borrow the scored depth's record. */
export const SKILL_DEPTH_TOLERANCE_M = 0.05;

/** True only for a known depth within tolerance of the record's scored depth. */
export function isScoredDepth(depthM: number | null | undefined): boolean {
  return fin(depthM) && Math.abs(depthM - SKILL_META.depth_m) <= SKILL_DEPTH_TOLERANCE_M;
}

/**
 * The single depth a plan's skill lookup may use. Fails closed (null) for a full-profile
 * decision (its resolvedDepthsM is [] by construction) and for anything other than exactly
 * one resolved depth.
 */
export function resolveSkillDepth(depthsM: number[] | null | undefined, fullProfile: boolean): number | null {
  if (fullProfile || !depthsM || depthsM.length !== 1) return null;
  return Number.isFinite(depthsM[0]) ? depthsM[0] : null;
}

/** Days to show: a finite horizon >= 1 (floored), else 7. Not capped: days past 21 are "not scored". */
export function resolveSkillHorizon(h?: number | null): number {
  return fin(h) && h >= 1 ? Math.floor(h) : SKILL_DEFAULT_DAYS;
}

/**
 * The skill record for a forecast, or null when none applies: an unscored site (BVR), a
 * depth other than the scored one, an unknown or multi-depth / full-profile depth, an
 * unscored variable, or a malformed record. Never throws.
 */
export function getForecastSkill(
  site: string | null | undefined,
  variable: string | null | undefined,
  depthM: number | null | undefined,
  horizon?: number | null,
): ForecastSkill | null {
  try {
    if (!site || !variable || !isScoredDepth(depthM)) return null;
    const rec = RAW[site.toLowerCase()]?.[variable];
    const all = validateSkillDays(rec?.days);
    if (!rec || !all) return null;
    const H = resolveSkillHorizon(horizon);
    return {
      site: site.toLowerCase(),
      variable,
      depthM: SKILL_META.depth_m,
      horizon: H,
      days: all.slice(0, Math.min(H, SKILL_MAX_DAY)),
      unscored: H > SKILL_MAX_DAY ? { from: SKILL_MAX_DAY + 1, to: H } : null,
      coverage: { from: String(rec.coverage?.from ?? ""), to: String(rec.coverage?.to ?? "") },
    };
  } catch {
    return null;
  }
}

/** Classified on the stored 2-decimal values (no CI bound lies within ±0.5, so the rounded
 *  CI shown never contradicts the class). */
export const skillClass = (d: DaySkill): SkillClass => (d.lo > 0 ? "more" : d.hi < 0 ? "less" : "same");

/** One wording everywhere: [full phrase, short phrase]. */
export const SKILL_CLASS_PHRASE: Record<SkillClass, { full: string; short: string }> = {
  more: { full: "more skilful than climatology", short: "more skilful" },
  same: { full: "not distinguishable from climatology", short: "not distinguishable" },
  less: { full: "less skilful than climatology", short: "less skilful" },
};

/** Whole-percent label from the stored value: "+62%", "−7%" (U+2212), "0%"; ascii for jsPDF. */
export function fmtSkillPct(v: number, ascii = false): string {
  const r = Math.round(v) || 0;
  return (r > 0 ? "+" : r < 0 ? (ascii ? "-" : "−") : "") + Math.abs(r) + "%";
}

/** A CI bound: "51", "−26" (U+2212), "0"; ascii for jsPDF and the evidence record. */
export function fmtSkillNum(v: number, ascii = false): string {
  const r = Math.round(v) || 0;
  return (r < 0 ? (ascii ? "-" : "−") : "") + Math.abs(r);
}

/** "day 8", "days 1–7" (en dash, CP1252-safe for the PDF). */
const daySpan = (a: number, b: number) => (a === b ? `day ${a}` : `days ${a}–${b}`);

/** Runs of consecutive days with the same class. */
export function skillRuns(days: DaySkill[]): { cls: SkillClass; from: number; to: number }[] {
  const runs: { cls: SkillClass; from: number; to: number }[] = [];
  for (const d of days) {
    const c = skillClass(d), last = runs[runs.length - 1];
    if (last && last.cls === c && last.to === d.day - 1) last.to = d.day;
    else runs.push({ cls: c, from: d.day, to: d.day });
  }
  return runs;
}

/** e.g. "More skilful than climatology on days 1–8; not distinguishable on days 9–21." */
export function skillVerdict(days: DaySkill[]): string {
  const runs = skillRuns(days);
  if (!runs.length) return "";
  const s = runs
    .map((r, i) => `${i === 0 ? SKILL_CLASS_PHRASE[r.cls].full : SKILL_CLASS_PHRASE[r.cls].short} on ${daySpan(r.from, r.to)}`)
    .join("; ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** "Days 22–30 are not scored." / "Day 22 is not scored." / "" when h <= 21. */
export function skillUnscoredNote(h?: number | null): string {
  const H = resolveSkillHorizon(h);
  if (H <= SKILL_MAX_DAY) return "";
  return H === SKILL_MAX_DAY + 1 ? `Day ${H} is not scored.` : `Days ${SKILL_MAX_DAY + 1}–${H} are not scored.`;
}

/** Plain labels for the scored variables, from the chart's VARIABLE_META. */
export const SKILL_VARIABLE_LABEL: Record<string, string> = Object.fromEntries(
  Object.keys(RAW[table.meta.site] ?? {}).map((v) => [v, VARIABLE_META[v]?.label ?? v]),
);

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-14" -> "14 Oct 2026" (UTC, so it never drifts with the viewer's timezone). */
export function fmtSkillDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** The record's last target date, e.g. "14 Oct 2026". */
export const SKILL_RECORD_THROUGH = fmtSkillDate(SKILL_META.record_through);

/** Issue (reference) date of a chart forecast. FLARE days start at lead 1 (horizon 0 is
 *  the assimilation window and is dropped by lib/leads/flare-reader.ts), so the first
 *  plotted target date is the reference date + 1 day. */
export function referenceDateFromDay1(day1ISO: string | null | undefined): string | null {
  if (!day1ISO) return null;
  const t = new Date(day1ISO).getTime();
  return Number.isNaN(t) ? null : new Date(t - 86_400_000).toISOString();
}

// Labels and fixed wording, shared by the card, the PDF and the evidence record

const SITE_LABEL: Record<string, string> = { fcre: "FCR", bvre: "BVR" };
export const skillSiteLabel = (site: string | null | undefined): string =>
  site ? SITE_LABEL[site.toLowerCase()] ?? site.toUpperCase() : "this site";
export const skillDepthLabel = (depthM: number): string => `${Number(depthM.toFixed(2))} m`;

/** Where the record is scored, from its own keys and meta, e.g. "FCR 1.6 m". */
export const SKILL_SCORED_SCOPE =
  `${SCORED_SITES.map((s) => skillSiteLabel(s)).join("/")} ${skillDepthLabel(SKILL_META.depth_m)}`;

/** Depth phrase for the no-record disclosure: "at 9 m", "across the full water column",
 *  or "at an unresolved depth". */
export function skillDepthPhrase(depthM: number | null | undefined, fullProfile = false): string {
  if (fullProfile) return "across the full water column";
  return fin(depthM) ? `at ${skillDepthLabel(depthM)}` : "at an unresolved depth";
}

/** Why there is no record, for the greyed card/PDF slot: "at BVR", "at 9 m", "for turbidity". */
export function skillGapPhrase(
  site: string | null | undefined,
  variable: string | null | undefined,
  depthM: number | null | undefined,
  fullProfile = false,
): string {
  if (!site || !SCORED_SITES.includes(site.toLowerCase())) return `at ${skillSiteLabel(site)}`;
  if (fullProfile || !isScoredDepth(depthM)) return skillDepthPhrase(depthM, fullProfile);
  return `for ${variable ? (VARIABLE_META[variable]?.label ?? variable).toLowerCase() : "this variable"}`;
}

/** Sign definition, printed wherever a CRPSS value is. */
export const CRPSS_SIGN_NOTE =
  "Negative CRPSS means less skilful than climatology; it does not show whether the forecast runs high or low.";

/** Deterministic disclosure for a forecast with no applicable record. */
export function skillNoRecordText(
  site: string | null | undefined,
  variable: string | null | undefined,
  depthM: number | null | undefined,
  fullProfile = false,
): string {
  return (
    `No historical skill record exists for ${skillSiteLabel(site)} ${variable ?? "this variable"} ` +
    `${skillDepthPhrase(depthM, fullProfile)} (FLARE is scored only at ${SKILL_SCORED_SCOPE}). ` +
    `How well forecasts like this have performed is unknown; agreement among ensemble members ` +
    `or a narrow spread is not evidence of accuracy.`
  );
}

/** "day 8", "days 8–21", "days 3–4 and 8–21" for a sorted set of day numbers. */
function dayList(nums: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    runs.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j + 1;
  }
  const head = nums.length > 1 ? "days" : "day";
  return `${head} ${runs.length > 1 ? `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}` : runs[0]}`;
}

/**
 * The forecast-skill evidence record the orchestrator injects. Always returns text: the
 * scored record when the gate passes, otherwise the no-record disclosure, so the answer is
 * never left to infer accuracy from ensemble agreement. The verdict comes first so it
 * survives every display cut; numbers use an ASCII minus. The prefix is FORECAST SKILL
 * RECORD, not FLARE, because LEADS computes this record from past scores; it is not a FLARE
 * forecast. The text never contains an "N% probability" phrase.
 */
export function buildForecastSkillNote(o: {
  site: string | null | undefined;
  variable: string | null | undefined;
  depthsM: number[] | null | undefined;
  fullProfile: boolean;
  horizonDays: number | null | undefined;
  /** Ignored: the record is pooled, not dated. */
  referenceISO?: string | null;
}): string {
  const depthM = resolveSkillDepth(o.depthsM, o.fullProfile);
  const sk = getForecastSkill(o.site, o.variable, depthM, o.horizonDays);
  if (!sk || depthM == null) {
    return `FORECAST SKILL RECORD (deterministic): ${skillNoRecordText(o.site, o.variable, depthM, o.fullProfile)}`;
  }
  const label = SKILL_VARIABLE_LABEL[sk.variable] ?? sk.variable;
  const list = sk.days
    .map((d) => `day ${d.day} ${fmtSkillPct(d.crpss, true)} (${fmtSkillNum(d.lo, true)} to ${fmtSkillNum(d.hi, true)})`)
    .join("; ");
  const less = sk.days.filter((d) => skillClass(d) === "less").map((d) => d.day);
  const unscored = skillUnscoredNote(sk.horizon);
  const lessSentence = less.length
    ? ` On ${dayList(less)} the forecast is less skilful than climatology: treat it as weaker evidence than climatology on ${less.length > 1 ? "those days" : "that day"} and say so.`
    : "";
  return (
    `FORECAST SKILL RECORD (deterministic, ${skillSiteLabel(sk.site)} ${label} at ${skillDepthLabel(sk.depthM)}, ` +
    `past forecasts to ${SKILL_RECORD_THROUGH}): ${skillVerdict(sk.days)} ` +
    `CRPSS against climatology by forecast day, with 95% CI: ${list}. ` +
    `0 means as skilful as climatology. ${CRPSS_SIGN_NOTE}` +
    lessSentence +
    (unscored ? ` ${unscored}` : "") +
    ` This is the model's past track record, not a score for today's forecast.`
  );
}
