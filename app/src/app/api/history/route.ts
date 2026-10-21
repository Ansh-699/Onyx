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
import { getAmmPoolsForMarkets, getConnection } from "@/lib/onchain";
import { getDelegationStatus, getErConnection } from "@/lib/erRouting";
import { spotPriceScaled } from "@/lib/ammMath";
import { BadInput, apiError, clientIp, pubkey, rateLimited, readJson, tooManyRequests } from "@/lib/apiGuard";

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
    if (rateLimited(`history:${clientIp(req)}`, 60, 60_000)) return tooManyRequests();
    const body = await readJson(req);
    const market = pubkey(body.market, "market").toBase58();
    const side = Number(body.side);
    const dir = Number(body.dir);
    const amountIn = String(body.amountIn);
    const sig = String(body.sig);
    if (![1, 2].includes(side) || ![0, 1].includes(dir)) throw new BadInput("bad side/dir");
    if (!/^\d{1,20}$/.test(amountIn)) throw new BadInput("bad amountIn");
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new BadInput("bad sig");

    const summaries = await getAmmPoolsForMarkets([market]);
    const s = summaries.get(market);
    if (!s) return NextResponse.json({ ok: false, error: "no pool for market" }, { status: 404 });

    // The feed promises real signatures, so don't take the caller's word: the
    // tx must exist and have succeeded on whichever ledger holds the market.
    // ponytail: doesn't check the tx touched THIS pool or that side/dir/amountIn
    // match it; that needs a getTransaction decode per record.
    const st = await getDelegationStatus(new PublicKey(market));
    const ledger = st.isDelegated && st.fqdn ? getErConnection(st.fqdn) : getConnection();
    const { value } = await ledger.getSignatureStatuses([sig], { searchTransactionHistory: true });
    if (!value[0] || value[0].err) {
      return NextResponse.json({ ok: false, error: "signature not found or failed" }, { status: 422 });
    }
    // idempotent: the same sig is never listed twice
    if (readHistory().pools[s.pool]?.trades.some((t) => t.sig === sig)) return NextResponse.json({ ok: true });

    const point = { t: Date.now(), priceA: Number(spotPriceScaled(s.reserveA, s.reserveB)), fees: s.feesAccrued.toString() };
    recordBatch(s.pool, [point], [{ t: Date.now(), side, dir, amountIn, sig }]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
