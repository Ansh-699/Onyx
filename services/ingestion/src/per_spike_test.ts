// MagicBlock PER/TEE de-risk spike (task 8) — native Pinocchio access-control
// CPI probe. NOT a full PER build; answers one concrete question with real
// on-chain evidence: can our native Pinocchio program CPI into MagicBlock's
// Permission Program (access_control) to gate a PDA it owns, the same way
// cpi_delegate proved the Delegation Program CPI works (task 7)?
//
// Uses a THROWAWAY market (fresh fixture id) — NEVER the L0-proven or
// ER-proven markets.
//
// Stage:
//   A. open_market (throwaway, fixture 900000004)         [base]
//   B. create_market_permission (disc 14)                  [base] => tx
//   C. read back the Permission account, decode it, verify:
//        - owned by the Permission Program
//        - permissioned_account == our market PDA
//        - members == [{flags: AUTHORITY, pubkey: admin}]
//
// Usage: cd onyx && bun run services/ingestion/src/per_spike_test.ts

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
const ONYX = new PublicKey(process.env.ONYX_PROGRAM_ID ?? "4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

const IX_OPEN_MARKET = 1;
const IX_CREATE_MARKET_PERMISSION = 14;
const OP_NONE = 0xff, CMP_GREATER_THAN = 0;
const SEED_MARKET = Buffer.from("market"), SEED_VAULT = Buffer.from("vault");
const PERMISSION_SEED = Buffer.from("permission:"); // trailing colon is exact

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
  console.log(`[per] ${label} -> ${sig}`);
  return sig;
}

async function main() {
  const base = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));
  console.log("[per] admin:", admin.publicKey.toBase58());
  console.log("[per] ONYX program:", ONYX.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  if (!configInfo) throw new Error("config not initialized; run l0_loop_test first");
  const usdcMint = new PublicKey(configInfo.data.subarray(40, 72));

  // ---- Stage A: throwaway market (fresh fixture, never reused for ER/L0) ----
  const fixtureId = BigInt(process.env.PER_FIXTURE_ID ?? "900000004");
  const statKey = 1, threshold = 2n, deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const paramsHash = sha256(u64le(fixtureId), u32le(statKey), u32le(0), Buffer.from([OP_NONE]), Buffer.from([CMP_GREATER_THAN]), i64le(threshold), i64le(deadline));
  const fixtureLe = u64le(fixtureId);
  const [market] = PublicKey.findProgramAddressSync([SEED_MARKET, fixtureLe, paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([SEED_VAULT, market.toBuffer()], ONYX);
  console.log("[per] throwaway market PDA:", market.toBase58());

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
    })], [admin], "open_market (throwaway, PER spike)");
  } else {
    console.log("[per] throwaway market already exists; reusing.");
  }

  // ---- Stage B: create_market_permission ----
  const [permission] = PublicKey.findProgramAddressSync([PERMISSION_SEED, market.toBuffer()], PERMISSION_PROGRAM);
  console.log("[per] permission PDA:", permission.toBase58());

  let createSig = "(skipped: permission already exists)";
  const existing = await base.getAccountInfo(permission);
  if (!existing) {
    createSig = await send(base, [new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: permission, isSigner: false, isWritable: true },
        { pubkey: PERMISSION_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([IX_CREATE_MARKET_PERMISSION]),
    })], [admin], "create_market_permission");
  }

  // ---- Stage C: read back + decode the Permission account ----
  const permInfo = await base.getAccountInfo(permission);
  console.log("\n===== PER ACCESS-CONTROL SPIKE RESULT =====");
  console.log("ONYX program:        ", ONYX.toBase58());
  console.log("throwaway market:    ", market.toBase58());
  console.log("permission PDA:      ", permission.toBase58());
  console.log("create tx:           ", createSig);
  if (!permInfo) {
    console.log("permission account:   NOT FOUND (FAIL)");
  } else {
    console.log("permission owner:    ", permInfo.owner.toBase58(), permInfo.owner.equals(PERMISSION_PROGRAM) ? "(Permission Program ✓)" : "(WRONG ✗)");
    const d = permInfo.data;
    const disc = d[0], bump = d[1];
    const permissionedAccount = new PublicKey(d.subarray(2, 34));
    // Option<Vec<Member>>: tag byte, then (if Some) u32 LE len + N*(flags:1, pubkey:32)
    const someTag = d[34];
    let membersDesc = "None";
    if (someTag === 1) {
      const count = d.readUInt32LE(35);
      const members: string[] = [];
      let off = 39;
      for (let i = 0; i < count; i++) {
        const flags = d[off];
        const pk = new PublicKey(d.subarray(off + 1, off + 33));
        members.push(`{flags=${flags}, pubkey=${pk.toBase58()}}`);
        off += 33;
      }
      membersDesc = `[${members.join(", ")}]`;
    }
    console.log("discriminator:       ", disc, "bump:", bump);
    console.log("permissioned_account:", permissionedAccount.toBase58(), permissionedAccount.equals(market) ? "(== our market ✓)" : "(MISMATCH ✗)");
    console.log("members:             ", membersDesc);
    const adminIsSoleAuthority = membersDesc.includes(admin.publicKey.toBase58()) && someTag === 1;
    console.log("gated to admin only: ", adminIsSoleAuthority ? "YES ✓" : "NO ✗");
  }
  console.log("=============================================");
}

main().catch((e) => { console.error("[per] FAILED:", e); process.exit(1); });
