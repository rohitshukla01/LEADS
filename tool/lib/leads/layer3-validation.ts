/**
 * Layer 3: post-generation deterministic validation.
 *
 * After generation, a deterministic checker validates the response against the
 * decision's guardrail config. It runs in logged-warning mode: a failure never blocks
 * the answer, and the adherence percentage is emitted on the `guardrail-l3` SSE step
 * event as a quantitative guardrail-adherence metric.
 *
 * Checks:
 *   1. forbidden_variables_avoided: the response mentions no variable from
 *      `guardrail.forbidden_variables` (the list is empty for every current decision,
 *      so the check is skipped).
 *   2. required_variables_grounded: each item in `required_sensor_variables` appears
 *      either as a number near one of the variable's aliases or as a supported
 *      claim's source title. Catches answers that ignore the data they were given.
 *   3. threshold_referenced: for an operational decision with a `rules_by_persona`
 *      rule, the response references each persona constraint's value (or names its
 *      variable alongside "threshold" or its units). Skipped for informational
 *      answers, the public persona and decisions without a per-persona rule (no
 *      operational threshold).
 *   4. uncertainty_preserved: when forecast evidence is present, the response
 *      contains at least one uncertainty cue (such as range, ensemble, spread,
 *      probability, quantile, confidence interval, ±, bound).
 *   5. operational_lever_referenced: the answer names the decision's operational
 *      lever (HOx, algaecide, intake or withdrawal depth, flow), which the
 *      orchestrator injects as grounding. Skipped for informational decisions.
 *   6. operational_conclusion_consistent: the answer's prose does not assert the
 *      opposite of the deterministic single-zone verdict.
 *
 * Rules that need a reading of the answer's meaning (e.g. "names compared candidate
 * depths") are not checked here.
 *
 * Informational mode (decision === "none") has no required variables, threshold or
 * forbidden variables, so Layer 3 passes trivially, as Layer 2 does.
 */

import { mentionsVariable, variableMentions } from "./alias-match";
import {
  getGuardrail,
  getPersonaRule,
  type DecisionKey,
  type Persona,
  type ThresholdConstraint,
} from "./guardrails";
import type { LeadsCitation, LeadsClaimVerification, LeadsReservoir } from "./types";

export type Layer3CheckName =
  | "forbidden_variables_avoided"
  | "required_variables_grounded"
  | "threshold_referenced"
  | "uncertainty_preserved"
  | "operational_lever_referenced"
  | "operational_conclusion_consistent";

export type Layer3CheckStatus = "passed" | "failed" | "skipped";

export interface Layer3CheckResult {
  name: Layer3CheckName;
  status: Layer3CheckStatus;
  detail: string;
}

export interface Layer3Inputs {
  decision: DecisionKey;
  /** Selects the reservoir-specific guardrail. */
  reservoir: LeadsReservoir;
  /** Selects the `rules_by_persona` rule, so the required-variable and threshold
   *  checks audit the persona-specific constraints (e.g. researcher hypoxia:
   *  DOsat_percent_mean < 50% sat). When omitted, the guardrail's top-level required
   *  variables are used and the threshold check is skipped. */
  persona?: Persona;
  responseText: string;
  citations: LeadsCitation[];
  claims?: LeadsClaimVerification[];
  /** Set by the orchestrator from `fused.evidence`. Drives whether the
   *  uncertainty-preserved check applies. */
  hasForecastEvidence: boolean;
  /** The deterministic constraint verdict's stance for a single-zone decision:
   *  "indicated" (the action is warranted on the latest reading) or "not_indicated".
   *  When present, Layer 3 audits that the answer's prose does not assert the opposite
   *  stance. Undefined or null when there is no determinate single-zone verdict (the
   *  check then skips). */
  operationalStance?: "indicated" | "not_indicated" | null;
}

export interface Layer3Result {
  ok: boolean;
  decision: DecisionKey;
  checks: Layer3CheckResult[];
  /** Adherence metric: passed / (passed + failed). Skipped checks are excluded
   *  from the denominator so a decision without a threshold is not penalized
   *  for a rule it cannot enforce. */
  adherencePct: number;
  warning?: string;
}

/** Per-decision operational-lever keywords. The injected operational
 *  framing (orchestrator) delivers the lever to the synthesizer; this audits that the
 *  answer actually named it. Deterministic, no NL understanding. Absent for `none`
 *  (informational), so the check skips. */
const LEVER_KEYWORDS: Partial<Record<DecisionKey, string[]>> = {
  // stems so natural phrasings match (oxygenate/oxygenation; withdraw/withdrawal; extract/extraction)
  hypoxia_management: ["oxygenat", "hox"],
  algal_management: ["algaecide", "algicide"],
  water_extraction: ["intake", "withdraw", "extract"],
  flow_management: ["flow", "flush"],
};

const UNCERTAINTY_CUES = [
  "range",
  "ensemble",
  "spread",
  "probability",
  "quantile",
  "confidence interval",
  "credible interval",
  "uncertain",
  "likely",
  "lower bound",
  "upper bound",
  "±",
  "+/-",
  "forecast bound",
  "ci",
];

/** Variable is mentioned alongside a number (digits, possibly with decimal /
 *  unit). Anchors the alias within ~80 chars of a numeric token in either
 *  direction. The wide window tolerates phrasings like
 *  "DO at 9 m is 7.49 mg/L" and "the temperature ... was 21.3 °C". */
function variableMentionedWithNumber(text: string, variable: string): boolean {
  // Mentions come from alias-match.ts, so "does" is not a DO mention and an answer
  // that never reports DO cannot pass this check on the strength of a verb.
  for (const { index, length } of variableMentions(text, variable)) {
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + length + 80);
    if (/-?\d+(\.\d+)?/.test(text.slice(start, end))) return true;
  }
  return false;
}

function variableInClaimSources(variable: string, claims: LeadsClaimVerification[]): boolean {
  return claims.some((c) => {
    if (!c.supported) return false;
    const title = (c.sourceTitle ?? "").toLowerCase();
    return title.includes(variable.toLowerCase());
  });
}

function checkForbidden(text: string, forbidden: string[]): Layer3CheckResult {
  if (forbidden.length === 0) {
    return {
      name: "forbidden_variables_avoided",
      status: "skipped",
      detail: "No forbidden variables configured for this decision.",
    };
  }
  const hits = forbidden.filter((v) => mentionsVariable(text, v));
  if (hits.length === 0) {
    return {
      name: "forbidden_variables_avoided",
      status: "passed",
      detail: "No forbidden variables mentioned.",
    };
  }
  return {
    name: "forbidden_variables_avoided",
    status: "failed",
    detail: `Response mentions forbidden variable(s): ${hits.join(", ")}.`,
  };
}

function checkRequiredVariablesGrounded(
  text: string,
  required: string[],
  claims: LeadsClaimVerification[],
): Layer3CheckResult {
  if (required.length === 0) {
    return {
      name: "required_variables_grounded",
      status: "skipped",
      detail: "No required sensor variables for this decision.",
    };
  }
  const missing: string[] = [];
  for (const v of required) {
    const inProse = variableMentionedWithNumber(text, v);
    const inClaim = variableInClaimSources(v, claims);
    if (!inProse && !inClaim) missing.push(v);
  }
  if (missing.length === 0) {
    return {
      name: "required_variables_grounded",
      status: "passed",
      detail: `All required variables grounded in response: ${required.join(", ")}.`,
    };
  }
  return {
    name: "required_variables_grounded",
    status: "failed",
    detail: `Required variable(s) not grounded with a number or supporting claim: ${missing.join(", ")}.`,
  };
}

/** Multi-constraint threshold check for the per-persona rules. The answer must
 *  engage each constraint's operational threshold: either its literal value, or its
 *  variable named in an answer that also mentions "threshold" or the constraint's
 *  units. Passes only if all are referenced (the deterministic constraint evaluation
 *  states them verbatim in the grounding, so a miss means the synthesizer dropped an
 *  operational number). */
function checkPersonaThresholds(text: string, constraints: ThresholdConstraint[]): Layer3CheckResult {
  if (constraints.length === 0) {
    return {
      name: "threshold_referenced",
      status: "skipped",
      detail: "No per-persona constraints for this decision.",
    };
  }
  const lower = text.toLowerCase();
  const missing: string[] = [];
  for (const c of constraints) {
    const valStr = String(c.value);
    const numberMentioned = lower.includes(valStr);
    const variableNamedNearThreshold =
      mentionsVariable(text, c.variable) &&
      (lower.includes("threshold") || lower.includes(c.units.toLowerCase()));
    if (!(numberMentioned || variableNamedNearThreshold)) {
      missing.push(`${c.variable} ${c.op} ${c.value} ${c.units}`);
    }
  }
  if (missing.length === 0) {
    return {
      name: "threshold_referenced",
      status: "passed",
      detail: `All ${constraints.length} operational threshold(s) referenced.`,
    };
  }
  return {
    name: "threshold_referenced",
    status: "failed",
    detail: `Operational threshold(s) not referenced in response: ${missing.join("; ")}.`,
  };
}

function checkUncertaintyPreserved(text: string, hasForecastEvidence: boolean): Layer3CheckResult {
  if (!hasForecastEvidence) {
    return {
      name: "uncertainty_preserved",
      status: "skipped",
      detail: "No forecast evidence in this answer; uncertainty rule does not apply.",
    };
  }
  const lower = text.toLowerCase();
  const matched = UNCERTAINTY_CUES.filter((cue) => lower.includes(cue));
  if (matched.length > 0) {
    return {
      name: "uncertainty_preserved",
      status: "passed",
      detail: `Uncertainty cue(s) present: ${matched.slice(0, 3).join(", ")}.`,
    };
  }
  return {
    name: "uncertainty_preserved",
    status: "failed",
    detail: "Forecast evidence was used but response contains no uncertainty cue (range / ensemble / spread / probability / bound / quantile / ±).",
  };
}

/** The answer must name the decision's operational lever (the framing is injected
 *  as authoritative grounding, so a miss means the synthesizer dropped it). Deterministic
 *  keyword check; skipped for decisions with no lever (informational). */
function checkOperationalLever(text: string, decision: DecisionKey): Layer3CheckResult {
  const keywords = LEVER_KEYWORDS[decision];
  if (!keywords || keywords.length === 0) {
    return {
      name: "operational_lever_referenced",
      status: "skipped",
      detail: "No operational lever for this decision (informational / unmapped).",
    };
  }
  const lower = text.toLowerCase();
  const hit = keywords.find((k) => lower.includes(k));
  if (hit) {
    return {
      name: "operational_lever_referenced",
      status: "passed",
      detail: `Operational lever named in the answer ("${hit}").`,
    };
  }
  return {
    name: "operational_lever_referenced",
    status: "failed",
    detail: `Operational lever not named (expected one of: ${keywords.join(", ")}).`,
  };
}

/** High-precision recommendation-polarity cues for the operational-conclusion check.
 *  Tuned for precision (few false positives) over recall: the deterministic banner is
 *  the authoritative floor, so this only needs to catch clear prose contradictions to
 *  trigger a corrective regeneration; a benign miss is covered by the banner. */
const NEG_RECOMMENDATION = [
  "not warranted", "is not warranted", "not necessary", "is not necessary",
  "not needed", "is not needed", "no need", "no immediate need", "not required",
  "not recommend", "would not recommend", "do not recommend", "don't recommend",
  "not advisable", "not advised", "not indicated", "unnecessary", "hold off",
  "no action", "not at this time", "not currently warranted", "isn't necessary",
  "isn't warranted", "refrain from", "need not", "premature", "defer", "postpone",
  "holding off",
];
const POS_RECOMMENDATION = [
  "is warranted", "is recommended", "recommend operating", "recommend activating",
  "recommend running", "recommend dosing", "recommend adding", "recommend applying",
  "recommend treating", "should operate", "should activate", "should run",
  "should dose", "should add", "should apply", "should treat", "is indicated",
  "is advisable", "is necessary", "is needed", "advise operating", "advise dosing",
];

/**
 * Operational-conclusion contradiction detector. Returns true only when the answer's
 * lever-scoped prose unambiguously asserts the opposite operational stance to the
 * deterministic verdict. Conservative by construction:
 *   - only clauses that name the decision's lever are examined;
 *   - a clause counts only if it carries a single-polarity recommendation cue;
 *   - if the answer asserts both stances (in different clauses) it is treated as
 *     ambiguous and not flagged.
 * The precision bias is deliberate: a positive triggers a corrective regeneration
 * (benign on a false positive, since the original is kept if regeneration does not
 * resolve it), and the deterministic banner always states the correct conclusion, so
 * recall gaps are covered. Exported so the orchestrator triggers its corrective pass
 * from the same definition.
 */
export function detectStanceContradiction(
  text: string,
  decision: DecisionKey,
  stance: "indicated" | "not_indicated",
): boolean {
  const lever = LEVER_KEYWORDS[decision];
  if (!lever || lever.length === 0) return false;
  const lower = text.toLowerCase();
  // Split into clauses: sentence enders (decimal-safe: the lookbehind requires
  // whitespace after [.!?], so "4.2 mg/L" is not split), then clause delimiters
  // (; , em/en-dash) and contrastive conjunctions. A recommendation cue is attributed
  // to the lever only when both fall in the same clause, so a cue about a different
  // action ("…HOx…, increased flow is not needed") is never misread as a statement
  // about the lever.
  const clauses = lower
    .split(/(?<=[.!?])\s+/)
    .flatMap((s) => s.split(/[;,—–]|\s+(?:but|although|though|whereas|however|while)\s+/));
  let asserted: "indicated" | "not_indicated" | null = null;
  for (const clause of clauses) {
    if (!lever.some((k) => clause.includes(k))) continue;
    const hasNeg = NEG_RECOMMENDATION.some((c) => clause.includes(c));
    const hasPos = POS_RECOMMENDATION.some((c) => clause.includes(c));
    if (hasNeg === hasPos) continue; // neither present, or mixed within one clause: skip
    const clauseStance: "indicated" | "not_indicated" = hasPos ? "indicated" : "not_indicated";
    if (asserted && asserted !== clauseStance) return false; // the answer asserts both: ambiguous
    asserted = clauseStance;
  }
  return asserted != null && asserted !== stance;
}

/** Layer-3 report of the operational-conclusion consistency check. Skipped when no
 *  determinate single-zone stance was supplied (informational, an indeterminate/absent
 *  reading, or a decision shape without a binary verdict). */
function checkOperationalConclusion(
  text: string,
  decision: DecisionKey,
  stance: "indicated" | "not_indicated" | null | undefined,
): Layer3CheckResult {
  if (!stance) {
    return {
      name: "operational_conclusion_consistent",
      status: "skipped",
      detail: "No determinate single-zone operational verdict to check the conclusion against.",
    };
  }
  if (detectStanceContradiction(text, decision, stance)) {
    return {
      name: "operational_conclusion_consistent",
      status: "failed",
      detail: `Answer prose asserts the opposite of the deterministic verdict (action ${stance === "indicated" ? "IS" : "is NOT"} indicated on the latest reading).`,
    };
  }
  return {
    name: "operational_conclusion_consistent",
    status: "passed",
    detail: `Answer's operational conclusion is consistent with the deterministic verdict (action ${stance === "indicated" ? "indicated" : "not indicated"}).`,
  };
}

/**
 * Run Layer 3 validation on a generated answer. Pure, testable; the
 * orchestrator wires inputs and emits the result as a `guardrail-l3` SSE step
 * event. Never blocks the answer: `ok=false` is a warning surfaced to the UI and
 * the evaluation, not a refusal.
 */
export function enforceLayer3(inputs: Layer3Inputs): Layer3Result {
  const guardrail = getGuardrail(inputs.reservoir, inputs.decision);
  const claims = inputs.claims ?? [];
  const text = inputs.responseText;

  // When a per-persona rule applies, audit its constraints (persona-specific
  // variables + multi-constraint thresholds). Otherwise (informational, public, or no
  // per-persona rule) use top-level required vars and skip the threshold check.
  const personaRule = inputs.persona
    ? getPersonaRule(inputs.reservoir, inputs.decision, inputs.persona)
    : null;
  const requiredVars = personaRule
    ? personaRule.constraints.map((c) => c.variable)
    : guardrail.required_sensor_variables;
  const thresholdCheck: Layer3CheckResult = personaRule
    ? checkPersonaThresholds(text, personaRule.constraints)
    : {
        name: "threshold_referenced",
        status: "skipped",
        detail: "No operational threshold for this decision.",
      };

  const checks: Layer3CheckResult[] = [
    checkForbidden(text, guardrail.forbidden_variables),
    checkRequiredVariablesGrounded(text, requiredVars, claims),
    thresholdCheck,
    checkUncertaintyPreserved(text, inputs.hasForecastEvidence),
    checkOperationalLever(text, inputs.decision),
    checkOperationalConclusion(text, inputs.decision, inputs.operationalStance),
  ];

  const enforceable = checks.filter((c) => c.status !== "skipped");
  const passed = enforceable.filter((c) => c.status === "passed").length;
  const failed = enforceable.filter((c) => c.status === "failed").length;
  const adherencePct = enforceable.length === 0
    ? 100
    : Math.round((passed / enforceable.length) * 100);

  const ok = failed === 0;
  const failedNames = checks.filter((c) => c.status === "failed").map((c) => c.name);
  const warning = ok
    ? undefined
    : `Layer 3 post-generation check(s) failed for ${guardrail.label}: ${failedNames.join(", ")}.`;

  return {
    ok,
    decision: inputs.decision,
    checks,
    adherencePct,
    warning,
  };
}
