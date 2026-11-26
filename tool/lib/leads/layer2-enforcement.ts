/**
 * Layer 2: deterministic data-fetching enforcement.
 *
 * Before the analyst LLM is invoked, the orchestrator reads the decision's
 * guardrail and verifies the required data is available (and, for operational
 * decisions, fresh enough) in retrieval. If a required variable is structurally
 * absent, or too stale to ground an action, the orchestrator refuses without
 * invoking the LLM.
 *
 * Two paths:
 *   - Per-persona, cadence-aware: when the (reservoir × decision) guardrail has a
 *     `rules_by_persona[persona]` rule, enforcement reads its constraints:
 *     persona-specific variables (e.g. DOsat_percent_mean for researcher hypoxia),
 *     per-constraint `source_class` freshness, and `forecastable: false` handling
 *     (sample-only variables are observation-only). Freshness is judged by the
 *     cadence policy (lib/leads/freshness-policy.ts):
 *       CURRENT, AGED, OFF_SEASON: proceed (AGED and OFF_SEASON add a caveat)
 *       STALE: refuse with a handoff
 *   - Presence-only fallback: when no persona rule applies (informational mode,
 *     the `public` persona, or BVR hypoxia), the check is presence-only on the
 *     guardrail's top-level `required_*` lists. Informational mode never refuses.
 *
 * The orchestrator wires sensor + forecast loaders into this pure core; the LLM
 * is only called after a successful `enforceLayer2` result.
 */

import {
  derivePersonaRequirements,
  getGuardrail,
  getPersonaRule,
  type DecisionKey,
  type Persona,
} from "./guardrails";
import { assessFreshness, cadenceClassFor } from "./freshness-policy";
import { evalNowIso } from "./config";
import type { LeadsReservoir, LeadsSensorRecord } from "./types";

export interface Layer2Inputs {
  decision: DecisionKey;
  /** Reservoir-conditioned guardrail lookup. */
  reservoir: LeadsReservoir;
  /** Selects the active `rules_by_persona` rule. When omitted (or no rule
   *  exists for it), enforcement uses the presence-only fallback. */
  persona?: Persona;
  /** Sensor records the orchestrator has already loaded for the focal site
   *  (filter by reservoir before passing in). `datetime` drives the freshness
   *  check. The operational gate requires a non-null `observation` to count a
   *  variable as available: value-less rows fall to missingSensor (refuse), so
   *  LEADS never grounds or OFF_SEASON-softens an action on an absent value. */
  sensorRecords: LeadsSensorRecord[];
  /** Variable names the forecast loader has actually returned. */
  forecastVariables: string[];
  /** ISO-8601 "now"/as-of date the freshness check is evaluated against.
   *  Defaults to the current time when omitted. */
  asOf?: string;
}

export interface Layer2Refusal {
  ok: false;
  decision: DecisionKey;
  missingSensor: string[];
  /** Required sensor variables present but too stale (older than their cadence
   *  window) to ground an operational recommendation. Empty on the presence-only
   *  fallback path. */
  staleSensor: string[];
  missingForecast: string[];
  /** Human-readable refusal text suitable for surfacing in the UI and
   *  appending to the session log. */
  refusal: string;
  /** Domain-specific refusal conditions from the live check results
   *  (not the static `guardrail.refusal_conditions` config list). */
  triggeredConditions: string[];
}

export interface Layer2Pass {
  ok: true;
  decision: DecisionKey;
  /** Subset of `sensorRecords` matching the required variables. */
  groundingSensor: LeadsSensorRecord[];
  /** The required forecast variables confirmed available. */
  groundingForecast: string[];
  /** Per-variable age caveats for required variables that are AGED or OFF_SEASON
   *  (proceed, but the answer must disclose the age). Empty when all required
   *  variables are CURRENT or on the presence-only fallback path. */
  freshnessCaveats: string[];
}

export type Layer2Result = Layer2Pass | Layer2Refusal;

// Presence-only fallback (informational / public / no persona rule)
function enforcePresenceOnly(
  decision: DecisionKey,
  reservoir: LeadsReservoir,
  sensorRecords: LeadsSensorRecord[],
  forecastVariables: string[],
): Layer2Result {
  const guardrail = getGuardrail(reservoir, decision);
  const presentSensorVars = new Set<string>();
  const groundingSensor: LeadsSensorRecord[] = [];
  for (const record of sensorRecords) {
    if (!guardrail.required_sensor_variables.includes(record.variable)) continue;
    presentSensorVars.add(record.variable);
    groundingSensor.push(record);
  }
  const missingSensor = guardrail.required_sensor_variables.filter(
    (v) => !presentSensorVars.has(v),
  );
  const forecastSet = new Set(forecastVariables);
  const missingForecast = guardrail.required_forecast_variables.filter(
    (v) => !forecastSet.has(v),
  );

  if (missingSensor.length === 0 && missingForecast.length === 0) {
    return {
      ok: true,
      decision,
      groundingSensor,
      groundingForecast: guardrail.required_forecast_variables,
      freshnessCaveats: [],
    };
  }
  return buildRefusal(decision, guardrail.label, missingSensor, [], missingForecast, []);
}

function buildRefusal(
  decision: DecisionKey,
  label: string,
  missingSensor: string[],
  staleSensor: string[],
  missingForecast: string[],
  staleMessages: string[],
): Layer2Refusal {
  const refusalParts: string[] = [
    `LEADS cannot answer this ${label} query because the data required by the operational guardrail is unavailable or not current.`,
  ];
  if (missingSensor.length) {
    refusalParts.push(`Missing sensor observations for: ${missingSensor.join(", ")}.`);
  }
  if (staleSensor.length) {
    refusalParts.push(`Required observations are too stale to ground a recommendation — ${staleMessages.join(" ")}`);
  }
  if (missingForecast.length) {
    refusalParts.push(`Missing FLARE forecast for: ${missingForecast.join(", ")}.`);
  }
  refusalParts.push("Refusing without invoking the analyst LLM (Layer 2 enforcement).");

  const triggeredConditions: string[] = [];
  if (missingSensor.length) {
    triggeredConditions.push(`Required sensor variables unavailable: ${missingSensor.join(", ")}`);
  }
  if (staleSensor.length) {
    triggeredConditions.push(`Required sensor variables stale: ${staleSensor.join(", ")}`);
  }
  if (missingForecast.length) {
    triggeredConditions.push(
      `FLARE forecast variables unavailable for the requested horizon: ${missingForecast.join(", ")}`,
    );
  }

  return {
    ok: false,
    decision,
    missingSensor,
    staleSensor,
    missingForecast,
    refusal: refusalParts.join(" "),
    triggeredConditions,
  };
}

/**
 * Check Layer 2 gating for a decision. Returns either a refusal (caller must
 * not invoke the LLM) or a pass with the grounding subset of evidence.
 *
 * Persona-rule path: refuses if and only if a required (per-persona-constraint)
 * sensor/forecast variable is structurally absent or a present required sensor
 * variable is STALE for its cadence class. AGED/OFF_SEASON variables pass with a
 * caveat. Fallback path (no persona rule): presence-only, never freshness-gated.
 *
 * Informational mode (`decision === "none"`) has no required variables and
 * always passes.
 */
export function enforceLayer2(inputs: Layer2Inputs): Layer2Result {
  const { decision, reservoir, persona, sensorRecords, forecastVariables } = inputs;
  const queryDate = inputs.asOf ?? evalNowIso();

  const personaRule = persona ? getPersonaRule(reservoir, decision, persona) : null;

  // Presence-only fallback (informational, public persona, or a decision
  // whose guardrail has no rules_by_persona entry for this persona).
  if (!personaRule) {
    return enforcePresenceOnly(decision, reservoir, sensorRecords, forecastVariables);
  }

  const label = getGuardrail(reservoir, decision).label;
  const { sensorVariables, forecastVariables: requiredForecast } =
    derivePersonaRequirements(personaRule);

  // Index presence + freshest datetime per required sensor variable.
  const requiredNames = new Set(sensorVariables.map((s) => s.variable));
  const presentVars = new Set<string>();
  const groundingSensor: LeadsSensorRecord[] = [];
  const freshestByVar = new Map<string, string>();
  for (const r of sensorRecords) {
    if (!requiredNames.has(r.variable)) continue;
    // A dated row with a null measurement is not an available observation: LEADS
    // must not ground - or OFF_SEASON-soften - an operational action on an absent
    // value. Skip value-less rows so the variable falls to missingSensor (refuse)
    // rather than passing presence on an empty record.
    if (r.observation === null) continue;
    presentVars.add(r.variable);
    groundingSensor.push(r);
    const cur = freshestByVar.get(r.variable);
    if (!cur || r.datetime > cur) freshestByVar.set(r.variable, r.datetime);
  }

  const missingSensor = sensorVariables
    .filter((s) => !presentVars.has(s.variable))
    .map((s) => s.variable);
  const forecastSet = new Set(forecastVariables);
  const missingForecast = requiredForecast.filter((v) => !forecastSet.has(v));

  // Freshness on the present required sensor variables (per cadence class).
  const staleSensor: string[] = [];
  const staleMessages: string[] = [];
  const freshnessCaveats: string[] = [];
  for (const s of sensorVariables) {
    if (!presentVars.has(s.variable)) continue; // absence handled by missingSensor
    const dt = freshestByVar.get(s.variable)!;
    const assessment = assessFreshness(cadenceClassFor(s.sourceClass, "sensor"), dt, queryDate);
    if (assessment.status === "STALE") {
      staleSensor.push(s.variable);
      staleMessages.push(`${s.variable}: ${assessment.message}`);
    } else if (assessment.status === "AGED" || assessment.status === "OFF_SEASON") {
      freshnessCaveats.push(`${s.variable}: ${assessment.message}`);
    }
  }

  const hasFailure =
    missingSensor.length > 0 || missingForecast.length > 0 || staleSensor.length > 0;

  if (!hasFailure) {
    return {
      ok: true,
      decision,
      groundingSensor,
      groundingForecast: requiredForecast,
      freshnessCaveats,
    };
  }

  return buildRefusal(decision, label, missingSensor, staleSensor, missingForecast, staleMessages);
}
