/**
 * Ensemble statistics engine for multi-model ecological forecasts.
 *
 * Computes ensemble means, spread, uncertainty envelopes, and threshold
 * exceedance probabilities from FLARE GLM-AED 221-member ensemble outputs.
 *
 * Methodological basis:
 *   Gneiting & Raftery 2007 - Strictly proper scoring rules, prediction, and estimation
 *   Dietze 2017 - Ecological Forecasting (Princeton University Press)
 *   Thomas et al. 2023 - NEON Ecological Forecasting Challenge
 */

import type { ForecastRecord, EnsembleSummary, RiskAssessment } from "./types";
import { LEADS_RISK_THRESHOLDS } from "./config";

// Helpers

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = groups.get(key) ?? [];
    arr.push(item);
    groups.set(key, arr);
  }
  return groups;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Ensemble summary computation

/**
 * Group forecast records by (variable, site, targetDate) and compute
 * multi-model ensemble statistics for each group.
 *
 * Each group aggregates predictions from different models for the same
 * forecast target. The ensemble mean is the mean of individual model
 * means; the spread is the standard deviation across model means;
 * bounds are the extremes of the individual model quantile envelopes.
 */
export function buildEnsembleSummaries(records: ForecastRecord[]): EnsembleSummary[] {
  // Only use recent forecasts to avoid inflating ensembles with stale data
  const recent = filterToRecentForecasts(records);
  const groups = groupBy(
    recent,
    (r) => `${r.variable}|${r.siteId}|${r.targetDate}`
  );

  const summaries: EnsembleSummary[] = [];

  for (const [, group] of groups) {
    // Deduplicate by model - take the most recent reference date per model
    const byModel = groupBy(group, (r) => r.modelId);
    const latestPerModel: ForecastRecord[] = [];
    for (const [, modelRecords] of byModel) {
      const sorted = modelRecords.sort((a, b) => b.referenceDate.localeCompare(a.referenceDate));
      latestPerModel.push(sorted[0]);
    }

    if (latestPerModel.length === 0) continue;

    const first = latestPerModel[0];
    const modelMeans = latestPerModel.map((r) => r.mean);
    const allLower = latestPerModel.map((r) => r.quantile02_5);
    const allUpper = latestPerModel.map((r) => r.quantile97_5);
    const allP10 = latestPerModel.map((r) => r.quantile10);
    const allP90 = latestPerModel.map((r) => r.quantile90);

    // Agreement score: fraction of models predicting the same direction
    // relative to the ensemble mean
    const ensMean = mean(modelMeans);
    const aboveCount = modelMeans.filter((m) => m >= ensMean).length;
    const belowCount = modelMeans.length - aboveCount;
    const agreementScore = Math.max(aboveCount, belowCount) / modelMeans.length;

    // Spread = std-dev across model means when multiple models are present.
    // For a single-model run (FLARE GLM-AED only), std-dev is always 0.
    // Use the half-width of the 95% prediction interval instead, which
    // correctly represents within-ensemble uncertainty from the 221 members.
    const modelSpread = latestPerModel.length > 1
      ? stddev(modelMeans)
      : mean(latestPerModel.map((r) => (r.quantile97_5 - r.quantile02_5) / 2));

    const outerLower = Math.min(...allLower);
    const outerUpper = Math.max(...allUpper);
    // Inner 10/90 band, clamped to nest inside the outer 2.5/97.5
    // envelope. For the single-model FLARE ensemble each group is one record, so
    // this is exactly that record's q10/q90; the clamp only guards a degenerate
    // multi-model case (if min q10 is above max q90, both collapse to the mean).
    let innerP10 = Math.max(outerLower, Math.min(...allP10));
    let innerP90 = Math.min(outerUpper, Math.max(...allP90));
    if (innerP10 > innerP90) { innerP10 = ensMean; innerP90 = ensMean; }

    summaries.push({
      variable: first.variable,
      siteId: first.siteId,
      targetDate: first.targetDate,
      horizon: first.horizon,
      models: latestPerModel.map((r) => r.modelId),
      ensembleMean: ensMean,
      ensembleSpread: Number(modelSpread.toFixed(3)),
      lowerBound: outerLower,
      upperBound: outerUpper,
      agreementScore,
      q10: innerP10,
      q90: innerP90,
    });
  }

  return summaries.sort((a, b) => a.horizon - b.horizon);
}

// Exceedance probability

/**
 * Exceedance probability, computed from the ensemble members when they are
 * available and falling back to a Gaussian approximation when they are not.
 *
 * 1. Empirical (preferred). Count the fraction of members on the risk side of the
 *    threshold. Makes no distributional assumption.
 *
 * 2. Gaussian (fallback only, for records without members). Fits a normal using
 *    sigma = (q90 - q10) / 2.56 and evaluates its CDF at the threshold. For
 *    multi-model input the share of supporting models is also taken into account.
 *
 * Why members are counted: a Gaussian is unbiased only while the ensemble is
 * symmetric. FLARE's hypolimnetic DO ensemble becomes right-skewed with lead time,
 * because a long upper tail pulls the mean above the median member. A normal centred
 * on that mean under-counts the lower tail and so understates hypoxia risk, most at
 * the 7-14 day horizons a manager plans around. Near-symmetric variables such as
 * chlorophyll-a are barely affected. The 221 members are already loaded to compute
 * the quantiles, so the distribution is used directly rather than approximated.
 *
 * Multi-horizon input: some callers pass records spanning several target dates. Those
 * are grouped by horizon and the peak per-day probability is returned, matching the
 * "peaks at X% (day N)" language used elsewhere. It is not a union across days:
 * member identity is not recoverable across target dates here (the accumulator keys
 * by member|date|depth and array order is incidental), so a trajectory union cannot
 * be computed without threading member ids through.
 *
 * Member counts: the empirical path also returns the count behind the proportion,
 * `crossingMembers` of `totalMembers` for the peak horizon, so callers can print it
 * with formatEnsembleProbability instead of a rounded percentage. The Gaussian path
 * has no members and leaves both fields undefined. The count is returned only when
 * the peak horizon's members come from one depth: records for several depths pool
 * into one bucket (2 x 221 = 442 values), and "k of 442 members" would misstate the
 * ensemble size and its 1-in-221 resolution. A pooled bucket returns `pooledDepths`
 * instead, and the formatter prints the pooled percentage without a member count.
 */
export function exceedanceProbability(
  records: ForecastRecord[],
  threshold: number,
  direction: "above" | "below"
): {
  probability: number;
  supportingModels: string[];
  totalModels: number;
  /** Members on the risk side at the peak horizon (empirical path only). */
  crossingMembers?: number;
  /** Members counted at the peak horizon (empirical path only). */
  totalMembers?: number;
  /** Set instead of the two counts when the peak horizon pools several depths. */
  pooledDepths?: number;
} {
  if (records.length === 0) return { probability: 0, supportingModels: [], totalModels: 0 };

  // Supporting models: a model supports the risk if its mean or its inner
  // quantile (q10 for "below", q90 for "above") is on the risk side of the
  // threshold. The 2.5/97.5 tails are not used, so a model whose 2.5th
  // percentile is negative but whose mean is well above the threshold is not
  // counted.
  const supporting: string[] = [];
  for (const r of records) {
    if (direction === "below") {
      const meanBelow = r.mean <= threshold;
      const q10Below = r.quantile10 <= threshold;
      if (meanBelow || q10Below) supporting.push(r.modelId);
    } else {
      const meanAbove = r.mean >= threshold;
      const q90Above = r.quantile90 >= threshold;
      if (meanAbove || q90Above) supporting.push(r.modelId);
    }
  }
  // Method 1 (preferred): count the members
  // Requires every record to carry its members, so a mixed batch never silently
  // computes a probability from a subset of the distribution.
  const crosses = (v: number) => (direction === "below" ? v < threshold : v > threshold);
  if (records.length > 0 && records.every((r) => r.members && r.members.length > 0)) {
    // Group by horizon: pooling different lead times would mix distributions that
    // are not comparable. Single-horizon input yields exactly one group.
    const byHorizon = new Map<number, { values: number[]; depths: Set<number> }>();
    for (const r of records) {
      const bucket = byHorizon.get(r.horizon) ?? { values: [], depths: new Set<number>() };
      for (const v of r.members as number[]) bucket.values.push(v);
      bucket.depths.add(r.depthM);
      byHorizon.set(r.horizon, bucket);
    }
    let peak = 0;
    let peakK = 0;
    let peakN = 0;
    let peakDepths = 0;
    for (const { values, depths } of byHorizon.values()) {
      if (!values.length) continue;
      const k = values.filter(crosses).length;
      const p = k / values.length;
      // Same peak as Math.max(peak, p); also keeps the count that produced it.
      if (peakN === 0 || p > peak) { peak = p; peakK = k; peakN = values.length; peakDepths = depths.size; }
    }
    // No damping here: that heuristic exists to blunt the Gaussian's fat-tail false
    // alarms. Applying it to a counted proportion would corrupt a correct number.
    return {
      probability: Number(Math.min(1, Math.max(0, peak)).toFixed(3)),
      supportingModels: supporting,
      totalModels: records.length,
      // One depth: report its member count. Several depths pooled: report the depth count instead.
      ...(peakDepths > 1 ? { pooledDepths: peakDepths } : { crossingMembers: peakK, totalMembers: peakN }),
    };
  }

  // Method 2 (fallback): Gaussian approximation
  // Model counting is only meaningful for a multi-model ensemble (more than one
  // record). FLARE is a single model aggregated to one record per (variable,
  // horizon, depth); with one record, counting reduces to a binary 0%/100% gate
  // on whether q10 crosses the threshold, which jumps abruptly once the ensemble
  // fans out even when the mean is far from the threshold. For single-record
  // input the Gaussian CDF is the continuous estimate and counting is skipped.
  const discreteP = records.length > 1 ? supporting.length / records.length : 0;

  // Gaussian CDF from ensemble mean and spread
  const modelMeans = records.map((r) => r.mean);
  const ensMean = mean(modelMeans);
  // Use the inner quantile envelope (10-90) for sigma estimation
  // to avoid inflated sigma from extreme 2.5-97.5 tails.
  const avgSigma = mean(
    records.map((r) => (r.quantile90 - r.quantile10) / 2.56) // 2.56 = 2 * z(0.90)
  );
  // Combine model spread with within-model uncertainty
  const combinedSigma = Math.sqrt(stddev(modelMeans) ** 2 + avgSigma ** 2);

  let gaussianP = 0;
  if (combinedSigma > 0) {
    const z = (threshold - ensMean) / combinedSigma;
    gaussianP = direction === "above" ? 1 - normalCDF(z) : normalCDF(z);
  } else {
    gaussianP = direction === "above" ? (ensMean >= threshold ? 1 : 0) : (ensMean <= threshold ? 1 : 0);
  }

  // Dampen probability when the ensemble mean is far from threshold.
  // If the mean is more than 1.5 sigma away on the "safe" side, the risk is
  // driven by wide tails, so a distance penalty is applied.
  const meanDistance = Math.abs(ensMean - threshold);
  const safeDirection =
    direction === "below" ? ensMean > threshold : ensMean < threshold;
  let dampingFactor = 1.0;
  if (safeDirection && combinedSigma > 0) {
    const sigmasAway = meanDistance / combinedSigma;
    if (sigmasAway > 1.5) {
      dampingFactor = Math.max(0.1, 1.0 - (sigmasAway - 1.5) * 0.3);
    }
  }

  const rawP = Math.max(discreteP, gaussianP) * dampingFactor;

  return {
    probability: Math.min(1, Math.max(0, Number(rawP.toFixed(3)))),
    supportingModels: supporting,
    totalModels: records.length,
  };
}

function normalCDF(z: number): number {
  // erf approximation from Abramowitz & Stegun 7.1.26, evaluated at |z|/√2
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// Probability formatting

/** Percentage for a proportion strictly between 0 and 1: whole numbers between 1% and
 *  99%, one decimal place outside that band, and more only if needed so the label can
 *  never round to 0% or 100%. */
function percentLabel(p: number): string {
  const pct = p * 100;
  let digits = pct < 1 || pct > 99 ? 1 : 0;
  let s = pct.toFixed(digits);
  while ((Number(s) === 0 || Number(s) === 100) && digits < 4) s = pct.toFixed(++digits);
  return `${s}%`;
}

/**
 * The one way an ensemble threshold-crossing probability is printed - evidence cards,
 * the persistence card and the operational banner all call this.
 *
 * An ensemble count has a resolution of 1/N, so the count leads. A rounded
 * percentage alone would print 0 of 221 members as "0%", which reads as impossible
 * rather than "no member crossed", and 220 of 221 as "100%", which reads as certain:
 *
 *   k = 0      "0 of 221 members (below the ensemble's 1-in-221 resolution)"
 *   k = n      "221 of 221 members"
 *   otherwise  "X% (k of 221 members)", one decimal below 1% and above 99%
 *
 * With no count (the Gaussian fallback, for records without members) it prints the
 * fitted probability and says so; it never prints 0% or 100% there either. A proportion
 * pooled across several depths (`pooledDepths` from exceedanceProbability) has no
 * single-ensemble count either, and is labelled as pooled.
 */
export function formatEnsembleProbability(
  crossingMembers: number | null | undefined,
  totalMembers: number | null | undefined,
  probability = 0,
  pooledDepths?: number,
): string {
  if (crossingMembers == null || !totalMembers) {
    const label =
      probability < 0.001 ? "<0.1%" : probability > 0.999 ? ">99.9%" : percentLabel(probability);
    if (pooledDepths != null && pooledDepths > 1) {
      return `${label} (pooled across ${pooledDepths} depths; no single-depth member count)`;
    }
    return `${label} (Gaussian approximation; no member count)`;
  }
  const k = Math.max(0, Math.min(totalMembers, crossingMembers));
  if (k === 0) return `0 of ${totalMembers} members (below the ensemble's 1-in-${totalMembers} resolution)`;
  if (k === totalMembers) return `${totalMembers} of ${totalMembers} members`;
  return `${percentLabel(k / totalMembers)} (${k} of ${totalMembers} members)`;
}

// Temporal filtering

/**
 * Filter forecast records to only the most recent reference date per model.
 * FLARE parquets per reference date contain the full run; using old
 * reference dates alongside current ones would inflate risk estimates.
 */
function filterToRecentForecasts(records: ForecastRecord[]): ForecastRecord[] {
  // Find the most recent reference date per model
  const latestRefByModel = new Map<string, string>();
  for (const r of records) {
    const current = latestRefByModel.get(r.modelId);
    if (!current || r.referenceDate > current) {
      latestRefByModel.set(r.modelId, r.referenceDate);
    }
  }

  // Keep only records from the latest reference date per model
  // (allow 1 day tolerance for models that publish at different times)
  return records.filter((r) => {
    const latest = latestRefByModel.get(r.modelId) ?? "";
    const latestMs = new Date(latest).getTime();
    const refMs = new Date(r.referenceDate).getTime();
    return latestMs - refMs <= 86400000; // within 1 day of latest
  });
}

// Risk assessment

/**
 * Generate risk assessments from forecast records using thresholds
 * from LEADS config (literature-grounded water quality standards).
 */
export function generateRiskAssessments(
  records: ForecastRecord[],
  maxHorizonDays = 7
): RiskAssessment[] {
  const assessments: RiskAssessment[] = [];

  // Use only the most recent reference date per model so that outdated
  // predictions do not inflate risk estimates.
  const recentRecords = filterToRecentForecasts(records);

  for (const [variable, config] of Object.entries(LEADS_RISK_THRESHOLDS)) {
    const varRecords = recentRecords.filter(
      (r) => r.variable === variable && r.horizon <= maxHorizonDays && r.horizon >= 0
    );
    if (varRecords.length === 0) continue;

    const bySite = groupBy(varRecords, (r) => r.siteId);

    for (const [siteId, siteRecords] of bySite) {
      // For each target date within horizon, compute exceedance
      const byDate = groupBy(siteRecords, (r) => r.targetDate);
      let maxProb = 0;
      let bestSupporting: string[] = [];
      let bestTotal = 0;

      for (const [, dateRecords] of byDate) {
        // Deduplicate by model (latest reference date)
        const byModel = groupBy(dateRecords, (r) => r.modelId);
        const latestPerModel = Array.from(byModel.values()).map(
          (recs) => recs.sort((a, b) => b.referenceDate.localeCompare(a.referenceDate))[0]
        );

        const result = exceedanceProbability(latestPerModel, config.threshold, config.direction);
        if (result.probability > maxProb) {
          maxProb = result.probability;
          bestSupporting = result.supportingModels;
          bestTotal = result.totalModels;
        }
      }

      if (maxProb > 0.05) {
        assessments.push({
          variable,
          siteId,
          riskLabel: config.label,
          probability: Number(maxProb.toFixed(3)),
          horizon: `${maxHorizonDays}-day`,
          threshold: config.threshold,
          thresholdSource: config.source,
          confidence: maxProb >= 0.7 ? "high" : maxProb >= 0.3 ? "medium" : "low",
          supportingModels: bestSupporting,
          totalModels: bestTotal,
        });
      }
    }
  }

  return assessments.sort((a, b) => b.probability - a.probability);
}
