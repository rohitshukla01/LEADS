/**
 * Banner-in-evidence gate: every forecast number on the operational banner must also be
 * in the evidence the model reads.
 *
 *   npx tsx scripts/check-banner-in-evidence.ts            offline (npm run check)
 *   npx tsx scripts/check-banner-in-evidence.ts --live     replay archived public FLARE runs
 *        [--dates=2026-06-20,2026-07-15]                    (network, no model calls)
 *
 * The banner scans every day of the horizon; the model reads only the sampled day cards
 * (day 1, the last day and evenly spaced days between), so a peak on an unsampled day
 * would be on the page but not in the evidence. The window-summary card therefore carries
 * the banner's peak, and the final-day value when the peak is earlier, computed by the
 * same function (forecastExceedanceOutlookFromRecords). This gate locks that invariant:
 *
 *  1. Offline (blocking): synthetic 221-member FLARE runs for both reservoirs, both banner
 *     decisions, several horizons and many probability shapes (nothing crosses, everything
 *     crosses, a peak on an unsampled day, ties, a single member, ...). Each case builds
 *     the banner exactly as the orchestrator does (from the records the banner's own fetch
 *     returns) and the window-summary card exactly as retrieveForecastEvidence does (from
 *     the evidence fetch, which may also hold forced inputs and derived %sat records), then
 *     asserts the banner's peak/final strings appear verbatim in the card. It also checks
 *     that the sampled day cards follow the reference sampling rule, and the card's
 *     daily-mean lowest/highest and envelope wording. Every (persona, decision) pair
 *     without a banner must get no peak line: there is no banner to match, and for a floor
 *     constraint the "peak" would be the most favourable day.
 *  2. Live (optional): the real computeForecastExceedanceOutlook + retrieveForecastEvidence
 *     against archived public FLARE runs (one child process per reference date, pinned via
 *     LEADS_FLARE_REFERENCE_DATE), with the same assertion.
 */
import { readFileSync } from "fs";
import { spawnSync } from "child_process";
import { planLeadsQuery } from "../lib/leads/router";
import { inferHorizon } from "../lib/leads/horizon";
import { buildEnsembleSummaries } from "../lib/leads/ensemble";
import {
  buildPerVariableForecastItems,
  buildWindowSummaryText,
  computeForecastExceedanceOutlook,
  forecastExceedanceOutlookFromRecords,
  resolveForecastSites,
  resolveForecastVariables,
  retrieveForecastEvidence,
  DERIVED_SATURATION_VARIABLE,
} from "../lib/leads/forecast";
import { bannerDecisionFor, buildOperationalVerdictBanner } from "../lib/leads/orchestrator";
import type { ConstraintEvaluation } from "../lib/leads/constraint-eval";
import type { DecisionKey } from "../lib/leads/guardrails";
import type { EnsembleSummary, ForecastRecord, LeadsProfile, LeadsQueryPlan, LeadsReservoir } from "../lib/leads/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

// Shared: the cases, the banner, and how to read its numbers back

type BannerDecision = "hypoxia_management" | "algal_management";
const DECISIONS: Record<BannerDecision, { variable: string; depth: LeadsProfile["depth"]; question: (site: string, n: number) => string }> = {
  // Generic phrasings written for this check (not benchmark questions).
  hypoxia_management: { variable: "DO_mgL_mean", depth: "hypolimnion", question: (s, n) => `Should we activate oxygenation at ${s} given the ${n}-day forecast?` },
  algal_management: { variable: "Chla_ugL_mean", depth: "epilimnion", question: (s, n) => `Should we start bloom control at ${s} given the ${n}-day forecast?` },
};
const RESERVOIRS: LeadsReservoir[] = ["fcr", "bvr"];
// Every horizon inferHorizon can name from "N-day" phrasing (lib/leads/horizon.ts).
const HORIZONS = [3, 7, 14, 21, 30];

function planFor(decision: BannerDecision, reservoir: LeadsReservoir, n: number) {
  const profile = { persona: "manager", reservoir, depth: DECISIONS[decision].depth, decision, summary: "" } as LeadsProfile;
  const plan = planLeadsQuery(DECISIONS[decision].question(reservoir.toUpperCase(), n), profile);
  return { plan, options: { decision: decision as DecisionKey, reservoir, persona: "manager" as const } };
}

/** A determinate single-zone reading, so the banner builder emits its line. */
function readingFor(decision: BannerDecision): ConstraintEvaluation {
  const variable = DECISIONS[decision].variable;
  const [value, units] = variable === "DO_mgL_mean" ? [4, "mg/L"] : [20, "µg/L"];
  return {
    applicable: true, kind: "single_zone", summary: "", allSatisfied: false,
    checks: [{ variable, op: variable === "DO_mgL_mean" ? "<=" : ">", value, units, observed: value + 1,
      observedDepthM: 1, observedDate: "2026-01-01", verdict: "violated" }],
  };
}

/** The banner's forecast numbers as printed: the peak string and, if shown, the final-day
 *  string. Parsed from the banner text itself, not rebuilt with the shared helpers. */
function bannerNumbers(banner: string): { peak: string; final: string | null } | null {
  const clause = banner.slice(banner.indexOf("Forecast:"));
  const every = /^Forecast: P\([^)]*\) is (.+ on every day) of the \d+-day outlook\.$/.exec(clause);
  if (every) return { peak: every[1], final: null };
  const peaks = /^Forecast: P\([^)]*\) peaks at (.+?) on day (\d+) of \d+(?:; (.+?) on day (\d+))?\.$/.exec(clause);
  if (peaks) return { peak: `${peaks[1]} on day ${peaks[2]}`, final: peaks[3] ? `${peaks[3]} on day ${peaks[4]}` : null };
  return null;
}

/** Reference copy of the day-sampling rule in selectHorizonDays (lib/leads/forecast.ts):
 *  the sampled day cards must stay on these days. */
function sampledDaysOLD(horizons: number[], maxDays = 4): number[] {
  if (horizons.length <= maxDays) return horizons;
  const lastIdx = horizons.length - 1;
  const picked = new Set<number>([0, lastIdx]);
  const remaining = maxDays - picked.size;
  for (let i = 1; i <= remaining; i++) picked.add(Math.round((i * lastIdx) / (remaining + 1)));
  return Array.from(picked).sort((a, b) => a - b).map((i) => horizons[i]);
}

// 1. Offline: synthetic ensembles

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const N_MEMBERS = 221;
type Shape = (day: number, days: number, rnd: () => number) => number; // crossing members on `day`
const SHAPES: Record<string, (rnd: () => number, days: number) => Shape> = {
  "nothing crosses": () => () => 0,
  "everything crosses": () => () => N_MEMBERS,
  "peak on an interior day": (rnd, days) => {
    const at = 2 + Math.floor(rnd() * Math.max(1, days - 2)), top = 20 + Math.floor(rnd() * 200);
    return (d) => Math.max(0, Math.round(top - Math.abs(d - at) * (top / days) * 2));
  },
  "rising": (rnd) => { const top = Math.floor(rnd() * 222); return (d, days) => Math.round((top * d) / days); },
  "falling": (rnd) => { const top = Math.floor(rnd() * 222); return (d, days) => Math.round((top * (days - d)) / days); },
  "random per day": () => (_d, _days, r) => Math.floor(r() * 222),
  "plateau (ties)": (rnd) => { const k = 1 + Math.floor(rnd() * 220); return () => k; },
  "one member on one day": (rnd, days) => { const at = 1 + Math.floor(rnd() * days); return (d) => (d === at ? 1 : 0); },
  "all but one member": (rnd, days) => { const at = 1 + Math.floor(rnd() * days); return (d) => (d === at ? 220 : 0); },
};

/** One synthetic FLARE run: every FLARE variable at both sites, days 1..35, at `depthM`. */
function syntheticRun(
  depthM: number, riskVar: string, threshold: number, direction: "above" | "below",
  shape: Shape, rnd: () => number,
): ForecastRecord[] {
  const out: ForecastRecord[] = [];
  for (const siteId of ["fcre", "bvre"]) {
    for (const variable of ["Temp_C_mean", "DO_mgL_mean", "Chla_ugL_mean"]) {
      for (let h = 1; h <= 35; h++) {
        let members: number[];
        if (variable === riskVar) {
          const k = Math.max(0, Math.min(N_MEMBERS, shape(h, 35, rnd)));
          const side = (cross: boolean) => {
            const gap = 0.05 + rnd() * 3;
            return (direction === "below") === cross ? threshold - gap : threshold + gap;
          };
          members = Array.from({ length: N_MEMBERS }, (_, i) => side(i < k));
        } else {
          const centre = variable === "Temp_C_mean" ? 18 : variable === "DO_mgL_mean" ? 7 : 8;
          members = Array.from({ length: N_MEMBERS }, () => centre + (rnd() - 0.5) * 4);
        }
        members.sort((a, b) => a - b);
        const q = (p: number) => members[Math.min(N_MEMBERS - 1, Math.floor(p * N_MEMBERS))];
        out.push({
          modelId: "glm_aed_flare_v3", siteId, variable, referenceDate: "2026-01-01",
          targetDate: new Date(Date.UTC(2026, 0, 1 + h)).toISOString().slice(0, 10), horizon: h,
          mean: members.reduce((s, v) => s + v, 0) / N_MEMBERS,
          quantile02_5: q(0.025), quantile10: q(0.1), quantile90: q(0.9), quantile97_5: q(0.975),
          members, depthM,
        });
      }
    }
  }
  return out;
}

/** What fetchFlareMultiSite returns for a variable list: the cached run filtered by
 *  site, variable and horizon (flare-reader.ts fetchFlareForecasts). */
function fetchView(run: ForecastRecord[], sites: string[], variables: string[], horizon: number) {
  return run.filter((r) => sites.includes(r.siteId) && variables.includes(r.variable) && r.horizon <= horizon);
}

/** Derived %sat records as deriveSaturationRecords emits them: same days, no members. */
function derivedSaturation(records: ForecastRecord[]): ForecastRecord[] {
  return records
    .filter((r) => r.variable === "DO_mgL_mean")
    .map((r) => ({ ...r, variable: DERIVED_SATURATION_VARIABLE, mean: r.mean * 10, quantile02_5: r.quantile02_5 * 10,
      quantile10: r.quantile10 * 10, quantile90: r.quantile90 * 10, quantile97_5: r.quantile97_5 * 10, members: undefined }));
}

function offline(): void {
  console.log("\n[offline] synthetic 221-member runs: 2 reservoirs x 2 banner decisions x horizons x probability shapes");
  const rnd = mulberry32(20261002);
  let cases = 0, withClause = 0, peakUnsampled = 0, finalShown = 0, everyDay = 0;
  const bad: string[] = [];
  const horizonsSeen = new Set<number>();

  for (const decision of Object.keys(DECISIONS) as BannerDecision[]) {
    for (const reservoir of RESERVOIRS) {
      for (const n of HORIZONS) {
        for (const [shapeName, makeShape] of Object.entries(SHAPES)) {
          for (const variant of ["plain", "+%sat", "+%sat, other variable named"] as const) {
            const { plan: planned, options } = planFor(decision, reservoir, n);
            // The %sat variants: the evidence fetch also forces DO + Temp and adds derived
            // records; the banner's fetch does not. In the last one the decision's own
            // variable reaches the evidence only as a forced input, so the banner has no
            // forecast clause and the card must not invent one.
            const saturation = variant !== "plain";
            const other = DECISIONS[decision].variable === "DO_mgL_mean" ? "Chla_ugL_mean" : "Temp_C_mean";
            const plan: LeadsQueryPlan =
              variant === "plain" ? planned
              : variant === "+%sat" ? { ...planned, variableHints: [...planned.variableHints, DERIVED_SATURATION_VARIABLE] }
              : { ...planned, variableHints: [other, DERIVED_SATURATION_VARIABLE] };
            const horizon = inferHorizon(plan.originalQuery);
            horizonsSeen.add(horizon);
            const riskVar = DECISIONS[decision].variable;
            const [threshold, direction] = riskVar === "DO_mgL_mean" ? [4, "below" as const] : [20, "above" as const];
            const run = syntheticRun(plan.resolvedDepthsM?.[0] ?? 1.6, riskVar, threshold, direction, makeShape(rnd, horizon), rnd);

            const sites = resolveForecastSites(plan);
            const variables = resolveForecastVariables(plan);
            const bannerRecords = fetchView(run, sites, variables, horizon);
            const fetchVariables = saturation ? [...new Set([...variables, "DO_mgL_mean", "Temp_C_mean"])] : variables;
            let evidenceRecords = fetchView(run, sites, fetchVariables, horizon);
            if (saturation) evidenceRecords = [...evidenceRecords, ...derivedSaturation(evidenceRecords)];

            // Banner: exactly the orchestrator's composition.
            const outlook = forecastExceedanceOutlookFromRecords(plan, bannerRecords, options);
            const banner = buildOperationalVerdictBanner(readingFor(decision), decision, outlook) ?? "";
            // Evidence: exactly retrieveForecastEvidence's composition.
            const ensembles = buildEnsembleSummaries(evidenceRecords);
            const card = buildWindowSummaryText(plan, evidenceRecords, ensembles, options, bannerDecisionFor("manager", decision) != null);
            const tag = `${decision}/${reservoir}/${horizon}d/${shapeName}/${variant}`;
            cases++;

            const nums = bannerNumbers(banner);
            if (!outlook) {
              if (banner.includes("Forecast:") || card.includes("Peak per-day")) bad.push(`${tag}: forecast line without an outlook`);
              continue;
            }
            withClause++;
            if (!nums) { bad.push(`${tag}: banner forecast clause not parseable: ${banner.slice(banner.indexOf("Forecast:"))}`); continue; }
            if (!card.includes(nums.peak)) bad.push(`${tag}: peak "${nums.peak}" missing from evidence`);
            if (nums.final && !card.includes(nums.final)) bad.push(`${tag}: final-day "${nums.final}" missing from evidence`);
            if (nums.final) finalShown++;
            if (nums.peak.endsWith("every day")) everyDay++;
            // The evidence path's own outlook is the banner's (the filter keeps extras out).
            const evidenceOutlook = forecastExceedanceOutlookFromRecords(plan, evidenceRecords, options);
            if (JSON.stringify(evidenceOutlook) !== JSON.stringify(outlook)) bad.push(`${tag}: evidence outlook differs from banner outlook`);

            // Sampled day cards: same days as the reference sampling rule.
            const series = ensembles.filter((e: EnsembleSummary) => e.variable === outlook.variable && e.siteId === sites[0])
              .map((e) => e.horizon).sort((a, b) => a - b);
            const want = sampledDaysOLD(series);
            const items = buildPerVariableForecastItems("summary", ensembles, evidenceRecords, options.decision, options.reservoir, horizon, options.persona)
              .filter((i) => i.variable === outlook.variable && i.siteId === sites[0]);
            const got = items.map((i) => i.horizonForItem);
            if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${tag}: sampled days moved: ${got} vs ${want}`);
            if (!nums.peak.endsWith("every day") && !want.includes(outlook.peakHorizonDay)) peakUnsampled++;

            // Window-summary wording: daily-mean extremes are the true ones; envelope named.
            const means = ensembles.filter((e) => e.variable === outlook.variable && e.siteId === sites[0]);
            const lo = means.reduce((a, e) => (e.ensembleMean < a.ensembleMean ? e : a));
            const hi = means.reduce((a, e) => (e.ensembleMean > a.ensembleMean ? e : a));
            const extremes = `daily means: lowest ${lo.ensembleMean.toFixed(2)} (day ${lo.horizon}), highest ${hi.ensembleMean.toFixed(2)} (day ${hi.horizon})`;
            if (!card.includes(extremes)) bad.push(`${tag}: card lacks "${extremes}"`);
            if (!card.includes("2.5–97.5% envelope across days:") || /\(range /.test(card)) bad.push(`${tag}: envelope not labelled`);
            if (!card.startsWith("FLARE")) bad.push(`${tag}: card does not start with "FLARE"`);
          }
        }
      }
    }
  }

  console.log(`[offline] ${cases} cases (${withClause} with a forecast clause); horizons {${[...horizonsSeen].sort((a, b) => a - b).join(", ")}}`);
  console.log(`[offline] peak on an unsampled day: ${peakUnsampled}; final-day value shown: ${finalShown}; nothing crossed on any day: ${everyDay}`);
  check("offline: banner peak (and final-day) strings appear verbatim in the window-summary evidence", bad.length === 0,
    bad.slice(0, 4).join(" | "));
  check("offline: the invariant was exercised (peaks on unsampled days, final-day values, all-zero runs)",
    peakUnsampled > 0 && finalShown > 0 && everyDay > 0 && horizonsSeen.size >= 4);

  // Pairs with no banner (another decision, or another persona): no peak line on the card.
  const noBanner: string[] = [];
  let negCases = 0, wouldHaveLine = 0;
  for (const persona of ["manager", "researcher"] as const) {
    for (const decision of ["hypoxia_management", "water_extraction", "flow_management", "algal_management"] as DecisionKey[]) {
      if (bannerDecisionFor(persona, decision)) continue;
      for (const reservoir of RESERVOIRS) {
        const profile = { persona, reservoir, depth: "hypolimnion", decision, summary: "" } as LeadsProfile;
        const plan = planLeadsQuery(`What is the 14-day forecast at ${reservoir.toUpperCase()}?`, profile);
        const horizon = inferHorizon(plan.originalQuery);
        const run = syntheticRun(plan.resolvedDepthsM?.[0] ?? 1.6, "DO_mgL_mean", 4, "below", SHAPES["random per day"](rnd, horizon), rnd);
        const fetchVariables = [...new Set([...resolveForecastVariables(plan), "DO_mgL_mean", "Temp_C_mean"])];
        const records = fetchView(run, resolveForecastSites(plan), fetchVariables, horizon);
        const options = { decision, reservoir, persona };
        const card = buildWindowSummaryText(plan, records, buildEnsembleSummaries(records), options, bannerDecisionFor(persona, decision) != null);
        negCases++;
        if (forecastExceedanceOutlookFromRecords(plan, records, options)) wouldHaveLine++;
        if (card.includes("Peak per-day")) noBanner.push(`${persona}/${decision}/${reservoir}`);
        if (!card.startsWith("FLARE")) noBanner.push(`${persona}/${decision}/${reservoir}: card does not start with "FLARE"`);
      }
    }
  }
  console.log(`[offline] ${negCases} no-banner cases (${wouldHaveLine} would have had a peak line without the gate)`);
  check("offline: no peak line where no banner can be drawn (other decisions, other personas)",
    noBanner.length === 0 && wouldHaveLine > 0, noBanner.slice(0, 4).join(" | "));
  const orch = readFileSync("lib/leads/orchestrator.ts", "utf8");
  check("orchestrator: retrieval's peak-line flag and the banner use the same predicate",
    orch.includes("bannerPeakLine: bannerDecisionFor(options.leadsProfile?.persona, operationalDecision) != null") &&
    orch.includes("const bannerDecision = bannerDecisionFor(options.leadsProfile?.persona, operationalDecision);"));
}

// 2. Live: archived public FLARE runs

const DEFAULT_DATES = ["2026-05-20", "2026-06-20", "2026-07-15", "2026-08-10", "2026-09-05"];

async function liveRun(): Promise<void> {
  const ref = process.env.LEADS_FLARE_REFERENCE_DATE;
  let ran = 0;
  for (const decision of Object.keys(DECISIONS) as BannerDecision[]) {
    for (const reservoir of RESERVOIRS) {
      for (const n of [7, 14, 21, 30]) {
        const { plan, options } = planFor(decision, reservoir, n);
        const outlook = await computeForecastExceedanceOutlook(plan, options);
        const evidence = await retrieveForecastEvidence(plan, { ...options, bannerPeakLine: bannerDecisionFor("manager", decision) != null });
        const horizon = inferHorizon(plan.originalQuery);
        const tag = `ref ${ref} ${decision}/${reservoir}/${horizon}d`;
        if (!outlook || evidence.length === 0) {
          // e.g. BVR has no manager hypoxia rule, so its banner never has a forecast clause.
          console.log(`SKIP  ${tag}: no outlook (no forecastable rule for this decision, or no FLARE data)`);
          continue;
        }
        ran++;
        const card = evidence.find((e) => e.id.startsWith("forecast:flare:") && e.id.endsWith(`:${horizon}d`) && !/:(quantiles|json):/.test(e.id));
        const banner = buildOperationalVerdictBanner(readingFor(decision), decision, outlook) ?? "";
        const nums = bannerNumbers(banner);
        const sampled = evidence.filter((e) => /:h\d+$/.test(e.id) && e.id.includes(`:${outlook.variable}:`))
          .map((e) => Number(e.id.split(":h").pop()));
        const where = nums?.peak.endsWith("every day") ? "every day" : sampled.includes(outlook.peakHorizonDay) ? "sampled day" : "UNSAMPLED day";
        check(`${tag}: peak ${nums?.peak ?? "?"} (${where}) in evidence`,
          !!card && !!nums && card.text.includes(nums.peak) && (!nums.final || card.text.includes(nums.final)),
          nums?.final ? `final ${nums.final}` : "");
      }
    }
  }
  if (ran === 0) check(`ref ${ref}: at least one case had forecast data`, false);
}

function live(): void {
  const arg = process.argv.find((a) => a.startsWith("--dates="));
  const dates = arg ? arg.slice("--dates=".length).split(",").filter(Boolean) : DEFAULT_DATES;
  console.log(`\n[live] archived FLARE runs: ${dates.join(", ")} (network, no model calls)`);
  for (const d of dates) {
    const r = spawnSync("npx", ["tsx", __filename, "--live-run"], {
      env: { ...process.env, LEADS_FLARE_REFERENCE_DATE: d },
      stdio: "inherit",
    });
    if (r.status !== 0) { failures++; console.log(`FAIL  reference date ${d}: child exited ${r.status}`); }
  }
}

// Main
(async () => {
  if (process.argv.includes("--live-run")) {
    await liveRun();
  } else {
    offline();
    if (process.argv.includes("--live")) live();
  }
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
