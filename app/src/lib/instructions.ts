// Pure ONYX instruction builders — framework-agnostic (no React, no wallet
// assumptions). Used by BOTH the wallet-signed UI components (which call
// `wallet.sendTransaction`) AND a plain-keypair verification script
// (`scripts/verify-flow.ts`, `bun run` directly), so the exact bytes the UI
// sends to a connected wallet are also exercised against real devnet outside
// the browser. No Anchor/IDL — this is a native Pinocchio program, so every
// instruction is hand-encoded to mirror programs/onyx/src/instructions/*.rs
// byte-for-byte (same discipline as services/ingestion/src/*_test.ts).

import { keccak256 } from "js-sha3";
import { createHash } from "crypto";
import { Buffer } from "buffer";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ONYX_PROGRAM_ID, TXORACLE_PROGRAM_ID } from "./onchain";

// ---- instruction discriminators (mirrors programs/onyx/src/constants.rs) ----
export const IX_OPEN_MARKET = 1;
export const IX_JOIN_MARKET = 2;
export const IX_SETTLE_MARKET = 5;
export const IX_CLAIM = 6;
export const IX_OPEN_MARKET_SEALED = 15;
export const IX_SUBMIT_SEALED_ORDER = 16;
export const IX_REVEAL_ORDER = 17;
export const IX_RUN_BATCH_MATCH = 18;
export const IX_REFUND_UNREVEALED = 19;

export const SIDE_A = 1;
export const SIDE_B = 2;
export const OP_NONE = 0xff;
export const CMP_GREATER_THAN = 0;
export const CMP_LESS_THAN = 1;
export const CMP_EQUAL_TO = 2;

export const SEED_CONFIG = Buffer.from("config");
export const SEED_MARKET = Buffer.from("market");
export const SEED_VAULT = Buffer.from("vault");
export const SEED_POSITION = Buffer.from("pos");
export const SEED_ORDER = Buffer.from("order");
export const SEED_DAILY_SCORES_ROOTS = Buffer.from("daily_scores_roots");

// ---- byte helpers ----
export const u16le = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
};
export const u32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};
export const i32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v, 0);
  return b;
};
export const u64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
};
export const i64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v, 0);
  return b;
};
export function sha256(...bufs: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
}

/** Borsh-ish little-endian writer, used only by settle_market's ValidateStatArgs payload. */
export class Writer {
  chunks: Buffer[] = [];
  u8(v: number) {
    this.chunks.push(Buffer.from([v & 0xff]));
    return this;
  }
  u32le(v: number) {
    this.chunks.push(u32le(v));
    return this;
  }
  i32le(v: number) {
    this.chunks.push(i32le(v));
    return this;
  }
  i64le(v: bigint) {
    this.chunks.push(i64le(v));
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
  vec<T>(items: T[], writeItem: (w: Writer, item: T) => void) {
    this.u32le(items.length);
    for (const it of items) writeItem(this, it);
    return this;
  }
  option<T>(v: T | null | undefined, writeItem: (w: Writer, item: T) => void) {
    if (v === null || v === undefined) this.u8(0);
    else {
      this.u8(1);
      writeItem(this, v);
    }
    return this;
  }
  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export interface ProofNodeJs {
  hash: number[];
  isRightSibling: boolean;
}
function writeProofNode(w: Writer, n: ProofNodeJs) {
  w.bytes(Buffer.from(n.hash));
  w.bool(n.isRightSibling);
}

// ---- PDA derivation ----
export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_CONFIG], ONYX_PROGRAM_ID)[0];
}
export function marketPdaFromTerms(fixtureId: bigint, paramsHash: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_MARKET, u64le(fixtureId), paramsHash], ONYX_PROGRAM_ID)[0];
}
export function vaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_VAULT, market.toBuffer()], ONYX_PROGRAM_ID)[0];
}
export function positionPda(market: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_POSITION, market.toBuffer(), owner.toBuffer()], ONYX_PROGRAM_ID)[0];
}
export function orderPda(market: PublicKey, owner: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_ORDER, market.toBuffer(), owner.toBuffer(), u64le(nonce)],
    ONYX_PROGRAM_ID,
  )[0];
}

export interface MarketTerms {
  fixtureId: bigint;
  statAKey: number;
  statBKey: number;
  op: number;
  predicate: number;
  threshold: bigint;
  deadline: bigint;
}
export function computeParamsHash(t: MarketTerms): Buffer {
  return sha256(
    u64le(t.fixtureId),
    u32le(t.statAKey),
    u32le(t.statBKey),
    Buffer.from([t.op]),
    Buffer.from([t.predicate]),
    i64le(t.threshold),
    i64le(t.deadline),
  );
}

// ---- commitment (mirrors reveal_order.rs: keccak256(side‖size_le‖limit_price_le‖nonce_le‖owner)) ----
export function sealedCommitment(side: number, size: bigint, limitPrice: bigint, nonce: bigint, owner: PublicKey): Buffer {
  return Buffer.from(
    keccak256.arrayBuffer(
      Buffer.concat([Buffer.from([side]), u64le(size), u64le(limitPrice), u64le(nonce), owner.toBuffer()]),
    ),
  );
}

// ---- open_market_sealed (disc 15) ----
export function buildOpenMarketSealedIx(params: {
  creator: PublicKey;
  usdcMint: PublicKey;
  terms: MarketTerms;
  paramsHash: Buffer;
  commitEndTs: bigint;
  revealEndTs: bigint;
}): { ix: TransactionInstruction; market: PublicKey; vault: PublicKey } {
  const { creator, usdcMint, terms, paramsHash, commitEndTs, revealEndTs } = params;
  const market = marketPdaFromTerms(terms.fixtureId, paramsHash);
  const vault = vaultPda(market);
  const args = Buffer.concat([
    u64le(terms.fixtureId),
    u32le(terms.statAKey),
    u32le(terms.statBKey),
    Buffer.from([terms.op]),
    Buffer.from([terms.predicate]),
    i64le(terms.threshold),
    i64le(terms.deadline),
    paramsHash,
    i64le(commitEndTs),
    i64le(revealEndTs),
  ]);
  const ix = new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_OPEN_MARKET_SEALED]), args]),
  });
  return { ix, market, vault };
}

// ---- submit_sealed_order (disc 16) ----
export function buildSubmitSealedOrderIx(params: {
  user: PublicKey;
  market: PublicKey;
  nonce: bigint;
  commitment: Buffer;
  collateral: bigint;
  userAta?: PublicKey;
  usdcMint: PublicKey;
}): { ix: TransactionInstruction; order: PublicKey } {
  const { user, market, nonce, commitment, collateral, usdcMint } = params;
  const order = orderPda(market, user, nonce);
  const vault = vaultPda(market);
  const userAta = params.userAta ?? getAssociatedTokenAddressSync(usdcMint, user);
  const args = Buffer.concat([u64le(nonce), commitment, u64le(collateral)]);
  const ix = new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: order, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_SUBMIT_SEALED_ORDER]), args]),
  });
  return { ix, order };
}

// ---- reveal_order (disc 17) ----
export function buildRevealOrderIx(params: {
  user: PublicKey;
  market: PublicKey;
  order: PublicKey;
  side: number;
  size: bigint;
  limitPrice: bigint;
  nonce: bigint;
}): TransactionInstruction {
  const { user, market, order, side, size, limitPrice, nonce } = params;
  const args = Buffer.concat([Buffer.from([side]), u64le(size), u64le(limitPrice), u64le(nonce)]);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: order, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([IX_REVEAL_ORDER]), args]),
  });
}

// ---- run_batch_match (disc 18) ----
export function buildRunBatchMatchIx(params: {
  payer: PublicKey;
  market: PublicKey;
  orders: { order: PublicKey; owner: PublicKey; usdcAta: PublicKey }[];
}): TransactionInstruction {
  const { payer, market, orders } = params;
  const vault = vaultPda(market);
  const remaining = orders.flatMap(({ order, owner, usdcAta }) => [
    { pubkey: order, isSigner: false, isWritable: true },
    { pubkey: positionPda(market, owner), isSigner: false, isWritable: true },
    { pubkey: usdcAta, isSigner: false, isWritable: true },
  ]);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data: Buffer.from([IX_RUN_BATCH_MATCH]),
  });
}

// ---- refund_unrevealed (disc 19) ----
export function buildRefundUnrevealedIx(params: {
  payer: PublicKey;
  market: PublicKey;
  order: PublicKey;
  ownerAta: PublicKey;
}): TransactionInstruction {
  const { payer, market, order, ownerAta } = params;
  const vault = vaultPda(market);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: order, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX_REFUND_UNREVEALED]),
  });
}

// ---- settle_market (disc 5) — real oracle CPI, requires a captured proof ----
export interface CapturedProofFixture {
  fixtureId: number;
  seq: number;
  targetTsMs: number;
  epochDay: number;
  payload: {
    ts: number;
    statsToProve: { key: number; value: number; period: number }[];
    eventStatRoot: number[];
    summary: {
      fixtureId: number;
      updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
      eventStatsSubTreeRoot: number[];
    };
    statProofs: ProofNodeJs[][];
    subTreeProof: ProofNodeJs[];
    mainTreeProof: ProofNodeJs[];
  };
}

export function buildSettleMarketIx(params: {
  submitter: PublicKey;
  market: PublicKey;
  fixture: CapturedProofFixture;
  threshold: bigint;
  predicate: number;
}): { ix: TransactionInstruction; computeIx: TransactionInstruction; rootsPda: PublicKey } {
  const { submitter, market, fixture, threshold, predicate } = params;
  const p = fixture.payload;
  const stat = p.statsToProve[0]!;
  const rootsPda = PublicKey.findProgramAddressSync(
    [SEED_DAILY_SCORES_ROOTS, u16le(fixture.epochDay)],
    TXORACLE_PROGRAM_ID,
  )[0];

  const w = new Writer();
  w.i64le(BigInt(fixture.targetTsMs));
  w.i64le(BigInt(p.summary.fixtureId));
  w.i32le(p.summary.updateStats.updateCount);
  w.i64le(BigInt(p.summary.updateStats.minTimestamp));
  w.i64le(BigInt(p.summary.updateStats.maxTimestamp));
  w.bytes(Buffer.from(p.summary.eventStatsSubTreeRoot));
  w.vec(p.subTreeProof, writeProofNode);
  w.vec(p.mainTreeProof, writeProofNode);
  w.i32le(Number(threshold));
  w.u8(predicate);
  w.u32le(stat.key);
  w.i32le(stat.value);
  w.i32le(stat.period);
  w.bytes(Buffer.from(p.eventStatRoot));
  w.vec(p.statProofs[0]!, writeProofNode);
  w.option<never>(null, () => {});
  w.option<never>(null, () => {});
  const settleArgs = w.build();

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const ix = new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: submitter, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: TXORACLE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: rootsPda, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_SETTLE_MARKET]), settleArgs]),
  });
  return { ix, computeIx, rootsPda };
}

// ---- claim (disc 6) ----
export function buildClaimIx(params: {
  winner: PublicKey;
  market: PublicKey;
  winnerAta?: PublicKey;
  usdcMint: PublicKey;
}): TransactionInstruction {
  const { winner, market, usdcMint } = params;
  const position = positionPda(market, winner);
  const vault = vaultPda(market);
  const winnerAta = params.winnerAta ?? getAssociatedTokenAddressSync(usdcMint, winner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: winner, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: winnerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX_CLAIM]),
  });
}

// =====================================================================
// MagicBlock ER delegation (base program instructions 3/4 — existing on
// devnet since the Phase 0 spike, but this repo never had TS builders for
// them until now) + ER-fast trading (TradingAccount, instructions 20-28,
// additive — see docs/ER_TRADING_DESIGN.md). Every ER-only instruction
// (23-27) deliberately keeps the signer read-only (never writable): the
// ER hard-rejects any tx that would change a non-delegated account's
// balance, including the fee payer itself (Phase 0 probe finding).
// =====================================================================

export const IX_DELEGATE_MARKET = 3;
export const IX_UNDELEGATE_MARKET = 4;
export const IX_OPEN_TRADING_ACCOUNT = 20;
export const IX_DEPOSIT_TRADING = 21;
export const IX_DELEGATE_TRADING_ACCOUNT = 22;
export const IX_SUBMIT_ORDER_FAST = 23;
export const IX_REVEAL_ORDER_FAST = 24;
export const IX_CANCEL_ORDER_FAST = 25;
export const IX_RUN_BATCH_MATCH_FAST = 26;
export const IX_UNDELEGATE_TRADING_ACCOUNT = 27;
export const IX_WITHDRAW_TRADING = 28;

export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");

export const SEED_TRADING = Buffer.from("trading");
export const SEED_DELEGATE_BUFFER = Buffer.from("buffer");
export const SEED_DELEGATION_RECORD = Buffer.from("delegation");
export const SEED_DELEGATION_METADATA = Buffer.from("delegation-metadata");

export const TRADING_STATUS_NAMES: Record<number, string> = {
  0: "None",
  1: "Locked",
  2: "Revealed",
  3: "Matched",
};

export function tradingAccountPda(market: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_TRADING, market.toBuffer(), owner.toBuffer()],
    ONYX_PROGRAM_ID,
  )[0];
}
export function delegateBufferPda(delegated: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_DELEGATE_BUFFER, delegated.toBuffer()], ONYX_PROGRAM_ID)[0];
}
export function delegationRecordPda(delegated: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_DELEGATION_RECORD, delegated.toBuffer()], DELEGATION_PROGRAM_ID)[0];
}
export function delegationMetadataPda(delegated: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SEED_DELEGATION_METADATA, delegated.toBuffer()], DELEGATION_PROGRAM_ID)[0];
}

/** Shared account list for delegating any PDA this program owns (base layer). */
function delegateAccounts(payer: PublicKey, delegated: PublicKey) {
  return [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: delegated, isSigner: false, isWritable: true },
    { pubkey: ONYX_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: delegateBufferPda(delegated), isSigner: false, isWritable: true },
    { pubkey: delegationRecordPda(delegated), isSigner: false, isWritable: true },
    { pubkey: delegationMetadataPda(delegated), isSigner: false, isWritable: true },
    { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

// ---- delegate_market (disc 3, base) ----
export function buildDelegateMarketIx(params: { payer: PublicKey; market: PublicKey; commitFrequencyMs?: number }): TransactionInstruction {
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: delegateAccounts(params.payer, params.market),
    data: Buffer.concat([Buffer.from([IX_DELEGATE_MARKET]), u32le(params.commitFrequencyMs ?? 0xffffffff)]),
  });
}

// ---- undelegate_market (disc 4, ER) ----
export function buildUndelegateMarketIx(params: { payer: PublicKey; market: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: params.market, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX_UNDELEGATE_MARKET]),
  });
}

// ---- open_trading_account (disc 20, base) ----
export function buildOpenTradingAccountIx(params: { owner: PublicKey; market: PublicKey }): { ix: TransactionInstruction; trading: PublicKey } {
  const trading = tradingAccountPda(params.market, params.owner);
  return {
    trading,
    ix: new TransactionInstruction({
      programId: ONYX_PROGRAM_ID,
      keys: [
        { pubkey: params.owner, isSigner: true, isWritable: true },
        { pubkey: params.market, isSigner: false, isWritable: false },
        { pubkey: trading, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([IX_OPEN_TRADING_ACCOUNT]),
    }),
  };
}

// ---- deposit_trading (disc 21, base) ----
export function buildDepositTradingIx(params: {
  owner: PublicKey;
  market: PublicKey;
  amount: bigint;
  usdcMint: PublicKey;
  ownerAta?: PublicKey;
}): TransactionInstruction {
  const trading = tradingAccountPda(params.market, params.owner);
  const vault = vaultPda(params.market);
  const ownerAta = params.ownerAta ?? getAssociatedTokenAddressSync(params.usdcMint, params.owner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: params.market, isSigner: false, isWritable: false },
      { pubkey: trading, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX_DEPOSIT_TRADING]), u64le(params.amount)]),
  });
}

// ---- delegate_trading_account (disc 22, base) ----
export function buildDelegateTradingAccountIx(params: {
  payer: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  commitFrequencyMs?: number;
}): TransactionInstruction {
  const trading = tradingAccountPda(params.market, params.owner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: delegateAccounts(params.payer, trading),
    data: Buffer.concat([Buffer.from([IX_DELEGATE_TRADING_ACCOUNT]), u32le(params.commitFrequencyMs ?? 0xffffffff)]),
  });
}

// ---- submit_order_fast (disc 23, ER — owner read-only) ----
export function buildSubmitOrderFastIx(params: {
  owner: PublicKey;
  market: PublicKey;
  commitment: Buffer;
  collateral: bigint;
}): TransactionInstruction {
  const trading = tradingAccountPda(params.market, params.owner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.market, isSigner: false, isWritable: true },
      { pubkey: trading, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([IX_SUBMIT_ORDER_FAST]), params.commitment, u64le(params.collateral)]),
  });
}

// ---- reveal_order_fast (disc 24, ER — owner read-only) ----
export function buildRevealOrderFastIx(params: {
  owner: PublicKey;
  market: PublicKey;
  side: number;
  size: bigint;
  limitPrice: bigint;
  nonce: bigint;
}): TransactionInstruction {
  const trading = tradingAccountPda(params.market, params.owner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.market, isSigner: false, isWritable: true },
      { pubkey: trading, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      Buffer.from([IX_REVEAL_ORDER_FAST, params.side]),
      u64le(params.size),
      u64le(params.limitPrice),
      u64le(params.nonce),
    ]),
  });
}

// ---- cancel_order_fast (disc 25, ER — owner read-only) ----
export function buildCancelOrderFastIx(params: { owner: PublicKey; market: PublicKey }): TransactionInstruction {
  const trading = tradingAccountPda(params.market, params.owner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.market, isSigner: false, isWritable: true },
      { pubkey: trading, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([IX_CANCEL_ORDER_FAST]),
  });
}

// ---- run_batch_match_fast (disc 26, ER — payer read-only, permissionless) ----
export function buildRunBatchMatchFastIx(params: {
  payer: PublicKey;
  market: PublicKey;
  tradingAccounts: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: false },
      { pubkey: params.market, isSigner: false, isWritable: true },
      ...params.tradingAccounts.map((t) => ({ pubkey: t, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from([IX_RUN_BATCH_MATCH_FAST]),
  });
}

// ---- undelegate_trading_account (disc 27, ER) — generic, accepts any set of
// this program's delegated accounts (market and/or one or more
// TradingAccounts) to commit+undelegate together in one CPI. ----
export function buildUndelegateManyIx(params: { payer: PublicKey; delegated: PublicKey[] }): TransactionInstruction {
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      ...params.delegated.map((d) => ({ pubkey: d, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from([IX_UNDELEGATE_TRADING_ACCOUNT]),
  });
}

// ---- withdraw_trading (disc 28, base) ----
export function buildWithdrawTradingIx(params: {
  owner: PublicKey;
  market: PublicKey;
  usdcMint: PublicKey;
  ownerAta?: PublicKey;
}): TransactionInstruction {
  const trading = tradingAccountPda(params.market, params.owner);
  const vault = vaultPda(params.market);
  const ownerAta = params.ownerAta ?? getAssociatedTokenAddressSync(params.usdcMint, params.owner);
  return new TransactionInstruction({
    programId: ONYX_PROGRAM_ID,
    keys: [
      { pubkey: params.owner, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: params.market, isSigner: false, isWritable: false },
      { pubkey: trading, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX_WITHDRAW_TRADING]),
  });
}
