// MagicBlock ER de-risk test — native Pinocchio program delegating a market
// into the Ephemeral Rollup, executing on the ER, and scheduling commit+undelegate.
//
// Uses a THROWAWAY market (fresh fixture id) — NEVER the L0-proven market — so a
// delegation bug can only ever strand a disposable account.
//
// Stages:
//   A. open_market (throwaway)                      [base]
//   B. delegate_market -> owner flips to dlp        [base]  => delegate tx
//   C. router getDelegationStatus + read on the ER  [ER]    => ER clone evidence
//   D. touch_market on the ER (OPEN -> LIVE)         [ER]    => ER execution
//   E. undelegate_market (ScheduleCommitAndUndelegate)[ER]  => commit/undelegate tx
//
// Usage: cd onyx && bun run services/ingestion/src/er_delegate_test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as cfg from "./config";

const RPC_URL = cfg.SOLANA_RPC_URL;
const ROUTER_URL = process.env.MAGICBLOCK_ROUTER_URL ?? "https://devnet-router.magicblock.app/";
const ONYX = new PublicKey(process.env.ONYX_PROGRAM_ID ?? "4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");

const IX_OPEN_MARKET = 1, IX_DELEGATE_MARKET = 3, IX_UNDELEGATE_MARKET = 4, IX_TOUCH_MARKET = 8;
const OP_NONE = 0xff, CMP_GREATER_THAN = 0;
const SEED_MARKET = Buffer.from("market"), SEED_VAULT = Buffer.from("vault"), SEED_BUFFER = Buffer.from("buffer");
const SEED_DELEGATION = Buffer.from("delegation"), SEED_DELEGATION_METADATA = Buffer.from("delegation-metadata");

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...b: Buffer[]) => { const h = createHash("sha256"); for (const x of b) h.update(x); return h.digest(); };

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string, skipPreflight = false) {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) {
    throw new Error(`${label} landed but FAILED: ${JSON.stringify(conf.value.err)} (sig ${sig})`);
  }
  console.log(`[er] ${label} -> ${sig}`);
  return sig;
}

async function routerGetDelegationStatus(account: PublicKey) {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
  });
  return await res.json();
}

async function main() {
  const base = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));
  console.log("[er] admin:", admin.publicKey.toBase58());
  console.log("[er] ONYX program:", ONYX.toBase58());

  // Config PDA + usdc mint (reuse the L0 config).
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  if (!configInfo) throw new Error("config not initialized; run l0_loop_test first");
  const usdcMint = new PublicKey(configInfo.data.subarray(40, 72));

  // ---- Stage A: throwaway market ----
  const fixtureId = BigInt(process.env.ER_FIXTURE_ID ?? "900000001");
  const statKey = 1, threshold = 2n, deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const paramsHash = sha256(u64le(fixtureId), u32le(statKey), u32le(0), Buffer.from([OP_NONE]), Buffer.from([CMP_GREATER_THAN]), i64le(threshold), i64le(deadline));
  const fixtureLe = u64le(fixtureId);
  const [market] = PublicKey.findProgramAddressSync([SEED_MARKET, fixtureLe, paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([SEED_VAULT, market.toBuffer()], ONYX);
  console.log("[er] throwaway market PDA:", market.toBase58());

  if (!(await base.getAccountInfo(market))) {
    const openArgs = Buffer.concat([fixtureLe, u32le(statKey), u32le(0), Buffer.from([OP_NONE]), Buffer.from([CMP_GREATER_THAN]), i64le(threshold), i64le(deadline), paramsHash]);
    await send(base, [new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX_OPEN_MARKET]), openArgs]),
    })], [admin], "open_market (throwaway)");
  } else {
    console.log("[er] throwaway market already exists; reusing.");
  }

  const ownerBefore = (await base.getAccountInfo(market))!.owner;
  console.log("[er] market owner BEFORE delegate:", ownerBefore.toBase58(), ownerBefore.equals(ONYX) ? "(ONYX ✓)" : "");

  // ---- Stage B: delegate_market (base) ----
  const [buffer] = PublicKey.findProgramAddressSync([SEED_BUFFER, market.toBuffer()], ONYX);
  const [delRecord] = PublicKey.findProgramAddressSync([SEED_DELEGATION, market.toBuffer()], DELEGATION_PROGRAM);
  const [delMetadata] = PublicKey.findProgramAddressSync([SEED_DELEGATION_METADATA, market.toBuffer()], DELEGATION_PROGRAM);

  let delegateSig = "(skipped: already delegated)";
  if (ownerBefore.equals(ONYX)) {
    const commitFreqMs = u32le(0xffffffff); // manual: commit only on undelegate
    delegateSig = await send(base, [new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: ONYX, isSigner: false, isWritable: false },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: delRecord, isSigner: false, isWritable: true },
        { pubkey: delMetadata, isSigner: false, isWritable: true },
        { pubkey: DELEGATION_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX_DELEGATE_MARKET]), commitFreqMs]),
    })], [admin], "delegate_market");
  }

  const infoAfter = await base.getAccountInfo(market);
  const ownerAfter = infoAfter!.owner;
  console.log("[er] market owner AFTER delegate: ", ownerAfter.toBase58(), ownerAfter.equals(DELEGATION_PROGRAM) ? "(DELEGATION PROGRAM ✓)" : "(NOT delegated ✗)");

  // ---- Stage C: router status + ER clone ----
  let erConn: Connection | null = null;
  try {
    const status = await routerGetDelegationStatus(market);
    console.log("[er] router getDelegationStatus:", JSON.stringify(status.result ?? status.error ?? status));
    const fqdn = status?.result?.fqdn;
    if (fqdn) {
      const erUrl = fqdn.startsWith("http") ? fqdn : `https://${fqdn}`;
      erConn = new Connection(erUrl, "confirmed");
      const erInfo = await erConn.getAccountInfo(market);
      console.log(`[er] market on ER (${erUrl}):`, erInfo ? `cloned, owner=${erInfo.owner.toBase58()} ${erInfo.owner.equals(ONYX) ? "(ONYX on ER ✓)" : ""}` : "NOT found on ER");
    }
  } catch (e) {
    console.warn("[er] router/ER read failed:", (e as Error).message);
  }

  // ---- Stage D: touch_market on the ER ----
  let touchSig = "(skipped: no ER connection)";
  if (erConn) {
    try {
      const statusBefore = (await erConn.getAccountInfo(market))?.data[26];
      touchSig = await send(erConn, [new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([IX_TOUCH_MARKET]),
      })], [admin], "touch_market (on ER)", true);
      const statusAfter = (await erConn.getAccountInfo(market))?.data[26];
      console.log(`[er] market.status on ER: ${statusBefore} -> ${statusAfter} (1=Open, 2=Live)`);
    } catch (e) {
      console.warn("[er] touch_market on ER failed:", (e as Error).message);
    }
  }

  // ---- Stage E: undelegate_market (commit+undelegate) on the ER ----
  let undelegateSig = "(skipped: no ER connection)";
  if (erConn) {
    try {
      undelegateSig = await send(erConn, [new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([IX_UNDELEGATE_MARKET]),
      })], [admin], "undelegate_market (ScheduleCommitAndUndelegate on ER)", true);
    } catch (e) {
      console.warn("[er] undelegate_market failed:", (e as Error).message);
    }
  }

  console.log("\n===== ER DE-RISK RESULT =====");
  console.log("ONYX program:      ", ONYX.toBase58());
  console.log("throwaway market:  ", market.toBase58());
  console.log("delegate tx:       ", delegateSig);
  console.log("owner after delegate:", ownerAfter.toBase58(), ownerAfter.equals(DELEGATION_PROGRAM) ? "(delegated ✓)" : "");
  console.log("touch tx (ER exec):", touchSig);
  console.log("undelegate tx:     ", undelegateSig);
  console.log("=============================");
}

main().catch((e) => { console.error("[er] FAILED:", e); process.exit(1); });
