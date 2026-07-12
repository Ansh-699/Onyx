// Browser-facing SSE relay of TxLINE's live score stream. The browser opens
// EventSource("/api/scores/stream"); this route subscribes it to the single
// server-side upstream connection (lib/scoreStream.ts) — credentials never
// reach the client, and updates arrive push-fashion the moment TxLINE
// publishes instead of on the next poll tick.

import { NextRequest } from "next/server";
import { subscribeScoreStream, streamConfigured } from "@/lib/scoreStream";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!streamConfigured()) {
    return new Response("TxLINE stream not configured", { status: 503 });
  }
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      send("retry: 3000\n\n");
      const unsub = subscribeScoreStream((ev) => send(`${ev}\n\n`));
      // keep intermediaries from closing an idle stream (no live match = quiet)
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      cleanup = () => {
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
