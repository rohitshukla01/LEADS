import { NextResponse } from "next/server";
import { QdrantClient } from "@qdrant/js-client-rest";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Force request-time execution so this probe touches the services on every
// call, never served from a prerendered or cached static response.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/health: lightweight keep-alive probe.
//
// Pings Supabase and Qdrant with read-only, metadata-only calls so free-tier
// services do not pause from inactivity. It never calls a language model,
// embedding or reranking service, so it uses no model tokens. It is fail-soft: a service being down never
// throws; the endpoint still returns 200 with per-service status, so a
// scheduled ping still reaches whichever services are up.
export async function GET() {
  const startedAt = Date.now();

  // Supabase: a count only; no rows are returned.
  let supabaseOk = false;
  try {
    const { error } = await getSupabaseAdmin()
      .from("documents")
      .select("id", { count: "exact", head: true });
    supabaseOk = !error;
  } catch {
    supabaseOk = false;
  }

  // Qdrant: list the collections (no vector search).
  let qdrantOk = false;
  try {
    const client = new QdrantClient({
      url: process.env.QDRANT_URL!,
      apiKey: process.env.QDRANT_API_KEY!,
    });
    await client.getCollections();
    qdrantOk = true;
  } catch {
    qdrantOk = false;
  }

  return NextResponse.json({
    ok: supabaseOk && qdrantOk,
    services: { supabase: supabaseOk, qdrant: qdrantOk },
    note: "keep-alive probe — no LLM calls, $0 token cost",
    tookMs: Date.now() - startedAt,
    ts: new Date().toISOString(),
  });
}
