import { embedQuery, rerank } from "@/lib/cohere";
import { getAuxiliaryClient, hasChatKey } from "@/lib/openai-client";
import { cleanPDFText } from "@/lib/pdf";
import { search, type SearchResult } from "@/lib/qdrant";
import { searchV2, type SearchResultV2 } from "@/lib/qdrant-v2";
import { postToRelay, relayUrl } from "@/lib/relay";

import { SITE_ALIASES } from "./config";
import { mentionsTerm, mentionsVariable } from "./alias-match";
import { recordUsage } from "./cost-tracker";
import { attachVerbatimPassages, litVerbatimMode, type LitVerbatimMode } from "./lit-verbatim";
import { denseSearchLimit, raptorMode, selectDenseHits, type RaptorMode } from "./raptor-mode";
import type { LeadsEvidence, LeadsQueryPlan } from "./types";

interface SparseHit {
  text: string;
  displayText: string;
  chunkIndex: number;
  docName: string;
  pageNum: number;
  key: string;
}

function extractText(response: { content: Array<{ type: string; text?: string }> }) {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function normalizeLiteratureText(text: string) {
  return cleanPDFText(text.replace(/\u0000/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function tokenOverlapScore(query: string, text: string) {
  const queryTerms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 2);
  const lower = text.toLowerCase();
  return queryTerms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function looksLowSignal(text: string) {
  const normalized = normalizeLiteratureText(text);
  if (normalized.length < 80) return true;
  if (/^posted on \d{1,2} /i.test(normalized)) return true;
  if (/this is a preprint and has not been peer-reviewed/i.test(normalized)) return true;
  if (/^(references|bibliography)\b/i.test(normalized)) return true;
  if (/^\d+\s+[A-Z][a-z]+,/.test(normalized)) return true;

  const longRuns = normalized.match(/[A-Za-z]{22,}/g) ?? [];
  if (longRuns.length >= 3) return true;

  const citationDensity = (normalized.match(/\b\d{4}\b/g) ?? []).length;
  if (citationDensity >= 8 && normalized.length < 900) return true;

  return false;
}

function extractBestClaim(query: string, text: string) {
  const normalized = normalizeLiteratureText(text);
  const sentences = splitSentences(normalized);
  if (sentences.length === 0) return normalized;

  const ranked = sentences
    .map((sentence) => ({ sentence, score: tokenOverlapScore(query, sentence) }))
    .sort((left, right) => right.score - left.score || right.sentence.length - left.sentence.length);

  const best = ranked.find((item) => item.score > 0 && item.sentence.length >= 60) ?? ranked.find((item) => item.sentence.length >= 60);
  return (best?.sentence ?? normalized).slice(0, 500).trim();
}

function toLiteratureText(query: string, text: string) {
  const cleaned = extractBestClaim(query, text);
  if (looksLowSignal(cleaned)) return null;
  return cleaned;
}

/**
 * Concept-boosted reranking.
 *
 * After Cohere reranking, chunks whose text mentions the queried variable(s) or
 * site(s) receive a score boost, so topic-specific chunks rank above broadly
 * relevant but off-concept ones: +0.15 for a variable match and +0.10 for a site
 * match, capped at +0.25.
 */
function applyConceptBoost(
  evidence: LeadsEvidence[],
  variableHints: string[],
  siteHints: string[]
): LeadsEvidence[] {
  if (variableHints.length === 0 && siteHints.length === 0) return evidence;

  // Variable matching goes through alias-match.ts (whole-word short aliases, "do"
  // only as the DO abbreviation), so words such as "random" or "document" do not
  // earn a DO boost.
  const conceptVariables = variableHints;

  // Build site terms from SITE_ALIASES
  const siteTerms = new Set<string>();
  for (const siteHint of siteHints) {
    const aliases = SITE_ALIASES[siteHint.toLowerCase()] ?? [siteHint.toLowerCase()];
    for (const alias of aliases) siteTerms.add(alias.toLowerCase());
  }

  return evidence
    .map((item) => {
      const lower = item.text.toLowerCase();
      let boost = 0;

      // +0.15 if any queried variable is mentioned in the text
      if (conceptVariables.some((v) => mentionsVariable(item.text, v))) boost += 0.15;

      // +0.10 if the site is explicitly mentioned in the text
      for (const term of siteTerms) {
        if (mentionsTerm(lower, term)) {
          boost += 0.10;
          break;
        }
      }

      if (boost === 0) return item;
      return {
        ...item,
        score: Math.min(item.score + boost, item.score + 0.25),
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function distillLiteratureEvidence(query: string, evidence: LeadsEvidence[]) {
  if (evidence.length === 0) return evidence;
  if (!hasChatKey()) {
    return evidence;
  }
  // Skip expensive distillation when fewer than 2 items - not worth a full LLM call.
  if (evidence.length < 2) return evidence;

  try {
    // 3 items max; truncate each to 240 chars to bound input token cost.
    const prompt = evidence
      .slice(0, 3)
      .map((item, index) =>
        `[${index + 1}] ${item.provenance.docName ?? item.title}\n${item.text.slice(0, 240)}`
      )
      .join("\n\n---\n\n");

    const response = await getAuxiliaryClient().messages.create({
      model: "gpt-4.1-mini",
      max_tokens: 500,
      system:
        'You clean retrieved scientific evidence for a freshwater decision-support system. Return ONLY valid JSON array like [{"index":1,"claim":"..."},{"index":2,"claim":"..."}]. Each claim must be 1 readable sentence, faithful to the source, stripped of PDF/OCR artifacts. No new facts.',
      messages: [
        {
          role: "user",
          content:
            `Question: ${query}\n\nRetrieved evidence:\n${prompt}\n\n` +
            "Rewrite each item as one sentence relevant to the question.",
        },
      ],
    });

    recordUsage(response.usage);
    const raw = extractText(response);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return evidence;
    const parsed = JSON.parse(match[0]) as Array<{ index?: number; claim?: string }>;
    const byIndex = new Map(
      parsed
        .filter((item) => typeof item.index === "number" && typeof item.claim === "string")
        .map((item) => [Number(item.index) - 1, item.claim!.trim()])
    );

    return evidence.map((item, index) => {
      const claim = byIndex.get(index);
      if (!claim || looksLowSignal(claim)) return item;
      return {
        ...item,
        text: claim,
      };
    });
  } catch {
    return evidence;
  }
}

function bm25Score(
  query: string,
  chunks: Array<{ text: string; displayText: string; chunkIndex: number; docName: string; pageNum: number; key: string }>,
  topK: number
): SparseHit[] {
  if (chunks.length === 0) return [];
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
  if (terms.length === 0) return chunks.slice(0, topK);

  const k1 = 1.5;
  const b = 0.75;
  const avgLen =
    chunks.reduce((sum, chunk) => sum + chunk.text.split(/\s+/).length, 0) / Math.max(chunks.length, 1);

  const idf = new Map<string, number>();
  for (const term of terms) {
    const df = chunks.filter((chunk) => chunk.text.toLowerCase().includes(term)).length;
    idf.set(term, Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5)));
  }

  return chunks
    .map((chunk) => {
      const words = chunk.text.toLowerCase().split(/\s+/);
      const len = words.length;
      let score = 0;
      for (const term of terms) {
        const tf = words.filter((word) => word.includes(term)).length;
        if (tf === 0) continue;
        score += ((idf.get(term) ?? 0) * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * len) / Math.max(avgLen, 1)));
      }
      return { score, chunk };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map(({ chunk }) => chunk);
}

// BM25 corpus cache. The corpus is small, so every bm25/bm25v2 chunk is loaded into
// memory once and BM25 scores the full set. The cache lives for the process with a
// short TTL, which bounds staleness after a re-ingest.
type Bm25Chunk = SparseHit;
const BM25_CACHE_TTL_MS = 10 * 60 * 1000;
const bm25CorpusCache = new Map<string, { at: number; chunks: Bm25Chunk[] }>();

async function loadBm25Corpus(prefix: "bm25" | "bm25v2"): Promise<Bm25Chunk[]> {
  const cached = bm25CorpusCache.get(prefix);
  if (cached && Date.now() - cached.at < BM25_CACHE_TTL_MS) return cached.chunks;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return [];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    // 1) SCAN every key for this prefix (no cap).
    const keys: string[] = [];
    let cursor = "0";
    do {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(["SCAN", cursor, "MATCH", `${prefix}:*`, "COUNT", "1000"]),
      });
      if (!res.ok) return [];
      const payload = (await res.json()) as { result: [string, string[]] };
      cursor = payload.result[0];
      keys.push(...(payload.result[1] ?? []));
    } while (cursor !== "0");
    if (keys.length === 0) return [];

    // 2) HGETALL all keys in batches (pipeline endpoint) to bound payload size.
    const chunks: Bm25Chunk[] = [];
    const BATCH = 512;
    for (let i = 0; i < keys.length; i += BATCH) {
      const batchKeys = keys.slice(i, i + BATCH);
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify(batchKeys.map((key) => ["HGETALL", key])),
      });
      if (!res.ok) return [];
      const payload = (await res.json()) as Array<{ result: string[] }>;
      payload.forEach((entry, index) => {
        const fields = entry.result ?? [];
        const mapped: Record<string, string> = {};
        for (let f = 0; f < fields.length; f += 2) mapped[fields[f]] = fields[f + 1];
        if ((mapped.text ?? "").length === 0) return;
        chunks.push({
          text: mapped.text ?? "",
          displayText: mapped.display_text ?? mapped.raw_text ?? mapped.text ?? "",
          chunkIndex: Number(mapped.chunk_index ?? 0),
          docName: mapped.doc_name ?? "",
          pageNum: Number(mapped.page_num ?? 0),
          key: batchKeys[index],
        });
      });
    }

    bm25CorpusCache.set(prefix, { at: Date.now(), chunks });
    return chunks;
  } catch {
    return [];
  }
}

async function sparseSearch(query: string, docId?: string | null, contextual = false): Promise<SparseHit[]> {
  const prefix = contextual ? "bm25v2" : "bm25";
  let corpus = await loadBm25Corpus(prefix);
  if (corpus.length === 0) return [];
  // key format is `${prefix}:${docId}:${chunkIndex}` - filter to a single doc when requested.
  if (docId) corpus = corpus.filter((chunk) => chunk.key.split(":")[1] === docId);
  return bm25Score(query, corpus, 8);
}

/**
 * Dense search for one literature query vector, with the summary-node mode applied
 * (raptor-mode.ts). "legacy" requests DENSE_LITERATURE_TOP_K hits and returns them as
 * Qdrant ranked them; "off" over-fetches and keeps the first DENSE_LITERATURE_TOP_K
 * verbatim chunks. The only filter ever sent is doc_id. Never throws: a failed call is
 * logged and yields [], so the sparse lane can still answer.
 */
export async function denseLiteratureSearch(
  vector: number[],
  options?: { docId?: string | null; profile?: "hybrid" | "contextual" },
  mode: RaptorMode = raptorMode()
): Promise<Array<SearchResult | SearchResultV2>> {
  const filter = options?.docId ? { doc_id: options.docId } : undefined;
  const limit = denseSearchLimit(mode);
  try {
    const contextual = options?.profile === "contextual";
    const hits = relayUrl()
      ? (
          await postToRelay<{ hits: Array<SearchResult | SearchResultV2> }>("search", {
            vector,
            limit,
            contextual,
            docId: options?.docId ?? null,
          })
        ).hits
      : contextual
      ? await searchV2(vector, limit, filter)
      : await search(vector, limit, filter);
    return selectDenseHits<SearchResult | SearchResultV2>(hits, mode);
  } catch (error) {
    console.error(
      "[literature] dense search failed",
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

/**
 * True when the literature search can run: through a relay (LEADS_RELAY_URL) or with a reranker
 * key. Where it cannot (the Docker version without a relay), the orchestrator leaves literature
 * out of the plan.
 */
export function literatureSearchConfigured(): boolean {
  if (relayUrl()) return true;
  return Boolean(process.env.COHERE_API_KEY || process.env.CO_API_KEY);
}

export async function retrieveLiteratureEvidence(
  plan: LeadsQueryPlan,
  options?: {
    docId?: string | null;
    profile?: "hybrid" | "contextual";
    raptorMode?: RaptorMode;
    litVerbatim?: LitVerbatimMode;
  }
): Promise<LeadsEvidence[]> {
  if (!literatureSearchConfigured()) {
    return [];
  }

  const profile = options?.profile ?? "hybrid";
  const mode = options?.raptorMode ?? raptorMode();
  const verbatimMode = options?.litVerbatim ?? litVerbatimMode();
  const queries = Array.from(new Set([plan.originalQuery, ...plan.literatureQueries, ...plan.subQueries])).slice(0, 7);
  const denseEvidence: LeadsEvidence[] = [];
  const sparseEvidence: LeadsEvidence[] = [];

  for (const [queryIndex, query] of queries.entries()) {
    let vector: number[];
    try {
      vector = await embedQuery(query);
    } catch (error) {
      console.error(
        "[literature] question embedding failed",
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    const denseHits = await denseLiteratureSearch(vector, { docId: options?.docId, profile }, mode);

    const sparseHits = await sparseSearch(query, options?.docId, profile === "contextual");

    denseEvidence.push(
      ...denseHits.flatMap((hit, index) => {
        const payload = hit.payload as {
          text: string;
          display_text?: string;
          raw_text?: string;
          chunk_index: number;
          doc_name: string;
          page_num?: number;
          raptor_level?: number;
        };

        const rawChunk = payload.display_text ?? payload.raw_text ?? payload.text;
        const literatureText = toLiteratureText(query, rawChunk);
        if (!literatureText) return [];
        const raptorLevel = payload.raptor_level ?? 0;

        return [{
          id: `lit:dense:${queryIndex}:${hit.id}`,
          channel: "literature" as const,
          title: payload.doc_name,
          text: literatureText,
          fullText: rawChunk,
          score: Math.max(0.25, hit.score - index * 0.02 - queryIndex * 0.01),
          provenance: {
            type: "literature" as const,
            label: payload.doc_name,
            docName: payload.doc_name,
            pageNum: payload.page_num ?? 0,
            chunkIndex: payload.chunk_index,
            score: hit.score,
            method:
              profile === "contextual"
                ? `dense-contextual:q${queryIndex + 1}`
                : `dense-hybrid:q${queryIndex + 1}`,
            ...(raptorLevel > 0 ? { raptorLevel } : {}),
          },
        }];
      })
    );

    sparseEvidence.push(
      ...sparseHits.flatMap((hit, index) => {
        const literatureText = toLiteratureText(query, hit.displayText);
        if (!literatureText) return [];

        return [{
        id: `lit:sparse:${queryIndex}:${hit.key}`,
        channel: "literature" as const,
        title: hit.docName,
        text: literatureText,
        fullText: hit.displayText,
        score: Math.max(0.2, 0.8 - index * 0.04 - queryIndex * 0.01),
        provenance: {
          type: "literature" as const,
          label: hit.docName,
          docName: hit.docName,
          pageNum: hit.pageNum,
          chunkIndex: hit.chunkIndex,
          score: Math.max(0.2, 0.8 - index * 0.04),
          method:
            profile === "contextual"
              ? `sparse-contextual:q${queryIndex + 1}`
              : `sparse-hybrid:q${queryIndex + 1}`,
        },
      }];
      })
    );
  }

  const merged = [...denseEvidence, ...sparseEvidence];
  const unique = Array.from(new Map(merged.map((item) => [`${item.provenance.docName}:${item.provenance.chunkIndex}`, item])).values());

  if (unique.length === 0) return [];

  try {
    const reranked = await rerank(plan.originalQuery, unique.map((item) => item.text), 6);
    const rerankScored = reranked.map((ranked) => ({
      ...unique[ranked.index],
      score: ranked.relevanceScore,
      provenance: {
        ...unique[ranked.index].provenance,
        score: ranked.relevanceScore,
        method: "cohere-rerank",
      },
    }));
    // Concept boost: elevate chunks that match the queried variable/site concepts
    const selected = applyConceptBoost(rerankScored, plan.variableHints, plan.siteHints);
    const head = await distillLiteratureEvidence(plan.originalQuery, selected.slice(0, 4));
    // The verbatim passage is attached last (lit-verbatim.ts): rerank, the concept boost,
    // distillation and fusion all work on `text`, so the set and its order do not move.
    return attachVerbatimPassages([...head, ...selected.slice(4)], verbatimMode);
  } catch {
    const fallback = applyConceptBoost(unique.slice(0, 6), plan.variableHints, plan.siteHints);
    const head = await distillLiteratureEvidence(plan.originalQuery, fallback.slice(0, 4));
    return attachVerbatimPassages([...head, ...fallback.slice(4)], verbatimMode);
  }
}
