// Shared guards for the app's API routes. The routes that sign with the server
// key (faucet, house-counter*, buy-usdc) and the ones that write state
// (history) are public, so they need a throttle, input checks that answer 400
// instead of 500, and error bodies that don't echo internals.

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

/** Caller's mistake: reported as a 400 with this message. */
export class BadInput extends Error {}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw new BadInput("invalid JSON body");
  return body as Record<string, unknown>;
}

export function pubkey(v: unknown, name: string): PublicKey {
  try {
    return new PublicKey(String(v));
  } catch {
    throw new BadInput(`invalid ${name}`);
  }
}

/** A base-10 integer in 1..=max, as bigint. */
export function positiveBigint(v: unknown, name: string, max: bigint): bigint {
  const s = String(v);
  if (!/^\d{1,30}$/.test(s)) throw new BadInput(`invalid ${name}`);
  const n = BigInt(s);
  if (n < 1n || n > max) throw new BadInput(`${name} out of range`);
  return n;
}

/** 400 for BadInput, otherwise log and answer a generic 500. */
export function apiError(err: unknown): NextResponse {
  if (err instanceof BadInput) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
  console.error(err);
  return NextResponse.json({ ok: false, error: "internal error" }, { status: 500 });
}

export const tooManyRequests = () => NextResponse.json({ ok: false, error: "too many requests" }, { status: 429 });

// ponytail: in-memory fixed window, per process. Fine for the single `next
// start` instance this runs as; use a shared store if it ever scales out.
const hits = new Map<string, { n: number; reset: number }>();

/** True when `key` has used up `max` calls in the current `windowMs` window. */
export function rateLimited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  if (hits.size > 5_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  const h = hits.get(key);
  if (!h || h.reset <= now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  return ++h.n > max;
}

/** Caller IP as the proxy in front reports it (Cloudflare, then nginx). Spoofable if the app is exposed without one. */
export function clientIp(req: NextRequest): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
