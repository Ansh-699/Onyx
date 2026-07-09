// L0 loop devnet integration test — the real Phase 1 exit criterion.
//
// Exercises the ONYX settlement program against the LIVE devnet txoracle
// program with a REAL captured validate_stat proof (fixtures/scores-validation.sample.json):
//
//   initialize_config -> open_market -> join_market (x2) -> settle_market
//   (real CPI into txoracle.validate_stat) -> claim
//
// refund_expired is intentionally NOT exercised live here: it requires
// `now > deadline + SETTLE_GRACE` (2h), which isn't practical to wait out
// interactively. Its logic is covered by the host-side unit tests instead
// (see task 5 / cargo test) with a simulated Clock.
//
// This program is hand-rolled Pinocchio (no Anchor IDL), so instructions are
// built by hand from the exact byte layouts documented in each
// programs/onyx/src/instructions/*.rs file. No borsh dependency is added —
// the small set of primitives needed (u8/u16/u32/u64/i32/i64 LE, Vec<T> with
// u32 LE length prefix, Option<T> as a 1-byte tag) are hand-written below and
// double-checked field-by-field against the Rust structs in cpi/txoracle.rs.
//
// Usage: cd onyx && bun run services/ingestion/src/l0_loop_test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import * as cfg from "./config";
import { loadFixture } from "./fixture";

const RPC_URL = cfg.SOLANA_RPC_URL;
const ONYX_PROGRAM_ID = new PublicKey(
  process.env.ONYX_PROGRAM_ID ?? "4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB",
);
const TXORACLE_PROGRAM_ID = new PublicKey(cfg.TXORACLE_PROGRAM_ID);

// ---- byte-buffer helpers (hand-rolled, mirrors util.rs / borsh rules) ----

class Writer {
  chunks: Buffer[] = [];
  u8(v: number) {
    this.chunks.push(Buffer.from([v & 0xff]));
    return this;
  }
  u16le(v: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  u32le(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.chunks.push(b);
    return this;
  }
  i32le(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  u64le(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  i64le(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v, 0);
    this.chunks.push(b);
    return this;
  }
  bytes(b: Buffer | Uint8Array) {
    this.chunks.push(Buffer.from(b));
    return this;
  }
  bool(v: boolean) {
    this.chunks.push(Buffer.from([v ? 1 : 0]));
    return this;
  }
  // borsh Vec<T>: u32 LE length prefix, then elements
  vec<T>(items: T[], writeItem: (w: Writer, item: T) => void) {
    this.u32le(items.length);
    for (const it of items) writeItem(this, it);
    return this;
  }
  // borsh Option<T>: 1-byte tag (0=None,1=Some) then T if Some
  option<T>(v: T | null | undefined, writeItem: (w: Writer, item: T) => void) {
    if (v === null || v === undefined) {
      this.u8(0);
    } else {
      this.u8(1);
      writeItem(this, v);
    }
    return this;
  }
  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface ProofNodeJs {
  hash: number[];
  isRightSibling: boolean;
}
function writeProofNode(w: Writer, n: ProofNodeJs) {
  w.bytes(Buffer.from(n.hash)); // [u8;32]
  w.bool(n.isRightSibling); // is_right_sibling
}

// ---- constants mirrored from programs/onyx/src/constants.rs ----
const IX_INITIALIZE_CONFIG = 0;
const IX_OPEN_MARKET = 1;
const IX_JOIN_MARKET = 2;
const IX_SETTLE_MARKET = 5;
const IX_CLAIM = 6;

const SIDE_A = 1;
const SIDE_B = 2;

const OP_NONE = 0xff;
const CMP_GREATER_THAN = 0;

const SEED_CONFIG = Buffer.from("config");
const SEED_MARKET = Buffer.from("market");
const SEED_VAULT = Buffer.from("vault");
const SEED_POSITION = Buffer.from("pos");
const SEED_DAILY_SCORES_ROOTS = Buffer.from("daily_scores_roots");

function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
}
function i64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v, 0);
  return b;
}
function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}
function u16le(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

async function confirm(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const bh = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );
  console.log(`[l0] ${label} -> ${sig}`);
  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))),
  );
  const sideBPath = process.env.SIDE_B_WALLET ?? "/tmp/onyx_side_b.json";
  const sideB = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(sideBPath, "utf8"))));

  console.log("[l0] admin/creator/sideA:", admin.publicKey.toBase58());
  console.log("[l0] sideB:", sideB.publicKey.toBase58());
  console.log("[l0] ONYX program:", ONYX_PROGRAM_ID.toBase58());
  console.log("[l0] txoracle program:", TXORACLE_PROGRAM_ID.toBase58());

  // ---- Config PDA: create once; reuse if it already exists ----
  const [configPda] = PublicKey.findProgramAddressSync([SEED_CONFIG], ONYX_PROGRAM_ID);
  console.log("[l0] config PDA:", configPda.toBase58());

  const configInfo = await connection.getAccountInfo(configPda);
  let usdcMint: PublicKey;

  if (configInfo) {
    // Config already initialized (e.g. re-running this script). Read the mint
    // back out at its fixed offset (Config layout: usdc_mint at bytes 40..72).
    usdcMint = new PublicKey(configInfo.data.subarray(40, 72));
    console.log("[l0] config already initialized; reusing usdc_mint:", usdcMint.toBase58());
  } else {
    // Devnet test escrow token (stand-in for USDC; the program only checks
    // that the mint passed to open_market matches config.usdc_mint — it does
    // not care which mint address). 6 decimals to mirror real USDC.
    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
    console.log("[l0] created devnet test-USDC mint:", usdcMint.toBase58());

    const feeBps = 100; // 1%
    const initArgs = Buffer.concat([
      admin.publicKey.toBuffer(),
      usdcMint.toBuffer(),
      TXORACLE_PROGRAM_ID.toBuffer(),
      u16le(feeBps),
    ]);
    const ix = new TransactionInstruction({
      programId: ONYX_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX_INITIALIZE_CONFIG]), initArgs]),
    });
    await confirm(connection, [ix], [admin], "initialize_config");
  }

  // ---- Fund both sides' ATAs with the escrow token ----
  const adminAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, admin.publicKey);
  const sideBAta = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, sideB.publicKey);
  const STAKE = 10_000_000n; // 10.000000 (6dp)
  if (adminAta.amount < STAKE) {
    await mintTo(connection, admin, usdcMint, adminAta.address, admin, 1_000_000_000n);
  }
  if (sideBAta.amount < STAKE) {
    await mintTo(connection, admin, usdcMint, sideBAta.address, admin, 1_000_000_000n);
  }
  console.log("[l0] admin ATA:", adminAta.address.toBase58());
  console.log("[l0] sideB ATA:", sideBAta.address.toBase58());

  // ---- Load the real captured proof fixture and derive market terms ----
  const fixture = loadFixture("fixtures/scores-validation.sample.json");
  const p = fixture.payload;
  const stat = p.statsToProve[0]!;
  console.log(
    `[l0] fixture: fixtureId=${fixture.fixtureId} stat.key=${stat.key} stat.value=${stat.value} epochDay=${fixture.epochDay}`,
  );

  const fixtureIdU64 = BigInt(fixture.fixtureId);
  const statAKey = stat.key >>> 0;
  const statBKey = 0;
  const op = OP_NONE;
  const predicate = CMP_GREATER_THAN; // stat.value(3) > threshold(2) -> true -> side A wins
  const threshold = 2n;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deadline = nowSec + 900n; // +15 min, comfortably in the future

  const paramsBuf = Buffer.concat([
    u64le(fixtureIdU64),
    u32le(statAKey),
    u32le(statBKey),
    Buffer.from([op]),
    Buffer.from([predicate]),
    i64le(threshold),
    i64le(deadline),
  ]);
  const paramsHash = sha256(paramsBuf);

  const fixtureLe = u64le(fixtureIdU64);
  const [marketPda] = PublicKey.findProgramAddressSync(
    [SEED_MARKET, fixtureLe, paramsHash],
    ONYX_PROGRAM_ID,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [SEED_VAULT, marketPda.toBuffer()],
    ONYX_PROGRAM_ID,
  );
  console.log("[l0] market PDA:", marketPda.toBase58());
  console.log("[l0] vault PDA:", vaultPda.toBase58());

  const marketInfo = await connection.getAccountInfo(marketPda);
  if (!marketInfo) {
    const openArgs = Buffer.concat([
      fixtureLe,
      u32le(statAKey),
      u32le(statBKey),
      Buffer.from([op]),
      Buffer.from([predicate]),
      i64le(threshold),
      i64le(deadline),
      paramsHash,
    ]);
    const ix = new TransactionInstruction({
      programId: ONYX_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: usdcMint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX_OPEN_MARKET]), openArgs]),
    });
    await confirm(connection, [ix], [admin], "open_market");
  } else {
    console.log("[l0] market already open; reusing.");
  }

  // ---- join_market: admin takes side A, sideB takes side B ----
  async function joinIfNeeded(user: Keypair, userAta: PublicKey, side: number) {
    const [posPda] = PublicKey.findProgramAddressSync(
      [SEED_POSITION, marketPda.toBuffer(), user.publicKey.toBuffer()],
      ONYX_PROGRAM_ID,
    );
    const existing = await connection.getAccountInfo(posPda);
    if (existing) {
      console.log(`[l0] position for ${user.publicKey.toBase58()} already exists; skipping join.`);
      return;
    }
    const args = Buffer.concat([Buffer.from([side]), u64le(STAKE)]);
    const ix = new TransactionInstruction({
      programId: ONYX_PROGRAM_ID,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: posPda, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX_JOIN_MARKET]), args]),
    });
    await confirm(connection, [ix], [user], `join_market(side=${side}, user=${user.publicKey.toBase58().slice(0, 8)})`);
  }
  await joinIfNeeded(admin, adminAta.address, SIDE_A);
  await joinIfNeeded(sideB, sideBAta.address, SIDE_B);

  // ---- settle_market: build ValidateStatArgs from the REAL captured proof ----
  const [rootsPda] = PublicKey.findProgramAddressSync(
    [SEED_DAILY_SCORES_ROOTS, u16le(fixture.epochDay)],
    TXORACLE_PROGRAM_ID,
  );
  const rootsInfo = await connection.getAccountInfo(rootsPda);
  console.log(
    `[l0] daily_scores_roots PDA: ${rootsPda.toBase58()} (${rootsInfo ? "found on-chain" : "MISSING"})`,
  );
  if (!rootsInfo) throw new Error("daily_scores_roots account not found for this epochDay");

  const w = new Writer();
  w.i64le(BigInt(fixture.targetTsMs)); // ts
  // fixture_summary
  w.i64le(BigInt(p.summary.fixtureId));
  w.i32le(p.summary.updateStats.updateCount);
  w.i64le(BigInt(p.summary.updateStats.minTimestamp));
  w.i64le(BigInt(p.summary.updateStats.maxTimestamp));
  w.bytes(Buffer.from(p.summary.eventStatsSubTreeRoot));
  // fixture_proof: Vec<ProofNode> = subTreeProof
  w.vec(p.subTreeProof as ProofNodeJs[], writeProofNode);
  // main_tree_proof: Vec<ProofNode>
  w.vec(p.mainTreeProof as ProofNodeJs[], writeProofNode);
  // predicate: TraderPredicate { threshold: i32, comparison: u8 enum }
  w.i32le(Number(threshold));
  w.u8(predicate);
  // stat_a: StatTerm { stat_to_prove: ScoreStat{key,value,period}, event_stat_root, stat_proof }
  w.u32le(stat.key);
  w.i32le(stat.value);
  w.i32le(stat.period);
  w.bytes(Buffer.from(p.eventStatRoot));
  w.vec(p.statProofs[0] as ProofNodeJs[], writeProofNode);
  // stat_b: Option<StatTerm> = None
  w.option<never>(null, () => {});
  // op: Option<BinaryExpression> = None
  w.option<never>(null, () => {});

  const settleArgs = w.build();

  const marketStatusBefore = (await connection.getAccountInfo(marketPda))!.data[26];
  console.log("[l0] market status before settle:", marketStatusBefore);

  let settleSig: string;
  if (marketStatusBefore === 4 /* STATUS_SETTLED */ || marketStatusBefore === 5 /* CLAIMED */) {
    console.log("[l0] market already settled; skipping settle_market CPI call.");
    settleSig = "(skipped: already settled)";
  } else {
    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    const settleIx = new TransactionInstruction({
      programId: ONYX_PROGRAM_ID,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: TXORACLE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: rootsPda, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX_SETTLE_MARKET]), settleArgs]),
    });
    settleSig = await confirm(connection, [computeIx, settleIx], [admin], "settle_market (CPI -> validate_stat)");
  }

  const marketAfter = await connection.getAccountInfo(marketPda);
  const statusAfter = marketAfter!.data[26];
  const outcomeAfter = marketAfter!.data[27];
  const statusNames: Record<number, string> = {
    1: "Open",
    2: "Live",
    3: "Settling",
    4: "Settled",
    5: "Claimed",
    6: "Expired",
    7: "Refunded",
  };
  const outcomeNames: Record<number, string> = { 0: "Unknown", 1: "SideA", 2: "SideB" };
  console.log(
    `[l0] market status after settle: ${statusNames[statusAfter] ?? statusAfter} outcome: ${outcomeNames[outcomeAfter] ?? outcomeAfter}`,
  );

  // ---- claim: the winning side claims payout ----
  const winner = outcomeAfter === 1 ? admin : sideB;
  const winnerAta = outcomeAfter === 1 ? adminAta.address : sideBAta.address;
  const [winnerPos] = PublicKey.findProgramAddressSync(
    [SEED_POSITION, marketPda.toBuffer(), winner.publicKey.toBuffer()],
    ONYX_PROGRAM_ID,
  );
  const posInfoBefore = await connection.getAccountInfo(winnerPos);
  const claimedBefore = posInfoBefore ? posInfoBefore.data[81] : 1;

  let claimSig = "(skipped: already claimed)";
  if (claimedBefore === 0) {
    const balanceBefore = (await getAccount(connection, winnerAta)).amount;
    const claimIx = new TransactionInstruction({
      programId: ONYX_PROGRAM_ID,
      keys: [
        { pubkey: winner.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: marketPda, isSigner: false, isWritable: true },
        { pubkey: winnerPos, isSigner: false, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: winnerAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([IX_CLAIM]),
    });
    claimSig = await confirm(connection, [claimIx], [winner], `claim(winner=${winner.publicKey.toBase58().slice(0, 8)})`);
    const balanceAfter = (await getAccount(connection, winnerAta)).amount;
    console.log(
      `[l0] winner balance: ${balanceBefore} -> ${balanceAfter} (+${balanceAfter - balanceBefore})`,
    );
  }

  console.log("\n===== L0 LOOP RESULT =====");
  console.log("ONYX program id:      ", ONYX_PROGRAM_ID.toBase58());
  console.log("Market PDA:           ", marketPda.toBase58());
  console.log("settle_market tx:     ", settleSig);
  console.log("claim tx:             ", claimSig);
  console.log("Oracle CPI outcome:   ", outcomeNames[outcomeAfter] ?? outcomeAfter, `(raw stat value ${stat.value} ${predicate === 0 ? ">" : "?"} threshold ${threshold})`);
  console.log("Market status:        ", statusNames[statusAfter] ?? statusAfter);
  console.log("===========================");
}

main().catch((e) => {
  console.error("[l0] FAILED:", e);
  process.exit(1);
});
