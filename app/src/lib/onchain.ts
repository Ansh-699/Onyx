// Live devnet reads for the ONYX settlement program. No mocks past this file
// for the L0 path (lobby / market detail / receipt) — every value here comes
// from a real getAccountInfo / getProgramAccounts / getTransaction call
// against devnet.
//
// Market account layout mirrors programs/onyx/src/state/market.rs exactly
// (128 bytes, byte-for-byte offsets documented there). Decoded here in plain
// TS with DataView since there's no Anchor IDL for this Pinocchio program.

import { Buffer } from "buffer";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

export const ONYX_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_ONYX_PROGRAM_ID ?? "4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB",
);
export const TXORACLE_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_TXORACLE_PROGRAM_ID ?? "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
);

const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");

export function getConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

// ---- constants mirrored from programs/onyx/src/constants.rs ----
export const DISC_MARKET = 2;
export const DISC_SEALED_ORDER = 4;

export const STATUS_DRAFT = 0;
export const STATUS_OPEN = 1;
export const STATUS_LIVE = 2;
export const STATUS_SETTLING = 3;
export const STATUS_SETTLED = 4;
export const STATUS_CLAIMED = 5;
export const STATUS_EXPIRED = 6;
export const STATUS_REFUNDED = 7;

export const STATUS_NAMES: Record<number, string> = {
  [STATUS_DRAFT]: "Draft",
  [STATUS_OPEN]: "Open",
  [STATUS_LIVE]: "Live",
  [STATUS_SETTLING]: "Settling",
  [STATUS_SETTLED]: "Settled",
  [STATUS_CLAIMED]: "Claimed",
  [STATUS_EXPIRED]: "Expired",
  [STATUS_REFUNDED]: "Refunded",
};
export const OUTCOME_NAMES: Record<number, string> = {
  0: "Unknown",
  1: "Side A",
  2: "Side B",
};
export const OP_NAMES: Record<number, string> = { 0: "Add", 1: "Subtract", 255: "—" };
export const CMP_SYMBOLS: Record<number, string> = { 0: ">", 1: "<", 2: "=" };

/** Market.phase — sealed-order sub-state (Level 1, O7). 0 = not a sealed market. */
export const PHASE_NAMES: Record<number, string> = {
  0: "—",
  1: "Commit",
  2: "Reveal",
  3: "Matched",
};
export const PHASE_NONE = 0;
export const PHASE_COMMIT = 1;
export const PHASE_REVEAL = 2;
export const PHASE_MATCHED = 3;

export const ORDER_STATUS_NAMES: Record<number, string> = {
  0: "Locked",
  1: "Revealed",
  2: "Matched",
  3: "Refunded",
};

const ODDS_SCALE = 1_000_000n;

/** Decoded on-chain Market account (see state/market.rs for the byte layout). */
export interface OnChainMarket {
  pda: string;
  fixtureId: bigint;
  statAKey: number;
  statBKey: number;
  op: number;
  predicate: number;
  status: number;
  outcome: number;
  threshold: bigint;
  deadline: bigint;
  createdSlot: bigint;
  totalSideA: bigint;
  totalSideB: bigint;
  paramsHash: string; // hex
  // Sealed-order extension (offsets 102-126, carved out of what was pure
  // _reserved padding — see state/market.rs doc comment). phase===PHASE_NONE
  // for any market opened via plain open_market.
  commitEndTs: bigint;
  revealEndTs: bigint;
  phase: number;
  clearingPrice: bigint;
  /** ER-fast TradingAccount reveals only (byte 127, repurposed from
   * _reserved — see state/market.rs). The base sealed-order flow
   * (SealedOrder) never touches this; always 0 for a classic-only market. */
  revealedCount: number;
}

export function decodeMarket(pda: PublicKey, data: Buffer): OnChainMarket | null {
  if (data.length < 128 || data[0] !== DISC_MARKET) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pda: pda.toBase58(),
    fixtureId: dv.getBigUint64(8, true),
    statAKey: dv.getUint32(16, true),
    statBKey: dv.getUint32(20, true),
    op: data[24]!,
    predicate: data[25]!,
    status: data[26]!,
    outcome: data[27]!,
    threshold: dv.getBigInt64(28, true),
    deadline: dv.getBigInt64(36, true),
    createdSlot: dv.getBigUint64(44, true),
    totalSideA: dv.getBigUint64(52, true),
    totalSideB: dv.getBigUint64(60, true),
    paramsHash: Buffer.from(data.subarray(68, 100)).toString("hex"),
    commitEndTs: dv.getBigInt64(102, true),
    revealEndTs: dv.getBigInt64(110, true),
    phase: data[118]!,
    clearingPrice: dv.getBigUint64(119, true),
    revealedCount: data[127]!,
  };
}

/** Decoded on-chain SealedOrder account (see state/sealed_order.rs). */
export interface OnChainSealedOrder {
  pda: string;
  owner: string;
  market: string;
  commitment: string; // hex
  collateralLocked: bigint;
  nonce: bigint;
  revealed: boolean;
  side: number;
  status: number;
  size: bigint;
  limitPrice: bigint;
  matchedSize: bigint;
}

export function decodeSealedOrder(pda: PublicKey, data: Buffer): OnChainSealedOrder | null {
  if (data.length < 160 || data[0] !== DISC_SEALED_ORDER) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pda: pda.toBase58(),
    owner: new PublicKey(data.subarray(8, 40)).toBase58(),
    market: new PublicKey(data.subarray(40, 72)).toBase58(),
    commitment: Buffer.from(data.subarray(72, 104)).toString("hex"),
    collateralLocked: dv.getBigUint64(104, true),
    nonce: dv.getBigUint64(112, true),
    revealed: data[120] !== 0,
    side: data[121]!,
    status: data[122]!,
    size: dv.getBigUint64(128, true),
    limitPrice: dv.getBigUint64(136, true),
    matchedSize: dv.getBigUint64(144, true),
  };
}

/** All revealed/unrevealed SealedOrder accounts for a given market. */
export async function listSealedOrders(marketPda: string): Promise<OnChainSealedOrder[]> {
  const connection = getConnection();
  const market = new PublicKey(marketPda);
  const accounts = await connection.getProgramAccounts(ONYX_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from([DISC_SEALED_ORDER]).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 40, bytes: market.toBase58(), encoding: "base58" } },
    ],
  });
  return accounts
    .map(({ pubkey, account }) => decodeSealedOrder(pubkey, account.data))
    .filter((o): o is OnChainSealedOrder => o !== null);
}

/** Config PDA (singleton) — see state/config.rs. usdc_mint lives at bytes 40..72. */
export async function getConfigUsdcMint(): Promise<PublicKey | null> {
  const connection = getConnection();
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX_PROGRAM_ID);
  const info = await connection.getAccountInfo(configPda);
  if (!info) return null;
  return new PublicKey(info.data.subarray(40, 72));
}

/** ODDS_SCALE-fixed-point price (0..=1_000_000) as a human percentage string. */
export function priceToPercent(price: bigint): string {
  return ((Number(price) / Number(ODDS_SCALE)) * 100).toFixed(1) + "%";
}

/** All ONYX Market accounts currently on devnet, newest (by created_slot) first. */
export async function listMarkets(): Promise<OnChainMarket[]> {
  const connection = getConnection();
  const accounts = await connection.getProgramAccounts(ONYX_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from([DISC_MARKET]).toString("base64"), encoding: "base64" } }],
  });
  const markets = accounts
    .map(({ pubkey, account }) => decodeMarket(pubkey, account.data))
    .filter((m): m is OnChainMarket => m !== null);
  markets.sort((a, b) => (b.createdSlot > a.createdSlot ? 1 : -1));
  return markets;
}

/** `connection` defaults to base — pass an ER connection to read a delegated market's live state (see erRouting.ts / useRoutedMarket). */
export async function getMarket(pda: string, connection: Connection = getConnection()): Promise<OnChainMarket | null> {
  const pubkey = new PublicKey(pda);
  const info = await connection.getAccountInfo(pubkey);
  if (!info) return null;
  return decodeMarket(pubkey, info.data);
}

/**
 * Find the settle_market transaction for a market by scanning its recent
 * signatures for the one whose logs mention the txoracle CPI. Good enough for
 * a single-market demo slice; a real indexer would track this directly.
 */
export async function findSettleTx(pda: string): Promise<{
  signature: string;
  logs: string[];
  slot: number;
} | null> {
  const connection = getConnection();
  const pubkey = new PublicKey(pda);
  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 20 });
  for (const s of sigs) {
    const tx = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    if (logs.some((l) => l.includes("ValidateStat") || l.includes("Evaluate predicate"))) {
      return { signature: s.signature, logs, slot: s.slot };
    }
  }
  return null;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

// =====================================================================
// TradingAccount (ER-fast trading — additive, see docs/ER_TRADING_DESIGN.md
// and programs/onyx/src/state/trading_account.rs for the byte layout this
// mirrors exactly, 176 bytes). Every read here takes an explicit
// `connection` param (no default) — callers MUST resolve base-vs-ER via
// erRouting.ts first, since which endpoint holds the authoritative copy
// depends on this specific account's current delegation state.
// =====================================================================

export const DISC_TRADING_ACCOUNT = 5;
export const TRADING_ACCOUNT_LEN = 176;

export const TRADING_STATUS_NONE = 0;
export const TRADING_STATUS_LOCKED = 1;
export const TRADING_STATUS_REVEALED = 2;
export const TRADING_STATUS_MATCHED = 3;
export const TRADING_STATUS_NAMES: Record<number, string> = {
  0: "None",
  1: "Locked",
  2: "Revealed",
  3: "Matched",
};

export interface OnChainTradingAccount {
  pda: string;
  owner: string;
  market: string;
  deposited: bigint;
  available: bigint;
  locked: bigint;
  commitment: string; // hex, all-zero = no open order
  side: number;
  status: number;
  size: bigint;
  limitPrice: bigint;
  matchedSize: bigint;
  withdrawn: bigint;
  claimedWinnings: boolean;
}

export function decodeTradingAccount(pda: PublicKey, data: Buffer): OnChainTradingAccount | null {
  if (data.length < TRADING_ACCOUNT_LEN || data[0] !== DISC_TRADING_ACCOUNT) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pda: pda.toBase58(),
    owner: new PublicKey(data.subarray(8, 40)).toBase58(),
    market: new PublicKey(data.subarray(40, 72)).toBase58(),
    deposited: dv.getBigUint64(72, true),
    available: dv.getBigUint64(80, true),
    locked: dv.getBigUint64(88, true),
    commitment: Buffer.from(data.subarray(96, 128)).toString("hex"),
    side: data[128]!,
    status: data[129]!,
    size: dv.getBigUint64(136, true),
    limitPrice: dv.getBigUint64(144, true),
    matchedSize: dv.getBigUint64(152, true),
    withdrawn: dv.getBigUint64(160, true),
    claimedWinnings: data[169] !== 0,
  };
}

export function tradingAccountPda(market: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("trading"), market.toBuffer(), owner.toBuffer()],
    ONYX_PROGRAM_ID,
  )[0];
}

/** One wallet's TradingAccount for a market, read from the given connection (base or ER — caller resolves). Null if it doesn't exist there. */
export async function getTradingAccount(
  connection: Connection,
  market: PublicKey,
  owner: PublicKey,
): Promise<OnChainTradingAccount | null> {
  const pda = tradingAccountPda(market, owner);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return decodeTradingAccount(pda, info.data);
}

/** Every TradingAccount for a market, read from the given connection. Used to build the batch-match account list and to undelegate everything at once. */
export async function listTradingAccountsForMarket(
  connection: Connection,
  market: PublicKey,
): Promise<OnChainTradingAccount[]> {
  const accounts = await connection.getProgramAccounts(ONYX_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from([DISC_TRADING_ACCOUNT]).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 40, bytes: market.toBase58(), encoding: "base58" } },
    ],
  });
  return accounts
    .map(({ pubkey, account }) => decodeTradingAccount(pubkey, account.data))
    .filter((t): t is OnChainTradingAccount => t !== null);
}
