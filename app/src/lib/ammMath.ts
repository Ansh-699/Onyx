// Client-side CPMM quote engine — a BigInt mirror of programs/onyx/src/
// fpmm.rs, byte-for-byte in behavior. PROVEN unit-exact against the deployed
// program: Phase B's devnet lifecycle set every swap's min_out to this
// module's exact predicted output and all six swaps landed (one unit of
// divergence anywhere would have reverted with SlippageExceeded), and the
// Phase C replay audits reproduced live concurrent-swap end states through
// these same formulas (see BUILD_STATE.md 2026-07-11 entries).
//
// Framework-agnostic (no React) so the browser panel and proof scripts share
// one implementation. All rounding favors the pool, matching on-chain:
// buys ceil the pool's keep, sells floor the trader's proceeds.

export const BPS_DENOM = 10_000n;

export interface QuoteBuy {
  /** Outcome tokens the trader receives (this is what min_out guards). */
  tokensOut: bigint;
  fee: bigint;
  newReserveBuy: bigint;
  newReserveOther: bigint;
  /** Average price paid per token, in collateral units scaled 1e6. */
  avgPriceScaled: bigint;
}

export interface QuoteSell {
  /** Net collateral out after fee (this is what min_out guards). */
  netOut: bigint;
  gross: bigint;
  fee: bigint;
  newReserveSell: bigint;
  newReserveOther: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length + 1) / 2n);
  for (;;) {
    const next = (x + n / x) / 2n;
    if (next >= x) break;
    x = next;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

export const calcFee = (amount: bigint, feeBps: number): bigint => (amount * BigInt(feeBps)) / BPS_DENOM;

/** Mirror of fpmm::calc_buy + the fee the instruction takes first. Null if unquotable (empty pool / dust). */
export function quoteBuy(reserveBuy: bigint, reserveOther: bigint, amountIn: bigint, feeBps: number): QuoteBuy | null {
  if (amountIn <= 0n || reserveBuy <= 0n || reserveOther <= 0n) return null;
  const fee = calcFee(amountIn, feeBps);
  const net = amountIn - fee;
  if (net <= 0n) return null;
  const ending = ceilDiv(reserveBuy * reserveOther, reserveOther + net);
  const tokensOut = reserveBuy + net - ending;
  if (tokensOut <= 0n) return null;
  return {
    tokensOut,
    fee,
    newReserveBuy: ending,
    newReserveOther: reserveOther + net,
    avgPriceScaled: (amountIn * 1_000_000n) / tokensOut,
  };
}

/** Mirror of fpmm::calc_sell + the fee the instruction takes from gross. Null if unquotable. */
export function quoteSell(reserveSell: bigint, reserveOther: bigint, tokensIn: bigint, feeBps: number): QuoteSell | null {
  if (tokensIn <= 0n || reserveSell <= 0n || reserveOther <= 0n) return null;
  const s = reserveSell + reserveOther + tokensIn;
  const gross = (s - isqrt(s * s - 4n * reserveOther * tokensIn)) / 2n;
  if (gross <= 0n) return null;
  const fee = calcFee(gross, feeBps);
  return {
    netOut: gross - fee,
    gross,
    fee,
    newReserveSell: reserveSell + tokensIn - gross,
    newReserveOther: reserveOther - gross,
  };
}

/** Spot price of the side whose reserve is `reserveThis`, scaled 1e6 (price_A = b/(a+b)). */
export function spotPriceScaled(reserveThis: bigint, reserveOther: bigint): bigint {
  const total = reserveThis + reserveOther;
  if (total === 0n) return 500_000n;
  return (reserveOther * 1_000_000n) / total;
}

/**
 * User-facing slippage: min acceptable output given a tolerance in bps.
 * THIS value goes on-chain as swap_amm's min_out and is enforced there
 * (SlippageExceeded, error 6026) — not advisory. Floor division means the
 * tolerance can only widen in the trader's favor by <1 base unit.
 */
export function minOutForTolerance(expectedOut: bigint, toleranceBps: number): bigint {
  const t = BigInt(Math.max(0, Math.min(10_000, Math.round(toleranceBps))));
  return (expectedOut * (BPS_DENOM - t)) / BPS_DENOM;
}

/** Price impact of a buy in bps: how far the average fill price sits above spot. */
export function buyImpactBps(reserveBuy: bigint, reserveOther: bigint, q: QuoteBuy): number {
  const spot = spotPriceScaled(reserveBuy, reserveOther);
  if (spot === 0n) return 0;
  const impact = ((q.avgPriceScaled - spot) * 10_000n) / spot;
  return Number(impact < 0n ? 0n : impact);
}
