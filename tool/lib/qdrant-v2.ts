import { QdrantClient } from "@qdrant/js-client-rest";

let _client: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY!,
    });
  }
  return _client;
}

export const COLLECTION_V2 = "leads_docs_v2";

export interface ChunkPayloadV2 {
  doc_id: string;
  doc_name: string;
  chunk_index: number;
  page_num: number;
  text: string;           // retrieval text: context_prefix + "\n\n" + raw_text, or raw_text when there is no prefix
  raw_text: string;       // original chunk text (used for citations)
  context_prefix: string; // context sentence for the chunk ("" as written by lib/ingest-core.ts)
  char_count: number;
  [key: string]: unknown;
}

export interface SearchResultV2 {
  id: string;
  score: number;
  payload: ChunkPayloadV2;
}

export async function ensureCollectionV2(): Promise<void> {
  const client = getClient();
  try {
    await client.getCollection(COLLECTION_V2);
    // Collection exists - ensure payload index exists (idempotent)
    try {
      await client.createPayloadIndex(COLLECTION_V2, {
        field_name: "doc_id",
        field_schema: "keyword",
      });
    } catch (_) { /* already exists */ }
  } catch {
    // Collection doesn't exist - create it with index
    await client.createCollection(COLLECTION_V2, {
      vectors: {
        size: 1024,
        distance: "Cosine",
        hnsw_config: { m: 16, ef_construct: 100 },
      },
      optimizers_config: { default_segment_number: 2 },
      replication_factor: 1,
    });
    await client.createPayloadIndex(COLLECTION_V2, {
      field_name: "doc_id",
      field_schema: "keyword",
    });
  }
}

export async function searchV2(
  vector: number[],
  topK = 15,
  filter?: { doc_id: string }
): Promise<SearchResultV2[]> {
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
  const results = await client.search(COLLECTION_V2, params);
  return results.map((r) => ({
    id: String(r.id),
    score: r.score,
    payload: r.payload as unknown as ChunkPayloadV2,
  }));
}

export async function upsertV2(
  points: Array<{ id: string; vector: number[]; payload: ChunkPayloadV2 }>
): Promise<void> {
  await getClient().upsert(COLLECTION_V2, {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload,
    })),
  });
}

export async function deleteByDocIdV2(docId: string): Promise<void> {
  await getClient().delete(COLLECTION_V2, {
    wait: true,
    filter: {
      must: [{ key: "doc_id", match: { value: docId } }],
    },
  });
}

/** Returns true if this docId has been indexed in leads_docs_v2 */
export async function hasV2Index(docId: string): Promise<boolean> {
  try {
    const client = getClient();
    // Ensure collection + payload index exist
    await ensureCollectionV2();
    const result = await client.count(COLLECTION_V2, {
      filter: { must: [{ key: "doc_id", match: { value: docId } }] },
      exact: false,
    });
    return (result.count ?? 0) > 0;
  } catch {
    return false;
  }
}
