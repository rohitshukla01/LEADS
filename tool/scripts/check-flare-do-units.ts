/**
 * Deterministic checks for FLARE dissolved-oxygen units (lib/leads/flare-reader.ts).
 * No network, no model calls.  Run:  npx tsx scripts/check-flare-do-units.ts
 *
 * FLARE glm_aed_flare_v3 writes DO_mgL_mean in mmol O2/m3 for every value (FLAREr renames
 * AED's OXY_oxy to the VERA target name without converting it). The reader must multiply
 * all of them by 32/1000. A rule that converted only values > 30 would read near-anoxic
 * members (raw 0-30 = 0-0.96 mg/L) as 0-30 mg/L, i.e. as well oxygenated.
 *
 * Fixture: raw members from the FLARE run pinned for the evaluation (reference_date
 * 2026-06-26), FCR 9 m days 1/3/5/7/14 and BVR 11 m day 1, exactly as published on the
 * public OSN bucket.
 */
import { readFileSync } from "fs";
import { normalizeFlareValue } from "../lib/leads/flare-reader";
import { exceedanceProbability } from "../lib/leads/ensemble";
import { buildReproduceSnippet } from "../lib/reproduce";
import type { ForecastRecord } from "../lib/leads/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const DO = "DO_mgL_mean";

// 1. the conversion itself: every DO value, whatever its size
for (const raw of [0, 0.5, 15, 29.99, 30, 30.01, 313]) {
  check(`DO raw ${raw} -> ${raw} x 0.032`, normalizeFlareValue(DO, raw) === raw * (32 / 1000));
}
check("Temp unchanged", normalizeFlareValue("Temp_C_mean", 25) === 25);
check("Chla unchanged", normalizeFlareValue("Chla_ugL_mean", 40) === 40);
// A magnitude test breaks ordering (raw 29 would read 29 mg/L, raw 31 0.99 mg/L).
check("DO conversion preserves order across 30",
  normalizeFlareValue(DO, 29) < normalizeFlareValue(DO, 31));

// 2. the FLARE run pinned for the evaluation, through the tool's member-to-probability path
const fx = JSON.parse(readFileSync("scripts/fixtures/flare-do-2026-06-26.json", "utf8"));
function record(key: string): ForecastRecord {
  const [siteId, depth, h] = key.split("|");
  const members = (fx.series[key] as number[]).map((v) => normalizeFlareValue(DO, v)).sort((a, b) => a - b);
  const mean = members.reduce((s, v) => s + v, 0) / members.length;
  return {
    modelId: "glm_aed_flare_v3", siteId, variable: DO, referenceDate: fx.reference_date,
    targetDate: "", horizon: Number(h), mean,
    quantile02_5: NaN, quantile10: NaN, quantile90: NaN, quantile97_5: NaN,
    members, depthM: Number(depth),
  } as ForecastRecord;
}
const count = (r: ForecastRecord, thr: number) => (r.members as number[]).filter((v) => v < thr).length;

// Expected values recomputed independently (Python/duckdb) from the raw parquet.
const expected: Array<[string, string, number, number, number]> = [
  // key            mean    n<2  n<4  P(<2) as the tool rounds it
  ["fcre|9|1",     "6.06",   0,   3, 0],
  ["fcre|9|3",     "5.48",   2,  31, 0.009],
  ["fcre|9|5",     "4.94",  11,  66, 0.05],
  ["fcre|9|7",     "4.35",  24,  95, 0.109],
  ["fcre|9|14",    "2.50", 106, 170, 0.48],
  ["bvre|11|1",    "0.28", 221, 221, 1],
];
for (const [key, mean, n2, n4, p2] of expected) {
  const fixtureKey = Object.keys(fx.series).find((k) => {
    const [s, d, h] = k.split("|");
    return `${s}|${Number(d)}|${h}` === key;
  });
  if (!fixtureKey) { check(`${key}: fixture present`, false); continue; }
  const r = record(fixtureKey);
  check(`${key}: ensemble mean ${mean} mg/L`, r.mean.toFixed(2) === mean, r.mean.toFixed(2));
  check(`${key}: ${n2}/221 members < 2 mg/L`, count(r, 2) === n2, String(count(r, 2)));
  check(`${key}: ${n4}/221 members < 4 mg/L`, count(r, 4) === n4, String(count(r, 4)));
  const p = exceedanceProbability([r], 2, "below").probability;
  check(`${key}: exceedanceProbability(<2) = ${p2}`, p === p2, String(p));
  // Water cannot hold ~20 mg/L of O2 at these depths.
  const max = Math.max(...(r.members as number[]));
  check(`${key}: every member below 20 mg/L`, max < 20, max.toFixed(2));
}

// 3. the reproduce snippet the user copies must use the same unconditional conversion
const params = {
  site: "fcre", variable: DO, depthM: 9, days: 30, horizon: 7,
  climatology: false, forecast: true, threshold: { value: 2, direction: "below" as const },
};
for (const lang of ["python", "r"] as const) {
  const code = buildReproduceSnippet(params, lang);
  check(`reproduce (${lang}): converts DO by 32/1000`, code.includes("32 / 1000"));
  check(`reproduce (${lang}): no "> 30" magnitude test`, !/prediction\s*>\s*30/.test(code));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
