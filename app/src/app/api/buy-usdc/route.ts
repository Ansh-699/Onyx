// Devnet SOL → test-USDC exchange. The server BUILDS the whole transaction
// itself (never co-signs client-supplied bytes): the user's SOL transfer to
// the treasury and the treasury's tUSDC mint to the user ride in ONE atomic
// transaction — the mint cannot happen without the payment landing. The
// server partial-signs with the mint authority (same ANCHOR_WALLET key the
// faucet already uses — no new key surface) and returns it base64; the
// browser adds the user's wallet signature and broadcasts.
//
// Fixed toy rate, disclosed in the UI: 1 SOL = 200 tUSDC. Devnet only —
// this route exists because our test-USDC has no DEX market; on mainnet
// users would bring real USDC and this route disappears.
//
// POST /api/buy-usdc { user, lamports } -> { ok, tx (base64), usdcOut, blockhash, lastValidBlockHeight }

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConfigUsdcMint } from "@/lib/onchain";

/** 1 SOL (1e9 lamports) buys 200 tUSDC (200e6 base units) → ÷ 5. */
const LAMPORTS_PER_USDC_UNIT = 5n;
const MIN_LAMPORTS = 10_000_000n; // 0.01 SOL
const MAX_LAMPORTS = 2_000_000_000n; // 2 SOL per request — devnet sanity cap

function loadTreasury(): Keypair {
  const path = process.env.ANCHOR_WALLET;
  if (!path) throw new Error("ANCHOR_WALLET not set (server env)");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function getRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const user = new PublicKey(String(body.user));
    const lamports = BigInt(String(body.lamports));
    if (lamports < MIN_LAMPORTS || lamports > MAX_LAMPORTS) {
      return NextResponse.json({ ok: false, error: "amount must be between 0.01 and 2 SOL" }, { status: 400 });
    }

    const connection = new Connection(getRpcUrl(), "confirmed");
    const treasury = loadTreasury();
    const usdcMint = await getConfigUsdcMint();
    if (!usdcMint) return NextResponse.json({ ok: false, error: "config not initialized" }, { status: 400 });

    const usdcOut = lamports / LAMPORTS_PER_USDC_UNIT;
    const userAta = getAssociatedTokenAddressSync(usdcMint, user);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: user, toPubkey: treasury.publicKey, lamports: Number(lamports) }),
      createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, userAta, user, usdcMint),
      createMintToInstruction(usdcMint, userAta, treasury.publicKey, usdcOut),
    );
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user; // the buyer pays the fee — treasury only mints
    tx.partialSign(treasury);

    return NextResponse.json({
      ok: true,
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      usdcOut: usdcOut.toString(),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
