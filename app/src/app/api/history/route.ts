// Price/trade history for AMM pools. Serves ONLY real data: points recorded
// by the seeding script (each a live read of on-chain reserves) plus lazy
// live samples this route takes itself when the newest stored point is older
// than SAMPLE_MS — so charts keep moving while anyone is watching, from
// nothing but genuine ledger reads. Trades carry real tx signatures.
//
// GET /api/history?pools=<pda>,<pda>...

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { readHistory, recordPricePoint, recordBatch } from "@/lib/priceHistory";
import { getAmmPoolsForMarkets } from "@/lib/onchain";
import { spotPriceScaled } from "@/lib/ammMath";

const SAMPLE_MS = 15_000;
// pool pda -> market pda mapping isn't invertible from the pool alone, so
// callers pass MARKET pdas; we derive pools server-side (same as the lobby).
export async function GET(req: NextRequest) {
  const marketsParam = req.nextUrl.searchParams.get("markets");
  if (!marketsParam) return NextResponse.json({ ok: false, error: "markets param required" }, { status: 400 });
  const markets = marketsParam.split(",").slice(0, 60);
  try {
    for (const m of markets) new PublicKey(m);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid market pda" }, { status: 400 });
  }

  const store = readHistory();
  const summaries = await getAmmPoolsForMarkets(markets);

  const out: Record<string, { pool: string; points: { t: number; priceA: number }[]; trades: unknown[] }> = {};
  const now = Date.now();
  for (const m of markets) {
    const s = summaries.get(m);
    if (!s) continue;
    const hist = store.pools[s.pool] ?? { points: [], trades: [] };
    const newest = hist.points[hist.points.length - 1];
    // lazily append a REAL live sample if stale (and the pool has custody)
    if ((!newest || now - newest.t > SAMPLE_MS) && s.reserveA + s.reserveB > 0n) {
      const point = { t: now, priceA: Number(spotPriceScaled(s.reserveA, s.reserveB)), fees: s.feesAccrued.toString() };
      recordPricePoint(s.pool, point);
      hist.points = [...hist.points, point];
    }
    out[m] = {
      pool: s.pool,
      points: hist.points.map((p) => ({ t: p.t, priceA: p.priceA })),
      trades: hist.trades.slice(-40).reverse(),
    };
  }
  return NextResponse.json({ ok: true, sampledAt: now, series: out });
}

/**
 * Record a swap the browser just executed, so the user's OWN trade shows in
 * the Recent-trades feed immediately (previously only the seeding script
 * wrote records — a live user saw stale "3h ago" rows and couldn't tell
 * their buy landed). The price point is sampled server-side from the real
 * pool (never trusted from the client); the sig is shape-validated and
 * link-verifiable on the explorer.
 * POST /api/history  { market, side, dir, amountIn, sig }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const market = new PublicKey(String(body.market)).toBase58();
    const side = Number(body.side);
    const dir = Number(body.dir);
    const amountIn = String(body.amountIn);
    const sig = String(body.sig);
    if (![1, 2].includes(side) || ![0, 1].includes(dir)) throw new Error("bad side/dir");
    if (!/^\d{1,20}$/.test(amountIn)) throw new Error("bad amountIn");
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new Error("bad sig");

    const summaries = await getAmmPoolsForMarkets([market]);
    const s = summaries.get(market);
    if (!s) return NextResponse.json({ ok: false, error: "no pool for market" }, { status: 404 });
    const point = { t: Date.now(), priceA: Number(spotPriceScaled(s.reserveA, s.reserveB)), fees: s.feesAccrued.toString() };
    recordBatch(s.pool, [point], [{ t: Date.now(), side, dir, amountIn, sig }]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
