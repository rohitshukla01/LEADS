/**
 * Embeddings + Reranker
 *
 * Embeddings: OpenAI text-embedding-3-small (1024-dim to match Qdrant collection)
 * Reranker:   Cohere rerank-english-v3.0
 *
 * When LEADS_RELAY_URL is set, the question embedding and the reranking are requested from that
 * relay, which holds the two keys (see relay.ts).
 */

import { CohereClient } from "cohere-ai";

import { postToRelay, relayUrl } from "./relay";

// Constants

const EMBED_BATCH_SIZE = 64; // OpenAI supports up to 2048 per call
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIMENSIONS = 1024; // match existing Qdrant collection
const RATE_LIMIT_BACKOFF_MS = [5000, 15000, 30000];

// OpenAI embeddings

function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is required for embeddings");
  return key;
}

function getOpenAIBaseUrl() {
  return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
}

async function embedWithOpenAI(texts: string[]): Promise<number[][]> {
  const response = await fetch(`${getOpenAIBaseUrl()}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getOpenAIKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
      dimensions: EMBED_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI embeddings error ${response.status}: ${text.slice(0, 300)}`
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index: number }>;
  };

  const items = payload.data ?? [];
  if (items.length !== texts.length) {
    throw new Error(
      `OpenAI embeddings returned ${items.length} vectors for ${texts.length} inputs`
    );
  }

  // Sort by index to guarantee order
  items.sort((a, b) => a.index - b.index);
  return items.map((item) => item.embedding ?? []);
}

// Cohere reranker

let _cohere: CohereClient | null = null;

function getCohereClient() {
  const token = process.env.COHERE_API_KEY || process.env.CO_API_KEY;
  if (!token) {
    throw new Error("COHERE_API_KEY is required for reranking");
  }
  if (!_cohere) {
    _cohere = new CohereClient({ token });
  }
  return _cohere;
}

function isRateLimitError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const message =
    "message" in error ? String(error.message ?? "") : String(error);
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : null;
  return statusCode === 429 || /429|TooManyRequests|rate limit/i.test(message);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withCohereRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        !isRateLimitError(error) ||
        attempt === RATE_LIMIT_BACKOFF_MS.length
      ) {
        throw error;
      }
      const backoffMs = RATE_LIMIT_BACKOFF_MS[attempt];
      console.warn(`[cohere] rate limited, retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Public API

/** Embed document texts (batched, 1024-dim) */
export async function embed(texts: string[]): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
    allEmbeddings.push(...(await embedWithOpenAI(batch)));
  }
  return allEmbeddings;
}

/** Embed a single query (same model, same dimensions) */
export async function embedQuery(query: string): Promise<number[]> {
  if (relayUrl()) {
    return (await postToRelay<{ embedding: number[] }>("embed", { input: query })).embedding;
  }
  const result = await embedWithOpenAI([query]);
  return result[0];
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/** Rerank using Cohere rerank-english-v3.0 */
export async function rerank(
  query: string,
  documents: string[],
  topN = 5
): Promise<RerankResult[]> {
  if (relayUrl()) {
    return (await postToRelay<{ results: RerankResult[] }>("rerank", { query, documents, topN })).results;
  }
  const response = await withCohereRetry(() =>
    getCohereClient().rerank({
      query,
      documents,
      model: "rerank-english-v3.0",
      topN,
    })
  );
  return response.results.map((r) => ({
    index: r.index,
    relevanceScore: r.relevanceScore,
  }));
}
