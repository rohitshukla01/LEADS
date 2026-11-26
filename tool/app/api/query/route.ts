import { NextRequest } from "next/server";

import { runLeadsOrchestrator } from "@/lib/leads/orchestrator";
import type { LeadsProfile } from "@/lib/leads/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { query, docId, sessionId, leadsProfile } = (await req.json()) as {
    query?: string;
    docId?: string;
    sessionId?: string;
    leadsProfile?: LeadsProfile;
  };

  if (!query) {
    return new Response(
      JSON.stringify({ error: "query is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
        );
      };

      try {
        for await (const event of runLeadsOrchestrator(query, {
          docId: docId ?? null,
          profile: "hybrid",
          sessionId: sessionId ?? "",
          ...(leadsProfile ? { leadsProfile } : {}),
        })) {
          send(event);
        }
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Pipeline error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
