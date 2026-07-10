// Live negative test for run_batch_match_fast's batch-inclusion completeness
// check (programs/onyx/src/instructions/run_batch_match_fast.rs). Sets up
// TWO genuinely revealed orders, then tries two attacks:
//   (a) wrong count: pass only 1 account when revealed_count == 2
//   (b) padding: pass the SAME account twice (satisfies the count) while
//       genuinely omitting the second real order
// Both must fail. If either SUCCEEDS, the completeness check is broken.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
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

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string, expectFail: boolean) {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  const failed = !!conf.value.err;
  console.log(`[attack] ${label} -> ${sig} : ${failed ? "FAILED (" + JSON.stringify(conf.value.err) + ")" : "SUCCEEDED"} [expected ${expectFail ? "FAIL" : "SUCCEED"}] ${failed === expectFail ? "-- correct" : "*** WRONG, SECURITY BUG ***"}`);
  return { sig, failed };
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
  console.log("[attack] market:", market.toBase58());

  if (!(await base.getAccountInfo(market))) {
    const { ix: openIx } = ix.buildOpenMarketSealedIx({
      creator: admin.publicKey, usdcMint,
      terms: { fixtureId, statAKey: 1, statBKey: 0, op: 0xff, predicate: 0, threshold: 2n, deadline },
      paramsHash, commitEndTs, revealEndTs,
    });
    await send(base, [openIx], [admin], "open_market_sealed", false);
  }

  for (const [who] of [[admin], [bettor]] as const) {
    const { ix: openTaIx, trading } = ix.buildOpenTradingAccountIx({ owner: who.publicKey, market });
    if (!(await base.getAccountInfo(trading))) await send(base, [openTaIx], [who], "open_trading_account", false);
    await send(base, [ix.buildDepositTradingIx({ owner: who.publicKey, market, amount: 500_000n, usdcMint })], [who], "deposit_trading", false);
  }

  await send(base, [ix.buildDelegateMarketIx({ payer: admin.publicKey, market })], [admin], "delegate_market", false);
  for (const [who] of [[admin], [bettor]] as const) {
    await send(base, [ix.buildDelegateTradingAccountIx({ payer: who.publicKey, market, owner: who.publicKey })], [who], "delegate_trading_account", false);
  }

  const status = await (await fetch(ROUTER_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market.toBase58()] }),
  })).json();
  const fqdn = status?.result?.fqdn;
  const er = new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");

  const adminTa = ix.tradingAccountPda(market, admin.publicKey);
  const bettorTa = ix.tradingAccountPda(market, bettor.publicKey);
  const adminNonce = BigInt(Date.now());
  const bettorNonce = BigInt(Date.now() + 1);
  const adminCommitment = ix.sealedCommitment(1, 400_000n, 700_000n, adminNonce, admin.publicKey);
  const bettorCommitment = ix.sealedCommitment(2, 400_000n, 300_000n, bettorNonce, bettor.publicKey);

  await send(er, [ix.buildSubmitOrderFastIx({ owner: admin.publicKey, market, commitment: adminCommitment, collateral: 400_000n })], [admin], "submit (admin)", false);
  await send(er, [ix.buildSubmitOrderFastIx({ owner: bettor.publicKey, market, commitment: bettorCommitment, collateral: 400_000n })], [bettor], "submit (bettor)", false);

  while (Math.floor(Date.now() / 1000) < Number(commitEndTs) + 1) await new Promise((r) => setTimeout(r, 1000));

  await send(er, [ix.buildRevealOrderFastIx({ owner: admin.publicKey, market, side: 1, size: 400_000n, limitPrice: 700_000n, nonce: adminNonce })], [admin], "reveal (admin)", false);
  await send(er, [ix.buildRevealOrderFastIx({ owner: bettor.publicKey, market, side: 2, size: 400_000n, limitPrice: 300_000n, nonce: bettorNonce })], [bettor], "reveal (bettor)", false);

  while (Math.floor(Date.now() / 1000) < Number(revealEndTs) + 1) await new Promise((r) => setTimeout(r, 1000));

  const erMarket = await er.getAccountInfo(market);
  console.log("[attack] revealed_count on ER (byte 127):", erMarket!.data[127], "(expect 2)");

  console.log("\n--- ATTACK (a): wrong count -- pass only 1 account when revealed_count == 2 ---");
  await send(er, [ix.buildRunBatchMatchFastIx({ payer: admin.publicKey, market, tradingAccounts: [adminTa] })], [admin], "run_batch_match_fast(1 account, omitting bettor)", true);

  console.log("\n--- ATTACK (b): padding -- pass adminTa TWICE (correct count=2, but bettor genuinely omitted) ---");
  await send(er, [ix.buildRunBatchMatchFastIx({ payer: admin.publicKey, market, tradingAccounts: [adminTa, adminTa] })], [admin], "run_batch_match_fast(adminTa,adminTa duplicate)", true);

  console.log("\n--- LEGITIMATE: pass both real accounts, once each ---");
  const legit = await send(er, [ix.buildRunBatchMatchFastIx({ payer: admin.publicKey, market, tradingAccounts: [adminTa, bettorTa] })], [admin], "run_batch_match_fast(adminTa,bettorTa) LEGITIMATE", false);

  console.log("\n===== OMISSION ATTACK TEST COMPLETE =====");
  console.log("market:", market.toBase58());
}

main().catch((e) => { console.error("[attack] FAILED:", e); process.exit(1); });
