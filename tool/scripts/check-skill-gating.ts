/**
 * Checks the forecast-skill record (lib/skill/forecast-skill.json: FLARE's past CRPSS
 * against climatology at one site and depth, forecast days 1..21, 95% CI) and the gate
 * the card, the PDF and the evidence record read it through (lib/skill/forecast-skill.ts).
 * Offline (no network, no model calls); exits 1 on any failure.
 *
 *   npx tsx scripts/check-skill-gating.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildForecastSkillNote, fmtSkillNum, fmtSkillPct, getForecastSkill, isScoredDepth, referenceDateFromDay1,
  resolveSkillDepth, resolveSkillHorizon, skillClass, skillGapPhrase, skillNoRecordText, skillRuns,
  skillUnscoredNote, skillVerdict, validateSkillDays, CRPSS_SIGN_NOTE, SKILL_CLASS_PHRASE,
  SKILL_DEFAULT_DAYS, SKILL_DEPTH_TOLERANCE_M, SKILL_MAX_DAY, SKILL_META, SKILL_SCORED_SCOPE,
  SKILL_VARIABLE_LABEL, type DaySkill,
} from "../lib/skill/forecast-skill";
import { layoutSkillPlot, skillLabelWidth, skillScale, SKILL_PLOT_COLORS } from "../lib/skill/skill-plot";
import { upperKeepMicro } from "../lib/report-content";
import { DEPTH_ZONE_MAPPING } from "../lib/leads/guardrails";
import { planLeadsQuery } from "../lib/leads/router";
import type { LeadsProfile } from "../lib/leads/types";
import { inferHorizon } from "../lib/leads/horizon";
import { forecastSkillNoteFor } from "../lib/leads/orchestrator";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const ROOT = join(__dirname, "..");
const RAW = JSON.parse(readFileSync(join(ROOT, "lib/skill/forecast-skill.json"), "utf8")) as Record<string, any>;
const SCORED = Object.keys(RAW).filter((k) => k !== "meta");
const DEPTH = SKILL_META.depth_m;
const SITE = "fcre";
const VARS = ["Temp_C_mean", "DO_mgL_mean", "Chla_ugL_mean"];
const SCORE_TOKEN = /[+\u2212-]?\d+%/; // any CRPSS-style value
const PROB_CLAIM = /(\d{1,3})%\s*probability/i; // lib/leads/verification.ts verifyForecastClaims
const twoDp = (x: number) => Math.abs(Math.round(x * 100) - x * 100) < 1e-6;
const sk = (v: string, h?: number | null, depth: number | null = DEPTH, site = SITE) => getForecastSkill(site, v, depth, h);
const day = (v: string, d: number) => sk(v, 21)!.days[d - 1];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const pin = (v: string, d: number, crpss: number, lo: number, hi: number) => {
  const x = day(v, d);
  return !!x && near(x.crpss, crpss) && near(x.lo, lo) && near(x.hi, hi);
};

// 1. Meta and the paper's Fig. 4d values
console.log("\n[meta]");
check("schema 2, max_day 21, default_days 7", SKILL_META.schema === 2 && SKILL_META.max_day === 21 &&
  SKILL_META.default_days === 7 && SKILL_MAX_DAY === 21 && SKILL_DEFAULT_DAYS === 7);
check("CI: 95% block bootstrap, 14-day blocks, 10000 resamples, seed 20261015",
  SKILL_META.ci.level === 95 && SKILL_META.ci.block_days === 14 && SKILL_META.ci.resamples === 10000 && SKILL_META.ci.seed === 20261015);
check("record through 2026-10-14, baseline climatology, depth 1.6 m",
  SKILL_META.record_through === "2026-10-14" && SKILL_META.baseline === "climatology" && DEPTH === 1.6);
check("no build date and no season fields in meta",
  !("generated" in SKILL_META) && !("leads" in SKILL_META) && !("coverage" in SKILL_META) && !/season/i.test(JSON.stringify(SKILL_META)));
check("one scored site (fcre)", SCORED.length === 1 && SCORED[0] === SITE, SCORED.join(","));
check("scored scope names the scored depth", SKILL_SCORED_SCOPE === "FCR 1.6 m", SKILL_SCORED_SCOPE);
let badRecord = "";
for (const v of VARS) {
  const days = RAW[SITE]?.[v]?.days as DaySkill[] | undefined;
  if (!validateSkillDays(days)) { badRecord ||= `${v}: not 21 well-formed days`; continue; }
  for (const d of days!) {
    if (![d.crpss, d.lo, d.hi].every(twoDp)) badRecord ||= `${v} day ${d.day}: more than 2 decimals`;
  }
}
check("each scored variable: 21 well-formed days, 2-decimal values, integer n > 0", badRecord === "", badRecord);

console.log("\n[paper twin]");
const chla7 = sk("Chla_ugL_mean", 7)!;
check("Chla days 1-7 crpss = Fig. 4d",
  JSON.stringify(chla7.days.map((d) => d.crpss)) === JSON.stringify([62.41, 54.64, 47.42, 40.66, 35.04, 29.46, 24.18]),
  chla7.days.map((d) => d.crpss).join(" "));
check("Chla days 1-7 lo", JSON.stringify(chla7.days.map((d) => d.lo)) === JSON.stringify([50.89, 42.63, 34.89, 27.0, 20.13, 13.06, 6.06]));
check("Chla days 1-7 hi", JSON.stringify(chla7.days.map((d) => d.hi)) === JSON.stringify([70.65, 63.69, 57.61, 52.1, 47.68, 43.24, 39.31]));
check("Chla n day 1 = 460, day 7 = 456", chla7.days[0].n === 460 && chla7.days[6].n === 456);
check("Chla labels = Fig. 4d (no double rounding)",
  chla7.days.map((d) => fmtSkillPct(d.crpss)).join(" ") === "+62% +55% +47% +41% +35% +29% +24%",
  chla7.days.map((d) => fmtSkillPct(d.crpss)).join(" "));
check("spot pins: Chla 14, 21; Temp 1, 7, 21; DO 1, 8, 21",
  pin("Chla_ugL_mean", 14, 1.79, -26.33, 21.0) && pin("Chla_ugL_mean", 21, -7.05, -38.27, 12.88) &&
  pin("Temp_C_mean", 1, 40.39, 22.22, 54.46) && pin("Temp_C_mean", 7, 25.17, 10.92, 36.77) &&
  pin("Temp_C_mean", 21, -12.26, -27.47, 2.47) && pin("DO_mgL_mean", 1, 17.86, -1.31, 33.26) &&
  pin("DO_mgL_mean", 8, -22.29, -48.66, -1.27) && pin("DO_mgL_mean", 21, -42.28, -70.36, -19.37));
check("formatters: U+2212 on screen, ASCII for the PDF, never -0",
  fmtSkillPct(-7.05) === "\u22127%" && fmtSkillPct(-7.05, true) === "-7%" && fmtSkillPct(-0.4) === "0%" &&
  fmtSkillPct(0.4) === "0%" && fmtSkillNum(-26.33) === "\u221226" && fmtSkillNum(-0.2, true) === "0" && fmtSkillNum(50.89) === "51");

// 2. Horizon
console.log("\n[horizon]");
check("null / NaN / 0 / -3 / undefined -> 7 days",
  [null, Number.NaN, 0, -3, undefined].every((h) => sk("Chla_ugL_mean", h)?.days.length === 7 && resolveSkillHorizon(h) === 7));
check("1 -> 1 day; 14 -> 14; 21 -> 21 with unscored null",
  sk("Chla_ugL_mean", 1)?.days.length === 1 && sk("Chla_ugL_mean", 14)?.days.length === 14 &&
  sk("Chla_ugL_mean", 21)?.days.length === 21 && sk("Chla_ugL_mean", 21)?.unscored === null);
const h30 = sk("Chla_ugL_mean", 30)!;
check("30 -> 21 days, unscored 22-30, exact sentence",
  h30.days.length === 21 && h30.unscored?.from === 22 && h30.unscored?.to === 30 &&
  skillUnscoredNote(30) === "Days 22\u201330 are not scored." && skillUnscoredNote(22) === "Day 22 is not scored." &&
  skillUnscoredNote(21) === "" && skillUnscoredNote(7) === "" && skillUnscoredNote(null) === "");
check("fractional horizon floors", sk("Chla_ugL_mean", 7.9)?.days.length === 7);

// 3. Depth, site, variable, malformed record
console.log("\n[depth / site / variable]");
const var0 = "Chla_ugL_mean";
check("scored depth returns the record", sk(var0, 7) !== null);
check("within tolerance returns the record",
  sk(var0, 7, DEPTH + SKILL_DEPTH_TOLERANCE_M * 0.8) !== null && sk(var0, 7, DEPTH - SKILL_DEPTH_TOLERANCE_M * 0.8) !== null);
check("just outside tolerance fails closed",
  sk(var0, 7, DEPTH + SKILL_DEPTH_TOLERANCE_M * 1.2) === null && sk(var0, 7, DEPTH - SKILL_DEPTH_TOLERANCE_M * 1.2) === null);
check("unknown depth fails closed (null / undefined / NaN)",
  [null, undefined, Number.NaN].every((d) => getForecastSkill(SITE, var0, d, 7) === null && !isScoredDepth(d)));
check("tolerance is float noise only (<= 0.05 m)", SKILL_DEPTH_TOLERANCE_M > 0 && SKILL_DEPTH_TOLERANCE_M <= 0.05,
  String(SKILL_DEPTH_TOLERANCE_M));
// Every canonical sensor/FLARE depth other than the scored one must fail, at every site
// (BVR's 1.5 m surface layer included: it is a different layer, not float noise).
const otherDepths = Object.values(DEPTH_ZONE_MAPPING)
  .flatMap((zones) => Object.values(zones).flat())
  .filter((d) => d !== DEPTH);
const leaks = otherDepths.filter((d) => VARS.some((v) => getForecastSkill(SITE, v, d, 7) !== null));
check(`no record at any other canonical depth (${[...new Set(otherDepths)].sort((a, b) => a - b).join(", ")} m)`,
  leaks.length === 0, leaks.join(","));
check("unscored site (BVR) fails closed at the scored depth", VARS.every((v) => getForecastSkill("bvre", v, DEPTH, 7) === null));
check("unscored variable fails closed", getForecastSkill(SITE, "Turbidity_FNU_mean", DEPTH, 7) === null &&
  getForecastSkill(SITE, null, DEPTH, 7) === null && getForecastSkill(null, var0, DEPTH, 7) === null);
check("resolveSkillDepth: single depth only, full profile fails closed",
  resolveSkillDepth([DEPTH], false) === DEPTH && resolveSkillDepth([], false) === null &&
  resolveSkillDepth([DEPTH], true) === null && resolveSkillDepth([DEPTH, 9], false) === null &&
  resolveSkillDepth(undefined, false) === null);
const good = RAW[SITE][var0].days as DaySkill[];
let threw = false, malformedOk = false;
try {
  malformedOk =
    validateSkillDays(good) !== null &&
    validateSkillDays(good.slice(0, 20)) === null &&
    validateSkillDays(good.map((d, i) => (i === 4 ? { ...d, lo: d.crpss + 1 } : d))) === null &&
    validateSkillDays(good.map((d, i) => (i === 4 ? { ...d, n: 0 } : d))) === null &&
    validateSkillDays(good.map((d, i) => (i === 4 ? { ...d, day: 9 } : d))) === null &&
    validateSkillDays(good.map((d, i) => (i === 4 ? { ...d, hi: Number.NaN } : d))) === null &&
    validateSkillDays(good.map((d, i) => (i === 4 ? null : d))) === null &&
    validateSkillDays(undefined) === null && validateSkillDays({}) === null && validateSkillDays("x") === null;
} catch { threw = true; }
check("malformed record (20 days, lo > crpss, n 0, wrong day, NaN, null) -> not scored, never a throw", malformedOk && !threw);
check("greyed-slot reason", skillGapPhrase("bvre", var0, 1.5) === "at BVR" && skillGapPhrase(SITE, var0, 9) === "at 9 m" &&
  skillGapPhrase(SITE, var0, null) === "at an unresolved depth" &&
  skillGapPhrase(SITE, var0, DEPTH, true) === "across the full water column" &&
  skillGapPhrase(SITE, "Turbidity_FNU_mean", DEPTH) === "for turbidity",
  skillGapPhrase(SITE, "Turbidity_FNU_mean", DEPTH));
check("variable labels", SKILL_VARIABLE_LABEL.Chla_ugL_mean === "Chlorophyll-a" &&
  SKILL_VARIABLE_LABEL.Temp_C_mean === "Water temperature" && SKILL_VARIABLE_LABEL.DO_mgL_mean === "Dissolved oxygen");
check("chart day 1 -> reference date", (referenceDateFromDay1("2025-07-02") ?? "").startsWith("2025-07-01") &&
  referenceDateFromDay1(null) === null);

// 4. Classes and record text
console.log("\n[classes]");
check("Chla 21 verdict", skillVerdict(sk("Chla_ugL_mean", 21)!.days) ===
  "More skilful than climatology on days 1\u20138; not distinguishable on days 9\u201321.", skillVerdict(sk("Chla_ugL_mean", 21)!.days));
check("Temp 21 verdict", skillVerdict(sk("Temp_C_mean", 21)!.days) ===
  "More skilful than climatology on days 1\u201310; not distinguishable on days 11\u201321.", skillVerdict(sk("Temp_C_mean", 21)!.days));
check("DO 21 verdict", skillVerdict(sk("DO_mgL_mean", 21)!.days) ===
  "Not distinguishable from climatology on days 1\u20137; less skilful on days 8\u201321.", skillVerdict(sk("DO_mgL_mean", 21)!.days));
check("Chla 7 verdict", skillVerdict(chla7.days) === "More skilful than climatology on days 1\u20137.");
check("single day uses 'on day N'", skillVerdict(sk("Chla_ugL_mean", 1)!.days) === "More skilful than climatology on day 1.");
check("classes follow the CI, not the sign (DO day 1 +18% with CI through 0 -> not distinguishable)",
  skillClass(day("DO_mgL_mean", 1)) === "same" && skillClass(day("DO_mgL_mean", 8)) === "less" &&
  skillClass(day("Chla_ugL_mean", 8)) === "more" && skillClass(day("Chla_ugL_mean", 9)) === "same");
check("runs cover every day exactly once",
  VARS.every((v) => skillRuns(sk(v, 21)!.days).reduce((n, r) => n + (r.to - r.from + 1), 0) === 21));

console.log("\n[record text]");
const note = (o: Partial<Parameters<typeof buildForecastSkillNote>[0]>) =>
  buildForecastSkillNote({ site: SITE, variable: var0, depthsM: [DEPTH], fullProfile: false, horizonDays: 7, ...o });
const NO_RECORD_TAIL = "How well forecasts like this have performed is unknown; agreement among ensemble members or a narrow spread is not evidence of accuracy.";

const n7 = note({});
const n30 = note({ horizonDays: 30 });
check("scored note: prefix, label, depth, record date, verdict first, CI list",
  n7.startsWith("FORECAST SKILL RECORD (deterministic, FCR Chlorophyll-a at 1.6 m, past forecasts to 14 Oct 2026): More skilful than climatology on days 1\u20137. ") &&
  n7.includes("day 1 +62% (51 to 71)") && n7.includes("day 7 +24% (6 to 39).") && !n7.includes("day 8 ") &&
  n7.includes(CRPSS_SIGN_NOTE) && n7.includes("0 means as skilful as climatology.") &&
  n7.endsWith("This is the model's past track record, not a score for today's forecast."), n7.slice(0, 200));
check("verdict within the first 220 characters (Brief cut)",
  VARS.every((v) => [7, 14, 21, 30].every((h) => {
    const t = note({ variable: v, horizonDays: h });
    return t.slice(0, 220).includes(skillVerdict(sk(v, h)!.days));
  })));
check("7-day note has no not-scored text; 30-day note has one",
  !/not scored/.test(n7) && n30.includes("Days 22\u201330 are not scored.") && !/day 2[2-9] [+-]|day 30 [+-]/.test(n30) &&
  n30.includes("day 21 -7% (-38 to 13)"));
check("note length bounded (<= 1.5k at 21 days)", VARS.every((v) => note({ variable: v, horizonDays: 30 }).length <= 1500),
  String(Math.max(...VARS.map((v) => note({ variable: v, horizonDays: 30 }).length))));
const doNote14 = note({ variable: "DO_mgL_mean", horizonDays: 14 });
check("'weaker evidence' sentence only when some day has hi < 0",
  doNote14.includes("On days 8\u201314 the forecast is less skilful than climatology: treat it as weaker evidence than climatology on those days and say so.") &&
  !note({ variable: "DO_mgL_mean", horizonDays: 7 }).includes("weaker evidence") &&
  !note({ horizonDays: 30 }).includes("weaker evidence") && !note({ variable: "Temp_C_mean", horizonDays: 21 }).includes("weaker evidence"));
check("note never prints -0 / \u22120 and uses an ASCII minus",
  VARS.every((v) => [7, 21, 30].every((h) => { const t = note({ variable: v, horizonDays: h }); return !/[-\u2212]0(%|\b)/.test(t) && !t.includes("\u2212"); })));
check("referenceISO is accepted and ignored", note({ referenceISO: "2025-01-15" }) === note({ referenceISO: "2025-07-15" }) &&
  note({ referenceISO: "2025-01-15" }) === n7);

const cases: [string, Partial<Parameters<typeof buildForecastSkillNote>[0]>, string][] = [
  ["deep layer", { depthsM: [9] }, "at 9 m"],
  ["full profile", { depthsM: [], fullProfile: true }, "across the full water column"],
  ["full profile, surface depth listed", { depthsM: [DEPTH], fullProfile: true }, "across the full water column"],
  ["unresolved depth", { depthsM: [] }, "at an unresolved depth"],
  ["several depths", { depthsM: [DEPTH, 9] }, "at an unresolved depth"],
  ["unscored site", { site: "bvre", depthsM: [1.5] }, "BVR"],
  ["unknown site", { site: null }, "this site"],
  ["unscored variable", { variable: "Turbidity_FNU_mean" }, "Turbidity_FNU_mean"],
];
for (const [name, o, phrase] of cases) {
  const t = note(o);
  check(`no record (${name}): disclosure, no score`,
    t.startsWith("FORECAST SKILL RECORD (deterministic): No historical skill record exists for ") &&
    t.includes(phrase) && t.includes(`(FLARE is scored only at ${SKILL_SCORED_SCOPE}).`) &&
    t.includes(NO_RECORD_TAIL) && !SCORE_TOKEN.test(t), t.slice(0, 140));
}
const allNotes = [n7, n30, doNote14, ...VARS.flatMap((v) => [1, 7, 14, 21, 30].map((h) => note({ variable: v, horizonDays: h }))),
  ...cases.map(([, o]) => note(o))];
check("no record starts with 'FLARE' (the skill record is computed by LEADS, not issued by FLARE)",
  allNotes.every((t) => !t.startsWith("FLARE")) && allNotes.every((t) => t.startsWith("FORECAST SKILL RECORD")));
check("no record reads as a probability claim to verifyForecastClaims", allNotes.every((t) => !PROB_CLAIM.test(t)));

console.log("\n[wording]");
const SEASON_WORD = /season|seasonal[- ]average/i;
const STAMP_WORD = /\b(updated|new|refreshed)\b/i;
const exported = [
  ...allNotes, CRPSS_SIGN_NOTE, skillUnscoredNote(30), skillUnscoredNote(22),
  ...VARS.flatMap((v) => [7, 21].map((h) => skillVerdict(sk(v, h)!.days))),
  ...Object.values(SKILL_CLASS_PHRASE).flatMap((p) => [p.full, p.short]),
  skillGapPhrase("bvre", var0, 1.5), skillGapPhrase(SITE, "Turbidity_FNU_mean", DEPTH),
  skillNoRecordText("bvre", var0, 1.5), SKILL_SCORED_SCOPE,
];
const badWord = exported.find((t) => SEASON_WORD.test(t) || STAMP_WORD.test(t));
check("no season / seasonal-average / updated / new / refreshed in any exported skill string", !badWord, badWord ?? "");
check("CRPSS sign note names climatology", CRPSS_SIGN_NOTE.includes("climatology"));

// 4b. Plot layout (dot & interval)
console.log("\n[plot layout]");
const lay = (v: string, h: number, w: number) => layoutSkillPlot({ days: sk(v, h)!.days, horizon: sk(v, h)!.horizon, width: w });
const c7 = lay("Chla_ugL_mean", 7, 822);
check("Chla 7 @822: y ticks 0..80 step 20, every day labelled, values beside at 12.5 px, all filled dots",
  JSON.stringify(c7.ticks.map((t) => t.v)) === "[0,20,40,60,80]" && c7.dayLabels.length === 7 &&
  c7.valueMode === "beside" && c7.fs.value === 12.5 && c7.marks.every((m) => m.cls === "more" && m.beside !== null),
  `${c7.ticks.map((t) => t.v)} ${c7.valueMode}`);
const c21 = lay("Chla_ugL_mean", 21, 822);
check("Chla 21 @822: axis -40..80 with a 60 tick, open dots from day 9, all 21 values in a row",
  c21.ticks[0].v === -40 && c21.ticks[c21.ticks.length - 1].v === 80 && c21.ticks.some((t) => t.v === 60 && t.label === "60") &&
  c21.marks.filter((m) => m.cls === "same").map((m) => m.day)[0] === 9 && c21.marks.slice(0, 8).every((m) => m.cls === "more") &&
  c21.valueMode === "row" && c21.valueDays.length === 21 && c21.dayLabels.length === 21,
  `${c21.ticks.map((t) => `${t.v}:${t.label}`).join(",")} ${c21.valueMode}`);
const d21 = lay("DO_mgL_mean", 21, 822);
check("DO 21 @822: less-skilful squares from day 8, open dots on days 1-7, axis -80..40",
  d21.marks.slice(0, 7).every((m) => m.cls === "same") && d21.marks.slice(7).every((m) => m.cls === "less") &&
  d21.ticks[0].v === -80 && d21.ticks[d21.ticks.length - 1].v === 40);
check("y labels use U+2212", d21.ticks.some((t) => t.label === "\u221240") && d21.ticks.every((t) => !t.label || !t.label.includes("-")));
const do315 = lay("DO_mgL_mean", 7, 315);
check("DO 7 @315 (phone): values in a row under the day numbers, every day fits",
  do315.valueMode === "row" && do315.valueDays.length === 7 && do315.narrow);
const l30 = lay("Chla_ugL_mean", 30, 822);
check("H = 30 @822: hatched strip after day 21 (days 22-30), no mark past day 21, 21 values still in a row",
  !!l30.strip && Math.abs(l30.strip.x0 - l30.x(21.5)) < 1e-9 && l30.strip.from === 22 && l30.strip.to === 30 && l30.strip.label === "22\u201330" &&
  l30.axisDays === 30 && l30.marks.length === 21 && l30.valueMode === "row" && l30.valueDays.length === 21 &&
  l30.dayAt(l30.strip.x1 - 1) === 30 && l30.dayAt(l30.strip.x0 + 1) === 22 && l30.dayAt(l30.x(21)) === 21);
check("H = 7: no strip", c7.strip === null);
check("one-day horizon: a single centred column",
  (() => { const l = lay("Chla_ugL_mean", 1, 822); return l.marks.length === 1 && Math.abs(l.marks[0].x - (l.padL + l.plotW / 2)) < 1e-9; })());
// No overlapping text at any supported width, and nothing under 12 px.
let overlap = "";
for (const v of VARS) for (const h of [1, 3, 7, 14, 21, 30]) for (const w of [822, 600, 394, 330, 315, 300, 260]) {
  const l = lay(v, h, w);
  const minFs = Math.min(...Object.values(l.fs));
  if (minFs < 12) overlap ||= `${v} ${h}d @${w}: ${minFs}px text`;
  const dl = l.dayLabels.map((d) => d.x);
  for (let i = 1; i < dl.length; i++) if (dl[i] - dl[i - 1] < 14) overlap ||= `${v} ${h}d @${w}: day labels ${dl[i] - dl[i - 1]}px apart`;
  if (l.valueMode !== "beside") {
    const vx = l.marks.filter((m) => l.valueDays.includes(m.day));
    const widest = Math.max(0, ...vx.map((m) => skillLabelWidth(m.label, l.fs.valueRow)));
    for (let i = 1; i < vx.length; i++) if (vx[i].vx - vx[i - 1].vx < widest + 2) overlap ||= `${v} ${h}d @${w}: values overlap`;
    if (vx.some((m) => m.vx - skillLabelWidth(m.label, l.fs.valueRow) / 2 < 0 || m.vx + skillLabelWidth(m.label, l.fs.valueRow) / 2 > w)) overlap ||= `${v} ${h}d @${w}: value off the plot`;
  } else {
    for (const m of l.marks) {
      const bw = skillLabelWidth(m.label, l.fs.value);
      const x0 = m.beside!.anchor === "start" ? m.beside!.x : m.beside!.x - bw;
      if (x0 < 0 || x0 + bw > w) overlap ||= `${v} ${h}d @${w}: beside value off the plot`;
    }
  }
  if (l.ticks.filter((t) => t.label).some((t, i, a) => i > 0 && Math.abs(t.y - a[i - 1].y) < 14)) overlap ||= `${v} ${h}d @${w}: tick labels collide`;
  if (!l.ticks.some((t) => t.v === 0 && t.label === "0")) overlap ||= `${v} ${h}d @${w}: no 0 label`;
  const top = Math.max(...sk(v, h)!.days.map((d) => d.crpss));
  if (!l.ticks.some((t) => t.label && t.v >= top)) overlap ||= `${v} ${h}d @${w}: no labelled tick above the highest dot`;
  if (l.width !== w) overlap ||= `${v} ${h}d @${w}: width ${l.width}`;
  if (l.strip?.label && dl.length) {
    const sx = (l.strip.x0 + l.strip.x1) / 2, half = skillLabelWidth(l.strip.label, l.fs.day) / 2;
    if (sx - half < dl[dl.length - 1] + 8) overlap ||= `${v} ${h}d @${w}: strip label meets day ${l.dayLabels[l.dayLabels.length - 1].day}`;
  }
}
check("widths 260-822, horizons 1-30: no overlapping labels, no text under 12 px, 0 and a tick above the highest dot labelled", overlap === "", overlap);
check("shared scale: the PDF and screen use the same ticks", JSON.stringify(skillScale(sk("Chla_ugL_mean", 7)!.days).ticks) === "[0,20,40,60,80]");
check("palette is neutral (no navy, red, pink or orange)",
  Object.values(SKILL_PLOT_COLORS).every((c) => !/#02436e|#9e2a2b|#d99a9b|#d55e00|#b4453a/i.test(c)));

console.log("\n[wording: sources]");
// Code constructors ("new Date(") are not wording; everything else in the card and in the
// PDF skill section (between its SKILL SECTION markers) must pass.
const prose = (t: string) => t.replace(/\bnew\s+[A-Z][A-Za-z]*\s*[(<]/g, "");
const cardSrc = readFileSync(join(ROOT, "components/ForecastSkillCard.tsx"), "utf8");
const reportSrc = readFileSync(join(ROOT, "lib/report.ts"), "utf8");
const skillSections = [...reportSrc.matchAll(/SKILL SECTION START([\s\S]*?)SKILL SECTION END/g)].map((x) => x[1]);
check("PDF skill section markers present", skillSections.length >= 2, String(skillSections.length));
const srcBad = [["card", cardSrc], ...skillSections.map((t, i) => [`report section ${i + 1}`, t])]
  .find(([, t]) => SEASON_WORD.test(prose(t)) || STAMP_WORD.test(prose(t)));
check("card and PDF skill section: no season / seasonal-average / updated / new / refreshed", !srcBad, srcBad?.[0] ?? "");
check("card colours are neutral (no navy, brick red or pink)", !/#02436e|02,\s*67,\s*110|#9e2a2b|#d99a9b|ACCENT/i.test(cardSrc));
check("PDF eyebrows keep the metre unit lower case", upperKeepMicro("Forecast skill  ·  FCR  ·  1.6 m  ·  vs climatology") ===
  "FORECAST SKILL  ·  FCR  ·  1.6 m  ·  VS CLIMATOLOGY" && upperKeepMicro("vs 2 mg/L") === "VS 2 MG/L" &&
  upperKeepMicro("vs 20 \u00b5g/L threshold") === "VS 20 \u00b5G/L THRESHOLD");

// 5. Real plans from the planner
console.log("\n[planner]");
const profile = (reservoir: "fcr" | "bvr", decision: LeadsProfile["decision"], depth: LeadsProfile["depth"]): LeadsProfile =>
  ({ persona: "manager", reservoir, depth, decision, summary: "" });
const planNote = (p: LeadsProfile) => {
  const plan = planLeadsQuery("What does the forecast show over the next week?", p);
  return {
    plan,
    text: buildForecastSkillNote({
      site: plan.chart?.siteId ?? null,
      variable: plan.chart?.variableHints?.[0] ?? null,
      depthsM: plan.resolvedDepthsM,
      fullProfile: plan.resolvedDepthScope === "full_profile",
      horizonDays: 7,
    }),
  };
};
const surface = planNote(profile("fcr", "algal_management", "epilimnion"));
check("FCR surface decision -> scored record",
  surface.plan.resolvedDepthScope === "surface" && SCORE_TOKEN.test(surface.text) && !surface.text.includes("No historical"),
  `${surface.plan.resolvedDepthsM} ${surface.text.slice(0, 90)}`);
const deep = planNote(profile("fcr", "hypoxia_management", "hypolimnion"));
check("FCR profile-zone decision -> no record at its depth",
  deep.plan.resolvedDepthScope === "profile_zone" && deep.text.includes("No historical") && !SCORE_TOKEN.test(deep.text),
  `${deep.plan.resolvedDepthsM} ${deep.text.slice(0, 120)}`);
const full = planNote(profile("fcr", "water_extraction", "epilimnion"));
check("FCR full-profile decision -> fails closed",
  full.plan.resolvedDepthScope === "full_profile" && (full.plan.resolvedDepthsM ?? []).length === 0 &&
  full.text.includes("across the full water column") && !SCORE_TOKEN.test(full.text), full.text.slice(0, 120));
const bvr = planNote(profile("bvr", "algal_management", "epilimnion"));
check("BVR decision -> no record", bvr.text.includes("No historical") && bvr.text.includes("BVR") && !SCORE_TOKEN.test(bvr.text),
  bvr.text.slice(0, 120));

// 5b. Informational plans (no operational decision)
// The answer's skill evidence for an informational question must be the record the card
// under it shows: same gate, same site / variable / depth / horizon. The card reads
// getForecastSkill(site, variable, chart depth, question horizon); the chart depth for these
// plans is the plan's single resolved depth.
console.log("\n[informational plans]");
const researcher = (depth: LeadsProfile["depth"]): LeadsProfile =>
  ({ persona: "researcher", reservoir: "fcr", depth, decision: "none", summary: "" });
const cardFor = (q: string, p: LeadsProfile) => {
  const plan = planLeadsQuery(q, p);
  const depth = resolveSkillDepth(plan.resolvedDepthsM, false);
  const sk = getForecastSkill(plan.chart?.siteId ?? null, plan.chart?.variableHints?.[0] ?? null, depth, inferHorizon(q));
  return { plan, depth, sk, note: forecastSkillNoteFor(plan) };
};
for (const [q, varKey] of [
  ["Is near-surface dissolved oxygen at FCR forecast to change over the next 7 days?", "DO_mgL_mean"],
  ["What is the forecast water temperature at 1.6 m at FCR for the next week?", "Temp_C_mean"],
  ["What is the chlorophyll-a outlook at FCR over the next two weeks?", "Chla_ugL_mean"],
] as const) {
  const c = cardFor(q, researcher("epilimnion"));
  check(`informational "${q.slice(0, 48)}..." -> forecast channel, no operational scope`,
    c.plan.channels.includes("forecast") && c.plan.resolvedDepthScope === undefined && c.plan.chart?.variableHints?.[0] === varKey,
    `${c.plan.channels} ${c.plan.resolvedDepthScope} ${c.plan.chart?.variableHints}`);
  check(`informational "${q.slice(0, 48)}..." -> the card's scored record, verdict first, every card day`,
    !!c.sk && c.depth === SKILL_META.depth_m &&
    c.note.startsWith(`FORECAST SKILL RECORD (deterministic, FCR ${SKILL_VARIABLE_LABEL[varKey]} at ${SKILL_META.depth_m} m, `) &&
    c.note.includes(`): ${skillVerdict(c.sk.days)} `) &&
    c.sk.days.every((d) => c.note.includes(`day ${d.day} ${fmtSkillPct(d.crpss, true)} (`)) &&
    !c.note.includes(`day ${c.sk.days.length + 1} `) && !c.note.includes("No historical"),
    `${c.depth} ${c.note.slice(0, 140)}`);
}
{
  const c = cardFor("What is the chlorophyll-a outlook at FCR over the next two weeks?", researcher("epilimnion"));
  check("informational horizon: the question's two weeks -> days 1-14, as on the card", c.sk?.days.length === 14 && c.note.includes("day 14 "));
  const deepI = cardFor("What is the forecast hypolimnetic dissolved oxygen at FCR over the next 7 days?", researcher("epilimnion"));
  check("informational deep-water question -> no record, the card's own no-record text",
    !deepI.sk && deepI.depth != null && !isScoredDepth(deepI.depth) &&
    deepI.note === `FORECAST SKILL RECORD (deterministic): ${skillNoRecordText("fcre", "DO_mgL_mean", deepI.depth, false)}` && !SCORE_TOKEN.test(deepI.note),
    `${deepI.depth} ${deepI.note.slice(0, 120)}`);
  const op = planLeadsQuery("What does the forecast show over the next week?", profile("fcr", "algal_management", "epilimnion"));
  check("operational plan through the shared helper = the planner check's record above", forecastSkillNoteFor(op) === buildForecastSkillNote({
    site: op.chart?.siteId ?? null, variable: op.chart?.variableHints?.[0] ?? null, depthsM: op.resolvedDepthsM,
    fullProfile: op.resolvedDepthScope === "full_profile", horizonDays: 7 }));
}

// 6. Wiring of the three callers
console.log("\n[wiring]");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const orch = src("lib/leads/orchestrator.ts");
check("orchestrator: builds the record through the gate with plan depth + full-profile flag",
  /buildForecastSkillNote\(\{[\s\S]*?depthsM:\s*plan\.resolvedDepthsM[\s\S]*?fullProfile:\s*plan\.resolvedDepthScope === "full_profile"/.test(orch) &&
  !/getForecastSkill\b/.test(orch));
check("orchestrator: one record builder, called by both paths",
  (orch.match(/buildForecastSkillNote\(/g) ?? []).length === 1 &&
  (orch.match(/forecastSkillNoteFor\(plan\)/g) ?? []).length === 2);
check("orchestrator: operational path keeps its forecast gate",
  /if \(forecast\.length > 0 \|\| fusedForecast\.length > 0\) \{\s*forecastSkillNote = forecastSkillNoteFor\(plan\);/.test(orch));
check("orchestrator: informational answers get the record, only when forecast evidence is in the packet",
  /if \(!operationalDecision\) \{\s*const hasForecastEvidence =\s*forecast\.length > 0 \|\| fused\.evidence\.some\(\(e\) => e\.channel === "forecast"\);\s*forecastSkillNote = hasForecastEvidence \? forecastSkillNoteFor\(plan\) : null;/.test(orch));
check("orchestrator: the record is injected as evidence 'forecast:skill-record' whenever built (no decision gate)",
  /if \(forecastSkillNote\) \{\s*fused\.evidence\.unshift\(\{\s*id: "forecast:skill-record"/.test(orch));
const panel = src("components/InsightPanel.tsx");
check("InsightPanel: passes depthM to the card", /<ForecastSkillCard[^>]*depthM=\{depthM\}/.test(panel));
const card = src("components/ForecastSkillCard.tsx");
check("card: reads through the gate with its depth, greyed slot present",
  /getForecastSkill\([^)]*depthM[^)]*\)/.test(card) && card.includes("Forecast skill: not scored"));
const report = src("lib/report.ts");
check("PDF: reads through the gate with the chart depth, depth in the eyebrow, greyed slot",
  /getForecastSkill\([^)]*m\.chart\?\.depthM/.test(report) &&
  /eyebrow\(`Forecast skill[^`]*skillDepthLabel\(SKILL_META\.depth_m\)/.test(report) &&
  report.includes("Forecast skill: not scored"));
check("PDF: days past 21 named once (with the verdict, not again in the caption)",
  (() => { const a = report.indexOf("const skillCaption = "), b = report.indexOf("const drawSkillFigure = ");
    return a > 0 && b > a && !report.slice(a, b).includes("skillUnscoredNote"); })());
check("not scored: card and PDF show only 'Forecast skill: not scored ...' (no explanation line)",
  card.includes("Forecast skill: not scored") && !card.includes("How well forecasts like this") &&
  report.includes("Forecast skill: not scored") && !/skillNoRecordText\(/.test(report));

console.log("\n[linked forecast days]");
check("InsightPanel: one shared cursor passed to the card",
  /const \[skillCursor, setSkillCursor\] = useState<SkillCursor \| null>\(null\)/.test(panel) &&
  /<ForecastSkillCard[^>]*depthM=\{depthM\}[^>]*cursor=\{skillCursor\} onCursor=\{setSkillCursor\}/.test(panel));
const hiddenCopy = panel.slice(panel.indexOf("{memberLines && captureId != null && ("), panel.indexOf("{memberView === \"unavailable\" && ("));
check("InsightPanel: skillLink on the visible chart only (the hidden PDF copy gets none)",
  (panel.match(/skillLink=\{skillLink\}/g) ?? []).length === 1 && hiddenCopy.length > 0 && !hiddenCopy.includes("skillLink"));
check("InsightPanel: skillLink exists only when the card has a record (same gate)",
  /const skillRecord = [^;]*getForecastSkill\(site, variableKey, depthM, skillHorizon \?\? forecastHorizon\)/.test(panel) &&
  /const skillLink[^;]*= SKILL_CARD_ENABLED && skillRecord && fc\.length/.test(panel));
check("rollback switch: the card flag also turns off the chart link",
  /export const SKILL_CARD_ENABLED = process\.env\.NEXT_PUBLIC_LEADS_SKILL_CARD_ENABLED !== "false"/.test(card) &&
  /if \(!SKILL_CARD_ENABLED\) return null/.test(card) && /import ForecastSkillCard, \{ SKILL_CARD_ENABLED/.test(panel));
check("one tooltip at a time: the chart drops its tooltip while the card drives",
  /const hovered = cardDay == null && /.test(panel) && /if \(cardDriving\) setHoverIdx\(null\)/.test(panel));
check("hover, echo and highlight marks are data-transient (chart and card)",
  (panel.match(/data-transient=""/g) ?? []).length >= 2 && (card.match(/data-transient=""/g) ?? []).length >= 2);
check("PDF chart capture strips data-transient marks", /querySelectorAll\("\[data-transient\]"\)\.forEach\(\(n\) => n\.remove\(\)\)/.test(report));
check("chart tooltip: past skill row, 'not scored' past day 21", panel.includes("past skill ${fmtSkillPct(d.crpss)}") && panel.includes("past skill: not scored"));

const ok = failures === 0;
console.log(`\n${ok ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
process.exit(ok ? 0 : 1);
