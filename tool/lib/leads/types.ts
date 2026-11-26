import type { CitationAlignMode } from "./citation-align";
import type { LitVerbatimMode } from "./lit-verbatim";
import type { RaptorMode } from "./raptor-mode";

export type LeadsChannel = "sensor" | "literature" | "forecast";

/** The two reservoirs LEADS supports. Profile-facing names ("fcr"/"bvr")
 *  match the UI; the underlying VERA/FLARE site IDs are "fcre"/"bvre".
 *  Use `siteIdFor()` in lib/leads/guardrails.ts to convert. */
export type LeadsReservoir = "fcr" | "bvr";

/** Thermal stratification zone selected in the profile. The zone-to-meter
 *  mapping is in DEPTH_ZONE_MAPPING (guardrails.ts) and matches the FLARE
 *  GLM-AED layers and VERA sensor depths. */
export type LeadsDepthZone = "epilimnion" | "metalimnion" | "hypolimnion";

export type LeadsQueryMode =
  | "evidence"
  | "threshold"
  | "causal"
  | "predictive"
  | "management"
  | "comparative"
  | "temporal"
  | "scenario"
  | "general";

export type LeadsAudience =
  | "scientist"
  | "manager"
  | "operator"
  | "policy"
  | "general";

export type LeadsObjective =
  | "explain"
  | "assess"
  | "recommend"
  | "compare"
  | "forecast";

export type LeadsScope = "site-specific" | "regional-analogue" | "general";

/** Deterministic profile-query alignment. Computed in the router before any LLM
 *  call by comparing the Step-1 profile (declared decision/zone/reservoir)
 *  against the decision/zone/reservoir inferred from the question text, so a
 *  form-query mismatch is reported explicitly rather than showing up only as a
 *  lower Layer-3 adherence score. Non-blocking: the form still wins (retrieval
 *  and guardrail unchanged); this only flags the mismatch and offers a re-route. */
export interface LeadsProfileAlignment {
  aligned: boolean;
  /** aligned = text agrees or is silent; soft = one axis diverges; hard = ≥2. */
  severity: "aligned" | "soft" | "hard";
  /** Which axes diverged. "mode" = informational profile + a decision-shaped
   *  question (the inverse mismatch - no guardrail would be enforced). */
  dimensions: ("decision" | "zone" | "reservoir" | "mode")[];
  formDecision: string;
  inferredDecision: string | null;
  formZone: LeadsDepthZone | null;
  inferredZone: LeadsDepthZone | null;
  formReservoir: LeadsReservoir;
  inferredReservoir: LeadsReservoir | null;
  /** Plain-English explanation surfaced in the chip/banner. */
  rationale: string;
  /** The decision the question looks like it wants - drives the one-click
   *  re-route in the UI. */
  suggestedDecision?: string;
}

/** Out-of-scope guard: describes a water body the question named that LEADS has
 *  no coverage for. When present on a plan, the orchestrator refuses before
 *  retrieval rather than serving a covered reservoir's reading under the
 *  foreign name. */
export interface LeadsOutOfScope {
  /** Display name of the unsupported water body, e.g. "Lake Tahoe". */
  namedWaterBody: string;
  /** User-facing refusal text, streamed in place of an answer. */
  refusal: string;
}

/** Agentic plot spec: the planner's decision about what to chart, derived from
 *  the same query plan the pipeline retrieves and reasons over, so the chart
 *  shows the variable/site/depth/window the agent analyzed. Display-only and
 *  fail-soft: the frontend maps `variableHints` to a chartable VERA/FLARE
 *  series; a hint with no chart support renders nothing. */
export interface LeadsChartSpec {
  /** true when the plan activated a plottable channel (sensor and/or forecast)
   *  and resolved at least one variable, i.e. the agent judged this plot-worthy. */
  plot: boolean;
  /** Canonical variable keys the agent judged relevant (VARIABLE_ALIASES keys),
   *  in priority order. The frontend charts the first one it can render. */
  variableHints: string[];
  /** VERA/FLARE site id (fcre/bvre) resolved from the profile/query, or null. */
  siteId: string | null;
  /** The plottable channels the plan activated (subset: sensor | forecast). */
  channels: LeadsChannel[];
  /** Stratification zone the answer is anchored to (drives the chart depth). */
  depthZone: LeadsDepthZone | null;
  /** Rolling display window in days, parsed from the query (default 14). */
  windowDays: number;
  /** Forecast horizon in days the answer reasoned over, inferred from the query
   *  (inferHorizon, lib/leads/horizon.ts). The chart clamps this to [7,35] for a
   *  readable window; the answer and banner use the raw value. When absent, the
   *  client falls back to 7. */
  forecastHorizon?: number;
  /** Intent gate: draw the FLARE forecast layer only when the question is
   *  forward-looking. A purely retrospective question (trend / history /
   *  "last N") shows observations only, even in operational mode, so the chart's
   *  tense matches the question and the same question renders the same chart
   *  regardless of profile. The forecast channel may still be retrieved (Layer-2
   *  enforcement needs it); this only governs the display. */
  showForecast: boolean;
  /** Short human-readable rationale (surfaced in the pipeline drawer). */
  reason: string;
  /** Operational threshold line for the charted variable, derived from the active
   *  decision's persona-rule constraint (the guardrail) so the chart line, the forecast
   *  threshold-crossing probability, and the verdict banner all read one number. null
   *  when no operational threshold applies to the charted variable at the charted zone
   *  (informational mode, full-profile decisions, or non-operational). */
  threshold?: { value: number; label: string; direction: "above" | "below"; variable?: string } | null;
  /** Full-profile decisions (water extraction) choose between depths, so one series is
   *  the wrong figure: the deciding number lives at a depth the chart never drew. When
   *  set, the client plots one observation series per zone against the threshold line.
   *  Null or absent for single-zone decisions, which use the one-series path. */
  profileZones?: LeadsDepthZone[] | null;
}

export interface LeadsQueryPlan {
  originalQuery: string;
  queryMode: LeadsQueryMode;
  subQueries: string[];
  literatureQueries: string[];
  channels: LeadsChannel[];
  siteHints: string[];
  /** Sites inferred from the query text alone (before the profile-site union).
   *  Lets the follow-up guard distinguish a query that named a reservoir from
   *  one that only inherited it from the profile. */
  queryInferredSites: string[];
  variableHints: string[];
  timeHints: string[];
  yearHints: number[];
  monthHints: number[]; // 1=Jan ... 12=Dec, populated when query specifies a month name
  dayHints: number[];   // 1–31, populated when query specifies an exact day (e.g. "May 5", "the 26th")
  audience: LeadsAudience;
  objective: LeadsObjective;
  scope: LeadsScope;
  /** Carried forward from Reflexion verification so the retry synthesis
   *  prompt receives the verbal failure diagnosis. */
  reflexionNote?: string;
  /** Meters resolved from the profile's depth zone via DEPTH_ZONE_MAPPING.
   *  Empty if no profile / informational mode. Drives sensor-channel filtering
   *  and FLARE-channel target-layer selection. */
  resolvedDepthsM?: number[];
  /** Profile-query alignment. Present when a profile was supplied; `aligned: true`
   *  when the question agrees with or is silent on the form. */
  profileQueryAlignment?: LeadsProfileAlignment;
  /** The persona rule's depth_scope, when an operational decision is active.
   *  `full_profile` tells the sensor channel to retrieve the whole-column profile
   *  (all depths on the freshest sample date) for the qualifying-depth search,
   *  distinguishing it from informational mode (which also yields an empty
   *  resolvedDepthsM). Undefined in informational mode. */
  resolvedDepthScope?: "surface" | "profile_zone" | "full_profile";
  /** Out-of-scope guard: set when the question names a water body LEADS has no
   *  data for. The orchestrator refuses before any retrieval or LLM call so a
   *  foreign lake never gets a covered reservoir's reading mislabeled as its
   *  own. Undefined when the query is in scope. */
  outOfScope?: LeadsOutOfScope;
  /** Agentic plot spec: what the UI should chart, decided by the planner from
   *  this same plan (variables/site/depth/channels) rather than a separate
   *  keyword heuristic. Undefined only in degenerate plans. */
  chart?: LeadsChartSpec;
}

export interface EvidenceProvenance {
  type: "literature" | "sensor" | "forecast";
  label: string;
  docName?: string;
  pageNum?: number;
  chunkIndex?: number;
  doi?: string;
  sourceUrl?: string;
  siteId?: string;
  variable?: string;
  depthM?: number | null;
  /** The numeric observation value, carried on sensor-channel provenance so
   *  deterministic constraint evaluation (qualifying-depth search, persistence
   *  run) can read values at the gate without re-parsing evidence text.
   *  `null`/undefined for non-sensor channels or value-less items. */
  observation?: number | null;
  timestamp?: string;
  season?: string;
  baselineWindow?: string;
  score?: number;
  method?: string;
  pathId?: string;
  mechanismPath?: string[];
  modelId?: string;
  horizon?: number;
  referenceDate?: string;
  ensembleSize?: number;
  /** Which forecast-representation strategy (LEADS_FORECAST_REPRESENTATION)
   *  emitted this evidence item, recorded so ablation runs can be checked.
   *  `undefined` for non-forecast channels. */
  representation?: "summary" | "quantiles" | "json";
  /** Literature only: tree level (1-3) of an LLM-written summary node from the vector
   *  index. Unset for verbatim chunks. Such items appear only when LEADS_RAPTOR_MODE is
   *  "legacy" (raptor-mode.ts). */
  raptorLevel?: number;
}

export interface LeadsEvidence {
  id: string;
  channel: LeadsChannel;
  title: string;
  text: string;
  /** Full retrieved passage (the raw chunk) before single-sentence extraction
   *  (`toLiteratureText`) and LLM distillation compress `text`. Carried so
   *  RAGAS context_precision/recall can be scored against the real
   *  retrieved context rather than the compressed claim. Literature channel
   *  only; undefined for sensor/forecast (their `text` is already complete). */
  fullText?: string;
  /** Literature only, LEADS_LIT_VERBATIM "on" (lit-verbatim.ts): the whole retrieved
   *  verbatim chunk (fullText with paragraph breaks kept and whitespace normalised),
   *  attached after rerank. The answer model's packet, the claim verifier and the printed
   *  quotation read it; nothing that ranks or selects evidence does. Unset for summary
   *  nodes and whenever the switch is off. */
  verbatimText?: string;
  score: number;
  provenance: EvidenceProvenance;
}

export interface LeadsCitation {
  text: string;
  /** Full retrieved passage backing this citation (see `LeadsEvidence.fullText`).
   *  Lets RAGAS scoring use the real chunk instead of the compressed claim.
   *  Undefined when the source `text` is already complete (sensor/forecast). */
  fullText?: string;
  chunkIndex: number;
  docName: string;
  pageNum: number;
  rerankScore: number;
  method: "dense" | "sparse" | "hybrid";
  sourceType?: "literature" | "sensor" | "forecast";
  sourceUrl?: string;
  timestamp?: string;
  siteId?: string;
  variable?: string;
  depthM?: number | null;
  /** The 1-based index this evidence item had in the synthesis prompt's [N]
   *  enumeration. Stable across the three consumers (synthesis prompt, verifier
   *  slice, UI panel) so brackets in the answer text resolve to the same record
   *  everywhere. Equals `fused.evidence` position + 1. */
  bracketNum?: number;
  /** True when the LLM's response text contains a `[bracketNum]` referring
   *  to this item. UI uses this to filter the evidence panel; downstream
   *  consumers (evaluation scripts) can use it to distinguish what was
   *  shown to the LLM vs. what it actually cited. */
  citedInAnswer?: boolean;
  /** LEADS_LIT_VERBATIM "on" only: the text the answer model was shown for this item (the
   *  packet body: the verbatim passage for literature, the record text otherwise). With
   *  the switch on, `text` is the printed quotation and differs from this. */
  modelText?: string;
  /** LEADS_LIT_VERBATIM "on", literature only: true when `text` is a quotation of whole
   *  sentences copied from `modelText`; false when no sentence qualified and `text` is the
   *  passage's opening text (still copied, possibly cut with "…"). */
  verbatim?: boolean;
}

export interface LeadsFaithfulness {
  cited: number;
  total: number;
  pct: number;
}

export interface LeadsClaimVerification {
  text: string;
  supported: boolean;
  sourceIndex: number | null;
  confidence: number;
  channel?: LeadsChannel;
  sourceTitle?: string;
  /** Global 1-based bracket number into `fused.evidence` for the supporting
   *  item, or null if unsupported. This is what the UI renders next to each
   *  claim ("…[7]") and what evaluation scripts cross-reference against the
   *  answer text; it aligns with LeadsCitation.bracketNum. `sourceIndex` is
   *  verifier-local (0..k-1 of the verifier slice). */
  bracketNum?: number | null;
  /** "word-overlap" when the claim checker gave no result (no key, a failed call, or no
   *  claims returned) and verification.ts matched the answer's sentences to the evidence by
   *  shared words instead. Absent on claims the checker model judged. */
  checkedBy?: "word-overlap";
}

export interface LeadsVerificationSummary {
  claims: LeadsClaimVerification[];
  supported: number;
  unsupported: number;
  pct: number;
  unresolvedClaims: string[];
  missingChannels: LeadsChannel[];
  recommendedQueries: string[];
  shouldRetry: boolean;
  /** Reflexion (Shinn et al. 2023): verbal diagnosis of why the previous
   *  attempt failed, generated by a fast LLM and injected into the retry
   *  synthesis prompt to guide a more targeted next attempt. */
  reflexionNote?: string;
}

export interface LeadsAnswer {
  response: string;
  citations: LeadsCitation[];
  faithfulness: LeadsFaithfulness;
  verification?: LeadsVerificationSummary;
  /**
   * Per-answer confidence components and composite C_LEADS. The four
   * components (G, V, P, Y) and the composite `overall` are computed in
   * generator.ts:
   *   - computeCLeadsComposite(G, V, P, Y, iterations)
   *   - refineConfidenceFromPipelineState(...)
   * All component fields are in [0, 1].
   */
  confidence: {
    /** G - Grounding score: verification.pct / 100, the share of the answer's claims
     *  the claim checker found supported (1 when no claim check runs, e.g. an evidence
     *  sheet). Similar in aim to RAGAS faithfulness (Es et al. 2023). */
    grounding: number;
    /** V - Mean per-claim verifier confidence (graded), computed from
     *  verification.claims[].confidence. Captures "supported but shaky"
     *  cases that the pass/fail-based G alone misses. */
    verifierConfidence: number;
    /** P - Layer-3 policy adherence: layer3.adherencePct / 100, or 1.0
     *  by default when no operational policy applies (decision === "none").
     *  Measures whether the synthesizer followed the Layer-1 guardrail addendum
     *  (the operational framing), which prompting alone does not enforce. */
    policyAdherence: number;
    /** Y - Channel completeness: |{c ∈ requested : evidence_from_c > 0}|
     *  / |requested channels|. Captures retrieval-side success. */
    channelCoverage: number;
    /** Composite:
     *    C_LEADS = (G + V + P + Y) / 4  −  0.05 · iterations
     *  Equal weights (1/4 each) and iteration penalty matching
     *  Hu et al. 2025 Eq. 8 form (no cap; clamped to [0,1] at output). */
    overall: number;
    /** Number of plan-refinement iterations consumed before this answer
     *  was produced (0 = first-attempt answer; 1+ = answer after one or
     *  more refinePlan rounds). Surfaced so the iteration-penalty term can
     *  be audited. */
    iterations: number;
  };
}

export type LeadsPipelineEvent =
  | { type: "step"; step: string; status: "running" | "done"; data?: Record<string, unknown> }
  | { type: "token"; token: string }
  | { type: "faithfulness"; claims: LeadsClaimVerification[] }
  | { type: "error"; message: string }
  | { type: "done"; citations: LeadsCitation[]; faithfulness: LeadsFaithfulness; verification?: LeadsVerificationSummary; confidence?: LeadsAnswer["confidence"]; cost?: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedUsdCents: number; calls: number }; alignment?: LeadsProfileAlignment; raptorMode?: RaptorMode; litVerbatim?: LitVerbatimMode; citationAlign?: CitationAlignMode }
  // Agentic plot spec, streamed right after routing so the UI charts the
  // variable/site/depth the agent chose.
  | { type: "chart"; chart: LeadsChartSpec };

export interface LeadsSensorRecord {
  projectId: string;
  siteId: string;
  datetime: string;
  duration: string;
  depthM: number | null;
  variable: string;
  observation: number | null;
}

export interface LeadsBaselineStats {
  siteId: string;
  variable: string;
  depthBucket: string;
  dayOfYear: number;
  count: number;
  mean: number;
  min: number;
  max: number;
}

export interface LeadsOrchestratorOptions {
  docId?: string | null;
  profile?: "hybrid" | "contextual";
  maxIterations?: number;
  /** Opaque token that identifies a multi-turn conversation. When provided,
   *  the orchestrator loads prior Q&A turns from Redis and saves the new turn
   *  after synthesis, enabling follow-up questions. */
  sessionId?: string;
  /** Step-1 user profile from the UI. When `decision !== "none"`, the
   *  orchestrator invokes Layer 2 enforcement (lib/leads/layer2-enforcement.ts)
   *  after retrieval and refuses without calling the analyst LLM if the
   *  guardrail's required sensor/forecast variables are missing or stale. */
  leadsProfile?: LeadsProfile;
  /** Evaluation only (channel ablation): force the active retrieval channels
   *  instead of letting the router infer them, so the operational/guardrailed
   *  path can be channel-ablated as well as the informational path.
   *  Unset = router-inferred (production default). */
  forcedChannels?: LeadsChannel[];
}

/** Subset of the UI's `UserProfile` consumed by the orchestrator. Kept
 *  structurally compatible with `components/UserProfilePanel.UserProfile`
 *  so the API route can pass the payload through unchanged. */
export interface LeadsProfile {
  persona: "manager" | "researcher" | "public";
  reservoir: LeadsReservoir;
  depth: LeadsDepthZone;
  decision:
    | "hypoxia_management"
    | "water_extraction"
    | "flow_management"
    | "algal_management"
    | "none";
  summary: string;
}

// Forecast types

export interface ForecastRecord {
  modelId: string;
  siteId: string;
  variable: string;
  referenceDate: string;
  targetDate: string;
  horizon: number;
  mean: number;
  quantile02_5: number;
  quantile10: number;
  quantile90: number;
  quantile97_5: number;
  /** The ensemble members themselves for this (variable, target date, depth).
   *  Retained so exceedance probability can be counted from the distribution rather
   *  than approximated by fitting a Gaussian to it - FLARE gives 221 members, and a
   *  fitted Gaussian understates lower-tail risk when the DO ensemble is
   *  right-skewed at longer leads (see exceedanceProbability). Internal only: the
   *  record is never serialized to the client. Optional so older/cached records and
   *  non-FLARE sources still work via the Gaussian fallback. */
  members?: number[];
  /** FLARE GLM-AED layer depth at which these ensemble stats were computed.
   *  The FLARE configuration exposes layers at the VERA sensor depths for
   *  both reservoirs, so this value lines up 1:1 with
   *  `LeadsSensorRecord.depthM` for cross-channel comparability. */
  depthM: number;
}

export interface EnsembleSummary {
  variable: string;
  siteId: string;
  targetDate: string;
  horizon: number;
  models: string[];
  ensembleMean: number;
  ensembleSpread: number;
  lowerBound: number;
  upperBound: number;
  agreementScore: number;
  /** Inner 10th/90th-percentile band. lowerBound/upperBound are the outer
   *  2.5/97.5% envelope; these carry the inner q10/q90 the ensemble already
   *  computes, so the UI can show a "pessimistic (10th) / central / optimistic
   *  (90th)" read instead of only the extreme tails. Always set by
   *  buildEnsembleSummaries; clamped to nest within [lowerBound, upperBound]. */
  q10?: number;
  q90?: number;
}

export interface RiskAssessment {
  variable: string;
  siteId: string;
  riskLabel: string;
  probability: number;
  horizon: string;
  threshold: number;
  thresholdSource: string;
  confidence: "low" | "medium" | "high";
  supportingModels: string[];
  totalModels: number;
}
