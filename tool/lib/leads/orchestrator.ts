import { evalNowIso, LEADS_DEFAULT_MAX_ITERATIONS, LEADS_FAITHFULNESS_THRESHOLD } from "./config";
import { fuseEvidence } from "./fusion";
import { getGuardrail, getPersonaRule } from "./guardrails";
import { assessFreshness } from "./freshness-policy";
import { evaluateConstraints, type ConstraintEvaluation, type ConstraintObservation } from "./constraint-eval";
import { enforceLayer2 } from "./layer2-enforcement";
import { enforceLayer3, detectStanceContradiction } from "./layer3-validation";
import { alignAnswerCitations, generateAbstentionAnswer, generateGroundedAnswer, generateStructuredEvidenceAnswer, refineConfidenceFromPipelineState } from "./generator";
import { retrieveForecastEvidence, computeForecastExceedanceOutlook, formatForecastOutlookClause, type ForecastExceedanceOutlook } from "./forecast";
import { literatureSearchConfigured, retrieveLiteratureEvidence } from "./literature";
import { inferHorizon } from "./horizon";
import { citationAlignMode, describeCitationAlignment } from "./citation-align";
import { litVerbatimMode } from "./lit-verbatim";
import { raptorMode } from "./raptor-mode";
import { planLeadsQuery } from "./router";
import { buildForecastSkillNote } from "../skill/forecast-skill";
import { retrieveOperationalSensorEvidence } from "./sensor-operational";
import { retrievePublicSensorEvidence } from "./sensor-public";
import { loadHistory, saveHistory, formatHistoryForPrompt } from "./session-memory";
import { buildCacheKey, getCachedAnswer, setCachedAnswer } from "./query-cache";
import { runWithCostTracking, getSnapshot } from "./cost-tracker";
import { assessClaimSupport, generateReflection, type LeadsVerificationSummary } from "./verification";
import type {
  LeadsChannel,
  LeadsEvidence,
  LeadsOrchestratorOptions,
  LeadsPipelineEvent,
  LeadsQueryPlan,
  LeadsSensorRecord,
} from "./types";

function chunkTokens(text: string) {
  return text.split(/(\s+)/).filter(Boolean);
}

/**
 * The forecast skill evidence record for a plan, through the one gate the skill card and
 * the PDF use (lib/skill/forecast-skill.ts). site and variable come from the plan (the
 * forecast evidence's provenance carries neither; the record is keyed on the lowercase VERA
 * site id as the plan stores it), depth from plan.resolvedDepthsM (fails closed for a
 * full-profile decision or any unresolved depth), horizon from the question. One helper
 * for the operational and the informational path, so both resolve the record identically.
 */
export function forecastSkillNoteFor(plan: LeadsQueryPlan): string {
  return buildForecastSkillNote({
    site: plan.chart?.siteId ?? null,
    variable: plan.chart?.variableHints?.[0] ?? null,
    depthsM: plan.resolvedDepthsM,
    fullProfile: plan.resolvedDepthScope === "full_profile",
    horizonDays: inferHorizon(plan.originalQuery),
  });
}

/**
 * Deterministic operational verdict banner. Turns the code-computed constraint-eval
 * single-zone verdict into one LEADS-computed line, prepended to the streamed answer so
 * the operational conclusion on the latest reading is always present verbatim and cannot
 * be silently contradicted by the synthesized prose. Covers the single-zone operational
 * decisions: hypoxia (operate HOx when DO ≤ 4 mg/L at 9 m) and algal (bloom control
 * when Chla > 20 µg/L at the surface). The caller gates persona = manager + an active operational
 * decision; this function additionally requires a banner spec for the decision and an
 * observation on the single-zone check. Layer 2 already refuses on absent or stale data,
 * so an indeterminate reading returns null. Display-only: answer.response stays pure LLM
 * prose.
 *
 * Semantics: verdict "satisfied" means the constraint condition holds; for DO ≤ 4 that
 * is DO low, so operate HOx; for Chla > 20 it is bloom exceeded, so bloom control. The
 * banner states the operational conclusion and never echoes the raw satisfied/violated
 * label (which reads backwards). The line gives the latest reading, the threshold, the
 * threshold status in bold and whether the rule is met. The status is read with the rule's
 * direction: an upper limit (chl-a > 20) crossed is "threshold exceeded", a lower limit
 * (DO ≤ 4) crossed is "below threshold". The specific lever and any caveats (e.g.
 * algaecide and the toxin-release risk on a toxin-forming bloom) are left to the prose;
 * this line states only the threshold fact and the rule outcome for the current reading,
 * followed by the forecast clause when an outlook is supplied.
 */
const BANNER_SPEC: Record<string, { variable: string; varShort: string; trigger: string; action: string; rule: string }> = {
  hypoxia_management: { variable: "DO_mgL_mean", varShort: "DO", trigger: "HOx threshold", action: "HOx activation", rule: "HOx-activation rule" },
  algal_management: { variable: "Chla_ugL_mean", varShort: "chl-a", trigger: "bloom threshold", action: "bloom control", rule: "bloom-control rule" },
};

/** The decision whose banner can be drawn for this persona, or null: manager + a
 *  bannered decision. One predicate for the banner and for the peak line on the
 *  window-summary evidence card (retrieveForecastEvidence bannerPeakLine), so the card
 *  carries the banner's peak only where a banner can show it. Exported for
 *  scripts/check-banner-in-evidence.ts. */
export function bannerDecisionFor<D extends string>(persona: string | null | undefined, decision: D | null | undefined): D | null {
  return persona === "manager" && decision && BANNER_SPEC[decision] ? decision : null;
}

// Exported only so the offline checks (scripts/check-banner-in-evidence.ts,
// scripts/check-ensemble-format.ts) test the banner the user actually sees.
export function buildOperationalVerdictBanner(
  evalResult: ConstraintEvaluation,
  decision: string,
  outlook: ForecastExceedanceOutlook | null,
): string | null {
  const spec = BANNER_SPEC[decision];
  if (!spec) return null;
  if (!evalResult.applicable || evalResult.kind !== "single_zone") return null;
  const check = evalResult.checks.find((c) => c.variable === spec.variable);
  if (!check || check.observed == null) return null;
  const depthM = check.observedDepthM;
  const at = depthM != null ? `${Number.isInteger(depthM) ? depthM : depthM.toFixed(1)} m ` : "";
  const date = check.observedDate ? ` (${check.observedDate})` : "";
  // verdict "satisfied" means the constraint condition holds, so the action is indicated.
  const met = check.verdict === "satisfied";
  // Relation of the observed value to the threshold, derived from the numeric position
  // (op-direction-agnostic): strictly below reads "below", an exact tie reads "at".
  const rel = check.observed > check.value ? "above" : check.observed < check.value ? "below" : "at";
  // Threshold status in the rule's direction: crossing an upper limit reads "threshold
  // exceeded"; a lower limit (DO ≤ 4) crossed reads "below threshold".
  const status = rel === "above" ? (met ? "threshold exceeded" : "above threshold") : rel === "below" ? "below threshold" : "at threshold";
  let line =
    `> **Operational check (LEADS-computed):** latest ${at}${spec.varShort} ${check.observed.toFixed(2)} ${check.units}${date}; ` +
    `${spec.trigger} ${check.value} ${check.units} → **${status}**: ${spec.rule} ${met ? "met" : "not met"}.`;
  // Forecast clause: the peak per-day FLARE threshold-crossing probability over the
  // horizon (not a cumulative "within N days" union), plus the final-day value when the
  // peak falls earlier. Printed as member counts by the same formatter as the evidence
  // cards, so both read identically.
  if (outlook) line += ` ${formatForecastOutlookClause(outlook, spec.varShort)}`;
  return line;
}

/** Max grounding (verification pct) the stance correction may regress below the
 *  best-of-N winner and still be adopted. Beyond this, the better-grounded original is
 *  kept: the banner and the Layer-3 stance flag still carry the correct conclusion, so a
 *  much weaker answer is never shipped just to satisfy a prose-consistency check. */
const STANCE_CORRECTION_TOLERANCE = 15;

/** The deterministic operational stance for a single-zone banner-eligible decision:
 *  "indicated" (the constraint condition holds, so the action is warranted on the latest
 *  reading) or "not_indicated". null when there is no determinate single-zone verdict
 *  (non-banner decision, non-single-zone, or an indeterminate/absent reading) - the
 *  conclusion guarantee then does not apply. */
function operationalStanceFromEval(
  evalResult: ConstraintEvaluation,
  decision: string,
): "indicated" | "not_indicated" | null {
  const spec = BANNER_SPEC[decision];
  if (!spec) return null;
  if (!evalResult.applicable || evalResult.kind !== "single_zone") return null;
  const check = evalResult.checks.find((c) => c.variable === spec.variable);
  if (!check || check.observed == null) return null;
  return check.verdict === "satisfied" ? "indicated" : "not_indicated";
}

/** Corrective instruction injected into a single re-synthesis when the prose
 *  contradicted the deterministic operational verdict. States the authoritative
 *  determination (the banner text, stripped of markdown) and forbids contradicting it. */
function buildStanceCorrection(
  evalResult: ConstraintEvaluation,
  decision: string,
  stance: "indicated" | "not_indicated",
): string {
  const spec = BANNER_SPEC[decision];
  const verdict = (buildOperationalVerdictBanner(evalResult, decision, null) ?? "")
    .replace(/^>\s*/, "")
    .replace(/\*\*/g, "");
  return (
    `OPERATIONAL CONSISTENCY CORRECTION — your previous answer contradicted the authoritative, ` +
    `code-computed operational determination. Determination: ${verdict} ` +
    `You MUST state this determination and make your recommendation consistent with it: ` +
    `${spec ? spec.action : "the operational action"} ${stance === "indicated" ? "IS indicated" : "is NOT indicated"} ` +
    `on the latest reading. You may add forecast/uncertainty nuance, but do NOT assert the opposite operational conclusion.`
  );
}

function createRetrySignal(
  plan: LeadsQueryPlan,
  evidence: LeadsEvidence[],
  retrievalSummary?: Record<LeadsChannel, number>
): LeadsVerificationSummary {
  const missingChannels = plan.channels.filter((channel) => (retrievalSummary?.[channel] ?? 0) === 0);
  const recommendedQueries = [
    missingChannels.includes("sensor") ? `${plan.originalQuery} latest in situ sensor observation` : "",
    missingChannels.includes("literature") ? `${plan.originalQuery} limnology literature support` : "",
  ].filter(Boolean);

  return {
    claims: [],
    supported: evidence.length,
    unsupported: Math.max(missingChannels.length, evidence.length === 0 ? 1 : 0),
    pct: evidence.length > 0 && missingChannels.length === 0 ? 100 : 0,
    unresolvedClaims: [],
    missingChannels,
    recommendedQueries,
    shouldRetry: missingChannels.length > 0 || evidence.length < 3,
  };
}

function refinePlan(
  plan: LeadsQueryPlan,
  attempt: number,
  signal?: LeadsVerificationSummary
): LeadsQueryPlan {
  if (attempt === 0 && !signal) return plan;
  const fallbackQuery = [
    plan.originalQuery,
    plan.siteHints[0],
    plan.variableHints[0],
    "freshwater reservoir evidence",
  ]
    .filter(Boolean)
    .join(" ");

  let siteHints = plan.siteHints;
  let variableHints = plan.variableHints;
  const channels = new Set(plan.channels);

  if (signal?.missingChannels.includes("sensor")) {
    channels.add("sensor");
    if (siteHints.length > 0) {
      siteHints = [];
    } else if (variableHints.length > 0) {
      variableHints = [];
    }
  }

  if (signal?.missingChannels.includes("literature")) channels.add("literature");

  return {
    ...plan,
    channels: Array.from(channels),
    siteHints,
    variableHints,
    reflexionNote: signal?.reflexionNote,
    subQueries: Array.from(
      new Set([
        ...plan.subQueries,
        ...((signal?.recommendedQueries ?? []).slice(0, 4)),
        ...(signal?.unresolvedClaims ?? []).slice(0, 2).map((claim) => `Evidence for ${claim}`),
        fallbackQuery,
      ])
    ),
  };
}

function createSoftVerification(
  plan: LeadsQueryPlan,
  evidence: LeadsEvidence[],
  retrievalSummary: Record<LeadsChannel, number>
): LeadsVerificationSummary {
  const missingChannels = plan.channels.filter((channel) => retrievalSummary[channel] === 0);
  return {
    claims: [],
    supported: evidence.length,
    unsupported: 0,
    pct: 100,
    unresolvedClaims: [],
    missingChannels,
    recommendedQueries: [],
    shouldRetry: false,
  };
}

function isSimpleAnswerMode(plan: LeadsQueryPlan) {
  return plan.queryMode !== "evidence" && plan.queryMode !== "predictive" && plan.queryMode !== "scenario" && plan.queryMode !== "management";
}

/**
 * True for plans with no literature channel that are not scenario or management
 * questions. The caller then skips the claim checker (about $0.02 per query) unless
 * literature search is unavailable. The router always adds literature, so only a
 * run that forces the channels (options.forcedChannels) reaches this.
 */
function isVerificationSkippable(plan: LeadsQueryPlan): boolean {
  const hasLiterature = plan.channels.includes("literature");
  const hasScenario = plan.queryMode === "scenario" || plan.queryMode === "management";
  return !hasLiterature && !hasScenario;
}

async function* _runLeadsOrchestratorInner(
  query: string,
  options: LeadsOrchestratorOptions = {}
): AsyncGenerator<LeadsPipelineEvent> {
  const maxIterations = options.maxIterations ?? LEADS_DEFAULT_MAX_ITERATIONS;
  let plan = planLeadsQuery(query, options.leadsProfile);
  // Evaluation-only channel ablation: override router-inferred channels so the
  // operational/guardrailed path can be ablated too. Unset = production default.
  if (options.forcedChannels && options.forcedChannels.length > 0) {
    plan.channels = options.forcedChannels;
  }
  // Where the literature search is not configured (the Docker version without a relay), literature
  // is left out of the plan, so that an answer is not retried for evidence that cannot arrive. The
  // claim check still runs.
  const literatureOff = !literatureSearchConfigured();
  if (literatureOff) {
    plan.channels = plan.channels.filter((channel) => channel !== "literature");
  }

  // Out-of-scope guard
  // If the question names a water body LEADS doesn't cover (anything other than
  // the SITE_ALIASES reservoirs), refuse before any retrieval / LLM / cache
  // spend. Without this, the sensor channel serves a covered reservoir's VERA
  // reading under the foreign lake's name (false grounding). Mirrors the Layer 2
  // refusal event sequence so the UI renders it identically.
  if (plan.outOfScope) {
    yield { type: "step", step: "route", status: "done", data: { channels: plan.channels, mode: plan.queryMode, outOfScope: true } };
    yield { type: "step", step: "guardrail", status: "running" };
    yield {
      type: "step",
      step: "guardrail",
      status: "done",
      data: { verdict: "refused", reason: "out-of-scope-water-body", namedWaterBody: plan.outOfScope.namedWaterBody },
    };
    yield { type: "step", step: "synthesize", status: "running" };
    for (const token of chunkTokens(plan.outOfScope.refusal)) {
      yield { type: "token", token };
    }
    yield { type: "step", step: "synthesize", status: "done" };
    yield {
      type: "done",
      citations: [],
      faithfulness: { pct: 0, cited: 0, total: 0 },
      cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsdCents: 0, calls: 0 },
      alignment: plan.profileQueryAlignment,
    };
    return;
  }

  // Agentic plot spec: stream the planner's chart decision so the UI renders the
  // same variable/site/depth the agent analyzed. Emitted once, for every non-refusal
  // path (fresh, cached, operational); clients that don't handle "chart" ignore it.
  if (plan.chart) {
    yield { type: "chart", chart: plan.chart };
  }

  let retrySignal: LeadsVerificationSummary | undefined;
  // Best-of-N tracker: a retry attempt that regresses verification.pct must not
  // replace a stronger prior attempt (a poor reflexion could otherwise turn a
  // 60%-supported answer into a 40%-supported one). The highest-scoring attempt
  // across all iterations is kept and swapped in if the final attempt is worse,
  // following the best-of-N pattern from verifier-driven LLM evaluation
  // (e.g. Lightman et al. 2023).
  let bestAttempt: { answer: any; pct: number; attempt: number } | undefined;
  // The text and evidence each claim-verifier result was computed on, so citation
  // alignment runs only when the shipped answer is exactly the text that was verified
  // (best-of-N may ship an earlier attempt, built on that attempt's evidence; an
  // abstention carries the verification of the text it replaced).
  const verifiedAnswers = new WeakMap<LeadsVerificationSummary, { response: string; evidence: LeadsEvidence[] }>();
  // Deterministic constraint evaluation (qualifying-depth / persistence /
  // single-zone). Computed once when Layer 2 passes (attempt 0), then
  // injected into synthesis each attempt so the answer is anchored to the verdict.
  let constraintEval: ConstraintEvaluation | null = null;
  // Forecast-freshness caveat, set when the latest FLARE reference_date is AGED
  // (> 2 d) or STALE (> 7 d) under the default forecast window. Non-refusing: a
  // current sensor state can still carry the decision; a fully absent forecast
  // already refuses via Layer 2.
  let forecastFreshnessCaveat: string | null = null;
  let forecastSkillNote: string | null = null;

  // Query response cache (Upstash Redis, TTL set in query-cache.ts)
  // Skip cache for follow-up queries in an active session - context matters.
  // Also skip when an operational decision is set: Layer 2 enforces against
  // fresh sensor/forecast snapshots, and a cached answer would defeat that.
  const sessionId = options.sessionId ?? "";
  // Summary-node mode (raptor-mode.ts), verbatim-literature mode (lit-verbatim.ts) and
  // citation-alignment mode (citation-align.ts), read once so retrieval, verification, the
  // cache key and the reported values all agree for this request.
  const literatureRaptorMode = raptorMode();
  const literatureLitVerbatim = litVerbatimMode();
  const literatureCitationAlign = citationAlignMode();
  const cacheKey = buildCacheKey(query, plan.channels, literatureRaptorMode, literatureLitVerbatim, literatureCitationAlign);
  const operationalDecision =
    options.leadsProfile && options.leadsProfile.decision !== "none"
      ? options.leadsProfile.decision
      : null;
  // The profile's reservoir flows through to the retrieval and guardrail layers;
  // null when no profile is set.
  const operationalReservoir = options.leadsProfile ? options.leadsProfile.reservoir : null;
  // LEADS_DISABLE_QUERY_CACHE=1 bypasses the Redis query cache for both reads and
  // writes (both gate on isFreshSession). Set it for evaluation runs and after code
  // changes; otherwise informational (decision === "none") queries replay a cached
  // LeadsAnswer and the updated pipeline never runs. Operational (decision !== "none")
  // queries always bypass the cache.
  const cacheDisabled =
    process.env.LEADS_DISABLE_QUERY_CACHE === "1" ||
    process.env.LEADS_DISABLE_QUERY_CACHE === "true";
  const isFreshSession = !sessionId && !operationalDecision && !cacheDisabled;
  if (isFreshSession) {
    const cached = await getCachedAnswer(cacheKey);
    // Treat entries without recorded citations as a miss so the UI never shows
    // an empty evidence or claim-verification panel for a cached answer.
    const hasFullPayload =
      cached !== null && Array.isArray(cached.citations) && cached.citations.length > 0;
    if (cached && hasFullPayload) {
      yield { type: "step", step: "route", status: "done", data: { channels: plan.channels, mode: plan.queryMode, hints: {} } };
      yield { type: "step", step: "synthesize", status: "running" };
      for (const token of chunkTokens(cached.response)) {
        yield { type: "token", token };
      }
      yield { type: "step", step: "synthesize", status: "done" };
      // Replay the claim-verification panel so a cached answer shows the same
      // panels as a fresh run.
      const replayClaims = cached.claims ?? [];
      if (replayClaims.length > 0) {
        yield { type: "step", step: "verify", status: "done", data: { cached: true } };
        yield { type: "faithfulness", claims: replayClaims };
      }
      const replaySupported = replayClaims.filter((c) => c.supported).length;
      yield {
        type: "done",
        citations:    cached.citations ?? [],
        faithfulness: cached.faithfulness ?? { pct: 100, cited: 1, total: 1 },
        // Provide the verification summary on `done` for parity with the
        // fresh-path event (used by exports, telemetry and evaluation).
        verification: replayClaims.length > 0 ? {
          claims: replayClaims,
          supported: replaySupported,
          unsupported: replayClaims.length - replaySupported,
          pct: Math.round((replaySupported / replayClaims.length) * 100),
          unresolvedClaims: replayClaims.filter((c) => !c.supported).map((c) => c.text),
          missingChannels: [],
          recommendedQueries: [],
          shouldRetry: false,
        } : undefined,
        cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedUsdCents: 0, calls: 0 },
        alignment: plan.profileQueryAlignment,
        raptorMode: literatureRaptorMode,
        litVerbatim: literatureLitVerbatim,
        citationAlign: literatureCitationAlign,
      };
      return;
    }
    // Partial cache entry: fall through and regenerate so the entry is
    // rewritten with the full payload.
  }

  // Persistent session memory
  const sessionHistory = await loadHistory(sessionId);
  const conversationHistory = formatHistoryForPrompt(sessionHistory);

  // Follow-up grounding guard
  // Session memory feeds the synthesiser (conversationHistory) but the router
  // (planLeadsQuery) is history-blind, so an anaphoric follow-up ("what about the
  // bottom?", "and last year?") is planned from its own text alone. Rather than
  // silently retrieve generic or wrong evidence while the answer still reads as
  // continuous, be explicit, deterministically and without an LLM. Inert outside a
  // session: evaluation runs pass sessionId "", so the history is empty and isFollowUp is false.
  const isFollowUp = sessionHistory.length > 0;
  const queryNamedSite = plan.queryInferredSites.length > 0;

  // (a) Ungroundable follow-up: no reservoir from the query or a profile, so
  //     retrieval would be meaningless. Ask which reservoir instead of guessing.
  if (isFollowUp && plan.siteHints.length === 0 && !plan.outOfScope) {
    const lastQuery = sessionHistory[sessionHistory.length - 1]?.query ?? "";
    const clarify =
      `I can't tell which reservoir this follow-up refers to. Your previous question ` +
      `was: "${lastQuery}". Please name the reservoir — Falling Creek (FCR) or ` +
      `Beaverdam (BVR) — and the variable you mean, and I'll answer.`;
    yield { type: "step", step: "route", status: "done", data: { queryMode: plan.queryMode, followUp: "unresolved" } };
    yield { type: "step", step: "synthesize", status: "running" };
    for (const token of chunkTokens(clarify)) yield { type: "token", token };
    yield { type: "step", step: "synthesize", status: "done" };
    yield {
      type: "done",
      citations: [],
      faithfulness: { pct: 0, cited: 0, total: 0 },
      cost: getSnapshot(),
      alignment: plan.profileQueryAlignment,
    };
    return;
  }

  // (b) Assumed-context follow-up: the query named no reservoir but one is known
  //     (from the profile), so answer, but state the assumption up front so the
  //     user can correct it. Display-only line, prepended at stream time below.
  const SITE_LABEL: Record<string, string> = { fcre: "Falling Creek (FCR)", bvre: "Beaverdam (BVR)" };
  const followUpDisambig =
    isFollowUp && !queryNamedSite && plan.siteHints.length > 0
      ? `*Interpreting this follow-up as ${SITE_LABEL[plan.siteHints[0]] ?? plan.siteHints[0]}` +
        `${plan.variableHints[0] ? ` · ${plan.variableHints[0]}` : ""}` +
        `${plan.chart?.depthZone ? ` · ${plan.chart.depthZone}` : ""} — name the reservoir if you meant otherwise.*\n\n`
      : "";

  yield {
    type: "step",
    step: "route",
    status: "done",
    data: {
      queryMode: plan.queryMode,
      audience: plan.audience,
      objective: plan.objective,
      scope: plan.scope,
      channels: plan.channels,
      siteHints: plan.siteHints,
      variableHints: plan.variableHints,
    },
  };

  // Profile-query alignment: surface a form-question mismatch explicitly, before
  // the LLM runs, so it can't be masked by how the model writes (or by the injected
  // constraint verdict). Non-blocking; the form's guardrail still governs.
  if (plan.profileQueryAlignment && !plan.profileQueryAlignment.aligned) {
    yield {
      type: "step",
      step: "profile-query-mismatch",
      status: "done",
      data: { ...plan.profileQueryAlignment },
    };
  }

  yield {
    type: "step",
    step: "expand",
    status: "done",
    data: { queries: plan.subQueries, literatureQueries: plan.literatureQueries },
  };

  for (let attempt = 0; attempt < maxIterations; attempt += 1) {
    if (attempt > 0) {
      plan = refinePlan(plan, attempt, retrySignal);
      yield {
        type: "step",
        step: "retrieve2",
        status: "done",
        data: {
          fallbackQueries: plan.subQueries.slice(1),
          unresolvedClaims: retrySignal?.unresolvedClaims ?? [],
          missingChannels: retrySignal?.missingChannels ?? [],
        },
      };
    }

    yield { type: "step", step: "retrieve", status: "running" };

    const [publicSensor, operationalSensor, literature, forecast] = await Promise.all([
      // Sensor channels are fail-soft (.catch returns []) so a down/unreachable feed degrades
      // gracefully instead of rejecting the whole query; the public channel returns an
      // explicit "feed unavailable" notice in that case (see retrievePublicSensorEvidence).
      plan.channels.includes("sensor") ? retrievePublicSensorEvidence(plan).catch(() => []) : Promise.resolve([]),
      plan.channels.includes("sensor") ? retrieveOperationalSensorEvidence(plan).catch(() => []) : Promise.resolve([]),
      plan.channels.includes("literature")
        ? retrieveLiteratureEvidence(plan, {
            docId: options.docId ?? null,
            profile: options.profile ?? "hybrid",
            raptorMode: literatureRaptorMode,
            litVerbatim: literatureLitVerbatim,
          })
        : Promise.resolve([]),
      plan.channels.includes("forecast")
        ? retrieveForecastEvidence(plan, {
            decision: operationalDecision ?? undefined,
            reservoir: operationalReservoir ?? undefined,
            persona: options.leadsProfile?.persona, // persona-specific forecast threshold
            bannerPeakLine: bannerDecisionFor(options.leadsProfile?.persona, operationalDecision) != null,
          })
        : Promise.resolve([]),
    ]);

    const sensor = [...operationalSensor, ...publicSensor].slice(0, 6);

    yield {
      type: "step",
      step: "retrieve",
      status: "done",
      data: {
        literature: literature.length,
        sensor: sensor.length,
        forecast: forecast.length,
        raptorMode: literatureRaptorMode,
        litVerbatim: literatureLitVerbatim,
      },
    };

    yield { type: "step", step: "fuse", status: "running" };
    const fused = fuseEvidence({ sensor, literature, forecast });
    const isEvidenceMode = plan.queryMode === "evidence";
    yield {
      type: "step",
      step: "fuse",
      status: "done",
      data: {
        totalEvidence: fused.evidence.length,
        sensor: fused.retrievalSummary.sensor,
        literature: fused.retrievalSummary.literature,
        forecast: fused.retrievalSummary.forecast,
      },
    };

    // Layer 2: deterministic guardrail enforcement
    // Runs only when the profile sets an operational decision, on this attempt's
    // sensor and forecast retrieval and the fused evidence built from it.
    // Checks that the decision's required sensor variables are present + fresh
    // and that its required forecast variables are present, before the analyst
    // LLM is invoked. On refusal: emit a `guardrail` step event, stream the
    // refusal text, and short-circuit.
    if (operationalDecision && attempt === 0) {
      // Build the gate's sensor view from the raw pre-cap retrieval
      // (publicSensor + operationalSensor) plus the fused sensor items. The
      // upstream `slice(0, 6)` cap on `sensor` is an LLM-context constraint,
      // not a gate constraint: without the raw records a required variable like
      // DO_mgL_mean can be evicted from the gate's view by a Temp-heavy slice
      // and show up "missing" when it exists in VERA. Dedup by (siteId,
      // variable, timestamp, depthM).
      const fusedSensor = fused.evidence.filter((e) => e.channel === "sensor");
      const fusedForecast = fused.evidence.filter((e) => e.channel === "forecast");
      const gateSensorEvidence = [...publicSensor, ...operationalSensor, ...fusedSensor];
      const seen = new Set<string>();
      const sensorRecords: LeadsSensorRecord[] = [];
      for (const e of gateSensorEvidence) {
        if (!e.provenance.variable || !e.provenance.timestamp) continue;
        const key = `${e.provenance.siteId ?? ""}|${e.provenance.variable}|${e.provenance.timestamp}|${e.provenance.depthM ?? "na"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sensorRecords.push({
          projectId: "",
          siteId: e.provenance.siteId ?? "",
          datetime: e.provenance.timestamp as string,
          duration: "",
          depthM: e.provenance.depthM ?? null,
          variable: e.provenance.variable as string,
          // Carry the value through for deterministic constraint eval
          // (qualifying-depth / persistence). Layer 2 presence+freshness ignores it.
          observation: e.provenance.observation ?? null,
        });
      }
      const forecastVariables = Array.from(
        new Set(
          [...forecast, ...fusedForecast]
            .map((e) => e.provenance.variable)
            .filter((v): v is string => Boolean(v)),
        ),
      );

      yield { type: "step", step: "guardrail", status: "running" };
      const layer2 = enforceLayer2({
        decision: operationalDecision,
        reservoir: operationalReservoir!,
        // persona selects the rules_by_persona rule; asOf anchors the
        // cadence-aware freshness check.
        persona: options.leadsProfile?.persona,
        sensorRecords,
        forecastVariables,
        asOf: evalNowIso(),
      });

      if (!layer2.ok) {
        yield {
          type: "step",
          step: "guardrail",
          status: "done",
          data: {
            verdict: "refused",
            decision: layer2.decision,
            missingSensor: layer2.missingSensor,
            staleSensor: layer2.staleSensor,
            missingForecast: layer2.missingForecast,
            triggeredConditions: layer2.triggeredConditions,
          },
        };
        yield { type: "step", step: "synthesize", status: "running" };
        for (const token of chunkTokens(layer2.refusal)) {
          yield { type: "token", token };
        }
        yield { type: "step", step: "synthesize", status: "done" };
        yield {
          type: "done",
          citations: [],
          faithfulness: { pct: 0, cited: 0, total: 0 },
          cost: getSnapshot(),
          alignment: plan.profileQueryAlignment,
        };
        return;
      }

      yield {
        type: "step",
        step: "guardrail",
        status: "done",
        data: {
          verdict: "passed",
          decision: layer2.decision,
          groundingSensorVars: Array.from(
            new Set(layer2.groundingSensor.map((r) => r.variable)),
          ),
          groundingForecastVars: layer2.groundingForecast,
          // Per-variable AGED/OFF_SEASON age caveats the answer must disclose
          // (surfaced for the UI and the adherence check).
          freshnessCaveats: layer2.freshnessCaveats,
        },
      };

      // Forecast skill as evidence
      // The answer sees the forecast; this record tells it how well forecasts of that
      // kind have done, so confidence is not judged from ensemble spread alone. site and
      // variable come from the plan: the forecast evidence's provenance carries neither,
      // and the skill record is keyed on the lowercase VERA site id ("fcre") as the plan
      // stores it.
      //
      // Gate (lib/skill/forecast-skill.ts): the record is FLARE's past CRPSS against
      // climatology at FCR 1.6 m by forecast day 1-21, each past forecast pair counted
      // once and pooled, with a 95% CI per day. Depth comes from plan.resolvedDepthsM and
      // fails closed for a full-profile decision (whose list is [] by construction) or
      // any unresolved depth. The record lists days 1..min(H, 21) for the question's
      // horizon H (7 when none is given) and says so when days past 21 are asked for.
      // When no record applies, the note says so deterministically instead of staying
      // silent. Only when forecast evidence is in the packet; Layer 2 requires forecast
      // variables here, so in practice this fires on every operational answer that passed
      // it, BVR and deep water included.
      if (forecast.length > 0 || fusedForecast.length > 0) {
        forecastSkillNote = forecastSkillNoteFor(plan);
      }

      // Forecast freshness (reference_date age)
      const forecastRefDates = forecast
        .map((e) => e.provenance.referenceDate)
        .filter((d): d is string => Boolean(d));
      if (forecastRefDates.length > 0) {
        const latestRef = forecastRefDates.sort().reverse()[0];
        const fa = assessFreshness("forecast", latestRef, evalNowIso());
        if (fa.status === "AGED" || fa.status === "STALE") {
          forecastFreshnessCaveat =
            `FLARE forecast reference_date ${latestRef.slice(0, 10)} is ${fa.ageDays} d old (${fa.status}) — ` +
            `treat the forward-looking outlook with caution` +
            (fa.status === "STALE"
              ? "; it predates the reliable issue window (likely an upstream FLARE lag/outage), so lean on the current sensor state."
              : ".");
          yield {
            type: "step",
            step: "guardrail-forecast-freshness",
            status: "done",
            data: { status: fa.status, ageDays: fa.ageDays, referenceDate: latestRef.slice(0, 10) },
          };
        }
      }

      // Deterministic constraint evaluation
      // Layer 2 has confirmed the data is present + fresh enough. Now compute
      // the value-based verdict: qualifying-depth search (full_profile),
      // persistence run (flow), or per-zone satisfaction (hypoxia, algae).
      // Feeds the SSE event + synthesis grounding below.
      const personaRule = options.leadsProfile?.persona
        ? getPersonaRule(operationalReservoir!, operationalDecision, options.leadsProfile.persona)
        : null;
      if (personaRule) {
        const obs: ConstraintObservation[] = sensorRecords.map((r) => ({
          variable: r.variable,
          depthM: r.depthM,
          datetime: r.datetime,
          observation: r.observation,
        }));
        constraintEval = evaluateConstraints(personaRule, obs, evalNowIso());
        yield {
          type: "step",
          step: "guardrail-eval",
          status: "done",
          data: {
            applicable: constraintEval.applicable,
            kind: constraintEval.applicable ? constraintEval.kind : "inapplicable",
            summary: constraintEval.summary,
            ...(constraintEval.applicable && constraintEval.kind === "qualifying_depth"
              ? { qualifyingDepths: constraintEval.qualifyingDepths }
              : {}),
            ...(constraintEval.applicable && constraintEval.kind === "persistence"
              ? { sustained: constraintEval.sustained, indeterminate: constraintEval.indeterminate, runSpanDays: constraintEval.runSpanDays }
              : {}),
            // Display-only scope line (rules that leave some of their constraints
            // unevaluated). The client keeps step data on the message, so the UI prints
            // it under the answer and the PDF under the verdict; never in the token stream.
            ...(constraintEval.scopeNote ? { scopeNote: constraintEval.scopeNote } : {}),
          },
        };
      }
    }

    // Forecast skill as evidence, informational answers
    // Informational answers (no operational decision: researcher questions, decision
    // "none") get the same record the skill card under the answer shows, through the same
    // helper and with the same gate as above (only when forecast evidence is in the
    // packet), so the answer and the card agree. Where the gate finds no record (another
    // site, depth or variable), this carries the same no-record disclosure the card's
    // greyed slot shows.
    // Recomputed per attempt because the plan and the forecast evidence can change on a retry.
    if (!operationalDecision) {
      const hasForecastEvidence =
        forecast.length > 0 || fused.evidence.some((e) => e.channel === "forecast");
      forecastSkillNote = hasForecastEvidence ? forecastSkillNoteFor(plan) : null;
    }

    yield { type: "step", step: "rerank", status: "done", data: { selected: fused.evidence.length } };

    yield { type: "step", step: "gap", status: "done", data: { gaps: plan.channels.includes("sensor") && fused.retrievalSummary.sensor === 0 ? ["No sensor evidence matched current hints"] : [] } };

    yield { type: "step", step: "gate", status: "running" };
    const missingChannels = plan.channels.filter((channel) => fused.retrievalSummary[channel] === 0);
    const simpleAnswerMode = isSimpleAnswerMode(plan);
    const skipVerification = !literatureOff && isVerificationSkippable(plan);
    const sufficient = isEvidenceMode
      ? fused.evidence.length > 0
      : simpleAnswerMode
      ? fused.evidence.length > 0
      : fused.evidence.length >= 3 && missingChannels.length === 0;
    yield {
      type: "step",
      step: "gate",
      status: "done",
      data: {
        verdict: sufficient ? "correct" : "ambiguous",
        confidence: Math.round(fused.retrievalConfidence * 10),
        missingChannels,
        reason: sufficient
          ? isEvidenceMode
            ? "Evidence-sheet mode can answer from the retrieved packet and disclose any missing channels explicitly."
            : simpleAnswerMode
            ? "Simple-answer mode can answer from the retrieved evidence even if some channels are sparse."
            : "Evidence spans the requested channels."
          : "Evidence coverage is thin or incomplete across requested channels; one retry will broaden retrieval.",
      },
    };

    if (!sufficient && attempt < maxIterations - 1) {
      retrySignal = createRetrySignal(plan, fused.evidence, fused.retrievalSummary);
      continue;
    }

    // Anchor synthesis to the deterministic constraint verdict. Injected
    // as a top-priority sensor item so the answer states the qualifying depth /
    // persistence verdict / single-zone verdict verbatim rather than re-deriving
    // it from raw values (fused is rebuilt fresh each attempt, so no dup risk).
    if (constraintEval) {
      fused.evidence.unshift({
        id: "sensor:constraint-eval",
        channel: "sensor",
        title: "Operational constraint evaluation (deterministic)",
        text: `DECISION CONSTRAINT EVALUATION (deterministic, computed by LEADS — treat as authoritative for the operational verdict): ${constraintEval.summary}`,
        score: 0.99,
        provenance: {
          type: "sensor",
          label: "LEADS deterministic constraint evaluation",
          method: "constraint-eval",
        },
      });
    }
    // Surface the forecast-freshness caveat so the synthesizer discloses a
    // stale outlook rather than presenting an old forecast as current.
    if (forecastFreshnessCaveat) {
      fused.evidence.unshift({
        id: "forecast:freshness-caveat",
        channel: "forecast",
        title: "Forecast freshness caveat",
        text: `FORECAST FRESHNESS CAVEAT (deterministic): ${forecastFreshnessCaveat}`,
        score: 0.98,
        provenance: {
          type: "forecast",
          label: "FLARE forecast freshness",
          method: "forecast-freshness",
        },
      });
    }

    // Skill record, injected beside the freshness caveat so the answer can weigh how
    // trustworthy a forecast at this lead has historically been, not merely how wide it is.
    // When no record applies (another site or depth), this carries the no-record
    // disclosure instead, inside the record next to the forecast data.
    if (forecastSkillNote) {
      fused.evidence.unshift({
        id: "forecast:skill-record",
        channel: "forecast",
        title: "FLARE forecast skill record",
        text: forecastSkillNote,
        score: 0.975,
        provenance: {
          type: "forecast",
          label: "FLARE forecast skill vs climatology",
          method: "forecast-skill",
        },
      });
    }

    // Inject the decision's operational framing (lever and do-not rules) as
    // authoritative grounding evidence rather than through the LLM system prompt.
    // This delivers e.g. the HOx lever (FCR hypoxia), "add algaecide" (algae), intake
    // depth selection on the DO profile (water extraction), or "increase flow to flush"
    // (flow). Paired with the Layer-3 `operational_lever_referenced` audit so delivery
    // is also verified. fused is rebuilt per attempt, so there is no duplication risk.
    if (operationalDecision && operationalReservoir) {
      const framing = getGuardrail(operationalReservoir, operationalDecision).system_prompt_addendum;
      if (framing) {
        fused.evidence.unshift({
          id: "sensor:operational-framing",
          channel: "sensor",
          title: "Operational framing (decision guardrail)",
          text: `OPERATIONAL FRAMING (decision guardrail — authoritative; honor the operational lever and any do-not rules): ${framing}`,
          score: 0.97,
          provenance: {
            type: "sensor",
            label: "LEADS decision guardrail (operational framing)",
            method: "operational-framing",
          },
        });
      }
    }

    yield { type: "step", step: "synthesize", status: "running" };
    let answer;
    if (isEvidenceMode) {
      const verification = createSoftVerification(plan, fused.evidence, fused.retrievalSummary);
      answer = {
        ...generateStructuredEvidenceAnswer(query, fused.evidence, plan.channels, fused.retrievalConfidence, attempt),
        verification,
      };
      if (!bestAttempt || verification.pct > bestAttempt.pct) {
        bestAttempt = { answer, pct: verification.pct, attempt };
      }
      yield { type: "faithfulness", claims: verification.claims };
      yield {
        type: "step",
        step: "verify",
        status: "done",
        data: {
          supported: verification.supported,
          total: verification.claims.length,
          pct: verification.pct,
          unsupported: verification.unsupported,
          missingChannels: verification.missingChannels,
          unresolvedClaims: verification.unresolvedClaims,
        },
      };
    } else {
      answer = await generateGroundedAnswer(
        query,
        fused.evidence,
        fused.retrievalConfidence,
        plan.siteHints,
        conversationHistory,
        plan.reflexionNote,
        attempt
      );

      // Claim check skipped when skipVerification is set (see isVerificationSkippable).
      if (skipVerification) {
        const verification = createSoftVerification(plan, fused.evidence, fused.retrievalSummary);
        answer = { ...answer, verification };
        yield { type: "faithfulness", claims: verification.claims };
        yield {
          type: "step",
          step: "verify",
          status: "done",
          data: {
            supported: verification.supported,
            total: verification.claims.length,
            pct: verification.pct,
            unsupported: verification.unsupported,
            missingChannels: verification.missingChannels,
            unresolvedClaims: verification.unresolvedClaims,
          },
        };
      } else {
        const verification = await assessClaimSupport({
          query,
          answer: answer.response,
          evidence: fused.evidence,
          requestedChannels: plan.channels,
          litVerbatim: literatureLitVerbatim,
        });
        verifiedAnswers.set(verification, { response: answer.response, evidence: fused.evidence });
        answer = { ...answer, verification };
        if (!bestAttempt || verification.pct > bestAttempt.pct) {
          bestAttempt = { answer, pct: verification.pct, attempt };
        }

        yield { type: "faithfulness", claims: verification.claims };
        yield {
          type: "step",
          step: "verify",
          status: "done",
          data: {
            supported: verification.supported,
            total: verification.claims.length,
            pct: verification.pct,
            unsupported: verification.unsupported,
            missingChannels: verification.missingChannels,
            unresolvedClaims: verification.unresolvedClaims,
            ...(verification.claims.some((c) => c.checkedBy === "word-overlap") ? { checkedBy: "word-overlap" } : {}),
          },
        };

        const lowCitationSupport =
          !simpleAnswerMode &&
          answer.faithfulness.pct < LEADS_FAITHFULNESS_THRESHOLD &&
          verification.pct < LEADS_FAITHFULNESS_THRESHOLD;

        // shouldRetry fires when the verifier found unsupported claims, a correctness
        // signal rather than a density heuristic, so it triggers a retry even in
        // simple-answer mode; otherwise unsupported statements would ship silently.
        // lowCitationSupport is a density measure and defers to simple-answer mode.
        if ((lowCitationSupport || verification.shouldRetry) && attempt < maxIterations - 1) {
          const reflexionNote = await generateReflection(query, verification.unresolvedClaims);
          retrySignal = { ...verification, reflexionNote };
          continue;
        }

        const hasForecastEvidence = fused.evidence.some((e) => e.channel === "forecast");
        const severeFail = verification.pct < 50 && verification.unsupported > 2;
        if (verification.shouldRetry && !simpleAnswerMode && attempt === maxIterations - 1 && severeFail && !hasForecastEvidence) {
          answer = {
            ...generateAbstentionAnswer(query, fused.evidence, attempt),
            verification,
          };
        }
      }
    }

    // Best-of-N swap: if a prior attempt verified higher than the final one,
    // ship the prior (the attempt the verifier supported most).
    const finalPct = answer.verification?.pct ?? -1;
    if (bestAttempt && bestAttempt.pct > finalPct) {
      yield {
        type: "step",
        step: "best-of-n",
        status: "done",
        data: {
          keptAttempt: bestAttempt.attempt,
          keptPct: bestAttempt.pct,
          finalAttemptPct: finalPct,
          retryRegressed: true,
        },
      };
      answer = bestAttempt.answer;
      // The claim list the screen shows (and the sources it counts as cited) comes from
      // the last faithfulness event, so re-emit the kept attempt's claims.
      if (answer.verification?.claims) {
        yield { type: "faithfulness", claims: answer.verification.claims };
      }
    }

    // ── Operational-conclusion guarantee ───────────────────────────
    // The deterministic banner (prepended at stream time) always states the correct
    // operational conclusion. This step additionally checks that the prose does not
    // contradict it, and if it does, regenerates once with the verdict as a hard corrective
    // instruction - keeping the correction only if it resolves the contradiction (else
    // the original is kept; the banner remains authoritative and the Layer-3 stance
    // check below flags + penalizes it). Bounded to a single corrective pass; isolated
    // from the retry/best-of-N loop so it cannot interact with attempt selection.
    // Kill-switch: LEADS_DISABLE_CONCLUSION_GUARANTEE=1 skips the regeneration (the
    // Layer-3 stance check still reports + penalizes).
    let operationalStance: "indicated" | "not_indicated" | null = null;
    if (operationalDecision && constraintEval && !isEvidenceMode) {
      operationalStance = operationalStanceFromEval(constraintEval, operationalDecision);
      const guaranteeDisabled =
        process.env.LEADS_DISABLE_CONCLUSION_GUARANTEE === "1" ||
        process.env.LEADS_DISABLE_CONCLUSION_GUARANTEE === "true";
      if (
        operationalStance &&
        !guaranteeDisabled &&
        detectStanceContradiction(answer.response, operationalDecision, operationalStance)
      ) {
        yield { type: "step", step: "guardrail-conclusion", status: "running" };
        const corrected = await generateGroundedAnswer(
          query,
          fused.evidence,
          fused.retrievalConfidence,
          plan.siteHints,
          conversationHistory,
          buildStanceCorrection(constraintEval, operationalDecision, operationalStance),
          attempt,
        );
        const resolved = !detectStanceContradiction(corrected.response, operationalDecision, operationalStance);
        let adopted = false;
        if (resolved) {
          // Re-verify so citations / faithfulness / confidence reflect the corrected text.
          const cverification = skipVerification
            ? createSoftVerification(plan, fused.evidence, fused.retrievalSummary)
            : await assessClaimSupport({
                query,
                answer: corrected.response,
                evidence: fused.evidence,
                requestedChannels: plan.channels,
                litVerbatim: literatureLitVerbatim,
              });
          if (!skipVerification) {
            verifiedAnswers.set(cverification, { response: corrected.response, evidence: fused.evidence });
          }
          // Faithfulness floor: adopt the corrected answer only if it does not materially
          // regress grounding vs the best-of-N winner it would replace; otherwise the
          // better-grounded original is kept (the banner and the Layer-3 stance flag still
          // carry the correct conclusion).
          const priorPct = answer.verification?.pct ?? 0;
          if (cverification.pct + STANCE_CORRECTION_TOLERANCE >= priorPct) {
            answer = { ...corrected, verification: cverification };
            adopted = true;
          }
        }
        yield {
          type: "step",
          step: "guardrail-conclusion",
          status: "done",
          data: { stance: operationalStance, contradicted: true, resolved, adopted },
        };
      }
    }

    // Citation alignment (LEADS_CITATION_ALIGN, citation-align.ts)
    // Once, on the answer selected above, before Layer 3 audits it and before it is
    // streamed, cached and saved, so every view shows the same markers. Runs only when
    // the claim verifier judged exactly this text; it changes markers, never words.
    // "off" skips it and the answer is unchanged.
    const verifiedInput = answer.verification ? verifiedAnswers.get(answer.verification) : undefined;
    if (literatureCitationAlign === "on" && verifiedInput && verifiedInput.response === answer.response) {
      const aligned = alignAnswerCitations(
        answer,
        verifiedInput.evidence,
        answer.verification.claims,
        literatureCitationAlign,
        literatureLitVerbatim
      );
      for (const line of describeCitationAlignment(aligned.changes)) console.info(line);
      answer = aligned.answer;
    }

    // ── Layer 3 — post-generation deterministic validation ─────────
    // Operational decisions only. Runs after best-of-N has selected the
    // user-visible answer, so the checked text matches what the user reads.
    // Non-blocking: failures are flagged on the SSE event so the
    // guardrail-adherence rate can be computed; there is no retry.
    // Declared outside `if (operationalDecision)` so the Layer-3 result is
    // in scope at the confidence-refinement step below.
    let layer3: ReturnType<typeof enforceLayer3> | null = null;
    if (operationalDecision) {
      yield { type: "step", step: "guardrail-l3", status: "running" };
      layer3 = enforceLayer3({
        decision: operationalDecision,
        reservoir: operationalReservoir!,
        persona: options.leadsProfile?.persona, // audit persona constraints
        responseText: answer.response,
        citations: answer.citations,
        claims: answer.verification?.claims,
        hasForecastEvidence: fused.evidence.some((e) => e.channel === "forecast"),
        operationalStance,
      });
      yield {
        type: "step",
        step: "guardrail-l3",
        status: "done",
        data: {
          verdict: layer3.ok ? "passed" : "warning",
          decision: layer3.decision,
          adherencePct: layer3.adherencePct,
          checks: layer3.checks,
          warning: layer3.warning,
        },
      };
    }

    // Deterministic operational verdict banner: for a manager + an active single-zone
    // operational decision (hypoxia: HOx; algal: bloom control), prepend the
    // code-computed verdict to the streamed answer so the operational conclusion on the
    // latest reading is always present verbatim and cannot be silently contradicted by
    // the synthesized prose. Runs after Layer 3 (which audits the pure prose) and is
    // display-only - answer.response, which is audited/saved/cached, stays unchanged.
    // Forecast outlook for the banner - the decision's peak per-day threshold-crossing
    // probability over the FLARE horizon. Computed (cached fetch) only for a banner-
    // eligible manager decision when the question is forward-looking (same gate as the
    // chart's forecast layer, plan.chart.showForecast), so the banner's forecast clause
    // and the chart agree. It refetches rather than reusing the retrieval's records, so it
    // matches the evidence card's peak line only when both saw the same FLARE run and plan
    // (see forecastExceedanceOutlookFromRecords).
    const bannerDecision = bannerDecisionFor(options.leadsProfile?.persona, operationalDecision);
    const forecastOutlook =
      bannerDecision && constraintEval && plan.chart?.showForecast && plan.channels.includes("forecast")
        ? await computeForecastExceedanceOutlook(plan, {
            decision: bannerDecision,
            reservoir: operationalReservoir ?? undefined,
            persona: options.leadsProfile?.persona,
          }).catch(() => null)
        : null;
    const opBanner =
      bannerDecision && constraintEval
        ? buildOperationalVerdictBanner(constraintEval, bannerDecision, forecastOutlook)
        : null;
    const displayText = `${followUpDisambig}${opBanner ? `${opBanner}\n\n` : ""}${answer.response}`;
    for (const token of chunkTokens(displayText)) {
      yield { type: "token", token };
    }
    yield { type: "step", step: "synthesize", status: "done" };

    // Persist this Q&A turn to session memory for follow-up questions.
    if (sessionId && answer.response) {
      await saveHistory(sessionId, sessionHistory, query, answer.response);
    }

    // Store response in query cache for future identical queries (fire-and-forget).
    // Persist the full LeadsAnswer payload (citations, per-claim verification,
    // faithfulness), not just the text, so a cache hit replays the matching SSE
    // events and the evidence and claim panels render as in a fresh run.
    if (isFreshSession && answer.response) {
      setCachedAnswer(
        cacheKey,
        {
          response: answer.response,
          citations: answer.citations,
          claims: answer.verification?.claims,
          faithfulness: answer.faithfulness,
        },
        plan.channels,
      ).catch(() => {});
    }

    // Finalize the C_LEADS composite once per query, immediately before the
    // `done` event. By this point the pipeline has the post-verifier grounding (G),
    // per-claim verifier confidences (V), Layer-3 adherence (P, when an
    // operational policy applied; null otherwise, which defaults to 1.0),
    // requested-vs-filled channel counts (Y), and the iteration counter.
    // See `refineConfidenceFromPipelineState` in `generator.ts`.
    {
      const requestedChannels = plan.channels.length;
      const filledChannels = plan.channels.filter(
        (c) => (fused.retrievalSummary[c] ?? 0) > 0,
      ).length;
      answer = {
        ...answer,
        confidence: refineConfidenceFromPipelineState({
          groundingPct: answer.verification?.pct ?? 0,
          claimsConfidences: (answer.verification?.claims ?? []).map(
            (c: { confidence: number }) => c.confidence,
          ),
          l3AdherencePct: layer3?.adherencePct ?? null,
          requestedChannels,
          filledChannels,
          iterations: answer.confidence.iterations ?? attempt,
        }),
      };
    }

    yield {
      type: "done",
      citations: answer.citations,
      faithfulness: answer.faithfulness,
      verification: answer.verification,
      confidence: answer.confidence,
      cost: getSnapshot(),
      alignment: plan.profileQueryAlignment,
      raptorMode: literatureRaptorMode,
      litVerbatim: literatureLitVerbatim,
      citationAlign: literatureCitationAlign,
    };
    return;
  }

  yield {
    type: "error",
    message: "LEADS could not produce a grounded answer after multiple attempts.",
  };
}

/**
 * Public entry point - wraps the inner generator in a per-request cost-tracking
 * context so every LLM call accumulates token usage and the `done` event
 * carries an accurate cost snapshot.
 */
export function runLeadsOrchestrator(
  query: string,
  options: LeadsOrchestratorOptions = {}
): AsyncGenerator<LeadsPipelineEvent> {
  return runWithCostTracking(() => _runLeadsOrchestratorInner(query, options));
}
