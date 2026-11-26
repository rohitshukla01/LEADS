import { getQualityClient, hasChatKey } from "@/lib/openai-client";
import { readerText } from "@/lib/reader-text";
import { recordUsage } from "./cost-tracker";
import { cleanPDFText } from "@/lib/pdf";

import { evalNowIso, UNSUPPORTED_VARIABLE_TERMS } from "./config";
import { budgetEvidenceContext, describeEvidenceBudget, type EvidenceContextBudget } from "./evidence-budget";
import type { LeadsAnswer, LeadsCitation, LeadsEvidence, LeadsFaithfulness } from "./types";
import { bracketNumbers, hasCitation } from "./citation-brackets";
import {
  alignCitations,
  type CitationAlignChange,
  type CitationAlignClaim,
  type CitationAlignMode,
} from "./citation-align";
import {
  citingSentences,
  clipPassage,
  LITERATURE_ITEM_CHAR_CAP,
  litVerbatimMode,
  passageExcerpt,
  pickVerbatimQuote,
  type LitVerbatimMode,
} from "./lit-verbatim";
import { raptorMode } from "./raptor-mode";

const LEADS_SYNTHESIS_ATTEMPTS = 3;

/**
 * C_LEADS composite - equal-weighted four-component arithmetic mean with
 * Hu et al. 2025 Eq. 8-style subtractive iteration penalty.
 *
 *   C_LEADS(a) = (G + V + P + Y) / 4  −  0.05 · iterations
 *
 *   G - verifier-grounding score        = verification.pct / 100
 *   V - mean per-claim verifier conf.   = mean(verification.claims[].confidence)
 *   P - Layer-3 policy adherence        = layer3.adherencePct / 100, or 1.0 default
 *   Y - channel completeness            = filled requested channels / total requested
 *
 * Weights are equal (1/4 each). The iteration penalty follows Hu et al.'s
 * (k − 1) · 0.05 form (no separate cap; the composite is clamped to [0, 1]).
 */
export const C_LEADS_N_COMPONENTS = 4;
export const C_LEADS_ITER_PENALTY_PER_STEP = 0.05;

export function computeCLeadsComposite(
  grounding: number,
  verifierConfidence: number,
  policyAdherence: number,
  channelCoverage: number,
  iterations: number,
): number {
  const G = Math.min(1, Math.max(0, grounding));
  const V = Math.min(1, Math.max(0, verifierConfidence));
  const P = Math.min(1, Math.max(0, policyAdherence));
  const Y = Math.min(1, Math.max(0, channelCoverage));
  const mean = (G + V + P + Y) / C_LEADS_N_COMPONENTS;
  const penalty = Math.max(0, iterations) * C_LEADS_ITER_PENALTY_PER_STEP;
  return Number(Math.min(1, Math.max(0, mean - penalty)).toFixed(3));
}

/**
 * Build a finalized `LeadsAnswer.confidence` object from orchestrator-side
 * pipeline state. Called once per query at the done event, after the
 * verifier and (when operational) Layer 3 have both completed.
 *
 * Inputs come from in-scope orchestrator locals:
 *   - `groundingPct`        = `answer.verification.pct`
 *   - `claimsConfidences`   = `answer.verification.claims[].confidence`
 *   - `l3AdherencePct`      = `layer3.adherencePct` (operational) or null
 *   - `requestedChannels`   = `plan.channels.length`
 *   - `filledChannels`      = count of plan.channels with > 0 evidence
 *   - `iterations`          = the orchestrator's `attempt` counter
 *
 * Defaults:
 *   - V falls back to G if no claims (e.g. abstention before verifier ran).
 *   - P = 1.0 when `l3AdherencePct` is null (informational mode; semantic:
 *     trivially adherent to no policy).
 *   - Y = 1.0 when `requestedChannels` is 0 (no channels asked, nothing
 *     to under-cover).
 */
export function refineConfidenceFromPipelineState(inputs: {
  groundingPct: number;
  claimsConfidences: number[];
  l3AdherencePct: number | null;
  requestedChannels: number;
  filledChannels: number;
  iterations: number;
}): LeadsAnswer["confidence"] {
  const G = Math.min(1, Math.max(0, (inputs.groundingPct ?? 0) / 100));
  const V =
    inputs.claimsConfidences.length > 0
      ? inputs.claimsConfidences.reduce((sum, c) => sum + c, 0) / inputs.claimsConfidences.length
      : G;
  const P =
    inputs.l3AdherencePct === null || inputs.l3AdherencePct === undefined
      ? 1.0
      : Math.min(1, Math.max(0, inputs.l3AdherencePct / 100));
  const Y =
    inputs.requestedChannels > 0
      ? Math.min(1, Math.max(0, inputs.filledChannels / inputs.requestedChannels))
      : 1.0;
  const overall = computeCLeadsComposite(G, V, P, Y, inputs.iterations);
  return {
    grounding: Number(G.toFixed(3)),
    verifierConfidence: Number(V.toFixed(3)),
    policyAdherence: Number(P.toFixed(3)),
    channelCoverage: Number(Y.toFixed(3)),
    overall,
    iterations: Math.max(0, inputs.iterations),
  };
}

const LEADS_SYSTEM_PROMPT =
  "You are LEADS, a freshwater intelligence assistant. Use only the provided evidence. Give a direct, readable answer first. Distinguish between literature evidence and sensor observations. For sensor evidence, do not over-interpret values: being above the seasonal mean is not enough to call a value anomalous or extreme if it still falls within the matched historical range. State what is observed, what the matched baseline says, and what remains uncertain. Use light citations only when helpful; do not force a citation on every sentence." +
  "\n\nCRITICAL GROUNDING RULES:" +
  "\n1. Baseline statistics (mean, min, max, range, count) embedded in evidence text are ALL-TIME HISTORICAL AGGREGATES computed across all available years. They are NEVER tied to a specific observation date. NEVER claim that a baseline min or max value 'was recorded on' or 'was observed on' any particular date." +
  "\n2. If the user asks for the date of a specific measurement value, only report that date if an evidence item explicitly pairs that exact value with that exact date as a direct observation. If you cannot find such an explicit pairing, say so rather than guessing." +
  "\n3. When answering a question about a specific date (e.g., 'May 26, 2025'), only use evidence items whose datetime field matches that date. Do not substitute values from a different date even if the dates appear similar." +
  "\n4. NEVER surface internal data quality observations to the user. If you notice that a numeric field appears to be zero, missing, or anomalous in the evidence (e.g., spread = 0.00, count = 0, or a suspect value), silently omit that field from your answer rather than commenting on it. Report only values you can state with confidence." +
  // Rule 5: citation markers on quantitative and attributable claims. Without it
  // the model often drops inline [N] markers (especially in bulleted answers),
  // leaving the evidence panel empty even though the verifier still recovers
  // attributions. It does not ask for a marker on every sentence: numbers and
  // named sources get markers, connecting text does not, as in scientific writing.
  "\n5. When stating a specific number, date, named paper, sensor reading, or attributable claim, append the [N] marker for the source evidence packet. Brackets are NOT required on every sentence — only on quantitative or attributable claims. Markers must match the [N] labels in the Evidence packets section. Every evidence packet the answer relies on must carry its [N] marker at least once, on a sentence it directly supports (rule 7) — including the deterministic constraint evaluation when you state the operational verdict, the forecast skill record when you state forecast skill, and the data-recency record when you state data age." +
  // Rule 6: verdict-first decision brief (a manager wants the bottom line first).
  // Uncertainty (data recency, forecast spread) is kept, but each caveat is attached
  // as a qualifier on the verdict; a trailing list of unknowns reads as evasive.
  // Caveats are never dropped, and Layer 3 uncertainty preservation still applies.
  // The body is three or four short prose paragraphs (status, forecast, decision and
  // key gap) with a plain 'Confidence:' line. Each
  // paragraph item is conditional on the evidence giving it, so the form never invites
  // a threshold, seasonal context or skill verdict the packets do not contain; 'most
  // recent reading' matches the date block's 'most recent available data' label. The
  // Confidence line cites only its own qualifiers. A risk the framing asks to flag but
  // no packet can assess is the gap to name, and each gap is stated once (a missing
  // skill record goes to paragraph 3 only).
  "\n6. ANSWER STRUCTURE — decision-brief format. Open with a single committal sentence that directly answers the question: the bottom line up front (e.g. 'Hypoxia risk over the next 7 days is low.'). Then write three or four short paragraphs of plain prose — no headings, bold labels, bullet or numbered lists, or tables. Paragraph 1, after the bottom-line sentence: the most recent reading with its date and depth and, where the evidence gives them, the operational threshold it is compared with and its seasonal context. Paragraph 2, when forecast evidence is present: the forecast risk by day as shares of ensemble members where the record gives them (rules 9 and 9a), the daily means with units, and, when a forecast skill record is present, its verdict (when the record says no skill record exists, leave that to paragraph 3, where it is the evidence gap). Paragraph 3: what this means for the decision, and the most important evidence gap, stated once (when an earlier paragraph already stated that gap, such as a missing skill record, this paragraph and the 'Confidence:' line refer back to it in a few words and do not restate it); when the operational framing asks you to flag a risk that no evidence packet can assess, that unassessed risk is the gap to name. Omit a paragraph that has nothing to report, and never fill one with a threshold, value or context the evidence does not give; answers without sensor or forecast evidence keep the same prose form. Place data-recency, ensemble-spread, and confidence qualifiers in a closing line beginning 'Confidence:' (plain text, not bold); it cites only the packets behind its own qualifiers (typically the data-recency record and the forecast skill record), never every source cited above. Preserve every caveat you would otherwise raise — including sensor-data age and forecast uncertainty — but frame each as a qualifier ON the stated verdict, never as a freestanding list of unknowns that withdraws the verdict. Do not end on bare phrasing like 'it is unknown' or 'inherently uncertain'; pair any such note with its operational consequence (e.g. 'sensor data is 8 days old; this does not change the low-risk assessment but warrants re-checking after the next update')." +
  // Rule 7: evidence discipline. Forbids external facts not in the packets (such as an
  // invented 'Author Year' citation) and [N] markers on claims the cited packet does not
  // state, without banning synthesis: inference across the evidence is allowed but left
  // unbracketed rather than mis-attributed. A cited source keeps its hedges and scope.
  "\n7. EVIDENCE DISCIPLINE — Assert only what the Evidence packets contain. Do NOT introduce external facts, named studies, or references (e.g. an 'Author Year' citation like 'Mortimer 1941') that are not present in the packets, even if you believe them true. Attach a [N] marker ONLY when packet N directly supports that specific claim — never attach a citation to a claim its source does not state. You may still synthesize and explain across the evidence, but present any inference that goes beyond what a packet states as your own reasoning (leave it unbracketed), not as an attributed fact. Do not make a source sound stronger than it is: keep its hedges and scope (for example, \"helps control\" must not become \"prevents\", and \"can\" must not become \"does\")." +
  // Rule 7a: names the misattributions rule 7 alone does not prevent: operating rules
  // ("typically operated only when DO falls to critical levels"), skill or lead-time
  // claims, and causal mechanisms the cited snippet does not state.
  "\n7a. In particular, NEVER attribute to a source: an operating rule, trigger condition or management practice the source does not state; a claim about forecast skill, accuracy, or how either changes with lead time unless the source reports it; or a causal mechanism the source does not describe. If you believe a general principle is true but no packet asserts it, state it in your own voice with no marker — that is allowed and preferred over a wrong attribution." +
  // Rule 8: a run of markers drawn from one document implies corroboration that does
  // not exist, and breadth language ("multiple lines of evidence") needs two or more
  // distinct documents. The packet headers name the source document of every item.
  "\n8. CITATION BREADTH — Each Evidence packet header names its source document. When several packets come from the SAME document, cite only the one that best supports the claim; a string like [4][5][6] drawn from one paper implies corroboration that does not exist. If every marker for a claim resolves to ONE document, do not attribute the claim to 'the literature' collectively — name that single source instead (e.g. 'McClure et al. (2018) reports ...'). Reserve 'literature confirms', 'multiple studies', 'multiple lines of evidence' and similar breadth language for claims whose markers resolve to two or more DIFFERENT source documents." +
  // Rule 9: a forecast lead valid at or before the newest observation is overtaken by
  // it, and a run older than the latest reading is described by its actual dates
  // rather than as "the next 7 days".
  "\n9. FORECAST DATING — Tie every forecast statement to the period it actually covers. A forecast lead whose valid date falls at or before the most recent observation has already been overtaken by that observation: do not offer it as evidence for a forward-looking conclusion. When the forecast run is older than the latest reading, describe the horizon by its actual dates rather than as 'the next N days', 'the coming week' or 'this week'." +
  // Rule 9a: the forecast records print ensemble member counts and the lowest/highest
  // daily mean (forecast.ts, ensemble.ts formatEnsembleProbability), and the prose keeps
  // them as printed (standard ensemble reporting, resolution 1/N). A member fraction is
  // a share of ensemble members, not a probability; a value without a member count
  // (Gaussian or pooled-depth fallback) keeps the record's qualifier. The skill verdict
  // is stated for the forecast's days in the record's own terms (lib/skill/forecast-skill.ts
  // skillVerdict), with the forecast as its subject. 'Skill' is reserved for the
  // climatology comparison, so a published RMSE is called accuracy. Without a skill packet
  // the answer makes no skill claim, so it cannot contradict the skill card beside it.
  "\n9a. FORECAST NUMBERS — Report ensemble member shares exactly as the record gives them, with the member count (e.g. 'X% of ensemble members (k of N)'); never write 0% or 100% for an ensemble count, and never call a member share a 'probability', 'chance' or 'likelihood'. A stated range must be the lowest and highest of the values it summarises; report per-day shares per day and never combine them into a share over a window. When a FORECAST SKILL RECORD is present, state its verdict for the days the forecast covers in the record's own terms, with the forecast as the subject (e.g. 'the forecast is more skilful than climatology on each of days 1–N'), and cite it; do not single out individual lead days unless the record's verdict differs between them, and keep the record's note of any days it does not score. When the record gives no member count (a Gaussian approximation, or values pooled across depths), report the value with the record's own qualifier and do not call it a share of ensemble members. Reserve 'skill' and 'skilful' for the skill record's comparison with climatology: describe a published error measure (e.g. RMSE) as accuracy. When no FORECAST SKILL RECORD packet is present, make no claim that the forecast's skill is known, unknown, untested or unevaluated: the record is simply not among the packets." +
  // Rule 10: no evidence channel records whether a management system is running, so
  // the answer never infers its operating state. When a deterministic check tests
  // activation, the verdict stays within activation: widening "activation not
  // indicated" to "no operational need to run" reads as advice to shut down a system
  // that runs continuously through stratification.
  "\n10. VERDICT SCOPE — LEADS has no record of whether any management system (for example an oxygenation system, mixing or algaecide dosing) is running; never infer its operating state or effectiveness from sensor observations alone. \"Consistent with\" phrasing is acceptable. When the evidence contains a deterministic operational check, your verdict must not claim more than that check evaluated. If the check tests whether to ACTIVATE an intervention, confine the verdict to activation and never recommend continuing, stopping or reducing it. Stay committal about what the check does support (e.g. 'activation is not indicated by this reading')." +
  // Rule 11: the guardrail text is grounding, not something to recite; quoting it is
  // commentary about the rulebook, not an answer about the reservoir. The deterministic
  // "Not evaluated: ..." line in the constraint record is a limit on the evidence, not
  // scaffolding, so it is relayed rather than suppressed.
  "\n11. NO SCAFFOLDING — the operational framing and decision guardrails shape what you say; never describe them to the reader. Do not write 'the operational framing requires', 'the guardrail specifies', 'per the decision context' or similar. State the finding, not the rule that produced it. The one exception: when the deterministic constraint evaluation includes a 'Not evaluated:' line, relay it once, in plain words, as a limit on what the check covered." +
  // Rule 12: writing style, matching the skill card's
  // wording. Style only: it adds no facts. Each caveat and each value is stated once,
  // and 'significant' is reserved for a statistical test the evidence reports.
  "\n12. WRITING STYLE — Write concise, journal-quality prose. Give every value its unit, including spreads, ranges and differences (write 'a spread of X mg/L', never a bare 'spread X'). Call a decision rule's threshold the operational threshold, or by the name the evidence gives it; never present it as a published standard or guideline. Spell 'skilful' as the forecast skill record does. Use 'significant', 'significantly' or 'significance' only for a statistical test the evidence reports; otherwise write 'substantial', 'substantially' or 'marked'. Keep dates in the form the evidence gives them and state data age as the recency record does, without 'as of today'. State each caveat once, where it first applies; later paragraphs and the closing 'Confidence:' line may refer back to it in a few words but must not restate it. Report each value once: do not repeat in a later sentence a value already given, and leave the opening sentence's values out of the paragraphs that follow.";

function extractText(response: { content: Array<{ type: string; text?: string }> }) {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function cleanDocumentTitle(name?: string) {
  if (!name) return "Indexed source";
  return name.replace(/\.[^/.]+$/, "").trim() || name;
}

function formatPrimarySourceLabel(item: LeadsEvidence, index: number) {
  if (item.channel === "literature") {
    const title = cleanDocumentTitle(item.provenance.docName ?? item.title);
    const page = item.provenance.pageNum && item.provenance.pageNum > 0 ? `p.${item.provenance.pageNum}` : "page unknown";
    return `${title} (${page})`;
  }

  if (item.channel === "sensor") {
    if (!item.provenance.siteId) return item.title; // a LEADS record, not a sensor reading
    const site = item.provenance.siteId.toUpperCase();
    const variable = item.provenance.variable ?? "sensor";
    const time = item.provenance.timestamp ?? "unknown time";
    return `${site} ${variable} (${time})`;
  }

  if (item.channel === "forecast") {
    const site = item.provenance.siteId?.toUpperCase() ?? "";
    const variable = item.provenance.variable ?? "";
    const horizon = item.provenance.horizon ? `${item.provenance.horizon}d` : "";
    const modelInfo = item.provenance.ensembleSize ? `${item.provenance.ensembleSize}-member ensemble` : "";
    const parts = [site, variable, horizon, modelInfo].filter(Boolean);
    return parts.length > 0 ? `FLARE GLM-AED ${parts.join(" ")}` : item.title;
  }

  return item.title || `Source ${index + 1}`;
}

/** The excerpt a fallback or abstention answer prints for an item. With LEADS_LIT_VERBATIM
 *  "on", a literature item that carries its passage shows text copied from it (the
 *  sentences closest to its extracted sentence) rather than that sentence, which may be an
 *  LLM rewrite; everything else shows item.text. */
function fallbackExcerpt(item: LeadsEvidence) {
  if (litVerbatimMode() !== "on" || item.channel !== "literature" || !item.verbatimText) return item.text;
  const passage = clipPassage(item.verbatimText, LITERATURE_ITEM_CHAR_CAP);
  return pickVerbatimQuote(passage, "", item.text) ?? passageExcerpt(passage);
}

/** The evidence as a reader may see it (reader-text.ts): records keep their facts and lose
 *  the instructions written for the answer model. Same items, same order. */
function forReader(evidence: LeadsEvidence[]): LeadsEvidence[] {
  return evidence.map((item) => (item.channel === "literature" ? item : { ...item, text: readerText(item.text) }));
}

function formatFallbackEvidence(evidence: LeadsEvidence[]) {
  return evidence
    .slice(0, 4)
    .map((item, index) => {
      const sourceLabel = formatPrimarySourceLabel(item, index);
      return `Source ${index + 1}: ${sourceLabel}\nExcerpt: ${fallbackExcerpt(item)} [${index + 1}]`;
    })
    .join("\n\n");
}

function splitSentences(text: string) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanEvidenceText(text: string) {
  return cleanPDFText(text.replace(/\u0000/g, " ")).replace(/\s+/g, " ").trim();
}

function truncateSentence(text: string, maxChars = 260) {
  const normalized = cleanEvidenceText(text);
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, maxChars);
  return `${clipped.slice(0, clipped.lastIndexOf(" ")).trim()}...`;
}

function isForecastStyleQuery(query: string) {
  return /(forecast|predict|probability|probable|chance|likelihood|next week|tomorrow|outlook)/i.test(query);
}

function wantsSectionedAnalysis(query: string) {
  return (
    /\bcurrent data\b/i.test(query) &&
    /\bbaseline comparison\b/i.test(query) &&
    /\bliterature-backed mechanisms\b/i.test(query) &&
    /\bmanagement-relevant consequences\b/i.test(query) &&
    /\buncertainty\b/i.test(query)
  );
}

function topEvidenceByChannel(evidence: LeadsEvidence[], channel: LeadsEvidence["channel"], limit: number) {
  return evidence.filter((item) => item.channel === channel).slice(0, limit);
}

function extractReadableClaim(text: string, maxChars = 260) {
  const cleaned = cleanEvidenceText(text);
  const sentences = splitSentences(cleaned);
  const candidate =
    sentences.find((sentence) => sentence.length >= 70 && sentence.length <= maxChars) ??
    sentences.find((sentence) => sentence.length >= 40) ??
    cleaned;
  return truncateSentence(candidate, maxChars);
}

function buildReadableEvidencePacket(evidence: LeadsEvidence[]) {
  return evidence
    .slice(0, 5)
    .map((item, index) => {
      const label =
        item.channel === "sensor"
          ? `${item.provenance.siteId?.toUpperCase() ?? item.title} ${item.provenance.variable ?? "sensor"}`
          : cleanDocumentTitle(item.provenance.docName ?? item.title);
      return `[${index + 1}] ${label}: ${
        extractReadableClaim(item.text, item.channel === "literature" ? 260 : 220)
      }`;
    })
    .join("\n");
}

function buildStructuredEvidenceSheet(query: string, evidence: LeadsEvidence[], requestedChannels: Array<LeadsEvidence["channel"]>) {
  const sensorEvidence = evidence.filter((item) => item.channel === "sensor");
  const literatureEvidence = evidence.filter((item) => item.channel === "literature");
  const presentChannels = new Set(evidence.map((item) => item.channel));
  const missingChannels = requestedChannels.filter((channel) => !presentChannels.has(channel));

  const sensorLines =
    sensorEvidence.length > 0
      ? sensorEvidence.map((item, index) => {
          const evidenceIndex = evidence.indexOf(item);
          const observation = splitSentences(item.text)[0] ?? item.text;
          return `- ${formatPrimarySourceLabel(item, evidenceIndex)}: ${observation} [${evidenceIndex + 1}]`;
        })
      : ["- No current sensor observations were retrieved for this query."];

  const baselineLines =
    sensorEvidence.length > 0
      ? sensorEvidence.map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          const sentences = splitSentences(item.text);
          const baseline = sentences.slice(1).join(" ").trim();
          return baseline
            ? `- ${truncateSentence(baseline, 280)} [${evidenceIndex + 1}]`
            : `- No matched seasonal baseline details were present in this sensor packet. [${evidenceIndex + 1}]`;
        })
      : ["- No matched sensor/baseline packet was available to compare against the historical window."];

  const literatureLines =
    literatureEvidence.length > 0
      ? literatureEvidence.slice(0, 4).map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          const claim = splitSentences(item.text)[0] ?? item.text;
          const sourceLabel = formatPrimarySourceLabel(item, evidenceIndex);
          return `- ${sourceLabel}: ${truncateSentence(claim, 280)} [${evidenceIndex + 1}]`;
        })
      : ["- No supporting literature passages were retrieved from the indexed corpus for this query."];

  const missingEvidenceLines: string[] = [];
  if (missingChannels.includes("literature")) {
    missingEvidenceLines.push("- Literature support was not retrieved, so a corpus-backed mechanism or risk interpretation cannot be completed from this packet alone.");
  }
  if (missingChannels.includes("sensor")) {
    missingEvidenceLines.push("- Current sensor evidence was not retrieved, so no present-condition assessment can be made.");
  }
  if (missingChannels.includes("sensor") && sensorEvidence.length === 0) {
    missingEvidenceLines.push("- Sensor evidence was not retrieved, so current conditions and seasonal baseline context cannot be assessed.");
  }
  if (isForecastStyleQuery(query) && !evidence.some((e) => e.channel === "forecast")) {
    missingEvidenceLines.push('- No forecast artifact available; cannot estimate probability.');
  }
  if (missingEvidenceLines.length === 0) {
    missingEvidenceLines.push("- No critical retrieval gaps were detected in this evidence sheet, but conclusions should remain limited to the cited sources.");
  }

  // Forecast evidence section
  const forecastEvidence = evidence.filter((item) => item.channel === "forecast");
  const forecastLines =
    forecastEvidence.length > 0
      ? forecastEvidence.slice(0, 4).map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          const sourceLabel = formatPrimarySourceLabel(item, evidenceIndex);
          return `- ${sourceLabel}: ${truncateSentence(item.text, 320)} [${evidenceIndex + 1}]`;
        })
      : ["- No ensemble forecast data was retrieved for this query."];

  return [
    "A. Sensor evidence",
    ...sensorLines,
    "",
    "B. Baseline comparison",
    ...baselineLines,
    "",
    "C. Literature claims",
    ...literatureLines,
    "",
    "D. Forecast evidence",
    ...forecastLines,
    "",
    "E. Missing evidence / cannot answer directly",
    ...missingEvidenceLines,
  ].join("\n");
}

function buildSectionedAnalysisFallback(query: string, evidence: LeadsEvidence[]) {
  const sensorEvidence = evidence.filter((item) => item.channel === "sensor");
  const literatureEvidence = evidence.filter((item) => item.channel === "literature");

  const currentData =
    sensorEvidence.length > 0
      ? sensorEvidence.slice(0, 4).map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          const observation = splitSentences(item.text)[0] ?? item.text;
          return `- ${truncateSentence(observation, 220)} [${evidenceIndex + 1}]`;
        })
      : ["- No current sensor observations were retrieved for this query."];

  const baselineComparison =
    sensorEvidence.length > 0
      ? sensorEvidence.slice(0, 4).map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          const baseline = splitSentences(item.text).slice(1).join(" ").trim();
          return baseline
            ? `- ${truncateSentence(baseline, 240)} [${evidenceIndex + 1}]`
            : `- No matched seasonal baseline details were present in this sensor packet. [${evidenceIndex + 1}]`;
        })
      : ["- No sensor/baseline pair was available for comparison."];

  const mechanisms =
    literatureEvidence.length > 0
      ? literatureEvidence.slice(0, 3).map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          return `- ${extractReadableClaim(item.text, 260)} [${evidenceIndex + 1}]`;
        })
      : ["- No indexed literature passages were retrieved to support a mechanism-based interpretation."];

  const consequences =
    literatureEvidence.length > 0
      ? literatureEvidence.slice(0, 2).map((item) => {
          const evidenceIndex = evidence.indexOf(item);
          return `- Monitor consequences consistent with the cited literature passage: ${extractReadableClaim(item.text, 220)} [${evidenceIndex + 1}]`;
        })
      : ["- Without retrieved literature support, no corpus-backed management consequence can be stated confidently."];

  const uncertainty: string[] = [];
  uncertainty.push("- The current sensor packets describe observations relative to matched historical windows; they do not by themselves establish bloom probability or causation.");
  if (literatureEvidence.length === 0) {
    uncertainty.push("- Literature retrieval was empty, so mechanistic interpretation remains incomplete.");
  }
  if (isForecastStyleQuery(query) && !evidence.some((e) => e.channel === "forecast")) {
    uncertainty.push("- No forecast artifact available; cannot estimate probability.");
  }

  // Forecast section
  const forecastEvidence = evidence.filter((item) => item.channel === "forecast");
  const forecastData =
    forecastEvidence.length > 0
      ? forecastEvidence.slice(0, 3).map((item) => {
          const idx = evidence.indexOf(item);
          return `- ${truncateSentence(item.text, 260)} [${idx + 1}]`;
        })
      : [];

  const sections = [
    "1. Current data",
    ...currentData,
    "",
    "2. Baseline comparison",
    ...baselineComparison,
    "",
  ];

  if (forecastData.length > 0) {
    sections.push(
      "3. Forecast outlook",
      ...forecastData,
      "",
      "4. Literature-backed mechanisms",
      ...mechanisms,
      "",
      "5. Management-relevant consequences",
      ...consequences,
      "",
      "6. Uncertainty",
      ...uncertainty,
    );
  } else {
    sections.push(
      "3. Literature-backed mechanisms",
      ...mechanisms,
      "",
      "4. Management-relevant consequences",
      ...consequences,
      "",
      "5. Uncertainty",
      ...uncertainty,
    );
  }

  return sections.join("\n");
}

function buildSimpleAnswerFallback(query: string, evidence: LeadsEvidence[]) {
  const sensorEvidence = topEvidenceByChannel(evidence, "sensor", 3);
  const literatureEvidence = topEvidenceByChannel(evidence, "literature", 3);
  const forecastEvidence = topEvidenceByChannel(evidence, "forecast", 3);

  if (isForecastStyleQuery(query) && forecastEvidence.length === 0) {
    const supportLine =
      literatureEvidence.length > 0 || sensorEvidence.length > 0
        ? ` Most relevant available evidence: ${formatFallbackEvidence([...sensorEvidence, ...literatureEvidence].slice(0, 2))}`
        : "";
    return `I can summarize the current evidence, but I cannot estimate probability or make a forecast here because no forecast artifact or predictive model output was retrieved.${supportLine}`;
  }

  const parts: string[] = [];

  if (sensorEvidence.length > 0) {
    const sensorSummary = sensorEvidence
      .map((item) => {
        const idx = evidence.indexOf(item);
        const sentences = splitSentences(item.text);
        const observation = sentences[0] ?? item.text;
        const baseline = sentences.slice(1).join(" ").trim();
        return `${truncateSentence(observation, 170)}${baseline ? ` ${truncateSentence(baseline, 170)}` : ""} [${idx + 1}]`;
      })
      .join(" ");
    parts.push(`Current sensor context: ${sensorSummary}`);
  }

  if (literatureEvidence.length > 0) {
    const litSummary = literatureEvidence
      .map((item) => {
        const idx = evidence.indexOf(item);
        return `${extractReadableClaim(item.text, 190)} [${idx + 1}]`;
      })
      .join(" ");
    parts.push(`Literature context: ${litSummary}`);
  }

  if (forecastEvidence.length > 0) {
    const forecastSummary = forecastEvidence
      .map((item) => {
        const idx = evidence.indexOf(item);
        return `${truncateSentence(item.text, 220)} [${idx + 1}]`;
      })
      .join(" ");
    parts.push(`Forecast outlook: ${forecastSummary}`);
  }

  if (parts.length === 0) {
    return `I do not have enough retrieved evidence to answer that reliably yet.`;
  }

  return parts.join("\n\n");
}

function looksTruncated(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/LEADS fallback answer for:/.test(trimmed)) return false;

  const lastChar = trimmed.at(-1) ?? "";
  const endsCleanly = /[.!?\]")']/u.test(lastChar);
  const oddBoldMarkers = (trimmed.match(/\*\*/g) ?? []).length % 2 !== 0;
  const openParens =
    (trimmed.match(/\(/g) ?? []).length > (trimmed.match(/\)/g) ?? []).length ||
    (trimmed.match(/\[/g) ?? []).length > (trimmed.match(/\]/g) ?? []).length;
  const danglingLine = /[:;,(\-\u2014]\s*$/u.test(trimmed);

  return !endsCleanly || oddBoldMarkers || openParens || danglingLine;
}

// The evidence block's size is bounded by budgetEvidenceContext (evidence-budget.ts): an
// 8,000-char cut with LEADS_LIT_VERBATIM "off"; with "on", a 20,000-char limit met by
// trimming literature passages only, never the operational records.
function buildSynthesisPrompt(
  query: string,
  context: string,
  attempt: number,
  previousText: string,
  conversationHistory?: string,
  reflexionNote?: string
) {
  const wordBudget = attempt === 0 ? 280 : 200;
  const retryInstruction =
    attempt === 0
      ? `Respond in ≤ ${wordBudget} words. Be direct and rigorous. Cite key claims.`
      : `Previous draft was cut off: "${previousText.slice(-120)}". Rewrite from scratch in ≤ ${wordBudget} words. End with a complete sentence. Cite key claims.`;

  // Inject today's date so the LLM can correctly label data lag.
  // VERA4CAST publishes with a publication delay; sensor data from e.g. May 25
  // must not be labelled "current conditions" when today is May 29.
  // Honors the LEADS_AS_OF snapshot freeze: the pinned date when set, else the real clock.
  const todayStr = evalNowIso().slice(0, 10); // "YYYY-MM-DD"

  const historyBlock = conversationHistory ?? "";
  const reflexionBlock =
    reflexionNote
      ? `[Reflexion note from previous attempt: ${reflexionNote}]\n\n`
      : "";
  const dateBlock = `[Today's date: ${todayStr}. If the most recent sensor evidence is from an earlier date, label it as "most recent available data (YYYY-MM-DD)" rather than "current conditions".]\n\n`;

  return (
    historyBlock +
    reflexionBlock +
    dateBlock +
    `Question: ${query}\n\n` +
    "Evidence packets:\n" +
    context +
    `\n\n${retryInstruction}`
  );
}

/**
 * All synthesis routes through GPT-4.1 via getQualityClient(). Override at
 * runtime with the OPENAI_MODEL env var.
 */
const SYNTHESIS_MODEL = "gpt-4.1";

async function synthesizeWithRetries(
  query: string,
  context: string,
  conversationHistory?: string,
  reflexionNote?: string
) {
  let lastText = "";
  const client = getQualityClient();

  for (let attempt = 0; attempt < LEADS_SYNTHESIS_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.messages.create({
        model: SYNTHESIS_MODEL,
        // 2000 on the first attempt avoids a truncation-and-retry cycle that doubles cost.
        // Retry attempts use smaller limits since the rewrite is constrained.
        max_tokens: attempt === 0 ? 2000 : attempt === 1 ? 1200 : 800,
        system: LEADS_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: buildSynthesisPrompt(
              query,
              context,
              attempt,
              lastText,
              conversationHistory,
              reflexionNote
            ),
          },
        ],
      });

      recordUsage(response.usage);
      const text = extractText(response);
      if (!text) continue;

      // Use the API's own stop_reason as the primary truncation signal.
      // "end_turn": the model finished, so return the text.
      // "max_tokens": the limit was hit, so retry with a tighter word budget.
      const hitLimit = response.stop_reason === "max_tokens";
      if (!hitLimit) return text;

      lastText = text;
    } catch {
      // Continue to the next attempt with a shorter rewrite target.
    }
  }

  return "";
}

async function synthesizeReadableFallback(query: string, evidence: LeadsEvidence[]) {
  if (evidence.length === 0) return "";

  try {
    const response = await getQualityClient().messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: 450,
      system:
        "You are a freshwater science assistant. Write a short, readable answer in plain English based only on the provided evidence. Do not quote garbled PDF text verbatim. If source text is noisy, conservatively summarize its clear meaning. Use light citations only when helpful.",
      messages: [
        {
          role: "user",
          content:
            `Question: ${query}\n\n` +
            "Cleaned evidence summary:\n" +
            buildReadableEvidencePacket(evidence) +
            "\n\nWrite a concise answer in 3-5 sentences. If evidence is limited or mixed, say so plainly.",
        },
      ],
    });

    recordUsage(response.usage);
    const text = extractText(response);
    return !text || looksTruncated(text) ? "" : text;
  } catch {
    return "";
  }
}

function scoreFaithfulness(response: string): LeadsFaithfulness {
  const sentences = response
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25);
  const cited = sentences.filter((sentence) => hasCitation(sentence)).length;
  const total = sentences.length;
  return {
    cited,
    total,
    pct: total > 0 ? Math.round((cited / total) * 100) : 0,
  };
}

/**
 * Canonical bracket numbering. Returns the full fused evidence array, so every
 * `[n]` in the answer resolves to the synthesis-prompt slot it was written
 * against, with two flags per item:
 *   - bracketNum    = original 1-based slot in the synthesis prompt
 *   - citedInAnswer = whether the response text contains `[bracketNum]`
 *
 * The UI shows every cited source and numbers it for display in
 * lib/citation-display.ts (the stored bracketNum is unchanged). The verifier
 * builds a cited-union packet from the same flags (verification.ts). Evaluation
 * traces see the full packet the model was shown, which RAGAS context precision
 * requires.
 */
function toCitations(
  response: string,
  evidence: LeadsEvidence[],
  budget?: EvidenceContextBudget
): LeadsCitation[] {
  const used = new Set<number>();
  for (const bracket of bracketNumbers(response)) {
    const index = bracket - 1;
    if (index >= 0 && index < evidence.length) {
      used.add(index);
    }
  }

  // With LEADS_RAPTOR_MODE "off", dense search drops summary nodes (literature.ts), so none
  // should reach this point. Report any that do, but keep them: every [n] in the answer
  // must still resolve to the evidence slot it was written against.
  if (raptorMode() === "off") {
    const summarySlots = evidence.flatMap((item, index) =>
      item.channel === "literature" && (item.provenance.raptorLevel ?? 0) > 0 ? [index + 1] : []
    );
    if (summarySlots.length > 0) {
      console.error(
        `[citations] ${summarySlots.length} summary node(s) in evidence with LEADS_RAPTOR_MODE=off ` +
          `(slots ${summarySlots.join(", ")})`
      );
    }
  }

  const citations: LeadsCitation[] = evidence.map((item, index) => ({
    text: item.text,
    fullText: item.fullText,
    chunkIndex: item.provenance.chunkIndex ?? index,
    docName: item.provenance.docName ?? item.provenance.label,
    pageNum: item.provenance.pageNum ?? 0,
    rerankScore: item.score,
    method:
      item.channel === "sensor"
        ? "hybrid"
        : item.provenance.method?.includes("sparse")
        ? "sparse"
        : item.provenance.method?.includes("dense")
        ? "dense"
        : "hybrid",
    sourceType: item.provenance.type,
    sourceUrl: item.provenance.sourceUrl,
    timestamp: item.provenance.timestamp,
    siteId: item.provenance.siteId,
    variable: item.provenance.variable,
    depthM: item.provenance.depthM,
    bracketNum: index + 1,
    citedInAnswer: used.has(index),
  }));

  // LEADS_LIT_VERBATIM "off": the citations above, unchanged. "on" (lit-verbatim.ts): each
  // citation also keeps the text the model was shown (modelText), and a literature item
  // that carried its passage prints a quotation copied from that text, chosen against the
  // answer sentences that cite it, in place of the extracted (or rewritten) sentence. A
  // passage with no quotable sentence prints its opening text instead (verbatim: false).
  if ((budget?.mode ?? litVerbatimMode()) !== "on") return citations;
  const packet = budget ?? budgetEvidenceContext(evidence, "on");
  return citations.map((citation, index) => {
    const item = evidence[index];
    const modelText = packet.bodies[index] ?? item.text;
    if (item.channel !== "literature" || !item.verbatimText) return { ...citation, modelText };
    const quote = pickVerbatimQuote(modelText, citingSentences(response, index + 1), item.text);
    return { ...citation, text: quote ?? passageExcerpt(modelText), modelText, verbatim: quote !== null };
  });
}

/**
 * The answer with its literature markers aligned to the claim verifier's matches
 * (LEADS_CITATION_ALIGN, citation-align.ts). `evidence` is the packet the answer was
 * written against and `claims` the verifier's claims for exactly answer.response. The
 * overlap test reads the text the answer model saw for each item (the same packet bodies
 * as the synthesis prompt). When a marker changes, the citations (citedInAnswer and the
 * printed quotations) and the citation-presence score are rebuilt from the aligned text;
 * otherwise, and always with mode "off", the answer is returned as it is.
 */
export function alignAnswerCitations(
  answer: LeadsAnswer,
  evidence: LeadsEvidence[],
  claims: CitationAlignClaim[],
  mode: CitationAlignMode,
  litMode: LitVerbatimMode = litVerbatimMode()
): { answer: LeadsAnswer; changes: CitationAlignChange[] } {
  if (mode !== "on") return { answer, changes: [] };
  const budget = budgetEvidenceContext(evidence, litMode);
  const sources = evidence.map((item, index) => ({ channel: item.channel, text: budget.bodies[index] ?? item.text }));
  const aligned = alignCitations(answer.response, claims, sources, mode);
  if (aligned.changes.length === 0) return { answer, changes: [] };
  return {
    answer: {
      ...answer,
      response: aligned.text,
      citations: toCitations(aligned.text, evidence, budget),
      faithfulness: scoreFaithfulness(aligned.text),
    },
    changes: aligned.changes,
  };
}

/**
 * Returns a disclaimer string when the query asks about a variable that is
 * not in the VERA4CAST / LTREB sensor stream and no sensor evidence was found.
 */
function unsupportedVariableNote(query: string, evidence: LeadsEvidence[]): string {
  const hasSensorEvidence = evidence.some((e) => e.channel === "sensor");
  if (hasSensorEvidence) return "";
  const lower = query.toLowerCase();
  const matched = UNSUPPORTED_VARIABLE_TERMS.filter((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower)
  );
  if (matched.length === 0) return "";
  return (
    `[System note: The LEADS sensor stream (VERA4CAST / LTREB) does not monitor ` +
    `${matched.join(", ")} at these sites. No in-situ observations for ` +
    `${matched.join(", ")} are available. Answer from literature only and clearly ` +
    `state that direct sensor data for this variable is not available in this system.]`
  );
}

export async function generateGroundedAnswer(
  query: string,
  evidence: LeadsEvidence[],
  retrievalConfidence: number,
  siteHints?: string[],
  conversationHistory?: string,
  reflexionNote?: string,
  iterations: number = 0
): Promise<LeadsAnswer> {
  // When the user did not name a site, derive which site(s) the evidence came
  // from and prepend a one-line disclosure so the answer states which site it
  // used.
  let annotatedQuery = query;
  if (!siteHints || siteHints.length === 0) {
    const sitesInEvidence = [
      ...new Set(
        evidence
          .map((e) => e.provenance.siteId)
          .filter((s): s is string => Boolean(s))
          .map((s) => s.toUpperCase())
      ),
    ];
    if (sitesInEvidence.length > 0) {
      annotatedQuery =
        `[Note: No reservoir was specified in the question. Data shown is from ${sitesInEvidence.join(", ")}. If you meant a different site, please specify it.]\n\n` +
        query;
    }
  }

  // If the query mentions an unsupported variable and no sensor evidence was
  // retrieved, prepend a note so the answer discloses the gap.
  const varNote = unsupportedVariableNote(query, evidence);
  if (varNote) annotatedQuery = `${varNote}\n\n${annotatedQuery}`;

  // One packet per call: the synthesis prompt (every attempt), the citations' modelText and
  // their quotations all read the same per-item text.
  const budget = budgetEvidenceContext(evidence);
  if (budget.mode === "on") {
    (budget.overLimit ? console.warn : console.info)(describeEvidenceBudget(budget, evidence));
  }

  let text = "";
  if (!hasChatKey()) {
    text =
      `LEADS fallback answer for: ${query}\n\n` +
      formatFallbackEvidence(forReader(evidence));
  } else {
    text = await synthesizeWithRetries(annotatedQuery, budget.context, conversationHistory, reflexionNote);
    if (!text) {
      const readableFallback = await synthesizeReadableFallback(annotatedQuery, evidence);
      text = readableFallback
        ? readableFallback
        : wantsSectionedAnalysis(query)
        ? buildSectionedAnalysisFallback(query, forReader(evidence))
        : buildSimpleAnswerFallback(query, forReader(evidence));
    }
  }

  const faithfulness = scoreFaithfulness(text);
  const citations = toCitations(text, evidence, budget);
  // `citations` is the full fused packet (each item flagged citedInAnswer), so
  // its length always equals evidence.length and is not a confidence signal.
  // Synthesis-time initial confidence: G/V are seeded from the text-side
  // faithfulness heuristic (citation-presence proxy); P and Y default to 1.0.
  // The orchestrator replaces this object at the done event via
  // `refineConfidenceFromPipelineState` using the post-verifier and post-L3
  // signals (see orchestrator.ts immediately before the `done` yield).
  const proxy = faithfulness.pct / 100;
  const overall = computeCLeadsComposite(proxy, proxy, 1.0, 1.0, iterations);

  return {
    response: text,
    citations,
    faithfulness,
    confidence: {
      grounding: Number(proxy.toFixed(3)),
      verifierConfidence: Number(proxy.toFixed(3)),
      policyAdherence: 1.0,
      channelCoverage: 1.0,
      overall,
      iterations: Math.max(0, iterations),
    },
  };
}

export function generateStructuredEvidenceAnswer(
  query: string,
  evidence: LeadsEvidence[],
  requestedChannels: Array<LeadsEvidence["channel"]>,
  retrievalConfidence: number,
  iterations: number = 0
): LeadsAnswer {
  void retrievalConfidence;  // retained for caller-signature stability; not used by C_LEADS.
  const text = buildStructuredEvidenceSheet(query, forReader(evidence), requestedChannels);
  const faithfulness = scoreFaithfulness(text);
  const citations = toCitations(text, evidence);
  // Synthesis-time initial confidence: same proxy pattern as
  // generateGroundedAnswer above. The orchestrator overrides at done.
  const proxy = faithfulness.pct / 100;
  const overall = computeCLeadsComposite(proxy, proxy, 1.0, 1.0, iterations);

  return {
    response: text,
    citations,
    faithfulness,
    confidence: {
      grounding: Number(proxy.toFixed(3)),
      verifierConfidence: Number(proxy.toFixed(3)),
      policyAdherence: 1.0,
      channelCoverage: 1.0,
      overall,
      iterations: Math.max(0, iterations),
    },
  };
}

export function generateAbstentionAnswer(
  query: string,
  evidence: LeadsEvidence[],
  iterations: number = 0
): LeadsAnswer {
  const text =
    `LEADS could not verify enough support to answer "${query}" confidently.\n\n` +
    "Most relevant evidence:\n" +
    formatFallbackEvidence(forReader(evidence));

  const faithfulness = scoreFaithfulness(text);
  const citations = toCitations(text, evidence);
  // Interim values: G = V = 0, as the abstention makes no verifiable claims. As for
  // other answers, the orchestrator replaces this object at the done event
  // (refineConfidenceFromPipelineState).

  return {
    response: text,
    citations,
    faithfulness,
    confidence: {
      grounding: 0,
      verifierConfidence: 0,
      policyAdherence: 1.0,
      channelCoverage: 1.0,
      overall: computeCLeadsComposite(0, 0, 1.0, 1.0, iterations),
      iterations: Math.max(0, iterations),
    },
  };
}
