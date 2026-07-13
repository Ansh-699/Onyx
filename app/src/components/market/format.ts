// Tiny display helpers shared by the market-detail components.
// Base units are 6-decimal test-USDC (1_000_000 = 1 tUSDC), matching the
// devnet mint the faucet serves — never real money, and labeled as such.

const USDC_BASE = 1_000_000;

/** Base units (6dp test-USDC) -> human string, e.g. 1_500_000n -> "1.50". */
export function fmtUsdc(baseUnits: bigint): string {
  const n = Number(baseUnits) / USDC_BASE;
  if (!Number.isFinite(n)) return baseUnits.toString();
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2,
  });
}

/** Fixed 2dp variant for aligned stat columns (1_100_000n -> "1.10"). */
export function fmtUsdc2(baseUnits: bigint): string {
  const n = Number(baseUnits) / USDC_BASE;
  return Number.isFinite(n) ? n.toFixed(2) : baseUnits.toString();
}

export function shortAddr(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

/** Share of `part` in `total` as "62.5%" — em dash for an empty pool. */
export function poolShare(part: bigint, total: bigint): string {
  if (total <= 0n) return "—";
  return ((Number(part) / Number(total)) * 100).toFixed(1) + "%";
}
