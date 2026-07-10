// Live test for cancel_order_fast: commit, verify locked, cancel, verify
// available restored and revealed_count untouched (order was never revealed).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as ix from "../../../app/src/lib/instructions";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ROUTER_URL = "https://devnet-router.magicblock.app/";
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));

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
  console.log(`[cancel-test] ${label} -> ${sig} : ${conf.value.err ? "FAILED " + JSON.stringify(conf.value.err) : "SUCCEEDED"}`);
  if (conf.value.err) throw new Error(label + " failed");
  return sig;
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  const fixtureId = 18179550n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const commitEndTs = now + 60n;
  const revealEndTs = now + 120n;
  const paramsHash = sha256(u64le(fixtureId), u32le(1), u32le(0), Buffer.from([0xff]), Buffer.from([0]), i64le(2n), i64le(deadline));
  const market = ix.marketPdaFromTerms(fixtureId, paramsHash);
  console.log("[cancel-test] market:", market.toBase58());

  if (!(await base.getAccountInfo(market))) {
    const { ix: openIx } = ix.buildOpenMarketSealedIx({
      creator: admin.publicKey, usdcMint,
      terms: { fixtureId, statAKey: 1, statBKey: 0, op: 0xff, predicate: 0, threshold: 2n, deadline },
      paramsHash, commitEndTs, revealEndTs,
    });
    await send(base, [openIx], [admin], "open_market_sealed");
  }
  const { ix: openTaIx, trading } = ix.buildOpenTradingAccountIx({ owner: admin.publicKey, market });
  if (!(await base.getAccountInfo(trading))) await send(base, [openTaIx], [admin], "open_trading_account");
  await send(base, [ix.buildDepositTradingIx({ owner: admin.publicKey, market, amount: 1_000_000n, usdcMint })], [admin], "deposit_trading (1 tUSDC)");
  await send(base, [ix.buildDelegateMarketIx({ payer: admin.publicKey, market })], [admin], "delegate_market");
  await send(base, [ix.buildDelegateTradingAccountIx({ payer: admin.publicKey, market, owner: admin.publicKey })], [admin], "delegate_trading_account");

  const status = await (await fetch(ROUTER_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market.toBase58()] }),
  })).json();
  const fqdn = status?.result?.fqdn;
  const er = new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");

  const before = await er.getAccountInfo(trading);
  console.log("[cancel-test] BEFORE commit: available =", before!.data.readBigUInt64LE(80).toString(), "locked =", before!.data.readBigUInt64LE(88).toString(), "status =", before!.data[129]);

  const nonce = BigInt(Date.now());
  const commitment = ix.sealedCommitment(1, 500_000n, 500_000n, nonce, admin.publicKey);
  await send(er, [ix.buildSubmitOrderFastIx({ owner: admin.publicKey, market, commitment, collateral: 500_000n })], [admin], "submit_order_fast");

  const afterCommit = await er.getAccountInfo(trading);
  console.log("[cancel-test] AFTER commit: available =", afterCommit!.data.readBigUInt64LE(80).toString(), "locked =", afterCommit!.data.readBigUInt64LE(88).toString(), "status =", afterCommit!.data[129], "(expect available=500000 locked=500000 status=1)");

  await send(er, [ix.buildCancelOrderFastIx({ owner: admin.publicKey, market })], [admin], "cancel_order_fast");

  const afterCancel = await er.getAccountInfo(trading);
  console.log("[cancel-test] AFTER cancel: available =", afterCancel!.data.readBigUInt64LE(80).toString(), "locked =", afterCancel!.data.readBigUInt64LE(88).toString(), "status =", afterCancel!.data[129], "(expect available=1000000 locked=0 status=0)");

  const marketAfter = await er.getAccountInfo(market);
  console.log("[cancel-test] revealed_count after cancel (byte 127):", marketAfter!.data[127], "(expect 0 -- order was never revealed, cancel of a Locked order must not touch the counter)");

  // Re-submit to prove the slot is reusable after cancel (same TradingAccount, new commitment).
  const nonce2 = BigInt(Date.now() + 1);
  const commitment2 = ix.sealedCommitment(2, 300_000n, 200_000n, nonce2, admin.publicKey);
  await send(er, [ix.buildSubmitOrderFastIx({ owner: admin.publicKey, market, commitment: commitment2, collateral: 300_000n })], [admin], "submit_order_fast (re-commit after cancel)");
  const afterResubmit = await er.getAccountInfo(trading);
  console.log("[cancel-test] AFTER re-commit: available =", afterResubmit!.data.readBigUInt64LE(80).toString(), "locked =", afterResubmit!.data.readBigUInt64LE(88).toString(), "status =", afterResubmit!.data[129], "(expect available=700000 locked=300000 status=1)");

  console.log("\n===== CANCEL TEST COMPLETE =====");
  console.log("market:", market.toBase58());
}

main().catch((e) => { console.error("[cancel-test] FAILED:", e); process.exit(1); });
