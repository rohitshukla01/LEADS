import { NextResponse } from "next/server";
import { listIndexedDocuments } from "@/lib/document-artifacts";

// Resolve `p`, or fall back to `fallback` after `ms` - so a hung dependency
// (e.g. a stalled Supabase call) can never freeze the request.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// GET /api/documents - list all indexed documents (the page needs at least one to accept a question).
// Fails soft: the document list comes from Supabase, which is not on the query
// path. If it's slow/unreachable the list degrades to empty, never hangs or 500s the page.
export async function GET() {
  try {
    const documents = await withTimeout(listIndexedDocuments(), 12_000, []);
    return NextResponse.json({ documents });
  } catch (err) {
    return NextResponse.json({
      documents: [],
      warning: err instanceof Error ? err.message : "documents unavailable",
    });
  }
}
