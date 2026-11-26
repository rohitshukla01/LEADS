/**
 * Forecast retrieval channel for LEADS.
 *
 * Fetches the FLARE GLM-AED 221-member ensemble from a single Hive-partitioned
 * parquet file on OSN, computes ensemble statistics and threshold-crossing
 * probabilities, and returns LeadsEvidence[] conforming to the standard channel
 * contract used by the orchestrator.
 *
 * Data source:
 *   OSN bucket: bio230121-bucket01/flare/forecasts/parquet/
 *   Model:      glm_aed_flare_v3
 *   Endpoint:   https://amnh1.osn.mghpcc.org
 *
 * Methodological basis:
 *   Carey et al. 2022 - FLARE lake forecasting system
 *   Thomas et al. 2023 - Ecological Forecasting Challenge
 *   Gneiting & Raftery 2007 - Strictly proper scoring rules, prediction, and estimation
 */

import {
  LEADS_FLARE_BASE_URL,
  LEADS_FLARE_MODEL_ID,
  LEADS_FLARE_SITE,
  LEADS_FORECAST_REPRESENTATION,
  LEADS_FORECAST_VARIABLES,
  LEADS_FORECAST_SITES,
  LEADS_RISK_THRESHOLDS,
  type ForecastRepresentation,
} from "./config";
import { variablesMentioned } from "./alias-match";
import { doPercentSaturation } from "./do-saturation";
import { buildEnsembleSummaries, exceedanceProbability, formatEnsembleProbability } from "./ensemble";
import { fetchFlareMultiSite, computeMemberPersistence } from "./flare-reader";
import { DEPTH_ZONE_MAPPING, getPersonaRule, type DecisionKey, type Persona } from "./guardrails";
import { inferHorizon } from "./horizon";
import type {
  EnsembleSummary,
  ForecastRecord,
  LeadsEvidence,
  LeadsQueryPlan,
  LeadsReservoir,
} from "./types";

// Variable / site / horizon resolution

export function resolveForecastVariables(plan: LeadsQueryPlan): string[] {
  const resolved = plan.variableHints.filter((v) =>
    (LEADS_FORECAST_VARIABLES as readonly string[]).includes(v)
  );
  if (resolved.length > 0) return resolved;

  // Same matcher as the planner (alias-match.ts), so a word such as "does" is not
  // read as dissolved oxygen.
  const inferred = variablesMentioned(plan.originalQuery).filter((v) =>
    (LEADS_FORECAST_VARIABLES as readonly string[]).includes(v)
  );
  return inferred.length > 0 ? inferred : ["Temp_C_mean", "DO_mgL_mean", "Chla_ugL_mean"];
}

export function resolveForecastSites(plan: LeadsQueryPlan): string[] {
  const sites = plan.siteHints.filter((s) =>
    (LEADS_FORECAST_SITES as readonly string[]).includes(s)
  );
  return sites.length > 0 ? sites : [LEADS_FLARE_SITE];
}

// Derived DO % saturation (forecast side only)
//
// FLARE has no native saturation variable, so when a query needs forecast DO
// %sat (researcher hypoxia / water extraction), it is derived from the paired
// FLARE DO (mg/L) and Temp (°C) forecasts via García–Benson at 1 atm
// (see lib/leads/do-saturation.ts; the sensor side reads native DOsat_percent_mean).
//
// Pairing key: (siteId, referenceDate, targetDate, horizon, depthM). For each
// matched DO record the mean and every quantile are converted to %sat using that
// day's forecast temperature mean as the solubility denominator. This propagates
// the DO ensemble spread into the %sat band exactly (the map is monotone in DO, so
// quantile ordering is preserved) while folding temperature uncertainty into the
// mean, which is an approximation. Pairing DO and Temp member by member would need
// raw-member access, which this channel does not retrieve.
export const DERIVED_SATURATION_VARIABLE = "DOsat_percent_mean";

function recordKey(r: ForecastRecord): string {
  return `${r.siteId}|${r.referenceDate}|${r.targetDate}|${r.horizon}|${r.depthM}`;
}

function deriveSaturationRecords(records: ForecastRecord[]): ForecastRecord[] {
  const tempByKey = new Map<string, ForecastRecord>();
  for (const r of records) {
    if (r.variable === "Temp_C_mean") tempByKey.set(recordKey(r), r);
  }

  const derived: ForecastRecord[] = [];
  for (const doRec of records) {
    if (doRec.variable !== "DO_mgL_mean") continue;
    const temp = tempByKey.get(recordKey(doRec));
    if (!temp) continue;
    const t = temp.mean;
    const mean = doPercentSaturation(doRec.mean, t);
    const q025 = doPercentSaturation(doRec.quantile02_5, t);
    const q10 = doPercentSaturation(doRec.quantile10, t);
    const q90 = doPercentSaturation(doRec.quantile90, t);
    const q975 = doPercentSaturation(doRec.quantile97_5, t);
    if (mean == null || q025 == null || q10 == null || q90 == null || q975 == null) continue;
    derived.push({
      modelId: doRec.modelId,
      siteId: doRec.siteId,
      variable: DERIVED_SATURATION_VARIABLE,
      referenceDate: doRec.referenceDate,
      targetDate: doRec.targetDate,
      horizon: doRec.horizon,
      mean,
      quantile02_5: q025,
      quantile10: q10,
      quantile90: q90,
      quantile97_5: q975,
      depthM: doRec.depthM,
    });
  }
  return derived;
}

// Evidence text formatting

function formatEnsembleText(summaries: EnsembleSummary[]): string {
  // No aggregate risk text: hypoxia/bloom risk is carried only by the
  // per-horizon-day threshold-crossing probabilities in the per-variable items,
  // so the same calculation applies at every horizon and no whole-window figure
  // can contradict the per-day values.
  if (summaries.length === 0) return "No FLARE forecast data available.";

  const parts: string[] = [];

  const byVarSite = new Map<string, EnsembleSummary[]>();
  for (const s of summaries) {
    const key = `${s.variable}|${s.siteId}`;
    const arr = byVarSite.get(key) ?? [];
    arr.push(s);
    byVarSite.set(key, arr);
  }

  for (const [key, group] of byVarSite) {
    const [variable, siteId] = key.split("|");
    const sorted = group.sort((a, b) => a.horizon - b.horizon);
    const maxH = sorted[sorted.length - 1].horizon;

    const meanAcross = sorted.reduce((s, e) => s + e.ensembleMean, 0) / sorted.length;
    const minBound = Math.min(...sorted.map((e) => e.lowerBound));
    const maxBound = Math.max(...sorted.map((e) => e.upperBound));
    const avgSpread = sorted.reduce((s, e) => s + e.ensembleSpread, 0) / sorted.length;
    // Lowest and highest daily mean, with their days, stated separately from the
    // 2.5–97.5% envelope so the envelope is not read as a range of daily means.
    const lowest = sorted.reduce((a, e) => (e.ensembleMean < a.ensembleMean ? e : a));
    const highest = sorted.reduce((a, e) => (e.ensembleMean > a.ensembleMean ? e : a));

    parts.push(
      `FLARE GLM-AED ${maxH}-day forecast for ${siteId.toUpperCase()} ${variable}: ` +
      `mean ${meanAcross.toFixed(2)} (2.5–97.5% envelope across days: ${minBound.toFixed(2)}–${maxBound.toFixed(2)}), ` +
      `daily means: lowest ${lowest.ensembleMean.toFixed(2)} (day ${lowest.horizon}), ` +
      `highest ${highest.ensembleMean.toFixed(2)} (day ${highest.horizon}), ` +
      `ensemble spread ${avgSpread.toFixed(2)}, 221-member ensemble.`
    );
  }

  return parts.join(" ");
}

function unitFor(variable: string): string {
  if (variable.includes("sat")) return "% sat"; // DOsat_percent_mean (derived)
  if (variable.includes("Temp")) return "°C";
  if (variable.includes("Chla")) return "µg/L";
  if (variable.includes("Bloom")) return "";
  if (variable.includes("fDOM")) return "QSU";
  if (variable.includes("Turbidity")) return "FNU";
  return "mg/L";
}

/**
 * Resolve the threshold + direction for a forecast variable.
 *
 * Lookup order:
 *   1. Per-persona operational constraint (`rules_by_persona`) - matched by exact
 *      observation variable so units line up with the series (e.g. the researcher
 *      %sat threshold applies to the derived DOsat_percent_mean series, not the
 *      DO_mgL_mean input). This is the operational threshold.
 *   2. LEADS_RISK_THRESHOLDS - literature defaults with citations
 *      (EPA / WHO / Wetzel etc., see config.ts) for ancillary variables.
 *   3. null - the caller omits threshold-crossing text; no threshold is invented.
 */
function resolveThreshold(
  variable: string,
  decision?: DecisionKey,
  reservoir?: LeadsReservoir,
  persona?: Persona,
): { value: number; direction: "above" | "below"; units: string; source: string } | null {
  if (persona && decision && decision !== "none" && reservoir) {
    const rule = getPersonaRule(reservoir, decision, persona);
    const c = rule?.constraints.find((cc) => cc.variable === variable);
    if (c) {
      return {
        value: c.value,
        direction: c.op.startsWith(">") ? "above" : "below",
        units: c.units,
        source: c.source_citation ?? "LEADS operational guardrail",
      };
    }
  }
  const fallback = LEADS_RISK_THRESHOLDS[variable];
  if (fallback) {
    return {
      value: fallback.threshold,
      direction: fallback.direction,
      units: unitFor(variable),
      source: fallback.source,
    };
  }
  return null;
}

/** Max summary cards per (variable, site). Kept small: the fused evidence packet
 *  holds 16 items shared by literature, sensor and forecast evidence (fusion.ts),
 *  so a full daily series per variable would crowd out the other channels and be
 *  re-truncated by fusion's score sort. 4 sampled points (e.g. d1, d3, d5, d7)
 *  capture near-term, trend and endpoint. `selectHorizonDays` guarantees day 1 and
 *  the final day are always among them. */
const MAX_SUMMARY_DAYS_PER_VAR = 4;

/**
 * Pick which horizon days to surface for one (variable, site) series.
 *
 * Invariant: the first and last day are always retained - for a risk
 * decision the end of the window carries the signal, so it must never be
 * dropped. When the series is longer than `maxDays`, intermediate days are
 * sampled at even index spacing. Input must be sorted by horizon ascending.
 */
function selectHorizonDays(
  sorted: EnsembleSummary[],
  maxDays: number,
): EnsembleSummary[] {
  if (sorted.length <= maxDays) return sorted;

  const lastIdx = sorted.length - 1;
  const picked = new Set<number>([0, lastIdx]); // always day 1 + final day
  // Distribute the remaining budget evenly across the interior.
  const remaining = maxDays - picked.size;
  for (let i = 1; i <= remaining; i++) {
    const idx = Math.round((i * lastIdx) / (remaining + 1));
    picked.add(idx);
  }
  return Array.from(picked).sort((a, b) => a - b).map((i) => sorted[i]);
}

/**
 * Per-(variable, site) forecast formatter; the strategy is the forecast-
 * representation ablation variable (LEADS_FORECAST_REPRESENTATION).
 *
 * Strategy (a) summary: one item per (variable, site, horizon day) - the
 *   default layout. Mean / range / spread, plus threshold-crossing
 *   probability when a threshold is resolvable. Prose form.
 *
 * Strategy (b) quantiles: one item per (variable, site) covering all horizon
 *   days. Per-day quantile band table (q02.5 / q10 / q90 / q97.5) - preserves
 *   the tail shape needed for distributional reasoning. Prose form.
 *
 * Strategy (c) json: same data as (b), wrapped in a JSON object so the model
 *   parses structured fields rather than scanning prose. One item per
 *   (variable, site).
 *
 * The window-summary card (formatEnsembleText) is the same under all three
 * strategies; only the per-(variable, site) detail changes, which is where the
 * model reasons over forecast values.
 */
export function buildPerVariableForecastItems(
  strategy: ForecastRepresentation,
  ensembles: EnsembleSummary[],
  records: ForecastRecord[],
  decision: DecisionKey | undefined,
  reservoir: LeadsReservoir | undefined,
  horizon: number,
  persona: Persona | undefined,
): Array<{
  id: string;
  title: string;
  text: string;
  score: number;
  siteId: string;
  variable: string;
  horizonForItem: number;
  representation: ForecastRepresentation;
}> {
  // The forecast for the decision's own threshold variable (the persona-constraint
  // variable - e.g. for researcher hypoxia, the derived DOsat_percent_mean series, not
  // the raw DO_mgL_mean input) must outrank ancillary forecasts so fusion's capped
  // sensor+forecast slots keep it. Score it above the window-summary card (0.92)
  // and ancillary items (0.85).
  const personaVars =
    persona && decision && decision !== "none" && reservoir
      ? new Set((getPersonaRule(reservoir, decision, persona)?.constraints ?? []).map((c) => c.variable))
      : new Set<string>();
  const scoreFor = (variable: string): number => (personaVars.has(variable) ? 0.95 : 0.85);

  const inHorizon = ensembles.filter((e) => e.horizon <= horizon);

  if (strategy === "summary") {
    // (a) - one item per (variable, site, selected horizon day).
    //
    // Days are selected per (variable, site), always including day 1 and the
    // final day and sampling evenly in between, so the end of the window (where a
    // hypoxia decision's risk may sit) always reaches the model and long horizons
    // stay token-bounded.
    const bySite = new Map<string, EnsembleSummary[]>();
    for (const s of inHorizon) {
      const key = `${s.variable}|${s.siteId}`;
      const arr = bySite.get(key) ?? [];
      arr.push(s);
      bySite.set(key, arr);
    }

    const items: Array<{
      id: string; title: string; text: string; score: number;
      siteId: string; variable: string; horizonForItem: number;
      representation: ForecastRepresentation;
    }> = [];

    for (const [, group] of bySite) {
      const sorted = group.sort((a, b) => a.horizon - b.horizon);
      const selected = selectHorizonDays(sorted, MAX_SUMMARY_DAYS_PER_VAR);
      for (const summary of selected) {
        const thr = resolveThreshold(summary.variable, decision, reservoir, persona);
        const u = unitFor(summary.variable);
        let probSuffix = "";
        if (thr) {
          const slice = records.filter(
            (r) => r.variable === summary.variable && r.siteId === summary.siteId && r.horizon === summary.horizon,
          );
          if (slice.length > 0) {
            const exc = exceedanceProbability(slice, thr.value, thr.direction);
            const sign = thr.direction === "below" ? "<" : ">";
            // Say which day the probability belongs to. Without it the synthesiser
            // reads a single-lead exceedance as a whole-window one and writes "at some
            // point during this period", which is a different and larger quantity - the
            // wrong answer to a question about forecast confidence.
            // Printed as a member count (formatEnsembleProbability), never a bare "0%";
            // a slice spanning several depths is labelled pooled, with no member count.
            probSuffix = ` P(${summary.variable} ${sign} ${thr.value} ${thr.units}) = ${formatEnsembleProbability(exc.crossingMembers, exc.totalMembers, exc.probability, exc.pooledDepths)} on day ${summary.horizon} (probability on that day, NOT cumulative across the horizon) [source: ${thr.source}].`;
          }
        }
        const depthsForItem = [...new Set(
          records
            .filter((r) => r.variable === summary.variable && r.siteId === summary.siteId && r.horizon === summary.horizon)
            .map((r) => r.depthM),
        )];
        const depthForItem = depthsForItem.length === 1 ? depthsForItem[0] : null;
        items.push({
          id: `forecast:flare:${summary.variable}:${summary.siteId}:h${summary.horizon}`,
          title: `FLARE ${summary.siteId.toUpperCase()} ${summary.variable} ${summary.horizon}-day`,
          text:
            // State the depth, so a surface forecast is not quoted for a deeper layer
            // (e.g. the metalimnion) and forecasts for different depths on the same
            // day can be told apart.
            `FLARE ${summary.horizon}-day forecast for ${summary.siteId.toUpperCase()} ` +
            `${summary.variable}${depthForItem != null ? ` at ${depthForItem} m` : ""}: ` +
            `mean ${summary.ensembleMean.toFixed(2)} ${u} ` +
            `(${summary.lowerBound.toFixed(2)}–${summary.upperBound.toFixed(2)}), ` +
            `spread ${summary.ensembleSpread.toFixed(2)}, 221-member ensemble.${probSuffix}`,
          // Flat score across the sampled days (no horizon decay), so they survive
          // fusion's score sort together, including the final day a risk decision
          // needs most. The persona-constraint variable scores higher so the
          // decision's own threshold series is not evicted.
          score: scoreFor(summary.variable),
          siteId: summary.siteId,
          variable: summary.variable,
          horizonForItem: summary.horizon,
          representation: strategy,
        });
      }
    }
    return items;
  }

  // (b) and (c): group by (variable, site), emit one richer item per group.
  const groups = new Map<string, EnsembleSummary[]>();
  for (const s of inHorizon) {
    const key = `${s.variable}|${s.siteId}`;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }

  const items = [];
  for (const [key, group] of groups) {
    const sorted = group.sort((a, b) => a.horizon - b.horizon);
    const [variable, siteId] = key.split("|");
    const maxH = sorted[sorted.length - 1].horizon;
    const thr = resolveThreshold(variable, decision, reservoir, persona);
    const u = unitFor(variable);

    // Per-day records for this (variable, site), one per horizon day.
    const perDayRecords = sorted
      .map((s) => {
        const slice = records.filter(
          (r) => r.variable === variable && r.siteId === siteId && r.horizon === s.horizon,
        );
        return { summary: s, records: slice };
      });

    let probLine = "";
    if (thr) {
      const allDayRecords = perDayRecords.flatMap((d) => d.records);
      if (allDayRecords.length > 0) {
        const exc = exceedanceProbability(allDayRecords, thr.value, thr.direction);
        const sign = thr.direction === "below" ? "<" : ">";
        probLine = `Peak daily P(${variable} ${sign} ${thr.value} ${thr.units}) over the next ${maxH}d = ${formatEnsembleProbability(exc.crossingMembers, exc.totalMembers, exc.probability, exc.pooledDepths)} [source: ${thr.source}].`;
      }
    }

    if (strategy === "quantiles") {
      // (b) - per-day quantile band table.
      const header =
        `FLARE ${maxH}-day forecast for ${siteId.toUpperCase()} ${variable} ` +
        `(221-member ensemble, quantile bands per horizon day, q02.5 / q10 / q90 / q97.5):`;
      const lines = perDayRecords.map(({ summary, records: dayRecs }) => {
        if (dayRecs.length === 0) {
          return `  d${summary.horizon}: mean ${summary.ensembleMean.toFixed(2)} ${u} | bands [n/a]`;
        }
        const r = dayRecs[0];
        return (
          `  d${summary.horizon}: mean ${summary.ensembleMean.toFixed(2)} ${u} | ` +
          `bands [${r.quantile02_5.toFixed(2)}, ${r.quantile10.toFixed(2)}, ${r.quantile90.toFixed(2)}, ${r.quantile97_5.toFixed(2)}]`
        );
      });
      items.push({
        id: `forecast:flare:${variable}:${siteId}:quantiles:${maxH}d`,
        title: `FLARE ${siteId.toUpperCase()} ${variable} quantile bands (${maxH}-day)`,
        text: [header, ...lines, probLine].filter(Boolean).join("\n"),
        score: scoreFor(variable),
        siteId,
        variable,
        horizonForItem: maxH,
        representation: strategy,
      });
    } else {
      // (c) - structured JSON.
      const perDay = perDayRecords.map(({ summary, records: dayRecs }) => {
        const r = dayRecs[0];
        return {
          d: summary.horizon,
          target_date: summary.targetDate,
          mean: Number(summary.ensembleMean.toFixed(3)),
          q025: r ? Number(r.quantile02_5.toFixed(3)) : null,
          q10:  r ? Number(r.quantile10.toFixed(3))  : null,
          q90:  r ? Number(r.quantile90.toFixed(3))  : null,
          q975: r ? Number(r.quantile97_5.toFixed(3)) : null,
        };
      });
      const allDayRecords = perDayRecords.flatMap((d) => d.records);
      const exc = thr && allDayRecords.length > 0
        ? exceedanceProbability(allDayRecords, thr.value, thr.direction)
        : null;
      const thresholdField = thr && exc
        ? {
            value: thr.value,
            units: thr.units,
            direction: thr.direction,
            crossing_probability: Number(exc.probability.toFixed(3)),
            // The count behind crossing_probability, and how to print it.
            // Null when the days pool several depths (no single-ensemble count).
            crossing_members: exc.crossingMembers ?? null,
            total_members: exc.totalMembers ?? null,
            report_as: formatEnsembleProbability(exc.crossingMembers, exc.totalMembers, exc.probability, exc.pooledDepths),
            source: thr.source,
          }
        : null;
      const payload = {
        site: siteId.toUpperCase(),
        variable,
        units: u,
        horizon_days: maxH,
        reference_date: records[0]?.referenceDate ?? null,
        ensemble_size: 221,
        model_id: LEADS_FLARE_MODEL_ID,
        per_day: perDay,
        threshold: thresholdField,
      };
      items.push({
        id: `forecast:flare:${variable}:${siteId}:json:${maxH}d`,
        title: `FLARE ${siteId.toUpperCase()} ${variable} JSON forecast (${maxH}-day)`,
        text: JSON.stringify(payload),
        score: scoreFor(variable),
        siteId,
        variable,
        horizonForItem: maxH,
        representation: strategy,
      });
    }
  }
  return items.slice(0, 6);
}

/** Deterministic forecast outlook for the operational verdict banner. */
export interface ForecastExceedanceOutlook {
  variable: string;
  thresholdValue: number;
  units: string;
  direction: "above" | "below";
  /** Peak single-day threshold-crossing probability over the horizon (0..1). */
  peakProbability: number;
  /** The horizon day (1..N) at which the peak occurs. */
  peakHorizonDay: number;
  /** Forecast horizon in days (N). */
  horizon: number;
  /** Members behind the peak; undefined for the Gaussian fallback (no members) and when
   *  the day pools several depths (then peakPooledDepths is set). */
  peakCrossingMembers?: number;
  peakTotalMembers?: number;
  peakPooledDepths?: number;
  /** The last forecast day scanned (normally N) and its probability, so a peak that
   *  falls earlier is shown next to the value at the end of the window. */
  finalHorizonDay: number;
  finalProbability: number;
  finalCrossingMembers?: number;
  finalTotalMembers?: number;
  finalPooledDepths?: number;
}

/** True when no day in the window has any probability (no member crossed on any day). */
function outlookIsAllZero(o: ForecastExceedanceOutlook): boolean {
  return o.peakCrossingMembers != null ? o.peakCrossingMembers === 0 : o.peakProbability === 0;
}

/** "<probability> on day D" for the peak - the exact string the banner and the
 *  window-summary evidence both print. With nothing on any day it says "on every day". */
function outlookPeakPhrase(o: ForecastExceedanceOutlook): string {
  const p = formatEnsembleProbability(o.peakCrossingMembers, o.peakTotalMembers, o.peakProbability, o.peakPooledDepths);
  return outlookIsAllZero(o) ? `${p} on every day` : `${p} on day ${o.peakHorizonDay}`;
}

/** The final-day value, or null when the peak is the final day, when nothing crossed, or
 *  when the final day prints the same value as the peak (a tie): repeating one number on
 *  two days would read as a peak followed by a drop that does not happen. */
function outlookFinalPhrase(o: ForecastExceedanceOutlook): string | null {
  if (outlookIsAllZero(o) || o.finalHorizonDay === o.peakHorizonDay) return null;
  const p = formatEnsembleProbability(o.finalCrossingMembers, o.finalTotalMembers, o.finalProbability, o.finalPooledDepths);
  const peak = formatEnsembleProbability(o.peakCrossingMembers, o.peakTotalMembers, o.peakProbability, o.peakPooledDepths);
  if (p === peak) return null;
  return `${p} on day ${o.finalHorizonDay}`;
}

/**
 * The line appended to the window-summary evidence card. The banner scans every day of
 * the horizon, while the model reads only the sampled day cards, so a peak on an
 * unsampled day would otherwise be missing from the evidence. This line puts the
 * banner's numbers - peak, and the final day when the peak is earlier - in the
 * evidence, built from the same outlook object.
 */
export function formatForecastPeakLine(o: ForecastExceedanceOutlook): string {
  const sign = o.direction === "below" ? "<" : ">";
  const fin = outlookFinalPhrase(o);
  return (
    `Peak per-day P(${o.variable} ${sign} ${o.thresholdValue} ${o.units}) over days 1–${o.horizon} = ` +
    `${outlookPeakPhrase(o)} (per-day, not cumulative)${fin ? `; ${fin}` : ""}.`
  );
}

/**
 * The banner's forecast clause. `varLabel` is the banner's short variable name. Every
 * branch keeps a "Forecast:" prefix (parseVerdict splits on it) and a probability token
 * the PDF accepts (deriveExceedanceProb in report-content.ts).
 */
export function formatForecastOutlookClause(o: ForecastExceedanceOutlook, varLabel: string): string {
  const sign = o.direction === "below" ? "<" : ">";
  const pStr = `P(${varLabel} ${sign} ${o.thresholdValue} ${o.units})`;
  if (outlookIsAllZero(o)) return `Forecast: ${pStr} is ${outlookPeakPhrase(o)} of the ${o.horizon}-day outlook.`;
  const fin = outlookFinalPhrase(o);
  return `Forecast: ${pStr} peaks at ${outlookPeakPhrase(o)} of ${o.horizon}${fin ? `; ${fin}` : ""}.`;
}

/**
 * FLARE layers to read for a plan. A full-profile decision (water extraction) resolves
 * no single depth, and an unfiltered read returns FLARE's 0 m layer, which no sensor
 * observes. Such plans read the reservoir's surface sensor depth instead
 * (DEPTH_ZONE_MAPPING epilimnion: FCR 1.6 m, BVR 1.5 m), so the forecast describes a
 * monitored layer. Plans that resolved depths keep them; others pass no depth filter.
 */
export function forecastTargetDepths(plan: LeadsQueryPlan): number[] {
  if (plan.resolvedDepthsM && plan.resolvedDepthsM.length > 0) return plan.resolvedDepthsM;
  if (plan.resolvedDepthScope === "full_profile") {
    const site = resolveForecastSites(plan)[0];
    return [...DEPTH_ZONE_MAPPING[site === "bvre" ? "bvr" : "fcr"].epilimnion];
  }
  return plan.resolvedDepthsM ?? [];
}

/**
 * Forecast outlook for the operational verdict banner. For the decision's own
 * forecastable threshold constraint, computes the per-day FLARE threshold-crossing
 * probability across the horizon - reusing the exceedanceProbability and
 * resolveThreshold of the forecast-evidence path, and the same cached FLARE fetch
 * (fetchFlareMultiSite is memoised per site and depth for the forecast TTL, so this is
 * a cache hit, not a second network call) - and returns the peak single-day
 * probability and the day it occurs.
 *
 * The peak per-day probability is reported, not a cumulative "within N days" union,
 * which would be inconsistent with the per-day values the model reasons over. The peak
 * is one of the per-day probabilities, so the banner stays consistent with the per-day
 * evidence and the chart's plotted trajectory.
 *
 * Fail-soft: returns null when there is no forecast, no persona rule, no resolvable
 * threshold, or the threshold variable is not FLARE-forecastable - the banner then
 * omits the forecast clause.
 */
export async function computeForecastExceedanceOutlook(
  plan: LeadsQueryPlan,
  options: { decision?: DecisionKey; reservoir?: LeadsReservoir; persona?: Persona } = {},
): Promise<ForecastExceedanceOutlook | null> {
  if (!options.decision || options.decision === "none" || !options.reservoir) return null;
  if (!getPersonaRule(options.reservoir, options.decision, options.persona ?? "manager")) return null;

  const records = await fetchFlareMultiSite({
    siteIds: resolveForecastSites(plan),
    variables: resolveForecastVariables(plan),
    maxHorizonDays: inferHorizon(plan.originalQuery),
    targetDepthsM: forecastTargetDepths(plan),
  });
  return forecastExceedanceOutlookFromRecords(plan, records, options);
}

/**
 * The outlook computed from records already in hand. This is the one function behind
 * both the banner (computeForecastExceedanceOutlook, above) and the peak line on the
 * window-summary evidence card (retrieveForecastEvidence, below), so given the same
 * records and plan the two print the same numbers: same site (sites[0]), same horizon,
 * same first forecastable constraint. They are not handed one object: the banner
 * refetches after synthesis. If the in-memory FLARE cache expires in between and a newer
 * run is picked up, or a retry refines the plan while best-of-N ships an earlier
 * attempt's evidence, the banner can differ from the evidence line.
 *
 * Only the FLARE-native variables the plan resolved are considered - exactly what the
 * banner fetches. The evidence path also holds forced DO/Temp inputs and derived %sat
 * records; letting those in could make the two callers settle on different constraints.
 */
export function forecastExceedanceOutlookFromRecords(
  plan: LeadsQueryPlan,
  allRecords: ForecastRecord[],
  options: { decision?: DecisionKey; reservoir?: LeadsReservoir; persona?: Persona } = {},
): ForecastExceedanceOutlook | null {
  if (!options.decision || options.decision === "none" || !options.reservoir) return null;
  const rule = getPersonaRule(options.reservoir, options.decision, options.persona ?? "manager");
  if (!rule) return null;

  const variables = resolveForecastVariables(plan);
  const sites = resolveForecastSites(plan);
  const site = sites[0];
  if (!site) return null;
  const horizon = inferHorizon(plan.originalQuery);

  const records = allRecords.filter((r) => variables.includes(r.variable) && r.horizon <= horizon);
  if (records.length === 0) return null;
  const ensembles = buildEnsembleSummaries(records);

  for (const c of rule.constraints) {
    if (!c.forecastable) continue;
    const fvar = c.forecast_variable ?? c.variable;
    const thr = resolveThreshold(fvar, options.decision, options.reservoir, options.persona);
    if (!thr) continue;
    // True per-day peak over the horizon (matches the chart's plotted trajectory and the
    // per-day evidence; not a cumulative union). The last day scanned is kept as well.
    type Day = { horizon: number; probability: number; k?: number; n?: number; pooled?: number };
    let peak: Day | null = null;
    let final: Day | null = null;
    for (const e of ensembles) {
      if (e.variable !== fvar || e.siteId !== site || e.horizon > horizon) continue;
      const slice = records.filter(
        (r) => r.variable === fvar && r.siteId === site && r.horizon === e.horizon,
      );
      if (slice.length === 0) continue;
      const exc = exceedanceProbability(slice, thr.value, thr.direction);
      const day: Day = { horizon: e.horizon, probability: exc.probability, k: exc.crossingMembers, n: exc.totalMembers, pooled: exc.pooledDepths };
      if (!peak || exc.probability > peak.probability) peak = day;
      if (!final || e.horizon > final.horizon) final = day;
    }
    if (!peak || !final) continue;
    return {
      variable: fvar,
      thresholdValue: thr.value,
      units: thr.units,
      direction: thr.direction,
      peakProbability: peak.probability,
      peakHorizonDay: peak.horizon,
      horizon,
      peakCrossingMembers: peak.k,
      peakTotalMembers: peak.n,
      peakPooledDepths: peak.pooled,
      finalHorizonDay: final.horizon,
      finalProbability: final.probability,
      finalCrossingMembers: final.k,
      finalTotalMembers: final.n,
      finalPooledDepths: final.pooled,
    };
  }
  return null;
}

/**
 * Text of the window-summary evidence card: the per-(variable, site) summary, plus -
 * when the banner can be drawn - the banner's forecast numbers from the same outlook
 * function (formatForecastPeakLine). The sampled day cards are built separately. Exported
 * so scripts/check-banner-in-evidence.ts can build the card from records offline.
 */
export function buildWindowSummaryText(
  plan: LeadsQueryPlan,
  records: ForecastRecord[],
  ensembles: EnsembleSummary[],
  options: { decision?: DecisionKey; reservoir?: LeadsReservoir; persona?: Persona } = {},
  bannerPeakLine = false,
): string {
  // The peak line goes in only where the banner can show it (the caller decides:
  // orchestrator.ts bannerDecisionFor - manager + a bannered decision). Elsewhere it is
  // not the decision's risk: a floor constraint names the safe side, so its "peak" is the
  // most favourable day, and a rule whose constraint variable is not FLARE-native falls
  // back to a default threshold that the decision does not use.
  const outlook = bannerPeakLine ? forecastExceedanceOutlookFromRecords(plan, records, options) : null;
  return formatEnsembleText(ensembles) + (outlook ? ` ${formatForecastPeakLine(outlook)}` : "");
}

// Main channel retrieval

export async function retrieveForecastEvidence(
  plan: LeadsQueryPlan,
  options: {
    decision?: DecisionKey;
    /** Reservoir context for reservoir-conditioned threshold lookup.
     *  Propagated by the orchestrator from leadsProfile. */
    reservoir?: LeadsReservoir;
    /** Persona for per-persona threshold lookup - the forecast threshold-crossing
     *  probability uses the persona's own threshold (e.g. researcher flow
     *  P(Chla>50) vs manager P(Chla>20)). */
    persona?: Persona;
    /** True only when the operational banner can be drawn for this answer
     *  (orchestrator.ts bannerDecisionFor). Adds the banner's peak line to the
     *  window-summary card; every other caller leaves it off. */
    bannerPeakLine?: boolean;
  } = {},
): Promise<LeadsEvidence[]> {
  const variables = resolveForecastVariables(plan);
  const sites = resolveForecastSites(plan);
  // The horizon is read from the query text; `inferHorizon` defaults to 7 days
  // when the query names no time span.
  const horizon = inferHorizon(plan.originalQuery);

  // Pass the plan's depths through to FLARE so the 221-member quantiles are
  // computed at the same layers VERA observes (forecastTargetDepths: a full-profile
  // plan reads the surface sensor depth). Empty array means "no profile-driven depth
  // filter; FLARE picks surface".
  const targetDepthsM = forecastTargetDepths(plan);

  // A forecast DO %sat request (researcher hypoxia / water extraction) is met by
  // deriving %sat from FLARE DO + Temp (García–Benson). DOsat is not a FLARE-native
  // variable, so it never appears in `variables`; both inputs are fetched instead
  // and the derived series is built after the fetch.
  const wantSaturation = plan.variableHints.includes(DERIVED_SATURATION_VARIABLE);
  const fetchVariables = wantSaturation
    ? Array.from(new Set([...variables, "DO_mgL_mean", "Temp_C_mean"]))
    : variables;

  // Single FLARE fetch per site - no multi-model URL proliferation
  let records = await fetchFlareMultiSite({
    siteIds: sites,
    variables: fetchVariables,
    maxHorizonDays: horizon,
    targetDepthsM,
  });

  if (records.length === 0) return [];

  if (wantSaturation) {
    records = [...records, ...deriveSaturationRecords(records)];
  }

  const ensembles = buildEnsembleSummaries(records);
  // Risk is carried by the per-horizon-day threshold-crossing probabilities in the
  // per-variable items (`buildPerVariableForecastItems`); no aggregate
  // risk-assessment items are emitted as evidence.
  const evidence: LeadsEvidence[] = [];

  // Primary narrative evidence
  if (ensembles.length > 0) {
    const text = buildWindowSummaryText(plan, records, ensembles, options, options.bannerPeakLine === true);
    const latestRef = records.map((r) => r.referenceDate).sort().reverse()[0];

    evidence.push({
      id: `forecast:flare:${variables.join(",")}:${sites.join(",")}:${horizon}d`,
      channel: "forecast",
      title: `FLARE ${horizon}-day GLM-AED ensemble forecast`,
      text,
      score: 0.92,
      provenance: {
        type: "forecast",
        label: `${horizon}-day FLARE GLM-AED ensemble (221 members)`,
        sourceUrl: `${LEADS_FLARE_BASE_URL}/site_id=${sites[0]}/model_id=${LEADS_FLARE_MODEL_ID}/`,
        method: "flare-glm-aed-ensemble",
        modelId: LEADS_FLARE_MODEL_ID,
        horizon,
        referenceDate: latestRef,
        ensembleSize: 221,
        score: 0.92,
        representation: LEADS_FORECAST_REPRESENTATION,
      },
    });
  }

  // Per-variable/site detail items, shape determined by the forecast-representation
  // strategy. Strategy (a) emits one item per (variable, site, horizon day);
  // strategies (b) and (c) emit one richer item per (variable, site)
  // covering all horizons. The default strategy is "summary"; ablation runs
  // set the LEADS_FORECAST_REPRESENTATION env variable.
  const perVarItems = buildPerVariableForecastItems(
    LEADS_FORECAST_REPRESENTATION,
    ensembles,
    records,
    options.decision,
    options.reservoir,
    horizon,
    options.persona,
  );

  for (const item of perVarItems) {
    evidence.push({
      id: item.id,
      channel: "forecast",
      title: item.title,
      text: item.text,
      score: item.score,
      provenance: {
        type: "forecast",
        label: `FLARE ${item.siteId.toUpperCase()} ${item.variable}`,
        sourceUrl: `${LEADS_FLARE_BASE_URL}/site_id=${item.siteId}/model_id=${LEADS_FLARE_MODEL_ID}/`,
        method: "flare-glm-aed-ensemble",
        modelId: LEADS_FLARE_MODEL_ID,
        horizon: item.horizonForItem,
        ensembleSize: 221,
        siteId: item.siteId,
        variable: item.variable,
        score: item.score,
        representation: item.representation,
      },
    });
  }

  // Member-level persistence forecast: for a decision with a consecutive-day
  // persistence constraint (flow_management: chl-a sustained ≥7 d), forecast
  // P(threshold sustained ≥ N consecutive days) from the FLARE ensemble. Fails
  // open; only emitted when a persistence constraint exists. Uses the decision's
  // own constraint (variable/threshold/op/days) so it tracks the guardrail.
  let persistenceAdded = false;
  if (options.decision && options.decision !== "none" && options.reservoir) {
    const rule = getPersonaRule(options.reservoir, options.decision, options.persona ?? "manager");
    const days = rule?.temporal_persistence_days; // lives on PersonaRule, not the constraint
    // The persistence test applies to the rule's forecastable constraint
    // (flow_management: chl-a; FLARE has no metals, so non-forecastable ones are skipped).
    const pc = days && days > 0 ? (rule?.constraints ?? []).find((c) => c.forecastable) : undefined;
    if (rule && days && days > 0 && pc) {
      const direction: "above" | "below" = pc.op === ">" || pc.op === ">=" ? "above" : "below";
      const variable = pc.forecast_variable ?? pc.variable; // FLARE variable name if it differs
      const depthM = plan.resolvedDepthsM?.[0] ?? 1.6; // epilimnion / surface
      const persistSite = sites[0] ?? LEADS_FLARE_SITE;
      const persist = await computeMemberPersistence({
        siteId: persistSite,
        variable,
        threshold: pc.value,
        direction,
        minConsecutiveDays: days,
        depthM,
        maxHorizonDays: Math.max(horizon, days),
      });
      if (persist) {
        const sign = direction === "above" ? ">" : "<";
        const prob = formatEnsembleProbability(persist.supportingMembers, persist.totalMembers, persist.probability);
        evidence.push({
          id: `forecast:persistence:${persistSite}:${pc.variable}:${days}d`,
          channel: "forecast",
          title: `FLARE persistence — ${persistSite.toUpperCase()} ${pc.variable}`,
          text:
            `FLARE persistence forecast (${persist.totalMembers}-member ensemble, ref ` +
            `${persist.referenceDate}): probability that ${pc.variable} stays ${sign} ${pc.value} ` +
            `for ≥ ${days} consecutive days = ${prob}; longest run ` +
            `${persist.longestRunMax} d. Forecasts whether the ${options.decision} persistence ` +
            `trigger (≥ ${days} d sustained) is likely to be met.`,
          score: 0.95,
          provenance: {
            type: "forecast",
            label: `FLARE persistence P(≥${days}d ${sign}${pc.value})`,
            method: "flare-member-persistence",
            siteId: persistSite,
            variable: pc.variable,
            ensembleSize: persist.totalMembers,
            score: 0.95,
          },
        });
        persistenceAdded = true;
      }
    }
  }

  // The final cap is variable-aware so it does not re-truncate the per-variable
  // selection: budget = window-summary card + (emitted variables ×
  // MAX_SUMMARY_DAYS_PER_VAR). When %sat was requested the emitted variables are
  // `fetchVariables` (which forces DO and Temp) plus the derived DOsat series.
  // The quantiles/json strategies emit one card per variable and sit well under
  // this ceiling.
  const emittedVarCount = fetchVariables.length + (wantSaturation ? 1 : 0);
  // +1 budget for the persistence item so the final cap never truncates it.
  const maxForecastEvidence = 1 + emittedVarCount * MAX_SUMMARY_DAYS_PER_VAR + (persistenceAdded ? 1 : 0);
  return evidence.slice(0, maxForecastEvidence);
}
