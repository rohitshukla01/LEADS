import { verifyClaims } from "@/lib/faithfulness";
import { getAuxiliaryClient } from "@/lib/openai-client";
import { recordUsage } from "./cost-tracker";

import type { LeadsChannel, LeadsEvidence } from "./types";
import { bracketNumbers } from "./citation-brackets";
import { budgetEvidenceContext } from "./evidence-budget";
import { LITERATURE_ITEM_CHAR_CAP, litVerbatimMode, type LitVerbatimMode } from "./lit-verbatim";

export interface LeadsClaimAssessment {
  text: string;
  supported: boolean;
  sourceIndex: number | null;
  confidence: number;
  channel?: LeadsChannel;
  sourceTitle?: string;
  /** Global 1-based bracket into `fused.evidence` for the supporting item
   *  (aligned with LeadsCitation.bracketNum and the `[N]` markers in the answer
   *  text). `sourceIndex` is verifier-local (0..k-1 of the cited-union slice). */
  bracketNum?: number | null;
  /** Set only by buildFallbackClaims (see LeadsClaimVerification.checkedBy). */
  checkedBy?: "word-overlap";
}

export interface LeadsVerificationSummary {
  claims: LeadsClaimAssessment[];
  supported: number;
  unsupported: number;
  pct: number;
  unresolvedClaims: string[];
  missingChannels: LeadsChannel[];
  recommendedQueries: string[];
  shouldRetry: boolean;
  reflexionNote?: string;
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildFallbackClaims(answer: string, evidence: LeadsEvidence[], sourceTexts: string[]): LeadsClaimAssessment[] {
  const sentences = answer
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30);

  return sentences.map((sentence) => {
    const normalizedSentence = normalizeToken(sentence);
    const sourceIndex = evidence.findIndex((item, index) => {
      const normalizedEvidence = normalizeToken(sourceTexts[index] ?? item.text);
      const overlap = normalizedSentence
        .split(/\s+/)
        .filter((token) => token.length > 3 && normalizedEvidence.includes(token));
      return overlap.length >= 3;
    });

    return {
      text: sentence,
      supported: sourceIndex >= 0,
      sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
      confidence: sourceIndex >= 0 ? 0.6 : 0.2,
      channel: sourceIndex >= 0 ? evidence[sourceIndex].channel : undefined,
      sourceTitle: sourceIndex >= 0 ? evidence[sourceIndex].title : undefined,
      // No model checked these: the interface and the report say "not checked".
      checkedBy: "word-overlap" as const,
    };
  });
}

/**
 * The source texts the claim verifier judges against, for the evidence items at
 * `indices` (0-based positions in the fused evidence), and the per-source char cap.
 *
 * LEADS_LIT_VERBATIM "off": item.text with verifyClaims' default cap.
 * "on": the packet body the answer model read for each item (evidence-budget.ts, the same
 * computation the synthesis prompt uses) with the literature packet cap, so a claim taken
 * from late in a passage is judged against the text that contains it instead of being
 * marked unsupported, which would trigger a retry or an abstention.
 */
export function verifierSources(
  evidence: LeadsEvidence[],
  indices: number[],
  mode: LitVerbatimMode = litVerbatimMode()
): { sources: string[]; sourceCharCap: number | undefined } {
  if (mode === "off") {
    return { sources: indices.map((i) => evidence[i].text), sourceCharCap: undefined };
  }
  const { bodies } = budgetEvidenceContext(evidence, mode);
  return {
    sources: indices.map((i) => bodies[i] ?? evidence[i].text),
    sourceCharCap: LITERATURE_ITEM_CHAR_CAP,
  };
}

function uniqueQueries(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

/**
 * Second pass on unsupported claims that state a percentage probability, chance,
 * likelihood or risk: supported if a forecast item states "N% probability" with the
 * same N (the current forecast records print member shares instead), otherwise
 * confidence 0.15.
 */
function verifyForecastClaims(
  claims: LeadsClaimAssessment[],
  evidence: LeadsEvidence[]
): LeadsClaimAssessment[] {
  const forecastEvidence = evidence.filter((e) => e.channel === "forecast");
  if (forecastEvidence.length === 0) return claims;

  // Extract numeric probability values from forecast evidence
  const forecastNumbers = new Set<number>();
  for (const e of forecastEvidence) {
    const matches = e.text.matchAll(/(?:^|[^0-9.])(\d{1,3})%\s*probability/gi);
    for (const m of matches) {
      forecastNumbers.add(parseInt(m[1], 10));
    }
  }

  return claims.map((claim) => {
    // Check if claim contains a probability assertion
    const probMatch = claim.text.match(/(?:^|[^0-9.])(\d{1,3})%\s*(probability|chance|likelihood|risk)/i);
    if (!probMatch) return claim;

    const claimedPct = parseInt(probMatch[1], 10);

    // If the claim is supported by any channel, trust it
    if (claim.supported) return claim;

    // Check if the claimed number appears in forecast evidence
    const matchesEvidence = forecastNumbers.has(claimedPct);
    if (matchesEvidence) {
      const sourceIndex = forecastEvidence.findIndex((e) =>
        new RegExp(`(^|[^0-9.])${claimedPct}%`).test(e.text)
      );
      const globalIndex = sourceIndex >= 0 ? evidence.indexOf(forecastEvidence[sourceIndex]) : null;
      return {
        ...claim,
        supported: true,
        sourceIndex: globalIndex,
        confidence: 0.8,
        channel: "forecast" as LeadsChannel,
      };
    }

    // The claim asserts a probability not found in evidence - mark unsupported
    return {
      ...claim,
      supported: false,
      confidence: 0.15,
    };
  });
}

export async function assessClaimSupport(args: {
  query: string;
  answer: string;
  evidence: LeadsEvidence[];
  requestedChannels: LeadsChannel[];
  /** Defaults to LEADS_LIT_VERBATIM; see verifierSources. */
  litVerbatim?: LitVerbatimMode;
}): Promise<LeadsVerificationSummary> {
  const { query, answer, evidence, requestedChannels } = args;

  // Items sent to the claim checker: every item the answer cites (so any cited
  // claim can resolve), then up to 5 uncited items in packet order, added only
  // while the list holds fewer than 10 items, so claims without a marker can still
  // be checked. The order is kept so the checker's local sourceIndex maps back to
  // a global bracket.
  const citedBrackets = new Set<number>();
  for (const bracket of bracketNumbers(answer)) {
    if (bracket >= 1 && bracket <= evidence.length) {
      citedBrackets.add(bracket);
    }
  }
  const VERIFIER_CAP = 10;
  const TOP_K_BY_SCORE = 5;
  // Map back-pointers from each item we include to its global bracket (1-based).
  const sliceWithBracket: Array<{ ev: LeadsEvidence; bracket: number }> = [];
  const seenGlobal = new Set<number>();
  for (const bracket of citedBrackets) {
    sliceWithBracket.push({ ev: evidence[bracket - 1], bracket });
    seenGlobal.add(bracket - 1);
  }
  for (let i = 0; i < evidence.length && sliceWithBracket.length < VERIFIER_CAP; i += 1) {
    if (seenGlobal.has(i)) continue;
    if (sliceWithBracket.length >= citedBrackets.size + TOP_K_BY_SCORE) break;
    sliceWithBracket.push({ ev: evidence[i], bracket: i + 1 });
    seenGlobal.add(i);
  }
  const topEvidence = sliceWithBracket.map((s) => s.ev);
  const localToBracket = (localIdx: number | null): number | null => {
    if (typeof localIdx !== "number" || localIdx < 0 || localIdx >= sliceWithBracket.length) return null;
    return sliceWithBracket[localIdx].bracket;
  };

  const { sources, sourceCharCap } = verifierSources(
    evidence,
    sliceWithBracket.map((s) => s.bracket - 1),
    args.litVerbatim ?? litVerbatimMode()
  );
  const raw =
    sourceCharCap === undefined
      ? await verifyClaims(answer, sources)
      : await verifyClaims(answer, sources, { sourceCharCap });

  const baseClaims =
    raw.claims.length > 0
      ? raw.claims.map((claim) => ({
          text: claim.text,
          supported: claim.supported,
          sourceIndex: claim.sourceIndex,
          confidence: claim.confidence,
          channel:
            typeof claim.sourceIndex === "number" && claim.sourceIndex >= 0
              ? topEvidence[claim.sourceIndex]?.channel
              : undefined,
          sourceTitle:
            typeof claim.sourceIndex === "number" && claim.sourceIndex >= 0
              ? topEvidence[claim.sourceIndex]?.title
              : undefined,
          bracketNum: localToBracket(claim.sourceIndex),
        }))
      : buildFallbackClaims(answer, topEvidence, sources).map((claim) => ({
          ...claim,
          bracketNum: localToBracket(claim.sourceIndex),
        }));

  const claims = verifyForecastClaims(baseClaims, topEvidence).map((claim) => ({
    ...claim,
    // verifyForecastClaims may overwrite sourceIndex via .indexOf(...) against
    // topEvidence - re-derive bracketNum so it stays consistent on the way out.
    bracketNum: localToBracket(claim.sourceIndex),
  }));

  const supported = claims.filter((claim) => claim.supported).length;
  const unsupported = claims.length - supported;
  const pct = claims.length > 0 ? Math.round((supported / claims.length) * 100) : 0;
  const unresolvedClaims = claims.filter((claim) => !claim.supported).map((claim) => claim.text);

  const presentChannels = new Set(evidence.map((item) => item.channel));
  const missingChannels = requestedChannels.filter((channel) => !presentChannels.has(channel));

  const recommendedQueries = uniqueQueries([
    ...unresolvedClaims.slice(0, 3).map((claim) => `${claim} freshwater reservoir evidence`),
    missingChannels.includes("sensor") ? `${query} latest in situ sensor observation` : "",
    missingChannels.includes("literature") ? `${query} limnology literature support` : "",
  ]);

  return {
    claims,
    supported,
    unsupported,
    pct,
    unresolvedClaims,
    missingChannels,
    recommendedQueries,
    shouldRetry: unsupported > 0 || missingChannels.length > 0,
  };
}

/**
 * Reflexion (Shinn et al., 2023): generates a verbal diagnosis of why the
 * previous synthesis attempt failed and what specific evidence would resolve
 * the gap. Uses gpt-4.1-mini (auxiliary tier) for this short text generation.
 *
 * The returned note is added to the next synthesis prompt (buildSynthesisPrompt).
 */
export async function generateReflection(
  query: string,
  unresolvedClaims: string[]
): Promise<string> {
  if (unresolvedClaims.length === 0) return "";
  const client = getAuxiliaryClient();
  try {
    const claimList = unresolvedClaims
      .slice(0, 4)
      .map((c, i) => `${i + 1}. ${c.slice(0, 200)}`)
      .join("\n");

    const response = await client.messages.create({
      model: "gpt-4.1-mini",
      max_tokens: 120,
      system:
        "You are a self-critic for a freshwater AI assistant. " +
        "Given a question and a list of claims that could not be verified against retrieved evidence, " +
        "write 1–2 sentences explaining: (a) WHY the evidence likely failed to support these claims " +
        "(e.g. wrong depth, missing channel, temporal mismatch), and (b) what specific data or aspect " +
        "the next retrieval attempt should target. Be concrete and brief. No markdown.",
      messages: [
        {
          role: "user",
          content: `Question: ${query}\n\nUnverified claims:\n${claimList}`,
        },
      ],
    });

    recordUsage(response.usage);
    const text = response.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    return text;
  } catch {
    return "";
  }
}
