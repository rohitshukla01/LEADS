/**
 * Optional relay for the literature search.
 *
 * When LEADS_RELAY_URL is set, the three outside calls of the literature search go to that address
 * instead of to OpenAI, Qdrant and Cohere, and the keys of those services stay on the relay:
 *   POST {relay}/embed   { input }                              -> { embedding: number[] }
 *   POST {relay}/search  { vector, limit, contextual, docId }   -> { hits: [{ id, score, payload }] }
 *   POST {relay}/rerank  { query, documents, topN }             -> { results: [{ index, relevanceScore }] }
 * Unset, nothing here is used.
 */

const RELAY_TIMEOUT_MS = 20000;

export function relayUrl(): string | null {
  const url = process.env.LEADS_RELAY_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

export async function postToRelay<T>(job: "embed" | "search" | "rerank", body: unknown): Promise<T> {
  const response = await fetch(`${relayUrl()}/${job}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Relay ${job} error ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}
