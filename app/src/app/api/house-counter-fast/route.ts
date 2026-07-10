// Server-only liquidity-seeding endpoint for the ER-fast trading flow —
// exact same purpose, disclosure, and trust boundary as the classic
// /api/house-counter (see that file's header comment): a solo user always
// gets a crossing counterparty so the demo doesn't require two live wallets.
// This is a devnet demo convenience, not a production matching engine. It
// does not change any on-chain trust boundary — it submits a normal,
// publicly-visible submit_order_fast/reveal_order_fast transaction from a
// keypair like any other trader; the program cannot tell "house" traffic
// apart from anyone else's, and the house's TradingAccount is inspectable
// on-chain exactly like the user's.
//
// Three actions, all idempotent:
//   "ensure"  (base)  — house has USDC, a TradingAccount for this market,
//                        and that account is delegated. No-ops any step
//                        that's already done. Does NOT delegate the MARKET
//                        itself — that stays the connected user's explicit,
//                        visible click (see ErTradingPanel), never silently
//                        done server-side.
//   "submit"  (ER)     — house places the opposing side at an extreme limit
//                        price that crosses with virtually any reasonable
//                        user order. Calls "ensure" first if needed.
//   "reveal"  (ER)     — house reveals the same order (stateless recompute
//                        of side/size/price from the user's, same pattern
//                        as the classic house-counter route).

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import { getConfigUsdcMint, getTradingAccount, ONYX_PROGRAM_ID, TRADING_STATUS_LOCKED, TRADING_STATUS_REVEALED } from "@/lib/onchain";
import {
  buildOpenTradingAccountIx,
  buildDepositTradingIx,
  buildDelegateTradingAccountIx,
  buildSubmitOrderFastIx,
  buildRevealOrderFastIx,
  tradingAccountPda,
  sealedCommitment,
  SIDE_A,
  SIDE_B,
} from "@/lib/instructions";

const HOUSE_NONCE = 828282n;
const ODDS_SCALE = 1_000_000n;
const HOUSE_DEPOSIT = 50_000_000n; // 50 tUSDC — comfortably covers any reasonable demo bet size
const ROUTER_URL = "https://devnet-router.magicblock.app/";

function houseParams(userSide: number, userSize: bigint) {
  const side = userSide === SIDE_A ? SIDE_B : SIDE_A;
  const limitPrice = side === SIDE_A ? (ODDS_SCALE * 9n) / 10n : ODDS_SCALE / 10n;
  return { side, size: userSize, limitPrice };
}

function loadHouseKeypair(): Keypair {
  const path = process.env.ANCHOR_WALLET;
  if (!path) throw new Error("ANCHOR_WALLET not set (server env) — see app/.env.local");
  const secret = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getBaseUrl(): string {
  return process.env.SOLANA_RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
}

async function getErConnection(market: PublicKey): Promise<Connection | null> {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market.toBase58()] }),
  });
  const json = await res.json();
  const fqdn = json?.result?.fqdn as string | undefined;
  if (!json?.result?.isDelegated || !fqdn) return null;
  return new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");
}

async function send(connection: Connection, ixs: TransactionInstruction[], house: Keypair) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = house.publicKey;
  tx.sign(house);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

/** Ensures house has USDC + a delegated TradingAccount for `market`. Base-layer only. Idempotent. Returns the sigs of whatever it actually had to do. */
async function ensureHouseReady(market: PublicKey, house: Keypair): Promise<{ sigs: string[]; ready: boolean; reason?: string }> {
  const base = new Connection(getBaseUrl(), "confirmed");
  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) return { sigs: [], ready: false, reason: "config not initialized" };

  const sigs: string[] = [];
  const houseAta = await getOrCreateAssociatedTokenAccount(base, house, usdcMint, house.publicKey);
  const acct = await getAccount(base, houseAta.address);
  if (acct.amount < HOUSE_DEPOSIT) {
    await mintTo(base, house, usdcMint, houseAta.address, house, HOUSE_DEPOSIT * 2n);
  }

  const trading = tradingAccountPda(market, house.publicKey);
  const taInfo = await base.getAccountInfo(trading);
  if (!taInfo) {
    // Market must already be delegated before we bother creating+delegating
    // house's TradingAccount — if it isn't yet, the connected user hasn't
    // clicked "Enable fast trading" yet, so there's nothing to do (and
    // nothing wrong): report not-ready with a clear reason instead of
    // silently delegating the market ourselves.
    const erConn = await getErConnection(market);
    if (!erConn) return { sigs: [], ready: false, reason: "market not yet delegated" };

    const { ix: openIx } = buildOpenTradingAccountIx({ owner: house.publicKey, market });
    const depositIx = buildDepositTradingIx({ owner: house.publicKey, market, amount: HOUSE_DEPOSIT, usdcMint, ownerAta: houseAta.address });
    const delegateIx = buildDelegateTradingAccountIx({ payer: house.publicKey, market, owner: house.publicKey });
    sigs.push(
      await send(
        base,
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), openIx, depositIx, delegateIx],
        house,
      ),
    );
    return { sigs, ready: true };
  }

  // TradingAccount exists on base — either never delegated (fine, market
  // must not be delegated either, nothing to do) or it WAS delegated and
  // this is a stale post-undelegate base copy from a PRIOR round on the
  // same market (shouldn't normally recur within one market's lifecycle,
  // but handle it: if market is delegated and house's account still shows
  // up on base, it means house's account specifically isn't delegated yet).
  const erConn = await getErConnection(market);
  if (erConn) {
    const stillOnBase = await base.getAccountInfo(trading);
    if (stillOnBase && stillOnBase.owner.equals(ONYX_PROGRAM_ID)) {
      const delegateIx = buildDelegateTradingAccountIx({ payer: house.publicKey, market, owner: house.publicKey });
      sigs.push(await send(base, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), delegateIx], house));
    }
  }
  return { sigs, ready: true };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const market = new PublicKey(String(body.market));
    const action = String(body.action);
    const userSide = Number(body.userSide);
    const userSize = BigInt(String(body.userSize));
    if (![SIDE_A, SIDE_B].includes(userSide)) {
      return NextResponse.json({ ok: false, error: "invalid userSide" }, { status: 400 });
    }

    const house = loadHouseKeypair();

    if (action === "ensure") {
      const result = await ensureHouseReady(market, house);
      return NextResponse.json({ ok: result.ready, ...result });
    }

    if (action === "submit") {
      const prep = await ensureHouseReady(market, house);
      if (!prep.ready) return NextResponse.json({ ok: false, error: prep.reason ?? "house not ready" }, { status: 409 });

      const erConn = await getErConnection(market);
      if (!erConn) return NextResponse.json({ ok: false, error: "market not delegated" }, { status: 409 });

      const existing = await getTradingAccount(erConn, market, house.publicKey);
      if (existing && (existing.status === TRADING_STATUS_LOCKED || existing.status === TRADING_STATUS_REVEALED)) {
        return NextResponse.json({ ok: true, skipped: "house already has an open order", prepSigs: prep.sigs });
      }

      const { side, size, limitPrice } = houseParams(userSide, userSize);
      const commitment = sealedCommitment(side, size, limitPrice, HOUSE_NONCE, house.publicKey);
      const submitIx = buildSubmitOrderFastIx({ owner: house.publicKey, market, commitment, collateral: size });
      const signature = await send(erConn, [submitIx], house);

      return NextResponse.json({ ok: true, signature, prepSigs: prep.sigs, houseSide: side, houseSize: size.toString() });
    }

    if (action === "reveal") {
      const erConn = await getErConnection(market);
      if (!erConn) return NextResponse.json({ ok: false, error: "market not delegated" }, { status: 409 });

      const existing = await getTradingAccount(erConn, market, house.publicKey);
      if (!existing) return NextResponse.json({ ok: false, error: "house has no order on this market" }, { status: 404 });
      if (existing.status === TRADING_STATUS_REVEALED) {
        return NextResponse.json({ ok: true, skipped: "already revealed" });
      }

      const { side, size, limitPrice } = houseParams(userSide, userSize);
      const revealIx = buildRevealOrderFastIx({ owner: house.publicKey, market, side, size, limitPrice, nonce: HOUSE_NONCE });
      const signature = await send(erConn, [revealIx], house);

      return NextResponse.json({ ok: true, signature });
    }

    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
