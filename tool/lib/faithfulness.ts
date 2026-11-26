import { getAuxiliaryClient } from "./openai-client";
import { recordUsage } from "./leads/cost-tracker";

export interface ClaimVerification {
  text: string;
  supported: boolean;
  sourceIndex: number | null;
  confidence: number;
}

export interface FaithfulnessResult {
  claims: ClaimVerification[];
}

function extractText(response: { content: Array<{ type: string; text?: string }> }) {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/** Characters of each source passage shown to the verifier when the caller passes no
 *  sourceCharCap. */
export const DEFAULT_SOURCE_CHAR_CAP = 500;

export interface VerifyClaimsOptions {
  /** Characters of each source passage shown to the verifier. The LEADS path passes the
   *  literature packet cap when the answer model read whole passages
   *  (lib/leads/verification.ts), so a claim drawn from late in a passage can be found. */
  sourceCharCap?: number;
}

/** The "Sources:" block of the verifier prompt. Each passage is cut to `sourceCharCap`
 *  chars (DEFAULT_SOURCE_CHAR_CAP when absent or not a positive number). */
export function formatVerifierSources(sources: string[], sourceCharCap?: number): string {
  const cap =
    typeof sourceCharCap === "number" && Number.isFinite(sourceCharCap) && sourceCharCap > 0
      ? Math.floor(sourceCharCap)
      : DEFAULT_SOURCE_CHAR_CAP;
  return `Sources:\n${sources.map((s, i) => `[${i}] ${s.slice(0, cap)}`).join("\n\n---\n\n")}`;
}

export async function verifyClaims(
  answer: string,
  sources: string[],
  options: VerifyClaimsOptions = {}
): Promise<FaithfulnessResult> {
  if (!answer || sources.length === 0) {
    return { claims: [] };
  }

  try {
    const response = await getAuxiliaryClient().messages.create(
      {
        model: "gpt-4.1-mini",
        max_tokens: 1500,
        system: [
          {
            type: "text",
            text: `You are a faithfulness verifier. Given an answer and source passages:
1. Decompose the answer into atomic factual claims (skip opinions, hedging, meta-statements).
2. For each claim, check if ANY source passage supports it.
3. Return ONLY valid JSON array:
[{"text": "claim text", "supported": true/false, "sourceIndex": 0-based index or null, "confidence": 0.0-1.0}]`,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Answer:\n${answer.slice(0, 3000)}`,
              },
              {
                type: "text",
                text: formatVerifierSources(sources, options.sourceCharCap),
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      },
    );

    recordUsage(response.usage);
    const raw = extractText(response);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return { claims: [] };

    const parsed = JSON.parse(match[0]) as ClaimVerification[];
    if (!Array.isArray(parsed)) return { claims: [] };

    return {
      claims: parsed.map((c) => ({
        text: typeof c.text === "string" ? c.text : "",
        supported: c.supported === true,
        sourceIndex: typeof c.sourceIndex === "number" ? c.sourceIndex : null,
        confidence: typeof c.confidence === "number" ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
      })),
    };
  } catch (err) {
    // Log the failure: empty claims fall through to the word-overlap
    // fallback in verification.ts.
    console.error(
      "[faithfulness.verifyClaims] verifier call failed, returning empty claims:",
      err instanceof Error ? err.message : err,
    );
    return { claims: [] };
  }
}
