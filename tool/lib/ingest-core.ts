import { createHash, randomUUID } from "crypto";

import {
  chunkText,
} from "@/lib/chunker";
import { embed } from "@/lib/cohere";
import { parseDocumentArtifact, type PdfEngine } from "@/lib/document-parser";
import { buildRaptorTree } from "@/lib/raptor";
import { upsert, setPayload, type ChunkPayload } from "@/lib/qdrant";
import { ensureCollectionV2, upsertV2, type ChunkPayloadV2 } from "@/lib/qdrant-v2";
import { scrubPII, scrubPIIFast } from "@/lib/pii";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
type EnrichMode = "async" | "await" | "skip";

export interface IngestMetadataTags {
  ingestSource?: "upload" | "corpus";
  corpusVersion?: string;
  corpusRelativePath?: string;
  corpusSha256?: string;
}

export interface ParsedDocument {
  text: string;
  pages: number;
  kind: "pdf" | "txt" | "tika";
  extension: string;
  parser?: string;
  artifactPath?: string;
}

interface PrimaryArtifacts {
  docId: string;
  fileName: string;
  buffer: Buffer;
  parsed: ParsedDocument;
  rawChunks: string[];
  scrubbedAll: string[];
  points: Array<{ id: string; vector: number[]; payload: ChunkPayload }>;
  pointIds: string[];
}

export interface PrimaryIngestResult {
  docId: string;
  name: string;
  pages: number;
  chunkCount: number;
  charCount: number;
  tableCount: number;
  raptorEnabled: boolean;
  enrichingInBackground: boolean;
  phase1Ms: number;
  /** True when the file matched an already-ingested document by content
   *  hash (`corpus_sha256`); no re-embedding or re-upsert happened. */
  deduplicated?: boolean;
  /** sha256 of the raw file buffer; persisted on the documents row so
   *  later ingests of the same bytes (any filename) hit the dedup path. */
  contentSha256?: string;
}

export interface ContextualIngestResult {
  docId: string;
  name: string;
  pages: number;
  chunkCount: number;
  charCount: number;
  v2: true;
}

export async function parseDocumentBuffer(
  buffer: Buffer,
  fileName: string,
  mimeType?: string,
  options?: { fastPdf?: boolean; pdfEngine?: PdfEngine }
): Promise<ParsedDocument> {
  const parsed = await parseDocumentArtifact(buffer, fileName, mimeType, options);
  return {
    text: parsed.text,
    pages: parsed.pages,
    kind: parsed.kind,
    extension: parsed.extension,
    parser: parsed.parser,
    artifactPath: parsed.artifactPath,
  };
}

async function indexBm25(
  prefix: "bm25" | "bm25v2",
  retrievalChunks: string[],
  displayChunks: string[],
  docId: string,
  docName: string,
  metadata?: IngestMetadataTags
) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  const pipeline = retrievalChunks.map((text, i) => {
    const base = [
      "HSET",
      `${prefix}:${docId}:${i}`,
      "doc_id", docId,
      "doc_name", docName,
      "chunk_index", String(i),
      "text", text,
      "ingest_source", metadata?.ingestSource ?? "upload",
      "corpus_version", metadata?.corpusVersion ?? "",
      "corpus_relative_path", metadata?.corpusRelativePath ?? "",
      "corpus_sha256", metadata?.corpusSha256 ?? "",
    ];

    if (prefix === "bm25") {
      return [...base, "display_text", displayChunks[i] ?? text];
    }

    return [...base, "raw_text", displayChunks[i] ?? text];
  });

  await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(pipeline),
  });
}

async function upsertDocumentMetadata(
  docId: string,
  name: string,
  pages: number,
  chunkCount: number,
  charCount: number,
  qdrantIds: string[],
  metadata?: IngestMetadataTags
) {
  const baseRecord = {
    id: docId,
    name,
    pages,
    chunk_count: chunkCount,
    char_count: charCount,
    qdrant_ids: qdrantIds,
  };

  const extendedRecord = {
    ...baseRecord,
    ingest_source: metadata?.ingestSource ?? "upload",
    corpus_version: metadata?.corpusVersion ?? null,
    corpus_relative_path: metadata?.corpusRelativePath ?? null,
    corpus_sha256: metadata?.corpusSha256 ?? null,
  };

  let error;
  try {
    ({ error } = await getSupabaseAdmin().from("documents").upsert(extendedRecord));
  } catch (cause) {
    throw new Error(
      `Supabase metadata upsert failed for ${name}. Verify Supabase reachability and credentials. ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }

  if (error && /column|schema cache/i.test(error.message)) {
    try {
      ({ error } = await getSupabaseAdmin().from("documents").upsert(baseRecord));
    } catch (cause) {
      throw new Error(
        `Supabase metadata fallback upsert failed for ${name}. Verify Supabase reachability and credentials. ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }

  if (error) {
    throw new Error(error.message);
  }
}

async function runBackgroundEnrichment(artifacts: PrimaryArtifacts) {
  const { docId, fileName, rawChunks, scrubbedAll, points, pointIds } = artifacts;
  const totalChunks = rawChunks.length;
  const metadata = artifacts.points[0]?.payload ?? {};

  const llmScrubbed = await scrubPII(rawChunks);
  for (let i = 0; i < pointIds.length; i += 1) {
    if (llmScrubbed[i] !== scrubbedAll[i]) {
      await setPayload([pointIds[i]], {
        text: llmScrubbed[i],
        retrieval_text: llmScrubbed[i],
        display_text: llmScrubbed[i],
      });
    }
  }
  await indexBm25("bm25", llmScrubbed, llmScrubbed, docId, fileName, {
    ingestSource: typeof metadata.ingest_source === "string" ? (metadata.ingest_source as "upload" | "corpus") : "upload",
    corpusVersion: typeof metadata.corpus_version === "string" ? metadata.corpus_version : undefined,
    corpusRelativePath: typeof metadata.corpus_relative_path === "string" ? metadata.corpus_relative_path : undefined,
    corpusSha256: typeof metadata.corpus_sha256 === "string" ? metadata.corpus_sha256 : undefined,
  });

  if (totalChunks >= 5) {
    try {
      const raptorNodes = await buildRaptorTree(llmScrubbed, points.map((point) => point.vector));
      if (raptorNodes.length > 0) {
        const raptorPoints = raptorNodes.map((node, i) => ({
          id: randomUUID(),
          vector: node.embedding,
          payload: {
            doc_id: docId,
            doc_name: fileName,
            chunk_index: totalChunks + 100 + i,
            page_num: 0,
            text: node.text,
            retrieval_text: node.text,
            display_text: node.text,
            context_prefix: `RAPTOR Level ${node.level} Summary`,
            char_count: node.text.length,
            auto_questions: [] as string[],
            auto_keywords: [] as string[],
            parent_text: "",
            parent_index: -1,
            chunk_type: "text" as const,
            raptor_level: node.level,
          } satisfies ChunkPayload,
        }));
        await upsert(raptorPoints);
      }
    } catch (error) {
      console.warn("[ingest] RAPTOR enrichment failed:", error);
    }
  }
}

export async function ingestPrimaryDocument(params: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  docId?: string;
  enrichMode?: EnrichMode;
  metadata?: IngestMetadataTags;
  /** Skip the content-hash dedup check and ingest anyway. Use only when the
   *  caller explicitly wants to re-process the same file (e.g. forced re-index). */
  force?: boolean;
  /** PDF parser engine. Defaults to the fast path (pdf-parse-first).
   *  The curated-corpus batch ingest passes "docling-first" for structure-aware chunks. */
  pdfEngine?: PdfEngine;
}): Promise<PrimaryIngestResult> {
  const t0 = Date.now();

  // Dedup by content hash: the same bytes are the same document, whatever the filename.
  const contentSha256 = createHash("sha256").update(params.buffer).digest("hex");
  if (!params.force) {
    const existing = await findExistingByContentHash(contentSha256);
    if (existing) {
      return {
        docId: existing.id,
        name: existing.name,
        pages: existing.pages ?? 0,
        chunkCount: existing.chunk_count ?? 0,
        charCount: existing.char_count ?? 0,
        tableCount: 0,
        raptorEnabled: (existing.chunk_count ?? 0) >= 5,
        enrichingInBackground: false,
        phase1Ms: Date.now() - t0,
        deduplicated: true,
        contentSha256,
      };
    }
  }

  // Stamp the hash into metadata so it lands on the documents row + payload.
  params.metadata = { ...params.metadata, corpusSha256: params.metadata?.corpusSha256 ?? contentSha256 };

  const parsed = await parseDocumentBuffer(params.buffer, params.fileName, params.mimeType, {
    fastPdf: true,
    pdfEngine: params.pdfEngine,
  });

  const rawChunks = chunkText(parsed.text);
  const scrubbedAll = scrubPIIFast(rawChunks);
  const vectors = await embed(scrubbedAll);

  const docId = params.docId ?? randomUUID();
  const totalChunks = rawChunks.length;

  const points = scrubbedAll.map((chunkText, i) => ({
    id: randomUUID(),
    vector: vectors[i],
    payload: {
      doc_id: docId,
      doc_name: params.fileName,
      chunk_index: i,
      page_num: Math.floor((i / Math.max(rawChunks.length, 1)) * parsed.pages) + 1,
      text: chunkText,
      retrieval_text: chunkText,
      display_text: chunkText,
      context_prefix: "",
      char_count: rawChunks[i]?.length ?? chunkText.length,
      auto_questions: [] as string[],
      auto_keywords: [] as string[],
      parent_text: "",
      parent_index: -1,
      chunk_type: "text" as const,
      raptor_level: 0,
      ingest_source: params.metadata?.ingestSource ?? "upload",
      corpus_version: params.metadata?.corpusVersion ?? "",
      corpus_relative_path: params.metadata?.corpusRelativePath ?? "",
      corpus_sha256: params.metadata?.corpusSha256 ?? "",
    } satisfies ChunkPayload,
  }));

  await upsert(points);
  await indexBm25("bm25", scrubbedAll, scrubbedAll, docId, params.fileName, params.metadata);
  await upsertDocumentMetadata(
    docId,
    params.fileName,
    parsed.pages,
    totalChunks,
    parsed.text.length,
    points.map((point) => point.id),
    params.metadata
  );

  const artifacts: PrimaryArtifacts = {
    docId,
    fileName: params.fileName,
    buffer: params.buffer,
    parsed,
    rawChunks,
    scrubbedAll,
    points,
    pointIds: points.map((point) => point.id),
  };

  const enrichMode = params.enrichMode ?? "skip";
  if (enrichMode === "await") {
    await runBackgroundEnrichment(artifacts);
  } else if (enrichMode === "async") {
    void runBackgroundEnrichment(artifacts).catch((error) => {
      console.error("[ingest] background enrichment error:", error);
    });
  }

  return {
    docId,
    name: params.fileName,
    pages: parsed.pages,
    chunkCount: totalChunks,
    charCount: parsed.text.length,
    tableCount: 0,
    raptorEnabled: totalChunks >= 5,
    enrichingInBackground: enrichMode === "async",
    phase1Ms: Date.now() - t0,
    deduplicated: false,
    contentSha256,
  };
}

/**
 * Look up an already-ingested document by its content-hash. Returns null when
 * the row doesn't exist or when the `corpus_sha256` column is missing from
 * the deployed Supabase schema (treated as "dedup disabled, proceed with ingest").
 */
async function findExistingByContentHash(sha256: string): Promise<{
  id: string; name: string; pages: number | null; chunk_count: number | null; char_count: number | null;
} | null> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("documents")
      .select("id, name, pages, chunk_count, char_count")
      .eq("corpus_sha256", sha256)
      .limit(1)
      .maybeSingle();
    if (error) {
      if (/column|schema cache/i.test(error.message)) return null;
      throw new Error(error.message);
    }
    return data ?? null;
  } catch (cause) {
    console.warn("[ingest] dedup lookup failed (proceeding without dedup):", cause instanceof Error ? cause.message : cause);
    return null;
  }
}

/**
 * Index a document into the contextual collection (`leads_docs_v2`) and the `bm25v2:*`
 * keys. Chunks are stored without a context prefix: `text` equals `raw_text` and
 * `context_prefix` is empty.
 */
export async function ingestContextualV2Document(params: {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  docId: string;
  metadata?: IngestMetadataTags;
  /** PDF parser engine. Defaults to the fast path; the corpus batch passes "docling-first". */
  pdfEngine?: PdfEngine;
}): Promise<ContextualIngestResult> {
  const parsed = await parseDocumentBuffer(params.buffer, params.fileName, params.mimeType, {
    pdfEngine: params.pdfEngine,
  });
  await ensureCollectionV2();

  const rawChunks = chunkText(parsed.text);
  const vectors = await embed(rawChunks);

  const points = rawChunks.map((rawChunk, i) => ({
    id: randomUUID(),
    vector: vectors[i],
    payload: {
      doc_id: params.docId,
      doc_name: params.fileName,
      chunk_index: i,
      page_num: Math.floor((i / Math.max(rawChunks.length, 1)) * parsed.pages) + 1,
      text: rawChunk,
      raw_text: rawChunk,
      context_prefix: "",
      char_count: rawChunk.length,
      ingest_source: params.metadata?.ingestSource ?? "upload",
      corpus_version: params.metadata?.corpusVersion ?? "",
      corpus_relative_path: params.metadata?.corpusRelativePath ?? "",
      corpus_sha256: params.metadata?.corpusSha256 ?? "",
    } satisfies ChunkPayloadV2,
  }));

  await upsertV2(points);
  await indexBm25("bm25v2", rawChunks, rawChunks, params.docId, params.fileName, params.metadata);

  return {
    docId: params.docId,
    name: params.fileName,
    pages: parsed.pages,
    chunkCount: rawChunks.length,
    charCount: parsed.text.length,
    v2: true,
  };
}
