// Server-only liquidity-seeding endpoint (Level 1 demo aid — see the
// PDF/BUILD_STATE note on liquidity: "seed opposing sealed orders ... just
// enough that a solo user always gets filled"). Never exposed to the
// browser bundle; loads a keypair from disk server-side only.
//
// Fully stateless/idempotent by design: the house's side/size/price for a
// given user bet are a pure function of (userSide, userSize), recomputed
// identically on both the "submit" and "reveal" calls — no server-side
// session state needed between them.
//
// This is a devnet demo convenience, not a production matching engine: it
// assumes one active user bet per market at a time (the "solo judge running
// the demo" case explicitly called out as the target). It does not change
// any on-chain trust boundary — it just submits a normal, publicly-visible
// submit_sealed_order/reveal_order transaction from a keypair like any
// other bettor; the program cannot tell "house" traffic apart from anyone
// else's.

import { NextRequest, NextResponse } from "next/server";
import { loadServerKeypair } from "@/lib/serverKeypair";
import { Connection, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { getConfigUsdcMint } from "@/lib/onchain";
import { apiError, clientIp, positiveBigint, pubkey, rateLimited, readJson, tooManyRequests } from "@/lib/apiGuard";
import {
  buildSubmitSealedOrderIx,
  buildRevealOrderIx,
  sealedCommitment,
  orderPda,
  SIDE_A,
  SIDE_B,
} from "@/lib/instructions";

const HOUSE_NONCE = 424242n;
const ODDS_SCALE = 1_000_000n;
// Public endpoint that mints and signs as the house: bound what one request can ask for.
const MAX_USER_SIZE = 1_000_000_000_000n; // 1M tUSDC
const IP_MAX = 60;
const IP_WINDOW_MS = 10 * 60_000;

function houseParams(userSide: number, userSize: bigint) {
  const side = userSide === SIDE_A ? SIDE_B : SIDE_A;
  // Extreme enough to cross with virtually any reasonable user-chosen limit
  // price on the opposite side.
  const limitPrice = side === SIDE_A ? (ODDS_SCALE * 9n) / 10n : ODDS_SCALE / 10n;
  return { side, size: userSize, limitPrice, nonce: HOUSE_NONCE };
}


function getRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
}

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`house:${clientIp(req)}`, IP_MAX, IP_WINDOW_MS)) return tooManyRequests();
    const body = await readJson(req);
    const market = pubkey(body.market, "market");
    const action = String(body.action);
    const userSide = Number(body.userSide);
    const userSize = positiveBigint(body.userSize, "userSize", MAX_USER_SIZE);
    if (![SIDE_A, SIDE_B].includes(userSide)) {
      return NextResponse.json({ ok: false, error: "invalid userSide" }, { status: 400 });
    }

    const connection = new Connection(getRpcUrl(), "confirmed");
    const house = loadServerKeypair();
    const usdcMint = await getConfigUsdcMint();
    if (!usdcMint) return NextResponse.json({ ok: false, error: "config not initialized" }, { status: 400 });

    const { side, size, limitPrice, nonce } = houseParams(userSide, userSize);
    const order = orderPda(market, house.publicKey, nonce);

    if (action === "submit") {
      const existing = await connection.getAccountInfo(order);
      if (existing) {
        return NextResponse.json({ ok: true, skipped: "already submitted", order: order.toBase58() });
      }

      const houseAta = await getOrCreateAssociatedTokenAccount(connection, house, usdcMint, house.publicKey);
      const acct = await getAccount(connection, houseAta.address);
      if (acct.amount < size) {
        // House is the mint authority (devnet test-USDC only).
        await mintTo(connection, house, usdcMint, houseAta.address, house, size * 10n);
      }

      const commitment = sealedCommitment(side, size, limitPrice, nonce, house.publicKey);
      const { ix } = buildSubmitSealedOrderIx({
        user: house.publicKey,
        market,
        nonce,
        commitment,
        collateral: size,
        userAta: houseAta.address,
        usdcMint,
      });

      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = house.publicKey;
      tx.sign(house);
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      return NextResponse.json({
        ok: true,
        signature,
        order: order.toBase58(),
        houseSide: side,
        houseSize: size.toString(),
      });
    }

    if (action === "reveal") {
      const info = await connection.getAccountInfo(order);
      if (!info) return NextResponse.json({ ok: false, error: "house order not found yet" }, { status: 404 });
      if (info.data[120] !== 0) {
        return NextResponse.json({ ok: true, skipped: "already revealed", order: order.toBase58() });
      }

      const ix = buildRevealOrderIx({ user: house.publicKey, market, order, side, size, limitPrice, nonce });
      const tx = new Transaction().add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = house.publicKey;
      tx.sign(house);
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      return NextResponse.json({ ok: true, signature, order: order.toBase58() });
    }

    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (err) {
    return apiError(err);
  }
}
