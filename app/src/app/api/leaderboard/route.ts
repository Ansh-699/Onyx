// Trader leaderboard from real on-chain AmmPosition accounts — dual scan
// (ONYX-owned + ER-delegated on base), each hit PDA-verified, aggregated
// per owner. No P&L column on purpose: per-trade cost basis isn't stored
// on-chain, so ranking is by capital deployed + withdrawn — figures that
// ARE on-chain. Includes the disclosed seeded market-making wallets.
//
// GET /api/leaderboard

import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getConnection, decodeAmmPosition, ammPositionPda } from "@/lib/onchain";

const ONYX_PROGRAM_ID = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const CACHE_MS = 5 * 60_000;
let cached: { at: number; body: object } | null = null;

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return NextResponse.json(cached.body);
  try {
    const connection = getConnection();
    const disc = { memcmp: { offset: 0, bytes: Buffer.from([7]).toString("base64"), encoding: "base64" as const } };
    const [own, delegated] = await Promise.all([
      connection.getProgramAccounts(ONYX_PROGRAM_ID, { filters: [disc] }),
      connection.getProgramAccounts(DELEGATION_PROGRAM_ID, { filters: [disc] }).catch(() => []),
    ]);

    const byOwner = new Map<string, { markets: Set<string>; deployed: bigint; withdrawn: bigint }>();
    for (const { pubkey, account } of [...own, ...delegated]) {
      const p = decodeAmmPosition(pubkey, account.data as Buffer);
      if (!p) continue;
      // unforgeability: re-derive the PDA from the stored (market, owner)
      if (!ammPositionPda(new PublicKey(p.market), new PublicKey(p.owner)).equals(pubkey)) continue;
      const e = byOwner.get(p.owner) ?? { markets: new Set<string>(), deployed: 0n, withdrawn: 0n };
      e.markets.add(p.market);
      e.deployed += p.usdcAvailable + p.tokensA + p.tokensB;
      e.withdrawn += p.withdrawn;
      byOwner.set(p.owner, e);
    }

    const rows = [...byOwner.entries()]
      .map(([owner, e]) => ({
        owner,
        markets: e.markets.size,
        deployed: e.deployed.toString(),
        withdrawn: e.withdrawn.toString(),
      }))
      .sort((a, b) => Number(BigInt(b.deployed) + BigInt(b.withdrawn)) - Number(BigInt(a.deployed) + BigInt(a.withdrawn)))
      .slice(0, 50);

    const body = { ok: true, rows, at: Date.now() };
    cached = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
