// End-to-end test of every user-facing on-chain action, signed by a single
// fresh devnet keypair (_keys/test-bettor.json) -- exactly as the browser UI
// builds and sends them (same instructions.ts builders, same account lists),
// to reproduce and verify fixes for real user-reported errors before asking
// anyone to test manually again. The "house" counterparty steps mirror
// api/house-counter/route.ts exactly (same admin keypair, same extreme
// crossing price) so a solo bettor still gets matched, same as the real UI.
//
// Usage: cd onyx && MARKET=<pda> bun run services/ingestion/src/e2e_user_test.ts <step>
//   step: create | bet | house-submit | reveal | house-reveal | match | settle | claim
//
// State (nonce/side/size/price) is persisted to _keys/e2e-state.json between
// steps, mirroring the browser's localStorage save in SealedOrderPanel.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from "@solana/spl-token";
import * as cfg from "./config";
import capturedProof from "../../../app/src/lib/fixtures/scores-validation.sample.json";
import {
  buildOpenMarketSealedIx,
  buildSubmitSealedOrderIx,
  buildRevealOrderIx,
  buildRunBatchMatchIx,
  buildSettleMarketIx,
  buildClaimIx,
  computeParamsHash,
  sealedCommitment,
  orderPda,
  SIDE_A,
  SIDE_B,
  CMP_GREATER_THAN,
  OP_NONE,
  type MarketTerms,
  type CapturedProofFixture,
} from "../../../app/src/lib/instructions";
import { getConfigUsdcMint, getMarket } from "../../../app/src/lib/onchain";

const STATE_PATH = "_keys/e2e-state.json";
const connection = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("_keys/test-bettor.json", "utf8"))));
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));

interface State {
  market: string;
  nonce: string;
  side: number;
  size: string;
  limitPrice: string;
  houseNonce: string;
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) throw new Error(`no state at ${STATE_PATH} -- run "bet" first`);
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}
function saveState(s: State) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function send(ixs: any[], signer: Keypair) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  const step = process.argv[2];
  if (!step) throw new Error("usage: bun run e2e_user_test.ts <create|bet|house-submit|reveal|house-reveal|match|settle|claim>");
  console.log(`[e2e] bettor=${bettor.publicKey.toBase58()} admin=${admin.publicKey.toBase58()} step=${step}`);

  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) throw new Error("config not initialized");

  if (step === "create") {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const commitEndTs = nowSec + 90n;
    const revealEndTs = commitEndTs + 90n;
    const deadline = revealEndTs + 900n;
    const terms: MarketTerms = {
      fixtureId: 18179550n,
      statAKey: 1,
      statBKey: 0,
      op: OP_NONE,
      predicate: CMP_GREATER_THAN,
      threshold: 2n,
      deadline,
    };
    const paramsHash = computeParamsHash(terms);
    const { ix, market } = buildOpenMarketSealedIx({
      creator: bettor.publicKey,
      usdcMint,
      terms,
      paramsHash,
      commitEndTs,
      revealEndTs,
    });
    const sig = await send([ix], bettor);
    console.log(`[e2e] CREATE ok market=${market.toBase58()} sig=${sig}`);
    console.log(`[e2e] commit window closes in 90s, reveal window in another 90s after that`);
    saveState({ market: market.toBase58(), nonce: "", side: 0, size: "", limitPrice: "", houseNonce: "424242" });
    return;
  }

  const state = loadState();
  const market = new PublicKey(state.market);
  const m = await getMarket(market.toBase58());
  if (!m) throw new Error("market not found on-chain");
  console.log(`[e2e] market=${market.toBase58()} phase=${m.phase} status=${m.status}`);

  if (step === "bet") {
    // Faucet first -- exactly what the fixed SealedOrderPanel.placeBet() now does.
    const res = await fetch("http://localhost:3000/api/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: bettor.publicKey.toBase58() }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(`faucet failed: ${JSON.stringify(body)}`);
    console.log(`[e2e] faucet ok: ata=${body.ata} minted=${body.minted}`);

    const nonce = BigInt(Math.floor(Math.random() * 1_000_000_000));
    const size = 1_000_000n;
    const limitPrice = 500_000n;
    const commitment = sealedCommitment(SIDE_A, size, limitPrice, nonce, bettor.publicKey);
    const { ix } = buildSubmitSealedOrderIx({ user: bettor.publicKey, market, nonce, commitment, collateral: size, usdcMint });
    const sig = await send([ix], bettor);
    console.log(`[e2e] BET ok sig=${sig} nonce=${nonce}`);
    saveState({ ...state, nonce: nonce.toString(), side: SIDE_A, size: size.toString(), limitPrice: limitPrice.toString() });
    return;
  }

  if (step === "house-submit") {
    // Mirrors api/house-counter POST action=submit exactly.
    const houseAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, admin.publicKey);
    const acct = await getAccount(connection, houseAta.address);
    const size = BigInt(state.size);
    if (acct.amount < size) await mintTo(connection, admin, usdcMint, houseAta.address, admin, size * 10n);
    const houseSide = SIDE_B;
    const houseLimitPrice = 100_000n; // extreme crossing price, same as house-counter
    const houseNonce = BigInt(state.houseNonce);
    const commitment = sealedCommitment(houseSide, size, houseLimitPrice, houseNonce, admin.publicKey);
    const { ix } = buildSubmitSealedOrderIx({ user: admin.publicKey, market, nonce: houseNonce, commitment, collateral: size, usdcMint });
    const sig = await send([ix], admin);
    console.log(`[e2e] HOUSE-SUBMIT ok sig=${sig}`);
    return;
  }

  if (step === "reveal") {
    const order = orderPda(market, bettor.publicKey, BigInt(state.nonce));
    const ix = buildRevealOrderIx({
      user: bettor.publicKey,
      market,
      order,
      side: state.side,
      size: BigInt(state.size),
      limitPrice: BigInt(state.limitPrice),
      nonce: BigInt(state.nonce),
    });
    const sig = await send([ix], bettor);
    console.log(`[e2e] REVEAL ok sig=${sig}`);
    return;
  }

  if (step === "house-reveal") {
    const houseNonce = BigInt(state.houseNonce);
    const order = orderPda(market, admin.publicKey, houseNonce);
    const ix = buildRevealOrderIx({
      user: admin.publicKey,
      market,
      order,
      side: SIDE_B,
      size: BigInt(state.size),
      limitPrice: 100_000n,
      nonce: houseNonce,
    });
    const sig = await send([ix], admin);
    console.log(`[e2e] HOUSE-REVEAL ok sig=${sig}`);
    return;
  }

  if (step === "match") {
    const bettorOrder = orderPda(market, bettor.publicKey, BigInt(state.nonce));
    const houseOrder = orderPda(market, admin.publicKey, BigInt(state.houseNonce));
    const ix = buildRunBatchMatchIx({
      payer: bettor.publicKey,
      market,
      orders: [
        { order: bettorOrder, owner: bettor.publicKey, usdcAta: getAssociatedTokenAddressSync(usdcMint, bettor.publicKey) },
        { order: houseOrder, owner: admin.publicKey, usdcAta: getAssociatedTokenAddressSync(usdcMint, admin.publicKey) },
      ],
    });
    const sig = await send([ix], bettor);
    console.log(`[e2e] MATCH ok sig=${sig}`);
    const after = await getMarket(market.toBase58());
    console.log(`[e2e] clearingPrice=${after?.clearingPrice} phase=${after?.phase}`);
    return;
  }

  if (step === "settle") {
    const { ix, computeIx } = buildSettleMarketIx({
      submitter: bettor.publicKey,
      market,
      fixture: capturedProof as unknown as CapturedProofFixture,
      threshold: m.threshold,
      predicate: m.predicate,
    });
    const sig = await send([computeIx, ix], bettor);
    console.log(`[e2e] SETTLE ok sig=${sig}`);
    const after = await getMarket(market.toBase58());
    console.log(`[e2e] status=${after?.status} outcome=${after?.outcome}`);
    return;
  }

  if (step === "claim") {
    const ix = buildClaimIx({ winner: bettor.publicKey, market, usdcMint });
    const sig = await send([ix], bettor);
    console.log(`[e2e] CLAIM ok sig=${sig}`);
    return;
  }

  throw new Error(`unknown step: ${step}`);
}

main().catch((e) => {
  console.error(`[e2e] FAILED: ${e.message ?? e}`);
  if (e?.logs) console.error("[e2e] logs:", e.logs);
  process.exit(1);
});
