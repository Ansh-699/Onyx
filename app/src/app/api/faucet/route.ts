// Server-only devnet test-USDC faucet. A brand new wallet has no ATA and no
// balance for ONYX's test-USDC mint, and submit_sealed_order does a raw SPL
// Transfer from the user's ATA with no ATA-creation fallback (see
// programs/onyx/src/instructions/submit_sealed_order.rs) -- so the very
// first bet from any fresh wallet fails with "invalid account data for
// instruction" (Token program: the ATA doesn't exist). This mirrors the
// exact create-ATA-if-missing + mint-if-low pattern already used for the
// house counterparty in api/house-counter/route.ts, just for the real
// connected user instead. Never exposed on mainnet logic -- this only works
// because our devnet test-USDC mint's authority is our own dev keypair.

import { NextRequest, NextResponse } from "next/server";
import { loadServerKeypair } from "@/lib/serverKeypair";
import { Connection } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { getConfigUsdcMint } from "@/lib/onchain";
import { apiError, clientIp, pubkey, rateLimited, readJson, tooManyRequests } from "@/lib/apiGuard";

const MIN_BALANCE = 50_000_000n; // 50.000000 test-USDC (6dp)
const TOP_UP = 100_000_000n; // mint up to 100.000000 when below MIN_BALANCE

// Per-wallet mint cooldown. Devnet toy token, but this route holds the mint
// authority — without a throttle anyone can loop it into unbounded supply.
// In-memory is fine for a single dev-server process.
// ponytail: in-memory map, move to KV if this ever runs multi-instance.
const COOLDOWN_MS = 10 * 60_000;
const lastMintAt = new Map<string, number>();

// Per-IP cap, checked before anything touches the chain. The per-wallet
// cooldown below only guards the mint; ATA creation (authority-paid rent)
// happens first, so a loop over fresh pubkeys would otherwise drain the
// authority's SOL.
const IP_MAX = 30;
const IP_WINDOW_MS = 10 * 60_000;

function getRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
}

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`faucet:${clientIp(req)}`, IP_MAX, IP_WINDOW_MS)) return tooManyRequests();
    const body = await readJson(req);
    const user = pubkey(body.user, "user");

    const connection = new Connection(getRpcUrl(), "confirmed");
    const authority = loadServerKeypair();
    const usdcMint = await getConfigUsdcMint();
    if (!usdcMint) return NextResponse.json({ ok: false, error: "config not initialized" }, { status: 400 });

    // Creates the ATA if missing (authority pays rent); a no-op if it already exists.
    const userAta = await getOrCreateAssociatedTokenAccount(connection, authority, usdcMint, user);

    const acct = await getAccount(connection, userAta.address);
    let minted = 0n;
    const last = lastMintAt.get(user.toBase58()) ?? 0;
    if (acct.amount < MIN_BALANCE && Date.now() - last >= COOLDOWN_MS) {
      minted = TOP_UP;
      await mintTo(connection, authority, usdcMint, userAta.address, authority, minted);
      if (lastMintAt.size > 5_000) for (const [k, t] of lastMintAt) if (Date.now() - t >= COOLDOWN_MS) lastMintAt.delete(k);
      lastMintAt.set(user.toBase58(), Date.now());
    }

    return NextResponse.json({
      ok: true,
      ata: userAta.address.toBase58(),
      balanceBefore: acct.amount.toString(),
      minted: minted.toString(),
    });
  } catch (err) {
    return apiError(err);
  }
}
