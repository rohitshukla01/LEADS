import { QdrantClient } from "@qdrant/js-client-rest";

let _qdrant: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!_qdrant) {
    _qdrant = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY!,
    });
  }
  return _qdrant;
}

const COLLECTION = process.env.QDRANT_COLLECTION ?? "leads_docs";

export interface ChunkPayload {
  doc_id: string;
  doc_name: string;
  chunk_index: number;
  page_num: number;
  text: string;
  retrieval_text?: string;
  display_text?: string;
  context_prefix?: string;
  char_count: number;
  // Always empty; not read by the tool (written so all indexes share one payload shape)
  auto_questions?: string[];
  auto_keywords?: string[];
  // Always empty; not read by the tool (written so all indexes share one payload shape)
  parent_text?: string;
  parent_index?: number;
  // Always "text" as written by lib/ingest-core.ts; not read by the tool
  chunk_type?: "text" | "table";
  // RAPTOR hierarchical summaries
  raptor_level?: number; // 0 = chunk, 1-3 = RAPTOR summary level (lib/raptor.ts)
  [key: string]: unknown;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: ChunkPayload;
}

// Dense ANN search
export async function search(
  vector: number[],
  topK = 15,
  filter?: { doc_id: string }
): Promise<SearchResult[]> {
  const client = getClient();
  const params: Parameters<typeof client.search>[1] = {
    vector,
    limit: topK,
    with_payload: true,
  };

  if (filter) {
    params.filter = {
      must: [{ key: "doc_id", match: { value: filter.doc_id } }],
    };
  }

  const results = await client.search(COLLECTION, params);
  return results.map((r) => ({
    id: String(r.id),
    score: r.score,
    payload: r.payload as unknown as ChunkPayload,
  }));
}

// Upsert chunk vectors with payloads
export async function upsert(
  points: Array<{ id: string; vector: number[]; payload: ChunkPayload }>
): Promise<void> {
  await getClient().upsert(COLLECTION, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

// Delete all vectors for a document
export async function deleteByDocId(docId: string): Promise<void> {
  await getClient().delete(COLLECTION, {
    wait: true,
    filter: {
      must: [{ key: "doc_id", match: { value: docId } }],
    },
  });
}

// Update payload fields on existing points (merge, not replace)
export async function setPayload(
  pointIds: string[],
  payload: Partial<ChunkPayload>
): Promise<void> {
  await getClient().setPayload(COLLECTION, {
    wait: true,
    points: pointIds,
    payload,
  });
}

export { COLLECTION };
