/**
 * Ensemble-probability formatting gate (lib/leads/ensemble.ts formatEnsembleProbability).
 *
 *   npx tsx scripts/check-ensemble-format.ts
 *
 * No network, no model calls. An ensemble count has a resolution of 1/N, so a
 * threshold-crossing probability is printed with its member count: 0 of 221 members
 * must never read "0%" and 220 of 221 must never read "100%". Locks:
 *  1. the formatter itself - every branch, and a sweep of every k for several N;
 *  2. exceedanceProbability - `probability` identical to a frozen reference implementation
 *     (the DO-units gate asserts those values), plus the member-count fields, which
 *     are withheld when one horizon pools several depths (no "k of 442 members");
 *  3. the evidence cards, on the pinned FLARE fixture, through the production builder;
 *  4. the operational banner - every branch carries the count, never 0%/100%, and still
 *     parses into the PDF's verdict + exceedance clause (report-content.ts);
 *  5. the one-sentence system-prompt rule, and no "(p * 100).toFixed(0)%" printing of
 *     a probability in the forecast/banner code.
 */
import { readFileSync } from "fs";
import { exceedanceProbability, formatEnsembleProbability } from "../lib/leads/ensemble";
import { normalizeFlareValue } from "../lib/leads/flare-reader";
import {
  buildPerVariableForecastItems,
  formatForecastOutlookClause,
  formatForecastPeakLine,
  type ForecastExceedanceOutlook,
} from "../lib/leads/forecast";
import { buildEnsembleSummaries } from "../lib/leads/ensemble";
import { buildOperationalVerdictBanner } from "../lib/leads/orchestrator";
import { deriveExceedanceProb, parseVerdict } from "../lib/report-content";
import type { ConstraintEvaluation } from "../lib/leads/constraint-eval";
import type { ForecastRecord } from "../lib/leads/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

/** A bare "0%" / "100%" (also "0.0%", "100.00%"), not part of a larger number. */
const BARE_0_OR_100 = /(^|[^\d.])(0|100)(\.0+)?%/;

// 1. The formatter
const exact: Array<[number | null, number | null, number, string]> = [
  [0, 221, 0, "0 of 221 members (below the ensemble's 1-in-221 resolution)"],
  [221, 221, 1, "221 of 221 members"],
  [1, 221, 0.005, "0.5% (1 of 221 members)"],
  [2, 221, 0.009, "0.9% (2 of 221 members)"],
  [3, 221, 0.014, "1% (3 of 221 members)"],
  [110, 221, 0.498, "50% (110 of 221 members)"],
  [218, 221, 0.986, "99% (218 of 221 members)"],
  [219, 221, 0.991, "99.1% (219 of 221 members)"],
  [220, 221, 0.995, "99.5% (220 of 221 members)"],
  // Gaussian fallback: no members, so no count - and still never 0% / 100%.
  [null, null, 0, "<0.1% (Gaussian approximation; no member count)"],
  [null, null, 1, ">99.9% (Gaussian approximation; no member count)"],
  [null, null, 0.004, "0.4% (Gaussian approximation; no member count)"],
  [null, null, 0.42, "42% (Gaussian approximation; no member count)"],
];
for (const [k, n, p, want] of exact) {
  const got = formatEnsembleProbability(k, n, p);
  check(`format(${k}, ${n}${k == null ? `, p=${p}` : ""}) = "${want}"`, got === want, got);
}
// Pooled across depths: a percentage, labelled pooled, never a member count or 0%/100%.
const pooledExact: Array<[number, number, string]> = [
  [0.33, 2, "33% (pooled across 2 depths; no single-depth member count)"],
  [0, 2, "<0.1% (pooled across 2 depths; no single-depth member count)"],
  [1, 3, ">99.9% (pooled across 3 depths; no single-depth member count)"],
];
for (const [p, d, want] of pooledExact) {
  const got = formatEnsembleProbability(undefined, undefined, p, d);
  check(`format(pooled ${d} depths, p=${p}) = "${want}"`, got === want, got);
}

let sweepBad: string[] = [];
for (const n of [21, 50, 221, 1000, 10000]) {
  for (let k = 0; k <= n; k++) {
    const s = formatEnsembleProbability(k, n);
    const countOk = k === 0 || k === n ? s.startsWith(`${k} of ${n} members`) : s.includes(`(${k} of ${n} members)`);
    const pct = /^([\d.]+)%/.exec(s);
    const strictlyInside = k === 0 || k === n || (pct != null && Number(pct[1]) > 0 && Number(pct[1]) < 100);
    if (!countOk || !strictlyInside || BARE_0_OR_100.test(s)) sweepBad.push(`${k}/${n} -> ${s}`);
  }
}
check("sweep k = 0..N for N in {21, 50, 221, 1000, 10000}: count shown, never 0% or 100%",
  sweepBad.length === 0, sweepBad.slice(0, 3).join(" | "));
sweepBad = [];
for (let i = 0; i <= 1000; i++) {
  const s = formatEnsembleProbability(null, null, i / 1000);
  if (BARE_0_OR_100.test(s)) sweepBad.push(`${i / 1000} -> ${s}`);
}
check("Gaussian sweep p = 0..1: never 0% or 100%", sweepBad.length === 0, sweepBad.slice(0, 3).join(" | "));

// 2. exceedanceProbability: reference probability and member counts
// Frozen reference: the member-path probability, computed without the count fields.
function probabilityReference(records: ForecastRecord[], threshold: number, direction: "above" | "below"): number {
  const crosses = (v: number) => (direction === "below" ? v < threshold : v > threshold);
  const byHorizon = new Map<number, number[]>();
  for (const r of records) {
    const bucket = byHorizon.get(r.horizon) ?? [];
    for (const v of r.members as number[]) bucket.push(v);
    byHorizon.set(r.horizon, bucket);
  }
  let peak = 0;
  for (const values of byHorizon.values()) {
    if (!values.length) continue;
    peak = Math.max(peak, values.filter(crosses).length / values.length);
  }
  return Number(Math.min(1, Math.max(0, peak)).toFixed(3));
}

const fx = JSON.parse(readFileSync("scripts/fixtures/flare-do-2026-06-26.json", "utf8"));
const DO = "DO_mgL_mean";
const fixtureRecords: ForecastRecord[] = Object.keys(fx.series).map((key) => {
  const [siteId, depth, h] = key.split("|");
  const members = (fx.series[key] as number[]).map((v) => normalizeFlareValue(DO, v)).sort((a, b) => a - b);
  const q = (p: number) => members[Math.min(members.length - 1, Math.floor(p * members.length))];
  return {
    modelId: "glm_aed_flare_v3", siteId, variable: DO, referenceDate: fx.reference_date,
    targetDate: `h${h}`, horizon: Number(h), mean: members.reduce((s, v) => s + v, 0) / members.length,
    quantile02_5: q(0.025), quantile10: q(0.1), quantile90: q(0.9), quantile97_5: q(0.975),
    members, depthM: Number(depth),
  } as ForecastRecord;
});

let probMismatch: string[] = [];
let countMismatch: string[] = [];
for (const r of fixtureRecords) {
  for (const thr of [1, 2, 4, 6, 8]) {
    for (const dir of ["below", "above"] as const) {
      const exc = exceedanceProbability([r], thr, dir);
      if (exc.probability !== probabilityReference([r], thr, dir)) probMismatch.push(`${r.siteId}|h${r.horizon}|${dir}${thr}`);
      const k = (r.members as number[]).filter((v) => (dir === "below" ? v < thr : v > thr)).length;
      if (exc.crossingMembers !== k || exc.totalMembers !== (r.members as number[]).length) {
        countMismatch.push(`${r.siteId}|h${r.horizon}|${dir}${thr}: ${exc.crossingMembers}/${exc.totalMembers} vs ${k}`);
      }
    }
  }
}
check("fixture: probability matches the reference computation (every record x 5 thresholds x 2 directions)",
  probMismatch.length === 0, probMismatch.slice(0, 3).join(", "));
check("fixture: crossingMembers / totalMembers are the true member counts",
  countMismatch.length === 0, countMismatch.slice(0, 3).join(", "));

// Multi-horizon input: the counts belong to the peak horizon, and probability matches the reference.
const fcre = fixtureRecords.filter((r) => r.siteId === "fcre");
const multi = exceedanceProbability(fcre, 2, "below");
check("multi-horizon: probability matches the reference", multi.probability === probabilityReference(fcre, 2, "below"), String(multi.probability));
check("multi-horizon: count is the peak horizon's",
  multi.crossingMembers != null && multi.totalMembers != null &&
  Number((multi.crossingMembers / multi.totalMembers).toFixed(3)) === multi.probability,
  `${multi.crossingMembers}/${multi.totalMembers}`);

// Gaussian path (no members): no count fields.
const noMembers = fixtureRecords.map((r) => ({ ...r, members: undefined }));
const g = exceedanceProbability([noMembers[0]], 2, "below");
check("Gaussian path: no member-count fields", g.crossingMembers === undefined && g.totalMembers === undefined);

// Two depths at one horizon pool into one bucket (2 x 221 values): probability matches
// the reference, no member count (it would read "k of 442 members"), pooledDepths says why.
const fcre9h = fixtureRecords.filter((r) => r.siteId === "fcre");
const twoDepth = [...fcre9h, ...fcre9h.map((r) => ({ ...r, depthM: 1.6 }))];
const pooled = exceedanceProbability(twoDepth, 2, "below");
check("two depths: probability matches the reference", pooled.probability === probabilityReference(twoDepth, 2, "below"), String(pooled.probability));
check("two depths: no member count, pooledDepths = 2",
  pooled.crossingMembers === undefined && pooled.totalMembers === undefined && pooled.pooledDepths === 2,
  JSON.stringify({ k: pooled.crossingMembers, n: pooled.totalMembers, d: pooled.pooledDepths }));
check("one depth: no pooledDepths field", multi.pooledDepths === undefined);

// 3. Evidence cards through the production builder
// Day cards for the pinned FCR 9 m DO run against the default DO < 2 mg/L threshold
// (LEADS_RISK_THRESHOLDS; no decision): 0 of 221 members cross on day 1 (the "0%" case).
const fcre9 = fixtureRecords.filter((r) => r.siteId === "fcre");
const ens = buildEnsembleSummaries(fcre9);
const items = buildPerVariableForecastItems("summary", ens, fcre9, undefined, undefined, 14, undefined);
const cardText = items.map((i) => i.text).join("\n");
check("day cards: produced from the fixture", items.length > 0, String(items.length));
check("day cards: every P(...) carries a member count or the Gaussian label",
  items.every((i) => !i.text.includes(" P(") || /= (\d+(\.\d+)?% \(\d+ of \d+ members\)|\d+ of \d+ members)/.test(i.text)),
  items.map((i) => i.text.slice(i.text.indexOf(" P("), i.text.indexOf(" on day"))).join(" | "));
check("day cards: never a bare 0% or 100%", !BARE_0_OR_100.test(cardText.replace(/2\.5–97\.5%/g, "")));
check("day cards: 0 crossing members printed as a count",
  cardText.includes("= 0 of 221 members (below the ensemble's 1-in-221 resolution) on day 1"));
check("day cards: id format is :hN",
  items.every((i) => /^forecast:flare:[^:]+:[^:]+:h\d+$/.test(i.id)), items.map((i) => i.id).join(","));
check("day cards: text starts with 'FLARE'", items.every((i) => i.text.startsWith("FLARE")));

// Two-depth day cards: labelled pooled, never "of 442 members" or a 442 resolution.
const twoEns = buildEnsembleSummaries(twoDepth);
const pooledText = ["summary", "quantiles", "json"].map((st) =>
  buildPerVariableForecastItems(st as "summary" | "quantiles" | "json", twoEns, twoDepth, undefined, undefined, 14, undefined)
    .map((i) => i.text).join("\n")).join("\n");
check("two-depth cards (all strategies): pooled label, no pooled member count",
  pooledText.includes("pooled across 2 depths; no single-depth member count") && !/of 442\b|1-in-442/.test(pooledText) &&
  !/"total_members":442/.test(pooledText), pooledText.slice(0, 200));

for (const strategy of ["quantiles", "json"] as const) {
  const t = buildPerVariableForecastItems(strategy, ens, fcre9, undefined, undefined, 14, undefined)
    .map((i) => i.text).join("\n");
  check(`${strategy} strategy: probability printed with its count`, /\d+ of \d+ members/.test(t), t.slice(-160));
  if (strategy === "json") {
    const thr = JSON.parse(t.split("\n")[0]).threshold;
    check("json strategy: crossing_probability kept, count fields added",
      typeof thr?.crossing_probability === "number" && typeof thr?.crossing_members === "number" &&
      typeof thr?.total_members === "number" && typeof thr?.report_as === "string", JSON.stringify(thr));
  }
}

// 4. The operational banner
const singleZone = (variable: string, observed: number, value: number, units: string, verdict: "satisfied" | "violated"): ConstraintEvaluation => ({
  applicable: true, kind: "single_zone", summary: "", allSatisfied: verdict === "satisfied",
  checks: [{ variable, op: "<=", value, units, observed, observedDepthM: 9, observedDate: "2026-01-01", verdict }],
});
const base = { variable: "DO_mgL_mean", thresholdValue: 4, units: "mg/L", direction: "below" as const, horizon: 14 };
const outlooks: Array<[string, ForecastExceedanceOutlook, RegExp]> = [
  ["no member crosses on any day",
    { ...base, peakProbability: 0, peakHorizonDay: 1, peakCrossingMembers: 0, peakTotalMembers: 221,
      finalHorizonDay: 14, finalProbability: 0, finalCrossingMembers: 0, finalTotalMembers: 221 },
    /is 0 of 221 members \(below the ensemble's 1-in-221 resolution\) on every day of the 14-day outlook\./],
  ["one member, peak on the last day",
    { ...base, peakProbability: 0.005, peakHorizonDay: 14, peakCrossingMembers: 1, peakTotalMembers: 221,
      finalHorizonDay: 14, finalProbability: 0.005, finalCrossingMembers: 1, finalTotalMembers: 221 },
    /peaks at 0\.5% \(1 of 221 members\) on day 14 of 14\.$/],
  ["peak before the last day: final-day value added",
    { ...base, peakProbability: 0.38, peakHorizonDay: 9, peakCrossingMembers: 84, peakTotalMembers: 221,
      finalHorizonDay: 14, finalProbability: 0.33, finalCrossingMembers: 73, finalTotalMembers: 221 },
    /peaks at 38% \(84 of 221 members\) on day 9 of 14; 33% \(73 of 221 members\) on day 14\.$/],
  // A final day that ties the peak is not repeated (it would read as a drop after the peak).
  ["220 of 221 never reads 100% (final day ties the peak)",
    { ...base, peakProbability: 0.995, peakHorizonDay: 6, peakCrossingMembers: 220, peakTotalMembers: 221,
      finalHorizonDay: 14, finalProbability: 0.995, finalCrossingMembers: 220, finalTotalMembers: 221 },
    /peaks at 99\.5% \(220 of 221 members\) on day 6 of 14\.$/],
  ["every member crosses (final day ties the peak)",
    { ...base, peakProbability: 1, peakHorizonDay: 3, peakCrossingMembers: 221, peakTotalMembers: 221,
      finalHorizonDay: 14, finalProbability: 1, finalCrossingMembers: 221, finalTotalMembers: 221 },
    /peaks at 221 of 221 members on day 3 of 14\.$/],
  ["pooled across depths (no member count)",
    { ...base, peakProbability: 0.33, peakHorizonDay: 4, peakPooledDepths: 2,
      finalHorizonDay: 14, finalProbability: 0.2, finalPooledDepths: 2 },
    /peaks at 33% \(pooled across 2 depths; no single-depth member count\) on day 4 of 14; 20% \(pooled across 2 depths; no single-depth member count\) on day 14\.$/],
  ["Gaussian fallback (no members)",
    { ...base, peakProbability: 0.12, peakHorizonDay: 5, finalHorizonDay: 14, finalProbability: 0.08 },
    /peaks at 12% \(Gaussian approximation; no member count\) on day 5 of 14; 8% \(Gaussian approximation; no member count\) on day 14\.$/],
  ["Gaussian fallback, zero everywhere",
    { ...base, peakProbability: 0, peakHorizonDay: 1, finalHorizonDay: 14, finalProbability: 0 },
    /is <0\.1% \(Gaussian approximation; no member count\) on every day of the 14-day outlook\./],
];
for (const [label, o, want] of outlooks) {
  const banner = buildOperationalVerdictBanner(singleZone("DO_mgL_mean", 6.2, 4, "mg/L", "violated"), "hypoxia_management", o) ?? "";
  const v = parseVerdict(banner);
  check(`banner [${label}]: wording`, want.test(banner), banner.slice(banner.indexOf("Forecast:")));
  check(`banner [${label}]: never a bare 0% or 100%, no "<1%" rule`,
    !BARE_0_OR_100.test(banner) && !banner.includes("stays under 1%"));
  check(`banner [${label}]: PDF parses verdict + exceedance clause`,
    !!v && v.verdict.startsWith("Operational check") && deriveExceedanceProb(v.forecastClause) === v.forecastClause);
  const line = formatForecastPeakLine(o);
  check(`evidence peak line [${label}]: same numbers as the banner`,
    banner.includes(formatForecastOutlookClause(o, "DO")) &&
    line.includes(formatEnsembleProbability(o.peakCrossingMembers, o.peakTotalMembers, o.peakProbability, o.peakPooledDepths)), line);
}
// Saved conversations can hold banners in two other phrasings ("stays under 1%",
// "peaks at X% (day N of H)"); the PDF must parse those too.
check("PDF: other banner phrasings parse",
  deriveExceedanceProb("Forecast: P(DO < 4 mg/L) stays under 1% (≈0.0%) across the 7-day outlook.") !== null &&
  deriveExceedanceProb("Forecast: P(DO < 4 mg/L) peaks at 12% (day 3 of 7).") !== null);

// 5. Prompt rule + no rounded-percentage printing
const gen = readFileSync("lib/leads/generator.ts", "utf8");
check("system prompt: ensemble-count sentence present (member shares, with the member count)",
  gen.includes("Report ensemble member shares exactly as the record gives them, with the member count (e.g. 'X% of ensemble members (k of N)'); never write 0% or 100% for an ensemble count, and never call a member share a 'probability', 'chance' or 'likelihood'."));
check("system prompt: no 'Report ensemble probabilities' wording", !gen.includes("Report ensemble probabilities"));
check("system prompt: still never 0% or 100% for an ensemble count", gen.includes("never write 0% or 100% for an ensemble count"));
for (const f of ["lib/leads/forecast.ts", "lib/leads/orchestrator.ts"]) {
  const src = readFileSync(f, "utf8");
  check(`${f}: no probability printed as (p * 100).toFixed(...)%`,
    !/probability\s*\*\s*100\)\.toFixed\(\d\)\}%/.test(src) && !/\(p \* 100\)\.toFixed/.test(src));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
