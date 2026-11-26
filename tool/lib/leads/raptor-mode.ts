// Summary nodes in the literature lane (switch LEADS_RAPTOR_MODE, default "off").
//
// What is in the index
// The Qdrant collection holds two kinds of points: verbatim chunks of each paper
// (payload raptor_level 0) and per-paper summary nodes written by an LLM at ingest
// (lib/raptor.ts, raptor_level 1-3). Summary nodes carry page_num 0 and no link back to
// the chunks they summarise, so once retrieved they read as text from the paper itself.
// The keyword (BM25) lane never held summary nodes; only dense search can return them.
//
// Modes
//   "off"    (default: LEADS_RAPTOR_MODE unset, empty or unrecognised) - summary nodes are
//            dropped from dense literature search, so only verbatim text can be retrieved,
//            shown to the model, cited or printed.
//   "legacy" - dense search returns summary nodes and verbatim chunks from one pool. The
//            paper's benchmark runs used this mode.
//
// How "off" filters
// On the client. The collection runs in strict mode with a payload index on doc_id only,
// and Qdrant rejects a filter on raptor_level with HTTP 400, so no request ever carries
// one. Dense search instead asks for RAPTOR_OVERFETCH_K hits and keeps the first
// DENSE_LITERATURE_TOP_K whose raptor_level is 0 (missing counts as 0), in Qdrant's order.
// If fewer verbatim hits are in the over-fetched set, fewer are returned; nothing is
// re-queried.

export type RaptorMode = "off" | "legacy";

/** Hits per query the dense literature lane keeps (the same in both modes). */
export const DENSE_LITERATURE_TOP_K = 8;

/** Hits per query requested from Qdrant in "off" mode, before summary nodes are dropped. */
export const RAPTOR_OVERFETCH_K = 16;

/** Read at call time so an eval harness can set it after import. */
export function raptorMode(): RaptorMode {
  const raw = (process.env.LEADS_RAPTOR_MODE ?? "").trim().toLowerCase();
  return raw === "legacy" ? "legacy" : "off";
}

/** True for a verbatim chunk: raptor_level 0, or no raptor_level in the payload. */
export function isVerbatimHit(hit: { payload?: unknown }): boolean {
  const payload = hit.payload as { raptor_level?: unknown } | null | undefined;
  return (payload?.raptor_level ?? 0) === 0;
}

/** Number of hits to request from Qdrant for one dense literature query. */
export function denseSearchLimit(mode: RaptorMode): number {
  return mode === "off" ? RAPTOR_OVERFETCH_K : DENSE_LITERATURE_TOP_K;
}

/**
 * Applies the mode to the hits Qdrant returned for one query. "legacy" passes them
 * through untouched; "off" keeps the first DENSE_LITERATURE_TOP_K verbatim hits in
 * their original order.
 */
export function selectDenseHits<T extends { payload?: unknown }>(
  hits: T[],
  mode: RaptorMode
): T[] {
  if (mode === "legacy") return hits;
  return hits.filter(isVerbatimHit).slice(0, DENSE_LITERATURE_TOP_K);
}
