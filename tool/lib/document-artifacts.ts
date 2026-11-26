import { deleteByDocId } from "@/lib/qdrant";
import { deleteByDocIdV2 } from "@/lib/qdrant-v2";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export interface IndexedDocument {
  id: string;
  name: string;
  pages: number | null;
  chunk_count: number | null;
  char_count: number | null;
  created_at: string | null;
}

async function deleteBm25Keys(prefix: string, docId: string) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;

  try {
    let cursor = "0";
    const keys: string[] = [];
    do {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["SCAN", cursor, "MATCH", `${prefix}:${docId}:*`, "COUNT", "500"]),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { result: [string, string[]] };
      cursor = payload.result?.[0] ?? "0";
      keys.push(...(payload.result?.[1] ?? []));
    } while (cursor !== "0" && keys.length < 5000);

    if (keys.length > 0) {
      await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(keys.map((key) => ["DEL", key])),
      });
    }
  } catch {
    // best effort only
  }
}

export async function deleteDocumentArtifacts(docId: string) {
  await Promise.all([
    deleteByDocId(docId),
    deleteByDocIdV2(docId).catch(() => {}),
    deleteBm25Keys("bm25", docId),
    deleteBm25Keys("bm25v2", docId),
  ]);

  await getSupabaseAdmin()
    .from("documents")
    .delete()
    .eq("id", docId);
}

export async function listIndexedDocuments(): Promise<IndexedDocument[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("documents")
      .select("id, name, pages, chunk_count, char_count, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return (data ?? []) as IndexedDocument[];
  } catch (error) {
    throw new Error(
      `Supabase documents lookup failed. Verify NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and network/DNS reachability. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
