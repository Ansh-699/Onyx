import { NextResponse } from "next/server";
import { listMarkets, getAmmPoolsForMarkets } from "@/lib/onchain";

// One RPC scan shared by every visitor. listMarkets is two getProgramAccounts
// scans (~3s on public devnet RPC) — previously every browser paid that on
// every lobby visit and every 20s poll. This route runs it once, caches 8s,
// and serves stale-while-revalidate so a warm hit is always instant.
// bigints travel as {$bigint: "..."} — revived in lib/hooks.ts.
export const dynamic = "force-dynamic";

const TTL_MS = 8_000;
let cached: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;

const jsonBigint = (_k: string, v: unknown) => (typeof v === "bigint" ? { $bigint: v.toString() } : v);

async function build(): Promise<string> {
  const markets = await listMarkets();
  const pools = await getAmmPoolsForMarkets(markets.map((m) => m.pda));
  return JSON.stringify({ markets, pools: [...pools.values()] }, jsonBigint);
}

export async function GET() {
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    inflight ??= build()
      .then((body) => {
        cached = { at: Date.now(), body };
        return body;
      })
      .finally(() => {
        inflight = null;
      });
    if (!cached) {
      // nothing to serve stale — first hit (or every hit after a failure) waits
      try {
        await inflight;
      } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 502 });
      }
    }
  }
  return new NextResponse(cached!.body, { headers: { "content-type": "application/json" } });
}
