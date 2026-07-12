// Server-only bridge to TxLINE's live score stream (GET /scores/stream, SSE).
// One upstream connection (lazy-started when the first browser subscribes,
// closed when the last leaves, auto-reconnect with backoff) fans out to every
// connected browser via /api/scores/stream — credentials never leave the
// server, and score updates reach the UI the moment TxLINE publishes them
// instead of waiting out a poll interval.
//
// Events are treated as a SIGNAL first, data second: any event naming a
// fixtureId invalidates that fixture's server-side score cache, so the
// client's follow-up snapshot fetch returns fresh TxLINE data even if the
// stream payload shape shifts. The raw event is forwarded too.

import { invalidateScoreCache } from "./txlineScores";

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = process.env.TXLINE_API_BASE_URL ?? `${API_ORIGIN}/api`;
const JWT = process.env.TXLINE_JWT;
const API_TOKEN = process.env.TXLINE_API_TOKEN;

type Subscriber = (event: string) => void;

const subscribers = new Set<Subscriber>();
let upstreamAbort: AbortController | null = null;
let backoffMs = 1_000;

async function runUpstream(): Promise<void> {
  const abort = new AbortController();
  upstreamAbort = abort;
  while (subscribers.size > 0 && !abort.signal.aborted) {
    try {
      if (!JWT || !API_TOKEN) return;
      const res = await fetch(`${API_BASE_URL}/scores/stream`, {
        headers: { Authorization: `Bearer ${JWT}`, "X-Api-Token": API_TOKEN, Accept: "text/event-stream" },
        signal: abort.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      backoffMs = 1_000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop()!;
        for (const ev of events) {
          if (!ev.trim() || ev.startsWith(":")) continue; // keep-alive comment
          // signal: fresh data exists for this fixture — drop the stale cache
          for (const m of ev.matchAll(/"fixtureId"\s*:\s*(\d+)/g)) {
            invalidateScoreCache(Number(m[1]));
          }
          for (const fn of subscribers) fn(ev);
        }
      }
    } catch {
      // fall through to backoff/reconnect
    }
    if (subscribers.size === 0 || abort.signal.aborted) break;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }
  if (upstreamAbort === abort) upstreamAbort = null;
}

/** Subscribe to live TxLINE score events. Returns an unsubscribe fn. */
export function subscribeScoreStream(fn: Subscriber): () => void {
  subscribers.add(fn);
  if (!upstreamAbort) void runUpstream();
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && upstreamAbort) {
      upstreamAbort.abort();
      upstreamAbort = null;
    }
  };
}

export const streamConfigured = (): boolean => !!JWT && !!API_TOKEN;
