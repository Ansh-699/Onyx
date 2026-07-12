// Protocol-wide totals for the lobby/landing stats strip — every number is
// an aggregate of live on-chain scans, nothing stored, nothing synthetic:
//   volume        = sealed matched volume (Market.total_side_a+b) +
//                   AMM volume derived from on-chain fees (fees*1e4/fee_bps)
//   openInterest  = tUSDC currently custodied in AMM pools (reserves are
//                   claims on real vault balances) — conservative, excludes
//                   sealed escrow
//   traders       = unique AmmPosition owners (incl. ER-delegated)
//   settled       = markets with status Settled/Claimed
// Includes disclosed seeded market-making (see README no-bluff table).
//
// GET /api/stats

import { NextResponse } from "next/server";
import {
  listMarkets,
  getAmmPoolsForMarkets,
  getAmmPositionCounts,
  volumeFromFees,
  STATUS_SETTLED,
  STATUS_CLAIMED,
} from "@/lib/onchain";

const CACHE_MS = 5 * 60_000;
let cached: { at: number; body: object } | null = null;

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json(cached.body);
  try {
    const markets = await listMarkets();
    const pdas = markets.map((m) => m.pda);
    const [pools, positions] = await Promise.all([getAmmPoolsForMarkets(pdas), getAmmPositionCounts(pdas)]);

    let volume = 0n;
    let openInterest = 0n;
    let settled = 0;
    for (const m of markets) {
      volume += m.totalSideA + m.totalSideB; // sealed matched volume
      if (m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED) settled++;
    }
    for (const p of pools.values()) {
      volume += volumeFromFees(p.feesAccrued, p.feeBps);
      openInterest += p.reserveA < p.reserveB ? p.reserveA : p.reserveB; // paired custody (min side, conservative)
    }

    const body = {
      ok: true,
      volume: volume.toString(),
      openInterest: openInterest.toString(),
      traders: positions.uniqueTraders,
      settled,
      markets: markets.length,
      at: Date.now(),
    };
    cached = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
