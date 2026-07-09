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
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { getConfigUsdcMint } from "@/lib/onchain";

const MIN_BALANCE = 50_000_000n; // 50.000000 test-USDC (6dp)
const TOP_UP = 100_000_000n; // mint up to 100.000000 when below MIN_BALANCE

function loadMintAuthority(): Keypair {
  const path = process.env.ANCHOR_WALLET;
  if (!path) throw new Error("ANCHOR_WALLET not set (server env) — see app/.env.local");
  const secret = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const user = new PublicKey(String(body.user));

    const connection = new Connection(getRpcUrl(), "confirmed");
    const authority = loadMintAuthority();
    const usdcMint = await getConfigUsdcMint();
    if (!usdcMint) return NextResponse.json({ ok: false, error: "config not initialized" }, { status: 400 });

    // Creates the ATA if missing (authority pays rent); a no-op if it already exists.
    const userAta = await getOrCreateAssociatedTokenAccount(connection, authority, usdcMint, user);

    const acct = await getAccount(connection, userAta.address);
    let minted = 0n;
    if (acct.amount < MIN_BALANCE) {
      minted = TOP_UP;
      await mintTo(connection, authority, usdcMint, userAta.address, authority, minted);
    }

    return NextResponse.json({
      ok: true,
      ata: userAta.address.toBase58(),
      balanceBefore: acct.amount.toString(),
      minted: minted.toString(),
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
