/**
 * Decision-conditioned guardrail configuration: the executable policy layer.
 * Guardrails are keyed by (reservoir × decision) because the operational lever
 * differs by reservoir: FCR has a Hypolimnetic Oxygenation System (HOx) for
 * hypoxia control, BVR does not, so no addendum recommends an action the user
 * cannot take.
 */

import type { LeadsDepthZone, LeadsReservoir } from "./types";

export type DecisionKey =
  | "hypoxia_management"
  | "water_extraction"
  | "flow_management"
  | "algal_management"
  | "none";

// Guardrail schema
//
// Operational criteria are (a) per-persona (managers use operational units, e.g.
// DO mg/L; researchers use scientific units, e.g. DO % saturation) and (b)
// multi-constraint (e.g. researcher water extraction: DO ≥ 50% saturation AND
// chl-a < 20 µg/L), expressed as `rules_by_persona`.

/** Comparison operator for an operational constraint. */
export type ThresholdOp = "<" | "<=" | ">" | ">=";

/** Data-source class for a constraint's variable. Selects the freshness window
 *  (see freshness-policy.ts) and the ingestion path. */
export type SourceClass = "continuous" | "fluoroprobe" | "lab" | "forecast" | "derived";

/** Where in the water column the constraint is evaluated.
 *  - profile_zone: the decision's implied thermal zone (e.g. hypoxia: hypolimnion, 9 m)
 *  - surface:      the epilimnion / shallowest sensor (e.g. algae-manager, flow)
 *  - full_profile: every reportable depth (e.g. algae-researcher "any depth", water-extraction "pick best") */
export type DepthScope = "profile_zone" | "surface" | "full_profile";

/** One AND-combined operational constraint, e.g. { DO_mgL_mean, ">=", 4, "mg/L" }. */
export interface ThresholdConstraint {
  variable: string;            // observation variable (e.g. "DO_mgL_mean", "Chla_ugL_mean")
  op: ThresholdOp;
  value: number;
  units: string;               // "mg/L" | "% saturation" | "µg/L"
  source_class: SourceClass;
  forecastable: boolean;       // can FLARE forecast it? (false for sample-only variables FLARE doesn't model)
  forecast_variable?: string;  // FLARE variable when it differs from `variable`
  note?: string;               // caveat (e.g. "FLARE modeled chl, not FluoroProbe-sample-equivalent")
  source_citation?: string;    // published source of the threshold value, if any (no rule sets one)
}

/** "MM-DD" inclusive seasonal window during which a rule applies. */
export interface SeasonalWindow {
  start_mmdd: string; // e.g. "03-01"
  end_mmdd: string;   // e.g. "09-30"
}

/** A constraint in the operational specification that the rule does not evaluate, and why. */
export interface NotEvaluatedConstraint {
  label: string;   // plain-language name of the constraint(s), as the spec states them
  reason: string;  // why the live check cannot evaluate it (cadence / no feed)
}

/** A persona's complete operational rule for a decision: AND-combined constraints,
 *  the depth scope they apply at, and optional season / persistence gates. */
export interface PersonaRule {
  constraints: ThresholdConstraint[];
  depth_scope: DepthScope;
  seasonal_window?: SeasonalWindow;     // optional; no current rule sets one
  temporal_persistence_days?: number;   // e.g. 7 for flow (at least 7 consecutive days)
  /** Constraints the operational specification requires but this rule does not
   *  evaluate. constraint-eval prints them as a deterministic "Not evaluated: …" line
   *  and the UI/PDF print a scope line under the answer, so a check that departs from
   *  its specification says so instead of passing silently. Fill only from the
   *  specification, never from an individual answer. */
  not_evaluated?: NotEvaluatedConstraint[];
}

export interface DecisionGuardrail {
  key: DecisionKey;
  label: string;
  required_sensor_variables: string[];
  required_forecast_variables: string[];
  forbidden_variables: string[];
  /** Per-persona, AND-combined operational constraints. Absent for informational
   *  mode (`none`) and the BVR-hypoxia N/A entry (no oxygenation lever). */
  rules_by_persona?: Partial<Record<Persona, PersonaRule>>;
  /** Operational framing (lever + do-not rules). Not placed in the LLM system prompt:
   *  the orchestrator injects this string as an authoritative `operational-framing`
   *  evidence item, and Layer 3 audits that the answer named the lever
   *  (`operational_lever_referenced`). */
  system_prompt_addendum: string;
  refusal_conditions: string[];
  required_response_elements: string[];
}

// Reservoir to VERA/FLARE site ID conversion

/** VERA/FLARE site identifier for a profile-facing reservoir name. */
export function siteIdFor(reservoir: LeadsReservoir): "fcre" | "bvre" {
  return reservoir === "fcr" ? "fcre" : "bvre";
}

// Depth zone to meter resolution
//
// Every meter listed below corresponds to (a) a VERA sensor at that reservoir
// and (b) an exact-matching FLARE GLM-AED layer (0.000 m gap), so a query at,
// e.g., the FCR hypolimnion is grounded at 9 m in both channels. Zone boundaries
// are fixed at these sensor depths.
//
// BVR DO is measured only at 1.5 / 6 / 8 / 13 m, with no sensor between 8 and
// 13 m. The 13 m (bottom) sensor records genuine persistent hypolimnetic anoxia,
// not a fault (in 2026 it declined from 1.2 to 0.02 mg/L through April, then held
// near 0 all summer), so it carries no dynamic range. The hypolimnion therefore
// resolves to 8 m, the deepest sensor with varying readings (~8–9 mg/L). Use 13 m
// only when a bottom-DO (anoxia) signal is explicitly wanted.

export const DEPTH_ZONE_MAPPING: Record<LeadsReservoir, Record<LeadsDepthZone, number[]>> = {
  fcr: {
    epilimnion: [1.6],
    metalimnion: [5],
    hypolimnion: [9],
  },
  bvr: {
    epilimnion: [1.5],
    metalimnion: [6],
    hypolimnion: [8], // deepest BVR DO sensor with varying readings; 13 m (bottom) reads near-zero anoxia
  },
};

export function resolveDepthMeters(
  reservoir: LeadsReservoir,
  zone: LeadsDepthZone,
): number[] {
  return DEPTH_ZONE_MAPPING[reservoir][zone];
}

// Reservoir × Decision guardrails
//
// Base content (variable lists, thresholds, refusal conditions) is largely
// reservoir-invariant. What changes per reservoir is the
// `system_prompt_addendum` (because the operational lever differs) and the
// `required_response_elements` (which name the lever).

const HYPOXIA_FCR: DecisionGuardrail = {
  key: "hypoxia_management",
  label: "Hypoxia management",
  required_sensor_variables: ["DO_mgL_mean", "Temp_C_mean"],
  required_forecast_variables: ["DO_mgL_mean", "Temp_C_mean"],
  forbidden_variables: [],
  system_prompt_addendum: [
    "DECISION CONTEXT: Hypoxia management at FCR — whether to operate the FCR Hypolimnetic Oxygenation System (HOx).",
    "Operational lever: HOx on/off, intensity, duration.",
    "Ground the recommendation in hypolimnetic dissolved oxygen (DO), water temperature, and forecasted DO trajectory at the hypolimnion depth.",
    "Reference the operational DO threshold. It is a LEADS operational value for this deployment with NO published source citation — state it as an operational threshold and never attribute it to a paper.",
    "Preserve forecast uncertainty: report ensemble spread / threshold-crossing probability, not point estimates.",
    "If the required sensor or forecast variables are missing, refuse and explain what is missing.",
    // Circularity guard: FCR runs HOx through summer stratification, so hypolimnetic
    // DO well above the day-of-year mean is likely a result of the system running.
    // LEADS has no telemetry on the system's on/off state, so the verdict is scoped
    // to activation and the confound is named.
    "OPERATING STATE: LEADS has NO telemetry on whether the HOx system is currently running. The decision evaluated here is whether conditions call for ACTIVATION against the DO trigger — say 'activation is not indicated', never 'operation is not needed', and never recommend stopping, pausing or reducing a system that may already be running.",
    "CONFOUND: during summer stratification, hypolimnetic DO substantially above the day-of-year seasonal mean may itself be the effect of the HOx system already operating. Where the reading is well above that mean, state this explicitly — a healthy DO reading is not evidence that oxygenation is unnecessary.",
    // Temporal scope: the deterministic check evaluates the latest reading, while
    // questions often name a period ("this week"). A period-wide verdict could
    // contradict a forecast giving a high chance of crossing the trigger within that
    // period, so the verdict stays scoped to the reading, as the banner is.
    "TEMPORAL SCOPE: the deterministic check evaluates the most recent reading, not a period. Where the question names a period ('this week', 'the next N days'), keep the verdict scoped to the reading — say 'activation is not indicated on the current reading' — and answer the period separately from the forecast, stating plainly whether and when the trigger is likely to be met within it. Never extend the verdict across a period the check did not evaluate. Apply this silently: shape the answer accordingly but never describe the requirement, the guardrail or the framing to the reader — the reader wants the reservoir, not the rulebook.",
  ].join(" "),
  refusal_conditions: [
    "Required hypolimnetic DO observations unavailable",
    "FLARE DO forecast unavailable for the requested horizon",
  ],
  required_response_elements: [
    "Cites current hypolimnetic DO at FCR",
    "References operational DO threshold for HOx activation",
    "Preserves forecast uncertainty (no fabricated point estimate)",
  ],
  // FCR only (BVR has no HOx).
  // Manager: operate HOx when 9 m DO ≤ 4 mg/L. Researcher: 9 m DO < 50% saturation.
  // No source_citation: operational values with no published reference.
  rules_by_persona: {
    manager: {
      constraints: [
        {
          variable: "DO_mgL_mean",
          op: "<=",
          value: 4,
          units: "mg/L",
          source_class: "continuous",
          forecastable: true,
          forecast_variable: "DO_mgL_mean",
        },
      ],
      depth_scope: "profile_zone", // hypolimnion, 9 m
    },
    researcher: {
      constraints: [
        {
          variable: "DOsat_percent_mean",
          op: "<",
          value: 50,
          units: "% saturation",
          source_class: "continuous",
          forecastable: true,
          forecast_variable: "DO_mgL_mean",
          note: "forecast %sat derived from FLARE DO_mgL_mean + Temp_C_mean via García–Benson @1 atm (FLARE has no native saturation variable); sensor side reads native DOsat_percent_mean",
        },
      ],
      depth_scope: "profile_zone", // hypolimnion, 9 m
    },
  },
};

// Hypoxia at BVR is not an operational decision: BVR has no Hypolimnetic
// Oxygenation System, so there is no in-reservoir lever to recommend. The UI
// gates this combination out (UserProfilePanel) and the planner falls back; this
// entry exists only to keep the reservoir × decision lookup type-complete. Its
// addendum only states that no lever exists, and it has no rules_by_persona, so
// getPersonaRule() returns null and no operational answer is synthesized for
// BVR hypoxia.
const HYPOXIA_BVR: DecisionGuardrail = {
  key: "hypoxia_management",
  label: "Hypoxia management (N/A at BVR — no oxygenation system)",
  required_sensor_variables: [],
  required_forecast_variables: [],
  forbidden_variables: [],
  system_prompt_addendum: [
    "DECISION CONTEXT: BVR has NO hypolimnetic oxygenation system, so hypoxia management is NOT an operational decision at BVR.",
    "Do NOT recommend any oxygenation action at BVR — no such capability exists on site.",
  ].join(" "),
  refusal_conditions: [
    "Hypoxia management is not an operational decision at BVR (no oxygenation system)",
  ],
  required_response_elements: [
    "States no in-reservoir oxygenation lever exists at BVR",
  ],
};

// The operational specification requires soluble Fe < 0.3 AND Mn < 0.05 mg/L
// alongside DO for both personas. The rule does not evaluate them (see
// WATER_EXTRACTION_BASE), so the answer states what the check leaves out. The
// wording reflects their sampling cadence (lab grab samples, weekly in season; no
// sensor feed).
const WATER_EXTRACTION_NOT_EVALUATED: NotEvaluatedConstraint[] = [
  { label: "soluble iron and manganese", reason: "lab-sampled weekly to seasonally; no live feed" },
];

const WATER_EXTRACTION_BASE: Omit<DecisionGuardrail, "system_prompt_addendum" | "required_response_elements" | "label"> = {
  key: "water_extraction",
  // Manager core observation variable. Researcher adds DOsat + chl-a via
  // rules_by_persona below. Soluble Fe/Mn are not constraints: their
  // weekly-to-seasonal lab-grab cadence cannot ground a withdrawal recommendation on
  // current conditions (it would cause chronic STALE refusals), so the guardrail gates
  // on the continuously sensed DO profile. Fe/Mn remain a literature/advisory topic.
  // This top-level list is the presence-only fallback baseline; the operational
  // path reads rules_by_persona.
  required_sensor_variables: ["DO_mgL_mean"],
  required_forecast_variables: ["DO_mgL_mean", "Temp_C_mean"], // DO forecast (+ Temp for %sat derivation)
  forbidden_variables: [],
  refusal_conditions: [
    "Required DO profile incomplete at candidate withdrawal depths",
  ],
  // Applies to FCR and BVR. Semantics: select the depth(s) where all constraints
  // hold (a qualifying-depth search on the continuously sensed DO profile, not a
  // trigger).
  rules_by_persona: {
    manager: {
      constraints: [
        { variable: "DO_mgL_mean", op: ">=", value: 4, units: "mg/L",
          source_class: "continuous", forecastable: true, forecast_variable: "DO_mgL_mean" },
      ],
      depth_scope: "full_profile",
      not_evaluated: WATER_EXTRACTION_NOT_EVALUATED,
    },
    researcher: {
      constraints: [
        { variable: "DOsat_percent_mean", op: ">=", value: 50, units: "% saturation",
          source_class: "continuous", forecastable: true, forecast_variable: "DO_mgL_mean",
          note: "forecast %sat derived from FLARE DO_mgL_mean + Temp_C_mean via García–Benson @1 atm" },
        { variable: "TotalConcCM_ugL_sample", op: "<", value: 20, units: "µg/L",
          source_class: "fluoroprobe", forecastable: true, forecast_variable: "Chla_ugL_mean",
          note: "FLARE modeled chl, not FluoroProbe-sample-equivalent" },
      ],
      depth_scope: "full_profile",
      not_evaluated: WATER_EXTRACTION_NOT_EVALUATED,
    },
  },
};

const WATER_EXTRACTION_FCR: DecisionGuardrail = {
  ...WATER_EXTRACTION_BASE,
  label: "Water extraction (intake depth)",
  system_prompt_addendum: [
    "DECISION CONTEXT: Water extraction at FCR — selecting the intake depth that minimizes downstream treatment burden for the Western Virginia Water Authority.",
    "Operational lever: variable-depth intake selection at FCR's drinking-water withdrawal.",
    "Ground the recommendation in the dissolved-oxygen profile across candidate depths. The operative constraints and threshold values come from the per-persona constraint set evaluated for this decision — apply exactly those and no others.",
    "Select the depth(s) meeting ALL constraints (a qualifying-depth search over the full dissolved-oxygen profile).",
    // The manager rule has exactly one constraint (DO >= 4 mg/L), so naming a
    // "binding constraint" would only restate the verdict; the instruction applies
    // when more than one constraint is in force (the researcher rule). Exception: the
    // deterministic "Not evaluated: ..." line that constraint-eval prints when the
    // rule departs from its specification is relayed as a limit on the evidence. The
    // exception names no constraint; the content comes only from the deterministic record.
    "Name the depths compared. Frame the answer as a multi-variable tradeoff and name the binding constraint ONLY when more than one constraint is in force; with a single constraint, naming it separately merely restates the verdict, so do not add a binding-constraint line or section, and do not remark on which constraints are or are not in force for this persona — apply the constraint and report the result. Never write a sentence about which constraints the rule does or does not contain: that describes LEADS's configuration rather than the reservoir. The one exception to both of these: when the deterministic constraint evaluation includes a 'Not evaluated:' line, relay it once, in plain words, as a limit on what the check covered. If no depth qualifies, report the per-depth binding constraint rather than refusing.",
    "Preserve forecast uncertainty in the DO component.",
    // This decision compares several depths, each with its own day-of-year baseline.
    // Collapsing them into one clause can misstate a depth (e.g. 1.6 m at 7.53 mg/L
    // against a 7.66 mean is not "above typical seasonal means"). The evidence records
    // already distinguish them ("is above the matched seasonal mean" vs "falls within
    // the matched historical window").
    "PER-DEPTH COMPARISONS: every depth has its own seasonal baseline. Never generalise a seasonal-mean comparison across depths — a reading can sit above its baseline at one depth and at or below it at another. Either state each depth against its own baseline, or omit the comparison. Report only what each cited record states for that depth.",
    // The seasonal comparison matters most at a depth that fails: a depth can sit
    // below the intake floor yet above its seasonal mean (e.g. FCR 5 m at 3.52 mg/L
    // against a late-August mean of 2.32), which is a normal metalimnetic minimum
    // rather than a developing problem.
    "FAILING DEPTHS NEED THEIR BASELINE: any depth that does NOT meet a constraint must be placed against its own seasonal baseline — state whether that value sits above, at, or below the seasonal mean for this time of year, exactly as the cited record for that depth words it. A depth can fail the operational floor while sitting above its seasonal mean; that is normal seasonal structure rather than a developing problem, and the reader needs the distinction to act correctly.",
    "Print the operative threshold value(s) being applied, so the reader can see what \"meets the constraint\" means.",
    "Refuse if the required DO profile is unavailable at candidate depths.",
  ].join(" "),
  required_response_elements: [
    "Names compared candidate intake depths at FCR",
    "Cites DO at each candidate depth",
    "States the binding constraint / dominant driver of the depth recommendation",
  ],
};

const WATER_EXTRACTION_BVR: DecisionGuardrail = {
  ...WATER_EXTRACTION_BASE,
  label: "Water extraction (transfer-out depth)",
  // Mirrors WATER_EXTRACTION_FCR (same depth-selection rule) with BVR
  // transfer-outlet labels, so the two reservoirs are handled in parallel. The
  // comments on the FCR instructions explain the shared ones.
  system_prompt_addendum: [
    "DECISION CONTEXT: Water extraction at BVR — selecting the withdrawal depth for the BVR→FCR transfer pipeline.",
    "Operational lever: variable-depth withdrawal at BVR's transfer outlet.",
    "Ground the recommendation in the dissolved-oxygen profile across candidate depths. The operative constraints and threshold values come from the per-persona constraint set evaluated for this decision — apply exactly those and no others.",
    "Select the depth(s) meeting ALL constraints (a qualifying-depth search over the full dissolved-oxygen profile).",
    "Name the depths compared. Frame the answer as a multi-variable tradeoff and name the binding constraint ONLY when more than one constraint is in force; with a single constraint, naming it separately merely restates the verdict, so do not add a binding-constraint line or section, and do not remark on which constraints are or are not in force for this persona — apply the constraint and report the result. Never write a sentence about which constraints the rule does or does not contain: that describes LEADS's configuration rather than the reservoir. The one exception to both of these: when the deterministic constraint evaluation includes a 'Not evaluated:' line, relay it once, in plain words, as a limit on what the check covered. If no depth qualifies, report the per-depth binding constraint rather than refusing.",
    "Preserve forecast uncertainty in the DO component.",
    "PER-DEPTH COMPARISONS: every depth has its own seasonal baseline. Never generalise a seasonal-mean comparison across depths — a reading can sit above its baseline at one depth and at or below it at another. Either state each depth against its own baseline, or omit the comparison. Report only what each cited record states for that depth.",
    "FAILING DEPTHS NEED THEIR BASELINE: any depth that does NOT meet a constraint must be placed against its own seasonal baseline — state whether that value sits above, at, or below the seasonal mean for this time of year, exactly as the cited record for that depth words it. A depth can fail the operational floor while sitting above its seasonal mean; that is normal seasonal structure rather than a developing problem, and the reader needs the distinction to act correctly.",
    "Print the operative threshold value(s) being applied, so the reader can see what \"meets the constraint\" means.",
    "Refuse if the required DO profile is unavailable at candidate depths.",
  ].join(" "),
  required_response_elements: [
    "Names compared candidate withdrawal depths at BVR",
    "Cites DO at each candidate depth",
    "States the binding constraint / dominant driver of the depth recommendation",
  ],
};

const FLOW_MANAGEMENT_BASE: Omit<DecisionGuardrail, "system_prompt_addendum" | "required_response_elements" | "label"> = {
  key: "flow_management",
  required_sensor_variables: ["Chla_ugL_mean"],
  required_forecast_variables: ["Chla_ugL_mean"],
  forbidden_variables: [],
  refusal_conditions: [
    "Surface chlorophyll-a observations unavailable over the persistence window",
  ],
  // Bloom-flush decision. Trigger: surface chl-a sustained above threshold for ≥7
  // days: recommend increasing flow to flush the bloom (qualitative action; no
  // discharge/level setpoint, as LEADS has no flow-rate data).
  // Surface = epilimnion sonde (1.6 m FCR / 1.5 m BVR), within the surface mixed layer.
  // Daily sonde Chla_ugL_mean is required (not the biweekly FluoroProbe sample) because
  // a persistence test of at least 7 consecutive days needs daily data. Manager 20 /
  // Researcher 50 µg/L.
  rules_by_persona: {
    manager: {
      constraints: [
        { variable: "Chla_ugL_mean", op: ">", value: 20, units: "µg/L",
          source_class: "continuous", forecastable: true, forecast_variable: "Chla_ugL_mean" },
      ],
      depth_scope: "surface",
      temporal_persistence_days: 7,
    },
    researcher: {
      constraints: [
        { variable: "Chla_ugL_mean", op: ">", value: 50, units: "µg/L",
          source_class: "continuous", forecastable: true, forecast_variable: "Chla_ugL_mean" },
      ],
      depth_scope: "surface",
      temporal_persistence_days: 7,
    },
  },
};

/** "at least 7 consecutive days", built from the persona rules' temporal_persistence_days.
 *  If the personas ever diverge, each is named so neither number is misstated. */
function persistenceWindowPhrase(rules: DecisionGuardrail["rules_by_persona"]): string {
  const entries = Object.entries(rules ?? {}).filter(
    (e): e is [string, PersonaRule & { temporal_persistence_days: number }] =>
      e[1]?.temporal_persistence_days != null,
  );
  const days = Array.from(new Set(entries.map(([, r]) => r.temporal_persistence_days)));
  if (days.length === 0) return "the persistence window";
  if (days.length === 1) return `at least ${days[0]} consecutive days`;
  return entries.map(([p, r]) => `at least ${r.temporal_persistence_days} consecutive days (${p} rule)`).join(" / ");
}

// Single source for the persistence window: the prompt wording is generated from the
// same `temporal_persistence_days` that the deterministic test (runSpanDays >=
// requiredDays in constraint-eval) enforces, so the two cannot drift apart.
const FLOW_PERSISTENCE_WINDOW = persistenceWindowPhrase(FLOW_MANAGEMENT_BASE.rules_by_persona);

const FLOW_MANAGEMENT_FCR: DecisionGuardrail = {
  ...FLOW_MANAGEMENT_BASE,
  label: "Flow management (bloom flush — FCR)",
  system_prompt_addendum: [
    "DECISION CONTEXT: Flow management at FCR — whether to increase flow to flush a surface algal bloom.",
    "Operational lever: increase flow to flush the bloom (qualitative; no specific flow-rate setpoint).",
    `Trigger: surface (epilimnion) chlorophyll-a sustained above the operational threshold for ${FLOW_PERSISTENCE_WINDOW}.`,
    "Ground the recommendation in the surface chlorophyll-a record over the persistence window and the chlorophyll-a forecast trajectory.",
    "Preserve forecast uncertainty.",
    "Refuse if surface chlorophyll-a is unavailable over the persistence window.",
    // The persistence test evaluates the trailing window ending at the last
    // observation, not today. With a lagging sonde feed these are different periods,
    // and a manager reporting a bloom "this week" may be describing days the test
    // never saw. The caveat scales with coverage: when the record covers most of the
    // period described, report what it shows first, then name only the days missing.
    "DATA WINDOW: the persistence test covers the trailing window ending at the most recent observation, not today. Always state the date that window ends. If — and only if — the user asserts that bloom conditions have prevailed over some stated period, you MUST address that assertion directly in its own short paragraph — never silently drop it. If the user merely ASKS whether the threshold was sustained, they have asserted nothing: answer the question and do not invent a hypothetical assertion to rebut. In that paragraph, state what the observations covering the period they describe actually show and whether those observations support or contradict the assertion, then name only the days no observation covers. When observations cover most of the period described, do NOT say the report can be neither confirmed nor refuted — say what the record over those days shows and note the remaining gap. Give the recommendation on the evidence that does exist.",
  ].join(" "),
  required_response_elements: [
    `Cites surface chlorophyll-a over the persistence window (${FLOW_PERSISTENCE_WINDOW}) at FCR`,
    `States whether surface chlorophyll-a has stayed above the threshold for ${FLOW_PERSISTENCE_WINDOW}`,
    "Recommends increasing flow to flush the bloom when the threshold is sustained",
  ],
};

// Mirrors FLOW_MANAGEMENT_FCR with BVR labels; the DATA WINDOW comment there applies here too.
const FLOW_MANAGEMENT_BVR: DecisionGuardrail = {
  ...FLOW_MANAGEMENT_BASE,
  label: "Flow management (bloom flush — BVR)",
  system_prompt_addendum: [
    "DECISION CONTEXT: Flow management at BVR — whether to increase flow to flush a surface algal bloom.",
    "Operational lever: increase flow to flush the bloom (qualitative; no specific flow-rate setpoint).",
    `Trigger: surface (epilimnion) chlorophyll-a sustained above the operational threshold for ${FLOW_PERSISTENCE_WINDOW}.`,
    "Ground the recommendation in the surface chlorophyll-a record over the persistence window and the chlorophyll-a forecast trajectory.",
    "Preserve forecast uncertainty.",
    "Refuse if surface chlorophyll-a is unavailable over the persistence window.",
    "DATA WINDOW: the persistence test covers the trailing window ending at the most recent observation, not today. Always state the date that window ends. If — and only if — the user asserts that bloom conditions have prevailed over some stated period, you MUST address that assertion directly in its own short paragraph — never silently drop it. If the user merely ASKS whether the threshold was sustained, they have asserted nothing: answer the question and do not invent a hypothetical assertion to rebut. In that paragraph, state what the observations covering the period they describe actually show and whether those observations support or contradict the assertion, then name only the days no observation covers. When observations cover most of the period described, do NOT say the report can be neither confirmed nor refuted — say what the record over those days shows and note the remaining gap. Give the recommendation on the evidence that does exist.",
  ].join(" "),
  required_response_elements: [
    `Cites surface chlorophyll-a over the persistence window (${FLOW_PERSISTENCE_WINDOW}) at BVR`,
    `States whether surface chlorophyll-a has stayed above the threshold for ${FLOW_PERSISTENCE_WINDOW}`,
    "Recommends increasing flow to flush the bloom when the threshold is sustained",
  ],
};

const ALGAL_MANAGEMENT_BASE: Omit<DecisionGuardrail, "system_prompt_addendum" | "required_response_elements" | "label"> = {
  key: "algal_management",
  required_sensor_variables: ["Chla_ugL_mean", "Temp_C_mean", "Bloom_binary_mean"],
  required_forecast_variables: ["Chla_ugL_mean", "Temp_C_mean"],
  forbidden_variables: [],
  refusal_conditions: [
    "Chla observations missing at surface or shallow-pelagic depths",
    "FLARE Chla forecast unavailable for requested horizon",
  ],
  // Reservoir-invariant threshold; the lever differs per addendum.
  // Manager: surface sonde Chla_ugL_mean > 20 µg/L, year-round.
  // Researcher: FluoroProbe profile TotalConcCM_ugL_sample > 20 µg/L at any depth.
  // No source_citation: 20 µg/L is an operational value with no published citation.
  rules_by_persona: {
    manager: {
      constraints: [
        {
          variable: "Chla_ugL_mean",
          op: ">",
          value: 20,
          units: "µg/L",
          source_class: "continuous",
          forecastable: true,
          forecast_variable: "Chla_ugL_mean",
        },
      ],
      depth_scope: "surface",
    },
    researcher: {
      constraints: [
        {
          variable: "TotalConcCM_ugL_sample",
          op: ">",
          value: 20,
          units: "µg/L",
          source_class: "fluoroprobe",
          forecastable: true,
          forecast_variable: "Chla_ugL_mean",
          note: "FLARE forecast is modeled chl-a (Chla_ugL_mean), not FluoroProbe-sample-equivalent; treat as a risk outlook, not an exact match",
        },
      ],
      depth_scope: "full_profile",
    },
  },
};

const ALGAL_MANAGEMENT_FCR: DecisionGuardrail = {
  ...ALGAL_MANAGEMENT_BASE,
  label: "Algal management",
  system_prompt_addendum: [
    "DECISION CONTEXT: Algal management at FCR — whether to add algaecide to control bloom development.",
    "Operational lever: add algaecide.",
    "Ground the recommendation in chlorophyll-a at the relevant depth and the chlorophyll-a forecast trajectory.",
    "Reference the operational chlorophyll-a threshold. It is a LEADS operational value for this deployment with NO published source citation — state it as an operational threshold and never attribute it to a paper.",
    "Preserve forecast uncertainty: report threshold-crossing probability, not a single trajectory.",
    "If the bloom is toxin-forming (e.g. Microcystis), flag the toxin-release risk before recommending algaecide.",
    "Refuse if chlorophyll-a is missing at the relevant depths.",
  ].join(" "),
  required_response_elements: [
    "Cites chlorophyll-a at the relevant depths at FCR",
    "References the operational chlorophyll-a threshold for algaecide",
    "Preserves forecast uncertainty (threshold-crossing probability)",
  ],
};

const ALGAL_MANAGEMENT_BVR: DecisionGuardrail = {
  ...ALGAL_MANAGEMENT_BASE,
  label: "Algal management",
  system_prompt_addendum: [
    "DECISION CONTEXT: Algal management at BVR — whether to add algaecide to control bloom development.",
    "Operational lever: add algaecide.",
    "Ground the recommendation in BVR chlorophyll-a profile and the chlorophyll-a forecast trajectory.",
    "Reference the operational chlorophyll-a threshold. It is a LEADS operational value for this deployment with NO published source citation — state it as an operational threshold and never attribute it to a paper.",
    "Preserve forecast uncertainty.",
    "If the bloom is toxin-forming (e.g. Microcystis), flag the toxin-release risk before recommending algaecide.",
    // BVR-specific depth limitation. The epilimnion sonde sits at 1.5 m, but
    // Planktothrix at BVR has been documented blooming below the thermocline during
    // strong stratification (Hamre et al., 2018, Freshwater Science; in the literature
    // corpus). A surface reading therefore cannot rule out a deep bloom, and a
    // no-algaecide call that rests on it must say so. Encoded here because it is a
    // property of this reservoir's monitoring, not of any one question.
    "DEPTH LIMITATION: the BVR surface sonde (1.5 m) cannot detect a bloom below the thermocline, and Planktothrix has been observed blooming in the BVR hypolimnion during strong summer stratification. Whenever the recommendation rests on a surface chlorophyll-a reading, state that a deeper bloom would not register in it.",
  ].join(" "),
  required_response_elements: [
    "Cites chlorophyll-a at BVR at the relevant depths",
    "States the surface-sonde depth limitation when the call rests on a surface reading",
    "References the operational chlorophyll-a threshold for algaecide",
    "Preserves forecast uncertainty",
  ],
};

const INFORMATIONAL: DecisionGuardrail = {
  key: "none",
  label: "Informational (Researcher / General public)",
  required_sensor_variables: [],
  required_forecast_variables: [],
  forbidden_variables: [],
  system_prompt_addendum: [
    "DECISION CONTEXT: Informational mode — no operational guardrails.",
    "Answer as a synthesis of the retrieved literature (and sensor/forecast context when available).",
    "Do not recommend operational actions (dosing, HOx operation, transfer scheduling, intake-depth changes).",
    "Preserve uncertainty and cite sources.",
  ].join(" "),
  refusal_conditions: [],
  required_response_elements: ["Cites retrieved literature", "No operational recommendation issued"],
};

/**
 * The 2-D guardrail lookup table: one guardrail per reservoir × decision.
 *
 * Most fields (required variables, thresholds, refusal conditions) are
 * effectively the same between reservoirs because the underlying biology
 * is the same. What differs is the operational content: which lever the
 * manager has and what they cite.
 */
export const RESERVOIR_DECISION_GUARDRAILS: Record<LeadsReservoir, Record<DecisionKey, DecisionGuardrail>> = {
  fcr: {
    hypoxia_management: HYPOXIA_FCR,
    water_extraction: WATER_EXTRACTION_FCR,
    flow_management: FLOW_MANAGEMENT_FCR,
    algal_management: ALGAL_MANAGEMENT_FCR,
    none: INFORMATIONAL,
  },
  bvr: {
    hypoxia_management: HYPOXIA_BVR,
    water_extraction: WATER_EXTRACTION_BVR,
    flow_management: FLOW_MANAGEMENT_BVR,
    algal_management: ALGAL_MANAGEMENT_BVR,
    none: INFORMATIONAL,
  },
};

/**
 * Reservoir-aware guardrail accessor. Always prefer this over reaching into
 * the lookup directly so future config changes (e.g. seasonal addenda)
 * remain encapsulated.
 */
export function getGuardrail(
  reservoir: LeadsReservoir,
  decision: DecisionKey,
): DecisionGuardrail {
  return RESERVOIR_DECISION_GUARDRAILS[reservoir][decision];
}

/**
 * Allowed decision keys per persona. Manager sees all four operational decisions;
 * Researcher and General public are pinned to informational mode.
 */
export type Persona = "manager" | "researcher" | "public";

export const PERSONA_DECISIONS: Record<Persona, DecisionKey[]> = {
  manager: ["hypoxia_management", "water_extraction", "flow_management", "algal_management"],
  researcher: ["none"],
  public: ["none"],
};

// Persona-rule accessors
//
// Enforcement (Layer 2/3), the router (variableHints), and the forecast
// threshold all resolve the active PersonaRule through here.

/** The active per-persona rule for a (reservoir × decision × persona), or null
 *  when the decision has no rule for that persona (informational mode, the
 *  `public` persona, or BVR hypoxia; callers then use the presence-only check). */
export function getPersonaRule(
  reservoir: LeadsReservoir,
  decision: DecisionKey,
  persona: Persona,
): PersonaRule | null {
  return getGuardrail(reservoir, decision).rules_by_persona?.[persona] ?? null;
}

export interface PersonaRequirements {
  /** Observation-side variables the rule constrains, with their cadence class
   *  (drives the Layer-2 freshness window). One per constraint. */
  sensorVariables: { variable: string; sourceClass: SourceClass }[];
  /** FLARE forecast variables required by forecastable constraints. Constraints
   *  with `forecastable: false` (sample-only variables FLARE does not model) are
   *  observation-only and contribute nothing here. Deduped. */
  forecastVariables: string[];
}

/** Split a PersonaRule's constraints into the observation-side variables (with
 *  cadence class) and the forecast-side variables enforcement must check. */
export function derivePersonaRequirements(rule: PersonaRule): PersonaRequirements {
  const sensorVariables = rule.constraints.map((c) => ({
    variable: c.variable,
    sourceClass: c.source_class,
  }));
  const forecastVariables = Array.from(
    new Set(
      rule.constraints
        .filter((c) => c.forecastable)
        .map((c) => c.forecast_variable ?? c.variable),
    ),
  );
  return { sensorVariables, forecastVariables };
}

/** For `depth_scope: profile_zone` decisions, which thermal zone the decision
 *  implies. Only hypoxia uses profile_zone (hypolimnion); surface/full_profile
 *  decisions don't consult this. */
const DECISION_PROFILE_ZONE: Partial<Record<DecisionKey, LeadsDepthZone>> = {
  hypoxia_management: "hypolimnion",
};

/**
 * Resolve the depth(s) a persona rule's `depth_scope` evaluates at. Depth is
 * derived from decision × scope rather than chosen freely, so the profile and
 * query depths always agree:
 *   - surface:      epilimnion sonde (e.g. algae-manager, flow)
 *   - profile_zone: the decision's implied zone (hypoxia: hypolimnion, 9 m)
 *   - full_profile: [] (no depth filter, so the whole water column)
 */
export function resolveScopeDepths(
  reservoir: LeadsReservoir,
  decision: DecisionKey,
  depthScope: DepthScope,
): number[] {
  switch (depthScope) {
    case "surface":
      return DEPTH_ZONE_MAPPING[reservoir].epilimnion;
    case "profile_zone": {
      const zone = DECISION_PROFILE_ZONE[decision] ?? "hypolimnion";
      return DEPTH_ZONE_MAPPING[reservoir][zone];
    }
    case "full_profile":
    default:
      return [];
  }
}
