// Server-only price/trade history store. There is NO on-chain price history
// (AmmPool stores only current reserves), so this file records REAL samples
// of on-chain state: every point is a (timestamp, spot price from reserves,
// fees_accrued) read from the ledger, and every trade entry carries the real
// transaction signature — verifiable on the explorer. Nothing here is ever
// synthesized; an empty file just means no samples have been taken yet.
//
// Storage is a plain JSON file under app/.data/ (gitignored). That's fine
// for the local demo run this project targets; on a read-only/ephemeral fs
// (hosted serverless) every function degrades to a no-op / empty read and
// the UI falls back to live-sampled-only history.
// ponytail: fs JSON, move to KV/sqlite if this ever runs multi-instance.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PricePoint {
  /** unix ms */
  t: number;
  /** spot price of side A, 1e6-scaled (reserveB / (reserveA+reserveB)) */
  priceA: number;
  /** pool fees_accrued at sample time (base units, stringified u64) */
  fees: string;
}

export interface TradeRecord {
  t: number;
  side: number; // 1 = A/YES, 2 = B/NO
  dir: number; // 0 = buy, 1 = sell
  /** base units in (tUSDC for buys, tokens for sells), stringified u64 */
  amountIn: string;
  /** real transaction signature — explorer-verifiable */
  sig: string;
}

interface PoolHistory {
  points: PricePoint[];
  trades: TradeRecord[];
}
interface Store {
  pools: Record<string, PoolHistory>;
}

const MAX_POINTS = 2_000;
const MAX_TRADES = 300;

const dataDir = () => join(process.cwd(), ".data");
const storePath = () => join(dataDir(), "price-history.json");

export function readHistory(): Store {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8")) as Store;
  } catch {
    return { pools: {} };
  }
}

function writeStore(store: Store): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(store));
  } catch {
    // read-only fs (hosted) — degrade silently to live-sampled-only
  }
}

function poolEntry(store: Store, pool: string): PoolHistory {
  return (store.pools[pool] ??= { points: [], trades: [] });
}

export function recordPricePoint(pool: string, point: PricePoint): void {
  const store = readHistory();
  const entry = poolEntry(store, pool);
  entry.points.push(point);
  if (entry.points.length > MAX_POINTS) entry.points.splice(0, entry.points.length - MAX_POINTS);
  writeStore(store);
}

export function recordTrade(pool: string, trade: TradeRecord): void {
  const store = readHistory();
  const entry = poolEntry(store, pool);
  entry.trades.push(trade);
  if (entry.trades.length > MAX_TRADES) entry.trades.splice(0, entry.trades.length - MAX_TRADES);
  writeStore(store);
}

/** Batch variant used by the seeding script (avoids a read-modify-write per swap). */
export function recordBatch(pool: string, points: PricePoint[], trades: TradeRecord[]): void {
  const store = readHistory();
  const entry = poolEntry(store, pool);
  entry.points.push(...points);
  entry.trades.push(...trades);
  if (entry.points.length > MAX_POINTS) entry.points.splice(0, entry.points.length - MAX_POINTS);
  if (entry.trades.length > MAX_TRADES) entry.trades.splice(0, entry.trades.length - MAX_TRADES);
  writeStore(store);
}
