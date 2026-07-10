// Thin proxy so the browser never sees TXLINE_JWT / TXLINE_API_TOKEN --
// same discipline as /api/scores and /api/odds. Given a market PDA, reads
// its ON-CHAIN terms (fixtureId/statAKey/statBKey) live, then fetches a
// live TxLINE settlement proof for exactly that market's own predicate --
// general, not hardcoded to the one bundled demo fixture.
//
// GET /api/settlement-proof/<marketPda> -> { ok: true, fixture } | { ok: false, reason }

import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getMarket } from "@/lib/onchain";
import { getLiveSettlementProof } from "@/lib/txlineSettlementProof";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ market: string }> }) {
  const { market: marketStr } = await params;
  let marketPk: PublicKey;
  try {
    marketPk = new PublicKey(marketStr);
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid market address" }, { status: 400 });
  }

  const market = await getMarket(marketPk.toBase58());
  if (!market) {
    return NextResponse.json({ ok: false, reason: "market not found on-chain" }, { status: 404 });
  }

  const result = await getLiveSettlementProof({
    fixtureId: Number(market.fixtureId),
    statAKey: market.statAKey,
    statBKey: market.statBKey,
  });

  if (!result.ok) return NextResponse.json(result, { status: 200 });
  return NextResponse.json(result);
}
