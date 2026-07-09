// Live devnet NEGATIVE-path suite for the ONYX program: proves the program
// rejects invalid actions with the exact custom error codes declared in
// programs/onyx/src/error.rs. Built with the same browser instruction
// builders and config as e2e_user_test.ts (no Anchor — native Pinocchio).
//
// Usage: cd onyx && bun run services/ingestion/src/e2e_negative_test.ts
//
// Expected codes (confirmed by reading the Rust handlers, not guessed):
//   claim.rs:74            AlreadyClaimed     = 6010  (double claim)
//   claim.rs:82            NotWinner          = 6009  (losing side claims)
//   reveal_order.rs:81     CommitmentMismatch = 6019  (wrong preimage)
//   reveal_order.rs:46-47  WrongPhase         = 6018  (reveal before commit_end_ts)
//   submit_sealed_order.rs:52-58 WrongPhase   = 6018  (submit after commit_end_ts)
//   settle_market.rs:48-50 WrongStatus        = 6006  (settle a Settled/Claimed market)
//
// Documented behavior (not a test): settle_market enforces NO deadline — any
// signer may settle whenever status is Open/Live with a valid proof (§ below).

import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import * as cfg from "./config";
import capturedProof from "../../../app/src/lib/fixtures/scores-validation.sample.json";
import {
  buildOpenMarketSealedIx,
  buildSubmitSealedOrderIx,
  buildRevealOrderIx,
  buildSettleMarketIx,
  buildClaimIx,
  computeParamsHash,
  sealedCommitment,
  orderPda,
  SIDE_A,
  CMP_GREATER_THAN,
  OP_NONE,
  type MarketTerms,
  type CapturedProofFixture,
} from "../../../app/src/lib/instructions";
import { getConfigUsdcMint, getMarket } from "../../../app/src/lib/onchain";

// Error codes, mirrored from programs/onyx/src/error.rs (authoritative).
const ERR_WRONG_STATUS = 6006;
const ERR_NOT_WINNER = 6009;
const ERR_ALREADY_CLAIMED = 6010;
const ERR_WRONG_PHASE = 6018;
const ERR_COMMITMENT_MISMATCH = 6019;

const CLAIMED_MARKET = new PublicKey("EfwHJQuYWKEizBNM1A9eVmT5Uh61LDtnrHRnZdFN3Lsy");

const connection = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("_keys/test-bettor.json", "utf8"))));
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));

const setupSigs: { label: string; sig: string }[] = [];

async function send(ixs: TransactionInstruction[], signer: Keypair): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// Robust custom-error-code extraction from a thrown web3.js error: matches
// both "custom program error: 0x<hex>" and {"Custom":<dec>} in the message
// and any attached simulation logs.
function extractCustomCode(e: unknown): number | null {
  const err = e as { message?: unknown; logs?: unknown; transactionLogs?: unknown };
  const parts: string[] = [];
  if (err?.message) parts.push(String(err.message));
  try {
    if (Array.isArray(err?.logs)) parts.push((err.logs as unknown[]).join("\n"));
  } catch {
    /* SendTransactionError.logs getter can throw when unavailable */
  }
  if (Array.isArray(err?.transactionLogs)) parts.push((err.transactionLogs as unknown[]).join("\n"));
  const text = parts.join("\n");
  let m = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (m) return parseInt(m[1]!, 16);
  m = text.match(/"Custom"\s*:\s*(\d+)/);
  if (m) return parseInt(m[1]!, 10);
  return null;
}

interface Result {
  name: string;
  expected: number;
  actual: number | null;
  pass: boolean;
  note: string;
}
const results: Result[] = [];

async function expectRejection(name: string, expected: number, fn: () => Promise<string>) {
  console.log(`\n[neg] running: ${name} (expect ${expected})`);
  try {
    const sig = await fn();
    results.push({ name, expected, actual: null, pass: false, note: `UNEXPECTED SUCCESS sig=${sig}` });
    console.log(`[neg]   FAIL — transaction unexpectedly succeeded: ${sig}`);
  } catch (e) {
    const code = extractCustomCode(e);
    const pass = code === expected;
    const note = pass ? "" : `raw error: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
    results.push({ name, expected, actual: code, pass, note });
    console.log(`[neg]   caught code=${code} -> ${pass ? "PASS" : "FAIL"}`);
    if (!pass) console.log(`[neg]   ${note}`);
  }
}

async function waitUntilUnixTs(targetSec: number, label: string) {
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= targetSec) break;
    console.log(`[neg] waiting for ${label}: ${targetSec - now}s remaining`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  console.log(`[neg] bettor=${bettor.publicKey.toBase58()} admin=${admin.publicKey.toBase58()}`);
  console.log(`[neg] rpc=${cfg.SOLANA_RPC_URL}`);

  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) throw new Error("config not initialized");

  const claimed = await getMarket(CLAIMED_MARKET.toBase58());
  if (!claimed) throw new Error("claimed reference market not found on-chain");
  console.log(`[neg] reference market ${CLAIMED_MARKET.toBase58()} status=${claimed.status} outcome=${claimed.outcome}`);

  // ---- Test 1: double-claim by the already-claimed winner (bettor, Side A) ----
  await expectRejection("double-claim (bettor re-claims)", ERR_ALREADY_CLAIMED, async () => {
    const ix = buildClaimIx({ winner: bettor.publicKey, market: CLAIMED_MARKET, usdcMint });
    return send([ix], bettor);
  });

  // ---- Test 2: loser claim (admin was Side B, outcome was Side A) ----
  await expectRejection("loser-claim (admin, Side B)", ERR_NOT_WINNER, async () => {
    const ix = buildClaimIx({ winner: admin.publicKey, market: CLAIMED_MARKET, usdcMint });
    return send([ix], admin);
  });

  // ---- Setup: fresh sealed market (bettor as creator), ~120s commit window ----
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const commitEndTs = nowSec + 120n;
  const revealEndTs = commitEndTs + 240n;
  // Vary deadline (time-derived + random jitter) so paramsHash / market PDA is unique per run.
  const deadline = revealEndTs + 900n + BigInt(Math.floor(Math.random() * 1000));
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
  const { ix: createIx, market: freshMarket } = buildOpenMarketSealedIx({
    creator: bettor.publicKey,
    usdcMint,
    terms,
    paramsHash,
    commitEndTs,
    revealEndTs,
  });
  const createSig = await send([createIx], bettor);
  setupSigs.push({ label: "create fresh sealed market", sig: createSig });
  console.log(`\n[neg] SETUP: fresh market=${freshMarket.toBase58()} sig=${createSig}`);
  console.log(`[neg] commit window closes at ${commitEndTs} (in ~120s), reveal window at ${revealEndTs}`);

  // ---- Setup: submit a sealed order with known (side,size,price,nonce) ----
  const nonce = BigInt(Math.floor(Math.random() * 1_000_000_000));
  const size = 1_000_000n; // 1 test-USDC
  const limitPrice = 500_000n;
  const commitment = sealedCommitment(SIDE_A, size, limitPrice, nonce, bettor.publicKey);
  const { ix: submitIx } = buildSubmitSealedOrderIx({
    user: bettor.publicKey,
    market: freshMarket,
    nonce,
    commitment,
    collateral: size,
    usdcMint,
  });
  const submitSig = await send([submitIx], bettor);
  setupSigs.push({ label: "submit sealed order (nonce known)", sig: submitSig });
  console.log(`[neg] SETUP: sealed order submitted nonce=${nonce} sig=${submitSig}`);
  const order = orderPda(freshMarket, bettor.publicKey, nonce);

  // ---- Test 4 (runs before window closes): reveal during commit window ----
  await expectRejection("reveal-during-commit (too early)", ERR_WRONG_PHASE, async () => {
    const ix = buildRevealOrderIx({
      user: bettor.publicKey,
      market: freshMarket,
      order,
      side: SIDE_A,
      size,
      limitPrice,
      nonce,
    });
    return send([ix], bettor);
  });

  // ---- Wait for the commit window to close (+15s clock-skew buffer) ----
  await waitUntilUnixTs(Number(commitEndTs) + 15, "commit window close");

  // ---- Test 3: reveal with correct nonce/order PDA but WRONG limitPrice ----
  await expectRejection("commitment-mismatch (wrong limitPrice)", ERR_COMMITMENT_MISMATCH, async () => {
    const ix = buildRevealOrderIx({
      user: bettor.publicKey,
      market: freshMarket,
      order,
      side: SIDE_A,
      size,
      limitPrice: limitPrice + 1n, // wrong preimage
      nonce,
    });
    return send([ix], bettor);
  });

  // ---- Test 5: submit a NEW sealed order after the commit window closed ----
  await expectRejection("submit-after-commit-close", ERR_WRONG_PHASE, async () => {
    const lateNonce = nonce + 1n;
    const lateCommitment = sealedCommitment(SIDE_A, size, limitPrice, lateNonce, bettor.publicKey);
    const { ix } = buildSubmitSealedOrderIx({
      user: bettor.publicKey,
      market: freshMarket,
      nonce: lateNonce,
      commitment: lateCommitment,
      collateral: size,
      usdcMint,
    });
    return send([ix], bettor);
  });

  // ---- Sanity: the CORRECT reveal must still succeed (order not corrupted) ----
  {
    const ix = buildRevealOrderIx({
      user: bettor.publicKey,
      market: freshMarket,
      order,
      side: SIDE_A,
      size,
      limitPrice,
      nonce,
    });
    const sig = await send([ix], bettor);
    setupSigs.push({ label: "correct reveal (sanity, must succeed)", sig });
    console.log(`\n[neg] SANITY: correct reveal succeeded sig=${sig} — order was not corrupted by the failed attempts`);
  }

  // ---- Test 6: settle an already-Settled/Claimed market ----
  await expectRejection("settle-already-settled (Claimed market)", ERR_WRONG_STATUS, async () => {
    const { ix, computeIx } = buildSettleMarketIx({
      submitter: bettor.publicKey,
      market: CLAIMED_MARKET,
      fixture: capturedProof as unknown as CapturedProofFixture,
      threshold: claimed.threshold,
      predicate: claimed.predicate,
    });
    return send([computeIx, ix], bettor);
  });

  // ---- Report ----
  console.log("\n================ NEGATIVE-PATH RESULTS ================");
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad("test", 44)} | ${pad("expected", 8)} | ${pad("actual", 8)} | result`);
  console.log("-".repeat(44) + "-+-" + "-".repeat(8) + "-+-" + "-".repeat(8) + "-+-------");
  for (const r of results) {
    console.log(
      `${pad(r.name, 44)} | ${pad(String(r.expected), 8)} | ${pad(String(r.actual ?? "none"), 8)} | ${r.pass ? "PASS" : "FAIL"}${r.note ? "  <-- " + r.note : ""}`,
    );
  }
  console.log("\nSetup transaction signatures (real devnet txs):");
  for (const s of setupSigs) console.log(`  ${s.label}: ${s.sig}`);
  console.log(`\nFresh market PDA: ${freshMarket.toBase58()}`);

  console.log(
    "\nDocumented behavior (settle_market.rs): NO deadline is enforced — settlement is permissionless and allowed any time market status is Open/Live given a valid oracle proof (by design; determinism comes from the proof, not a time gate).",
  );

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`\n[neg] ${failed.length} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\n[neg] all negative-path tests PASSED");
}

main().catch((e) => {
  console.error(`[neg] SUITE ERROR: ${(e as Error)?.message ?? e}`);
  const logs = (e as { logs?: unknown })?.logs;
  if (Array.isArray(logs)) console.error("[neg] logs:", logs);
  process.exit(1);
});
