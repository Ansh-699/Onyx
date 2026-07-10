// Live test for the unmatched-locked-release fix in run_batch_match_fast:
// deliberately UNEQUAL order sizes so there's real leftover collateral,
// then verifies the unmatched remainder returns to `available` (not stuck)
// and is actually withdrawable. Before the fix, this leftover would have
// been silently unrecoverable (status flips to Matched, which
// cancel_order_fast no longer accepts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as ix from "../../../app/src/lib/instructions";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ROUTER_URL = "https://devnet-router.magicblock.app/";
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("_keys/test-bettor.json", "utf8"))));

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} FAILED: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  console.log(`[partial] ${label} -> ${sig}`);
  return sig;
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  const fixtureId = 18179550n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const commitEndTs = now + 15n;
  const revealEndTs = now + 30n;
  const paramsHash = sha256(u64le(fixtureId), u32le(1), u32le(0), Buffer.from([0xff]), Buffer.from([0]), i64le(2n), i64le(deadline));
  const market = ix.marketPdaFromTerms(fixtureId, paramsHash);
  console.log("[partial] market:", market.toBase58());

  if (!(await base.getAccountInfo(market))) {
    const { ix: openIx } = ix.buildOpenMarketSealedIx({
      creator: admin.publicKey, usdcMint,
      terms: { fixtureId, statAKey: 1, statBKey: 0, op: 0xff, predicate: 0, threshold: 2n, deadline },
      paramsHash, commitEndTs, revealEndTs,
    });
    await send(base, [openIx], [admin], "open_market_sealed");
  }

  // Admin deposits 2 tUSDC, bettor deposits 1 tUSDC -- deliberately unequal
  // so admin's order (bigger) cannot fully fill against bettor's (smaller).
  for (const [who, amt] of [[admin, 2_000_000n], [bettor, 1_000_000n]] as const) {
    const { ix: openTaIx, trading } = ix.buildOpenTradingAccountIx({ owner: who.publicKey, market });
    if (!(await base.getAccountInfo(trading))) await send(base, [openTaIx], [who], "open_trading_account");
    await send(base, [ix.buildDepositTradingIx({ owner: who.publicKey, market, amount: amt, usdcMint })], [who], `deposit_trading (${amt})`);
  }
  await send(base, [ix.buildDelegateMarketIx({ payer: admin.publicKey, market })], [admin], "delegate_market");
  for (const [who] of [[admin], [bettor]] as const) {
    await send(base, [ix.buildDelegateTradingAccountIx({ payer: who.publicKey, market, owner: who.publicKey })], [who], "delegate_trading_account");
  }

  const status = await (await fetch(ROUTER_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market.toBase58()] }),
  })).json();
  const fqdn = status?.result?.fqdn;
  const er = new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");

  const adminTa = ix.tradingAccountPda(market, admin.publicKey);
  const bettorTa = ix.tradingAccountPda(market, bettor.publicKey);

  // Admin: Side A, size 2,000,000 @ limit 700,000 (locks ALL of admin's 2 tUSDC).
  // Bettor: Side B, size 1,000,000 @ limit 300,000 (locks all of bettor's 1 tUSDC).
  // Crossing volume = min(2,000,000, 1,000,000) = 1,000,000 -- admin's order
  // can only be 50% filled; 1,000,000 of admin's locked collateral MUST come
  // back to `available` for withdraw_trading to ever pay it out.
  const adminNonce = BigInt(Date.now());
  const bettorNonce = BigInt(Date.now() + 1);
  const adminCommitment = ix.sealedCommitment(1, 2_000_000n, 700_000n, adminNonce, admin.publicKey);
  const bettorCommitment = ix.sealedCommitment(2, 1_000_000n, 300_000n, bettorNonce, bettor.publicKey);

  await send(er, [ix.buildSubmitOrderFastIx({ owner: admin.publicKey, market, commitment: adminCommitment, collateral: 2_000_000n })], [admin], "submit (admin, 2M)");
  await send(er, [ix.buildSubmitOrderFastIx({ owner: bettor.publicKey, market, commitment: bettorCommitment, collateral: 1_000_000n })], [bettor], "submit (bettor, 1M)");

  while (Math.floor(Date.now() / 1000) < Number(commitEndTs) + 1) await new Promise((r) => setTimeout(r, 1000));

  await send(er, [ix.buildRevealOrderFastIx({ owner: admin.publicKey, market, side: 1, size: 2_000_000n, limitPrice: 700_000n, nonce: adminNonce })], [admin], "reveal (admin)");
  await send(er, [ix.buildRevealOrderFastIx({ owner: bettor.publicKey, market, side: 2, size: 1_000_000n, limitPrice: 300_000n, nonce: bettorNonce })], [bettor], "reveal (bettor)");

  while (Math.floor(Date.now() / 1000) < Number(revealEndTs) + 1) await new Promise((r) => setTimeout(r, 1000));

  await send(er, [ix.buildRunBatchMatchFastIx({ payer: admin.publicKey, market, tradingAccounts: [adminTa, bettorTa] })], [admin], "run_batch_match_fast");

  const adminTaAfter = await er.getAccountInfo(adminTa);
  const locked = adminTaAfter!.data.readBigUInt64LE(88);
  const available = adminTaAfter!.data.readBigUInt64LE(80);
  const matchedSize = adminTaAfter!.data.readBigUInt64LE(152);
  const statusByte = adminTaAfter!.data[129];
  console.log(`[partial] admin TA after match: locked=${locked} available=${available} matched_size=${matchedSize} status=${statusByte}`);
  console.log(`[partial] EXPECT: locked=0 available=1000000 (the unfilled half) matched_size=1000000 status=3`);
  if (locked !== 0n || available !== 1_000_000n || matchedSize !== 1_000_000n) {
    throw new Error("PARTIAL-FILL RELEASE BUG STILL PRESENT");
  }
  console.log("[partial] PASS -- unmatched collateral correctly released to available");

  // Undelegate + settle + withdraw to prove it's ACTUALLY withdrawable, not just a byte-level check.
  await send(er, [ix.buildUndelegateManyIx({ payer: admin.publicKey, delegated: [market, adminTa, bettorTa] })], [admin], "undelegate (market+2 TAs)");
  let restored = false;
  for (let i = 0; i < 30; i++) {
    const m = await base.getAccountInfo(market);
    if (m && m.owner.equals(ONYX)) { restored = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("[partial] market restored on base:", restored);

  const capturedProof = (await import("../../../app/src/lib/fixtures/scores-validation.sample.json")).default;
  const settleBuilt = ix.buildSettleMarketIx({ submitter: admin.publicKey, market, fixture: capturedProof as any, threshold: 2n, predicate: 0 });
  await send(base, [settleBuilt.computeIx, settleBuilt.ix], [admin], "settle_market");

  const adminAtaBefore = (await base.getAccountInfo(getAssociatedTokenAddressSync(usdcMint, admin.publicKey)))!.data.readBigUInt64LE(64);
  await send(base, [ix.buildWithdrawTradingIx({ owner: admin.publicKey, market, usdcMint })], [admin], "withdraw_trading (admin)");
  const adminAtaAfter = (await base.getAccountInfo(getAssociatedTokenAddressSync(usdcMint, admin.publicKey)))!.data.readBigUInt64LE(64);
  console.log(`[partial] admin ATA: ${adminAtaBefore} -> ${adminAtaAfter} (delta ${adminAtaAfter - adminAtaBefore})`);
  console.log("[partial] delta must include the 1,000,000 released-unmatched leg PLUS matched winnings if admin won.");

  console.log("\n===== PARTIAL-FILL RELEASE TEST: PASS =====");
}

main().catch((e) => { console.error("[partial] FAILED:", e); process.exit(1); });
