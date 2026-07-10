// Phase-0 design research probe (NOT a feature, NOT the acceptance proof) —
// answers one narrow empirical question the ER trading design depends on:
// can a Pinocchio program CREATE A BRAND-NEW PDA (via System Program
// CreateAccount) inside a transaction sent to the ER RPC, when only the
// Market account is delegated — or does every account that ends up
// ER-resident need its own prior base-layer delegate step?
//
// Method: delegate a fresh throwaway SEALED market, then send
// submit_sealed_order (which does CreateAccount for a SealedOrder PDA +
// an SPL Token Transfer for collateral) to the ER RPC and inspect exactly
// where it succeeds or fails via tx logs.
//
// Usage: cd onyx && bun run services/ingestion/src/er_order_probe.ts

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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as cfg from "./config";

const RPC_URL = cfg.SOLANA_RPC_URL;
const ROUTER_URL = process.env.MAGICBLOCK_ROUTER_URL ?? "https://devnet-router.magicblock.app/";
const ONYX = new PublicKey(process.env.ONYX_PROGRAM_ID ?? "4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

const IX_OPEN_MARKET_SEALED = 15, IX_DELEGATE_MARKET = 3, IX_SUBMIT_SEALED_ORDER = 16;
const OP_NONE = 0xff, CMP_GREATER_THAN = 0;
const SEED_MARKET = Buffer.from("market"), SEED_VAULT = Buffer.from("vault"), SEED_BUFFER = Buffer.from("buffer");
const SEED_DELEGATION = Buffer.from("delegation"), SEED_DELEGATION_METADATA = Buffer.from("delegation-metadata");
const SEED_ORDER = Buffer.from("order");

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...b: Buffer[]) => { const h = createHash("sha256"); for (const x of b) h.update(x); return h.digest(); };

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log(`[probe] ${label} sig -> ${sig}`);
  try {
    const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
    if (conf.value.err) {
      console.log(`[probe] ${label} landed but FAILED:`, JSON.stringify(conf.value.err));
    } else {
      console.log(`[probe] ${label} SUCCEEDED`);
    }
  } catch (e) {
    console.log(`[probe] ${label} confirmation error:`, (e as Error).message);
  }
  // Always fetch full logs regardless of outcome.
  for (let i = 0; i < 6; i++) {
    const tx2 = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (tx2) {
      console.log(`[probe] ${label} logs:\n  ` + (tx2.meta?.logMessages ?? []).join("\n  "));
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`[probe] ${label}: could not fetch tx for logs`);
  return sig;
}

async function main() {
  const base = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));
  console.log("[probe] admin:", admin.publicKey.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  if (!configInfo) throw new Error("config not initialized");
  const usdcMint = new PublicKey(configInfo.data.subarray(40, 72));
  const adminAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
  const ataInfo = await base.getAccountInfo(adminAta);
  if (!ataInfo) throw new Error("admin has no USDC ATA — fund it first");
  console.log("[probe] admin USDC ATA:", adminAta.toBase58(), "balance (raw):", ataInfo.data.readBigUInt64LE(64));

  // ---- fresh throwaway SEALED market, short windows ----
  const fixtureId = BigInt(process.env.ER_PROBE_FIXTURE_ID ?? "900000005");
  const statKey = 1, threshold = 2n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deadline = nowSec + 3600n;
  const commitEndTs = nowSec + 1800n;
  const revealEndTs = nowSec + 2400n;
  const paramsHash = sha256(u64le(fixtureId), u32le(statKey), u32le(0), Buffer.from([OP_NONE]), Buffer.from([CMP_GREATER_THAN]), i64le(threshold), i64le(deadline));
  const fixtureLe = u64le(fixtureId);
  const [market] = PublicKey.findProgramAddressSync([SEED_MARKET, fixtureLe, paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([SEED_VAULT, market.toBuffer()], ONYX);
  console.log("[probe] throwaway sealed market PDA:", market.toBase58());

  const marketInfoPre = await base.getAccountInfo(market);
  if (!marketInfoPre) {
    const openArgs = Buffer.concat([
      fixtureLe, u32le(statKey), u32le(0), Buffer.from([OP_NONE]), Buffer.from([CMP_GREATER_THAN]),
      i64le(threshold), i64le(deadline), paramsHash, i64le(commitEndTs), i64le(revealEndTs),
    ]);
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
      data: Buffer.concat([Buffer.from([IX_OPEN_MARKET_SEALED]), openArgs]),
    })], [admin], "open_market_sealed (throwaway)");
  } else {
    console.log("[probe] market already exists, reusing");
  }

  const ownerBefore = (await base.getAccountInfo(market))!.owner;
  console.log("[probe] market owner before delegate:", ownerBefore.toBase58());

  // ---- delegate (base) ----
  const [buffer] = PublicKey.findProgramAddressSync([SEED_BUFFER, market.toBuffer()], ONYX);
  const [delRecord] = PublicKey.findProgramAddressSync([SEED_DELEGATION, market.toBuffer()], DELEGATION_PROGRAM);
  const [delMetadata] = PublicKey.findProgramAddressSync([SEED_DELEGATION_METADATA, market.toBuffer()], DELEGATION_PROGRAM);

  if (ownerBefore.equals(ONYX)) {
    await send(base, [new TransactionInstruction({
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
      data: Buffer.concat([Buffer.from([IX_DELEGATE_MARKET]), u32le(0xffffffff)]),
    })], [admin], "delegate_market");
  } else {
    console.log("[probe] already delegated, skipping delegate step");
  }

  const status = await (await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market.toBase58()] }),
  })).json();
  console.log("[probe] router getDelegationStatus:", JSON.stringify(status.result ?? status.error ?? status));
  const fqdn = status?.result?.fqdn;
  if (!fqdn) throw new Error("no ER fqdn from router — cannot continue");
  const erUrl = fqdn.startsWith("http") ? fqdn : `https://${fqdn}`;
  const er = new Connection(erUrl, "confirmed");
  console.log("[probe] ER endpoint:", erUrl);

  // ---- THE TEST: submit_sealed_order sent to the ER RPC ----
  // vault and admin's USDC ATA are NOT delegated -- only the market is.
  // This will tell us definitively whether (a) CreateAccount for a brand-new
  // SealedOrder PDA succeeds on the ER when only Market is delegated, and
  // (b) whether the SPL Token Transfer leg succeeds when neither side of the
  // transfer is itself delegated.
  const nonce = BigInt(Date.now());
  const nonceLe = u64le(nonce);
  const [orderPda] = PublicKey.findProgramAddressSync(
    [SEED_ORDER, market.toBuffer(), admin.publicKey.toBuffer(), nonceLe],
    ONYX,
  );
  console.log("[probe] target order PDA (brand new, never existed anywhere):", orderPda.toBase58());
  const dummyCommitment = Buffer.alloc(32, 7);
  const collateral = 100_000n; // 0.1 tUSDC

  const submitArgs = Buffer.concat([nonceLe, dummyCommitment, u64le(collateral)]);
  await send(er, [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: orderPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: adminAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_SUBMIT_SEALED_ORDER]), submitArgs]),
  })], [admin], "submit_sealed_order (sent to ER RPC)");

  // Check whether the order PDA actually exists now, on ER and on base.
  const orderOnEr = await er.getAccountInfo(orderPda);
  const orderOnBase = await base.getAccountInfo(orderPda);
  console.log("[probe] order PDA on ER:  ", orderOnEr ? `EXISTS, owner=${orderOnEr.owner.toBase58()}, ${orderOnEr.data.length}B` : "does not exist");
  console.log("[probe] order PDA on base:", orderOnBase ? `EXISTS, owner=${orderOnBase.owner.toBase58()}, ${orderOnBase.data.length}B` : "does not exist");

  console.log("\n===== PROBE RESULT =====");
  console.log("market:", market.toBase58());
  console.log("order PDA:", orderPda.toBase58());
  console.log("=========================");
}

main().catch((e) => { console.error("[probe] FAILED:", e); process.exit(1); });
