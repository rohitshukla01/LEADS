/**
 * Deterministic constraint evaluation.
 *
 * Layer 2 (presence + freshness) decides whether LEADS may answer at all. Once it
 * passes, this module computes the value-based finding the synthesizer must be
 * anchored to - turning the persona rule's constraints into a concrete verdict:
 *
 *   - full_profile (water-extraction): a qualifying-depth search - which depth(s)
 *     satisfy all constraints. When no depth qualifies, the result is not a refusal:
 *     it lists the binding constraints at each depth.
 *     Constraints are evaluated on the coarsest depth grid among the constrained
 *     variables (lab-sample depths when present); continuous variables are paired
 *     to the nearest sonde depth within tolerance, and the pairing gap is reported.
 *   - persistence (flow): a contiguous exceedance run ending at the latest record,
 *     NA-tolerant (a single missing day does not reset the run; 2+ consecutive
 *     missing or any sub-threshold day ends it). Fewer than `requiredDays` of
 *     daily data in the window gives an indeterminate result (reported, not refused).
 *   - single_zone (hypoxia, algae): each constraint checked at its zone depth.
 *
 * seasonal_window (optional; no current rule sets one): outside the window the
 * rule is inapplicable and no operational verdict is asserted.
 *
 * not_evaluated: constraints the rule's specification requires but the rule cannot
 * check are appended as a deterministic "Not evaluated: …" line, and carried
 * separately as a display-only `scopeNote` for the UI and PDF.
 *
 * Pure + testable. The orchestrator feeds it the value-bearing gate records and
 * injects the `summary` into synthesis as deterministic grounding.
 */

import type { PersonaRule, ThresholdConstraint, ThresholdOp } from "./guardrails";

/** Where the decision threshold comes from, stated in the same evidence record that
 *  states the number so it can be traced without leaving the page. These are
 *  deployment operating values, not published limits. */
export const THRESHOLD_PROVENANCE =
  "Threshold provenance: this is a LEADS operational decision value configured for this reservoir, decision and persona. It is an operating threshold, not a published or regulatory limit, and has no source citation in the literature corpus.";

/** Plain names for constraint variables - used only in the reader-facing scope line.
 *  Unlisted variables fall back to their code name, so nothing is ever dropped. */
const PLAIN_VARIABLE_NAME: Record<string, string> = {
  DO_mgL_mean: "dissolved oxygen",
  DOsat_percent_mean: "dissolved-oxygen saturation",
  Chla_ugL_mean: "chlorophyll-a",
  TotalConcCM_ugL_sample: "FluoroProbe chlorophyll-a",
};

/** "Not evaluated: <label> (<reason>); …." built from the rule's `not_evaluated`, or null
 *  when the rule evaluates every constraint its specification requires. */
export function notEvaluatedLine(rule: PersonaRule): string | null {
  const items = rule.not_evaluated ?? [];
  if (items.length === 0) return null;
  return `Not evaluated: ${items.map((n) => `${n.label} (${n.reason})`).join("; ")}.`;
}

/** Display-only scope line: "Check used dissolved oxygen only. Not evaluated: …". */
export function checkScopeNote(rule: PersonaRule): string | null {
  const notEvaluated = notEvaluatedLine(rule);
  if (!notEvaluated) return null;
  const used = Array.from(new Set(rule.constraints.map((c) => PLAIN_VARIABLE_NAME[c.variable] ?? c.variable)));
  const list = used.length > 1 ? `${used.slice(0, -1).join(", ")} and ${used[used.length - 1]}` : used.join("");
  return `Check used ${list} only. ${notEvaluated}`;
}

/** Minimal value-bearing record (a subset of LeadsSensorRecord). */
export interface ConstraintObservation {
  variable: string;
  depthM: number | null;
  datetime: string;
  observation: number | null;
}

export type ConstraintVerdict = "satisfied" | "violated" | "indeterminate";

export interface ConstraintCheck {
  variable: string;
  op: ThresholdOp;
  value: number;
  units: string;
  observed: number | null;
  observedDepthM?: number | null;
  observedDate?: string;
  /** Depth gap between the candidate depth and the record actually used (for
   *  continuous variables paired to a lab-sample depth). */
  depthPairingGapM?: number;
  verdict: ConstraintVerdict;
}

export interface DepthEvaluation {
  depthM: number;
  checks: ConstraintCheck[];
  allSatisfied: boolean;
  bindingConstraints: string[]; // variables that are violated/indeterminate here
}

interface Base {
  applicable: boolean;
  /** One-line, value-bearing finding injected into synthesis. */
  summary: string;
  /** Reader-facing scope of the check ("Check used … only. Not evaluated: …"), set only
   *  when the rule leaves specified constraints unevaluated. Display-only: the UI prints
   *  it under the answer and the PDF under the verdict; it never enters the answer text. */
  scopeNote?: string;
}

export interface InapplicableResult extends Base {
  applicable: false;
  reason: string;
}
export interface QualifyingDepthResult extends Base {
  applicable: true;
  kind: "qualifying_depth";
  qualifyingDepths: number[];
  perDepth: DepthEvaluation[];
}
export interface PersistenceResult extends Base {
  applicable: true;
  kind: "persistence";
  variable: string;
  op: ThresholdOp;
  thresholdValue: number;
  requiredDays: number;
  runSpanDays: number;
  coverageDays: number;
  sustained: boolean;
  indeterminate: boolean;
}
export interface SingleZoneResult extends Base {
  applicable: true;
  kind: "single_zone";
  checks: ConstraintCheck[];
  allSatisfied: boolean;
}

export type ConstraintEvaluation =
  | InapplicableResult
  | QualifyingDepthResult
  | PersistenceResult
  | SingleZoneResult;

const DEPTH_PAIRING_TOLERANCE_M = 2.0;

function satisfies(op: ThresholdOp, observed: number, value: number): boolean {
  switch (op) {
    case "<": return observed < value;
    case "<=": return observed <= value;
    case ">": return observed > value;
    case ">=": return observed >= value;
  }
}

function mmdd(iso: string): string {
  // "YYYY-MM-DD ..." to "MM-DD"
  return iso.slice(5, 10);
}

function inSeasonWindow(queryDateISO: string, start: string, end: string): boolean {
  const d = mmdd(queryDateISO);
  return start <= end ? d >= start && d <= end : d >= start || d <= end;
}

function dayDiff(aISO: string, bISO: string): number {
  const a = Date.parse(aISO.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(bISO.slice(0, 10) + "T00:00:00Z");
  return Math.round((a - b) / 86_400_000);
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(iso.slice(0, 10) + "T00:00:00Z") + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Freshest (latest-dated) record for a variable nearest a target depth. Returns
 *  null if none within tolerance (for continuous vars paired to a lab depth) or
 *  no records at all. */
function nearestRecord(
  records: ConstraintObservation[],
  variable: string,
  targetDepth: number,
  tolerance: number,
): ConstraintObservation | null {
  const candidates = records.filter(
    (r) => r.variable === variable && r.observation != null && r.depthM != null,
  );
  if (candidates.length === 0) return null;
  // Freshest date present for this variable.
  const latestDate = candidates.reduce((m, r) => (r.datetime > m ? r.datetime : m), "");
  const onLatest = candidates.filter((r) => r.datetime.slice(0, 10) === latestDate.slice(0, 10));
  let best: ConstraintObservation | null = null;
  let bestGap = Infinity;
  for (const r of onLatest) {
    const gap = Math.abs((r.depthM as number) - targetDepth);
    if (gap < bestGap) {
      bestGap = gap;
      best = r;
    }
  }
  if (best && bestGap > tolerance) return null;
  return best;
}

function evaluateQualifyingDepth(
  rule: PersonaRule,
  records: ConstraintObservation[],
): QualifyingDepthResult {
  // Candidate depths = the limiting (coarsest) grid: lab-sample depths if any,
  // else fluoroprobe, else continuous.
  const classRank: Record<string, number> = { lab: 0, fluoroprobe: 1, continuous: 2, derived: 2, forecast: 3 };
  const sortedConstraints = [...rule.constraints].sort(
    (a, b) => (classRank[a.source_class] ?? 9) - (classRank[b.source_class] ?? 9),
  );
  const limiting = sortedConstraints[0];
  const candidateDepths = Array.from(
    new Set(
      records
        .filter((r) => r.variable === limiting.variable && r.observation != null && r.depthM != null)
        .map((r) => r.depthM as number),
    ),
  ).sort((a, b) => a - b);

  const perDepth: DepthEvaluation[] = candidateDepths.map((depth) => {
    const checks: ConstraintCheck[] = rule.constraints.map((c) => buildCheck(c, records, depth));
    const allSatisfied = checks.every((ch) => ch.verdict === "satisfied");
    const binding = checks.filter((ch) => ch.verdict !== "satisfied").map((ch) => ch.variable);
    return { depthM: depth, checks, allSatisfied, bindingConstraints: binding };
  });

  const qualifyingDepths = perDepth.filter((d) => d.allSatisfied).map((d) => d.depthM);

  // Name the applied constraints so the answer can state the operative threshold,
  // as the single-zone path does.
  const applied = rule.constraints
    .map((c) => `${c.variable} ${c.op} ${c.value} ${c.units}`)
    .join("; ");

  let summary: string;
  if (candidateDepths.length === 0) {
    summary = "No profile data available to evaluate candidate withdrawal depths.";
  } else if (qualifyingDepths.length > 0) {
    summary =
      `Constraints applied: ${applied}. ` +
      `Qualifying withdrawal depth(s) where all constraints hold: ` +
      `${qualifyingDepths.map((d) => `${d} m`).join(", ")}.`;
  } else {
    // No depth qualifies: report the binding constraints at each depth.
    const detail = perDepth
      .map((d) => `${d.depthM} m (binding: ${d.bindingConstraints.join(", ") || "none"})`)
      .join("; ");
    summary = `Constraints applied: ${applied}. No depth satisfies all constraints. Per-depth binding constraints — ${detail}.`;
  }

  return {
    applicable: true, kind: "qualifying_depth", qualifyingDepths, perDepth,
    summary: candidateDepths.length === 0 ? summary : `${summary} ${THRESHOLD_PROVENANCE}`,
  };
}

function buildCheck(
  c: ThresholdConstraint,
  records: ConstraintObservation[],
  targetDepth: number,
): ConstraintCheck {
  // Same-class variable at this depth uses exact depth; cross-class (continuous
  // paired to a lab depth) uses the tolerance.
  const rec = nearestRecord(records, c.variable, targetDepth, DEPTH_PAIRING_TOLERANCE_M);
  if (!rec || rec.observation == null) {
    return {
      variable: c.variable, op: c.op, value: c.value, units: c.units,
      observed: null, verdict: "indeterminate",
    };
  }
  const ok = satisfies(c.op, rec.observation, c.value);
  return {
    variable: c.variable, op: c.op, value: c.value, units: c.units,
    observed: rec.observation,
    observedDepthM: rec.depthM,
    observedDate: rec.datetime.slice(0, 10),
    depthPairingGapM: rec.depthM != null ? Math.abs((rec.depthM as number) - targetDepth) : undefined,
    verdict: ok ? "satisfied" : "violated",
  };
}

function evaluatePersistence(
  rule: PersonaRule,
  records: ConstraintObservation[],
): PersistenceResult {
  const c = rule.constraints[0];
  const requiredDays = rule.temporal_persistence_days ?? 7;

  // Daily value map for the constrained variable (one value per date; if several
  // surface records share a date, take the freshest within that date).
  const byDate = new Map<string, ConstraintObservation>();
  for (const r of records) {
    if (r.variable !== c.variable || r.observation == null) continue;
    const day = r.datetime.slice(0, 10);
    const cur = byDate.get(day);
    if (!cur || r.datetime > cur.datetime) byDate.set(day, r);
  }

  if (byDate.size === 0) {
    return {
      applicable: true, kind: "persistence", variable: c.variable, op: c.op,
      thresholdValue: c.value, requiredDays, runSpanDays: 0, coverageDays: 0,
      sustained: false, indeterminate: true,
      summary: `No daily ${c.variable} observations available to assess ${requiredDays}-day persistence.`,
    };
  }

  const latestDate = Array.from(byDate.keys()).sort().reverse()[0];

  // Walk back from the latest date building the contiguous exceedance run.
  let runStart = latestDate;
  let consecutiveNA = 0;
  let satisfyingFound = false;
  let cursor = latestDate;
  // Bound the walk: never look back further than 3× the required window.
  const earliest = addDaysISO(latestDate, -(requiredDays * 3));
  while (cursor >= earliest) {
    const rec = byDate.get(cursor);
    if (!rec || rec.observation == null) {
      consecutiveNA += 1;
      if (consecutiveNA >= 2) break; // 2+ consecutive gaps ends the run
    } else if (satisfies(c.op, rec.observation, c.value)) {
      consecutiveNA = 0;
      satisfyingFound = true;
      runStart = cursor;
    } else {
      break; // a sub-threshold day ends the run
    }
    cursor = addDaysISO(cursor, -1);
  }

  const runSpanDays = satisfyingFound ? dayDiff(latestDate, runStart) + 1 : 0;

  // Coverage: distinct days with data in the trailing requiredDays-day window.
  const windowStart = addDaysISO(latestDate, -(requiredDays - 1));
  let coverageDays = 0;
  for (const day of byDate.keys()) if (day >= windowStart && day <= latestDate) coverageDays += 1;

  // Enumerate the window explicitly. The synthesiser sees only a few sensor snippets
  // and cannot observe completeness itself, so pass it the computed coverage, the
  // missing dates and the observed range to ground any statement about gaps.
  const windowDays: string[] = [];
  for (let i = requiredDays - 1; i >= 0; i--) windowDays.push(addDaysISO(latestDate, -i));
  const missingDays = windowDays.filter((d) => !byDate.has(d));
  const windowValues = windowDays
    .map((d) => byDate.get(d)?.observation)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const coverageNote =
    ` Window coverage: ${coverageDays} of ${requiredDays} days observed (${windowStart} to ${latestDate})` +
    (missingDays.length ? `, missing ${missingDays.join(", ")}.` : ", no gaps.") +
    (windowValues.length
      ? ` Observed ${c.variable} over the window ranged ${Math.min(...windowValues).toFixed(2)}` +
        `-${Math.max(...windowValues).toFixed(2)} ${c.units}.`
      : "");

  const sustained = runSpanDays >= requiredDays;
  const indeterminate = !sustained && coverageDays < requiredDays;

  const sign = c.op.startsWith(">") ? ">" : "<";
  let summary: string;
  if (sustained) {
    summary =
      `${c.variable} has been ${sign} ${c.value} ${c.units} for a contiguous ${runSpanDays}-day ` +
      `run ending ${latestDate} (≥ the ${requiredDays}-day persistence threshold).` + coverageNote;
  } else if (indeterminate) {
    summary =
      `Cannot confirm ${requiredDays}-day persistence of ${c.variable} ${sign} ${c.value} ${c.units}: ` +
      `only ${coverageDays} daily record(s) in the trailing ${requiredDays}-day window ` +
      `(longest exceedance run ${runSpanDays} d).` + coverageNote;
  } else {
    summary =
      `${c.variable} has NOT been sustained ${sign} ${c.value} ${c.units} for ${requiredDays} days ` +
      `(longest contiguous exceedance run is ${runSpanDays} d ending ${latestDate}).` + coverageNote;
  }

  // State the threshold provenance at the end of the record, as the single_zone and
  // qualifying_depth paths do.
  return {
    applicable: true, kind: "persistence", variable: c.variable, op: c.op,
    thresholdValue: c.value, requiredDays, runSpanDays, coverageDays, sustained,
    indeterminate, summary: `${summary} ${THRESHOLD_PROVENANCE}`,
  };
}

function evaluateSingleZone(
  rule: PersonaRule,
  records: ConstraintObservation[],
): SingleZoneResult {
  // Use the freshest record per variable (depth already filtered upstream to the
  // zone), so targetDepth is irrelevant - pass a large tolerance.
  const checks: ConstraintCheck[] = rule.constraints.map((c) => {
    const rec = nearestRecord(records, c.variable, 0, Number.POSITIVE_INFINITY);
    if (!rec || rec.observation == null) {
      return { variable: c.variable, op: c.op, value: c.value, units: c.units, observed: null, verdict: "indeterminate" as const };
    }
    const ok = satisfies(c.op, rec.observation, c.value);
    return {
      variable: c.variable, op: c.op, value: c.value, units: c.units,
      observed: rec.observation, observedDepthM: rec.depthM, observedDate: rec.datetime.slice(0, 10),
      verdict: ok ? ("satisfied" as const) : ("violated" as const),
    };
  });
  const allSatisfied = checks.every((ch) => ch.verdict === "satisfied");
  const summary = checks
    .map((ch) => {
      if (ch.observed == null) return `${ch.variable}: no current observation, so the condition cannot be evaluated`;
      // State whether the condition holds. The internal verdict is
      // "satisfied"/"violated" in the constraint-solver sense (does the expression
      // hold?), so printing "violated" beside a reading on the safe side would read
      // as a breached limit when it means the action trigger did not fire.
      // Observations are rounded to two decimals.
      const obs = Number(ch.observed.toFixed(2));
      const met = ch.verdict === "satisfied";
      return `${ch.variable} = ${obs} ${ch.units} — the ${ch.op} ${ch.value} ${ch.units} condition is ${met ? "MET" : "NOT met"}`;
    })
    .join("; ");
  // State where the threshold comes from in the same record that states the number.
  // The value has no published citation, so naming its provenance here keeps the
  // record self-contained and auditable.
  return {
    applicable: true, kind: "single_zone", checks, allSatisfied,
    summary: summary + `. ${THRESHOLD_PROVENANCE}`,
  };
}

/**
 * Evaluate a persona rule's constraints against the retrieved value-bearing
 * sensor records. Checks the seasonal window first, then runs one evaluation:
 * persistence when the rule sets one, else qualifying-depth (full_profile), else single-zone.
 */
export function evaluateConstraints(
  rule: PersonaRule,
  records: ConstraintObservation[],
  queryDateISO: string,
): ConstraintEvaluation {
  // Seasonal gate first - outside the window the operational rule is inactive.
  if (rule.seasonal_window) {
    const { start_mmdd, end_mmdd } = rule.seasonal_window;
    if (!inSeasonWindow(queryDateISO, start_mmdd, end_mmdd)) {
      return {
        applicable: false,
        reason: "out_of_season",
        summary:
          `Out of the operational season (${start_mmdd}–${end_mmdd}); this rule does not ` +
          `apply on ${queryDateISO.slice(0, 10)}. No operational threshold is enforced.`,
      };
    }
  }

  const result: ConstraintEvaluation =
    rule.temporal_persistence_days != null
      ? evaluatePersistence(rule, records)
      : rule.depth_scope === "full_profile"
      ? evaluateQualifyingDepth(rule, records)
      : evaluateSingleZone(rule, records);

  // Disclose what the check did not evaluate, at the end of the same deterministic
  // record (after the provenance), so the answer can relay it and the UI/PDF can print
  // the scope line. Only on evaluated rules; an inapplicable rule (outside its seasonal
  // window) returns early above.
  const notEvaluated = notEvaluatedLine(rule);
  if (!notEvaluated) return result;
  return { ...result, summary: `${result.summary} ${notEvaluated}`, scopeNote: checkScopeNote(rule) ?? undefined };
}
