// The one-command reproducible proof of the ENTIRE judge-facing journey —
// imports the EXACT same instruction-builder functions
// app/src/components/SealedOrderPanel.tsx, app/src/app/create/page.tsx, and
// app/src/components/SettleClaimPanel.tsx call, but drives them with a raw
// Keypair instead of a browser wallet extension (which no automated
// environment can click through). Also calls the LIVE running `next dev`
// server's /api/house-counter route for real, so the liquidity-seeding API
// path is genuinely exercised end-to-end, not just typechecked.
//
// This is the deterministic replay/fallback harness: if the live demo ever
// flakes during judging, this single command re-proves the full lifecycle
// -- create -> sealed bet -> liquidity seeded -> reveal -> batch match ->
// real oracle settlement -> claim -- against real devnet, start to finish.
//
// Usage: cd onyx/app && bun run scripts/verify-flow.ts
// (requires `bun run dev` already running on localhost:3000 --
// `bun run demo` from the onyx/ root does both in one command)

import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount, mintTo } from "@solana/spl-token";
import { getConfigUsdcMint, listSealedOrders, PHASE_MATCHED, explorerTxUrl } from "../src/lib/onchain";
import {
  buildOpenMarketSealedIx,
  buildSubmitSealedOrderIx,
  buildRevealOrderIx,
  buildRunBatchMatchIx,
  buildSettleMarketIx,
  buildClaimIx,
  computeParamsHash,
  sealedCommitment,
  type CapturedProofFixture,
  SIDE_A,
  OP_NONE,
  CMP_GREATER_THAN,
} from "../src/lib/instructions";
import capturedProof from "../src/lib/fixtures/scores-validation.sample.json";

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const APP_URL = "http://localhost:3000";
// The one fixture with a real captured oracle proof bundled in this repo --
// same default /create uses, so this script proves exactly the market a
// judge would create through the UI, not a disconnected throwaway. Using
// any other fixture id here would settle "successfully" against the SAME
// bundled proof (validate_stat's CPI args are built from the captured
// fixture's own embedded fixture id, not from the market's), which would
// silently decouple the market's displayed identity from what was actually
// verified -- the exact class of bug this script exists to catch, not repeat.
const DEMO_FIXTURE_ID = 18179550n;

async function send(connection: Connection, tx: Transaction, signers: Keypair[], label: string) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    throw new Error(`${label} FAILED: ${JSON.stringify(conf.value.err)}\n${(t?.meta?.logMessages ?? []).join("\n")}`);
  }
  console.log(`[verify] ${label} -> ${sig}`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? "/home/anshtyagi/.config/solana/id.json", "utf8"))),
  );
  const user = Keypair.generate();
  console.log("[verify] admin:", admin.publicKey.toBase58());
  console.log("[verify] throwaway user (simulates a connected wallet):", user.publicKey.toBase58());

  await send(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 30_000_000 }),
    ),
    [admin],
    "fund throwaway user",
  );

  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) throw new Error("config not initialized — run l0_loop_test.ts first");
  const userAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, user.publicKey);
  await mintTo(connection, admin, usdcMint, userAta.address, admin, 5_000_000n);

  // ---- Stage 1: /create equivalent — open_market_sealed ----
  const fixtureId = BigInt(process.env.VERIFY_FIXTURE_ID ?? DEMO_FIXTURE_ID.toString());
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const commitEndTs = nowSec + 15n;
  const revealEndTs = commitEndTs + 15n;
  const terms = {
    fixtureId,
    statAKey: 1,
    statBKey: 0,
    op: OP_NONE,
    predicate: CMP_GREATER_THAN,
    threshold: 2n,
    deadline: revealEndTs + 900n,
  };
  const paramsHash = computeParamsHash(terms);
  const { ix: openIx, market } = buildOpenMarketSealedIx({
    creator: admin.publicKey,
    usdcMint,
    terms,
    paramsHash,
    commitEndTs,
    revealEndTs,
  });
  console.log("[verify] market:", market.toBase58());
  if (!(await connection.getAccountInfo(market))) {
    await send(connection, new Transaction().add(openIx), [admin], "open_market_sealed (=/create)");
  } else {
    console.log("[verify] market already exists, reusing");
  }

  // ---- Stage 2: SealedOrderPanel equivalent — user places a sealed bet ----
  const nonce = BigInt(Math.floor(Math.random() * 1_000_000_000));
  const size = 1_000_000n;
  const limitPrice = 500_000n;
  const commitment = sealedCommitment(SIDE_A, size, limitPrice, nonce, user.publicKey);
  const { ix: submitIx, order: userOrder } = buildSubmitSealedOrderIx({
    user: user.publicKey,
    market,
    nonce,
    commitment,
    collateral: size,
    usdcMint,
  });
  await send(connection, new Transaction().add(submitIx), [user], "submit_sealed_order (=user bet in UI)");

  // ---- Stage 3: hit the LIVE /api/house-counter route for real ----
  const submitResp = await fetch(`${APP_URL}/api/house-counter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market: market.toBase58(), action: "submit", userSide: SIDE_A, userSize: size.toString() }),
  });
  const submitJson = await submitResp.json();
  console.log("[verify] /api/house-counter submit ->", JSON.stringify(submitJson));
  if (!submitJson.ok) throw new Error("house-counter submit failed: " + JSON.stringify(submitJson));

  // ---- Stage 4: wait for commit window, reveal both sides ----
  const waitUntil = async (target: bigint, label: string) => {
    const waitMs = Number(target) * 1000 - Date.now() + 2000;
    if (waitMs > 0) {
      console.log(`[verify] waiting ${Math.ceil(waitMs / 1000)}s for ${label}...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  };
  await waitUntil(commitEndTs, "commit_end_ts");

  const revealIx = buildRevealOrderIx({ user: user.publicKey, market, order: userOrder, side: SIDE_A, size, limitPrice, nonce });
  await send(connection, new Transaction().add(revealIx), [user], "reveal_order (=user reveal in UI)");

  const revealResp = await fetch(`${APP_URL}/api/house-counter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market: market.toBase58(), action: "reveal", userSide: SIDE_A, userSize: size.toString() }),
  });
  console.log("[verify] /api/house-counter reveal ->", JSON.stringify(await revealResp.json()));

  // ---- Stage 5: wait for reveal window, run the batch match (permissionless) ----
  await waitUntil(revealEndTs, "reveal_end_ts");
  const revealedOrders = await listSealedOrders(market.toBase58());
  console.log("[verify] revealed orders visible via listSealedOrders():", revealedOrders.length);
  const matchIx = buildRunBatchMatchIx({
    payer: user.publicKey,
    market,
    orders: revealedOrders.map((o) => {
      const owner = new PublicKey(o.owner);
      return {
        order: new PublicKey(o.pda),
        owner,
        usdcAta: o.owner === user.publicKey.toBase58() ? userAta.address : getAssociatedTokenAddressSync(usdcMint, owner),
      };
    }),
  });
  const matchSig = await send(connection, new Transaction().add(matchIx), [user], "run_batch_match (=Run match button in UI)");

  const marketAfter = await connection.getAccountInfo(market);
  const phase = marketAfter!.data[118];
  const clearingPrice = marketAfter!.data.readBigUInt64LE(119);

  // ---- Stage 6: SettleClaimPanel equivalent — real validate_stat CPI ----
  const { ix: settleIx, computeIx } = buildSettleMarketIx({
    submitter: admin.publicKey,
    market,
    fixture: capturedProof as unknown as CapturedProofFixture,
    threshold: terms.threshold,
    predicate: terms.predicate,
  });
  const settleSig = await send(
    connection,
    new Transaction().add(computeIx, settleIx),
    [admin],
    "settle_market (=Settle button in UI, real validate_stat CPI)",
  );
  const marketSettled = await connection.getAccountInfo(market);
  const status = marketSettled!.data[26];
  const outcome = marketSettled!.data[27];
  console.log(`[verify] market status=${status} (4=Settled) outcome=${outcome} (1=SideA won)`);

  // ---- Stage 7: claim — the matched side-A position (the user) won ----
  let claimSig = "(skipped: outcome wasn't Side A / user has no matched position)";
  if (outcome === 1) {
    const balanceBefore = (await getAccount(connection, userAta.address)).amount;
    const claimIx = buildClaimIx({ winner: user.publicKey, market, usdcMint });
    claimSig = await send(connection, new Transaction().add(claimIx), [user], "claim (=Claim payout button in UI)");
    const balanceAfter = (await getAccount(connection, userAta.address)).amount;
    console.log(`[verify] user USDC balance: ${balanceBefore} -> ${balanceAfter} (+${balanceAfter - balanceBefore})`);
  }

  console.log("\n===== FULL DEMO JOURNEY — REPRODUCIBLE PROOF =====");
  console.log("market:              ", market.toBase58());
  console.log("phase after match:   ", phase, phase === PHASE_MATCHED ? "(Matched ✓)" : "(unexpected)");
  console.log("clearing_price:      ", clearingPrice.toString());
  console.log("house liquidity seeded via live /api/house-counter route:", submitJson.ok ? "YES" : "NO");
  console.log("run_batch_match tx:  ", explorerTxUrl(matchSig));
  console.log("settle_market tx:    ", explorerTxUrl(settleSig), "(real validate_stat CPI)");
  console.log("claim tx:            ", claimSig.startsWith("(") ? claimSig : explorerTxUrl(claimSig));
  console.log("====================================================");
}

main().catch((e) => {
  console.error("[verify] FAILED:", e);
  process.exit(1);
});
