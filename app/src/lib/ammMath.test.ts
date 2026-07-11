// ammMath.ts must stay bit-identical to programs/onyx/src/fpmm.rs — every
// swap's min_out is this module's exact prediction, so ONE unit of drift
// becomes a SlippageExceeded storm on-chain. These vectors are lifted
// verbatim from fpmm.rs's own #[test]s (calc_buy/calc_sell), with the fee
// layer (which the instruction applies around fpmm, feeBps=0 here) matching.
//
// Run: cd app && bun test src/lib/ammMath.test.ts

import { describe, expect, test } from "bun:test";
import { quoteBuy, quoteSell, isqrt, calcFee, minOutForTolerance, spotPriceScaled } from "./ammMath";

describe("isqrt (mirror of fpmm::isqrt_u128)", () => {
  test("perfect squares are exact", () => {
    for (let n = 0n; n < 2000n; n++) expect(isqrt(n * n)).toBe(n);
  });
  test("floor property: x*x <= n < (x+1)^2", () => {
    for (let n = 0n; n < 5000n; n++) {
      const x = isqrt(n);
      expect(x * x <= n).toBe(true);
      expect((x + 1n) * (x + 1n) > n).toBe(true);
    }
  });
  test("large values", () => {
    const max = 18446744073709551615n; // u64::MAX
    expect(isqrt(max * max)).toBe(max);
  });
});

describe("quoteBuy (mirror of fpmm::calc_buy, feeBps=0)", () => {
  test("equal reserves known value: 1000/1000 buy 100 -> 190 out, reserves 910/1100", () => {
    const q = quoteBuy(1000n, 1000n, 100n, 0)!;
    expect(q.tokensOut).toBe(190n);
    expect(q.newReserveBuy).toBe(910n);
    expect(q.newReserveOther).toBe(1100n);
  });
  test("price impact direction: reserve_buy shrinks, reserve_other grows", () => {
    const q = quoteBuy(1000n, 1000n, 100n, 0)!;
    expect(q.newReserveBuy < 1000n).toBe(true);
    expect(q.newReserveOther > 1000n).toBe(true);
  });
  test("skewed pool: same collateral buys more of the cheap side", () => {
    const expensive = quoteBuy(200n, 1800n, 100n, 0)!;
    const cheap = quoteBuy(1800n, 200n, 100n, 0)!;
    expect(cheap.tokensOut > expensive.tokensOut).toBe(true);
  });
});

describe("quoteSell (mirror of fpmm::calc_sell, feeBps=0)", () => {
  test("formula matches manual algebra: (a+d-m)(b-m) ~= a*b within rounding", () => {
    const [a, b, d] = [1000n, 1000n, 200n];
    const q = quoteSell(a, b, d, 0)!;
    const m = q.gross;
    const lhs = (a + d - m) * (b - m);
    const rhs = a * b;
    const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
    expect(diff < 2000n).toBe(true);
  });
  test("price impact direction: reserve_sell grows, reserve_other shrinks", () => {
    const q = quoteSell(1000n, 1000n, 200n, 0)!;
    expect(q.newReserveSell > 1000n).toBe(true);
    expect(q.newReserveOther < 1000n).toBe(true);
  });
  test("discriminant never negative across adversarial grid", () => {
    const grid = [1n, 7n, 1000n, 50_000n, 1_000_000n, 4611686018427387903n]; // u64::MAX/4
    for (const a of grid) for (const b of grid) for (const d of grid) {
      // fpmm asserts is_ok(); here null only for the legitimate zero-gross dust case
      const q = quoteSell(a, b, d, 0);
      if (q) expect(q.gross > 0n).toBe(true);
    }
  });
});

describe("round trips never profit the trader (fee=0, pure price impact)", () => {
  test("buy then sell back", () => {
    for (const netIn of [1n, 10n, 100n, 1_000n, 50_000n]) {
      const buy = quoteBuy(1000n, 1000n, netIn, 0);
      if (!buy) continue; // dust buys legitimately unquotable
      const sell = quoteSell(buy.newReserveBuy, buy.newReserveOther, buy.tokensOut, 0);
      if (!sell) continue; // dust proceeds round to zero — pool keeps them
      expect(sell.gross <= netIn).toBe(true);
    }
  });
  test("sell then buy back", () => {
    for (const tokens of [10n, 100n, 1_000n, 50_000n]) {
      const sell = quoteSell(1000n, 1000n, tokens, 0);
      if (!sell || sell.gross === 0n) continue;
      const buy = quoteBuy(sell.newReserveSell, sell.newReserveOther, sell.gross, 0);
      if (!buy) continue;
      expect(buy.tokensOut <= tokens).toBe(true);
    }
  });
});

describe("fee + slippage layers (instruction-level, around fpmm)", () => {
  test("calcFee floors in the pool's favor", () => {
    expect(calcFee(100_000n, 100)).toBe(1_000n); // 1% of 0.1
    expect(calcFee(99n, 100)).toBe(0n); // dust floors to zero
  });
  test("buy with fee: fee off the top, then fpmm on the net", () => {
    // 1% fee on 100 in -> net 99 into the 1000/1000 curve
    const withFee = quoteBuy(1000n, 1000n, 100n, 100)!;
    const manual = quoteBuy(1000n, 1000n, 99n, 0)!;
    expect(withFee.fee).toBe(1n);
    expect(withFee.tokensOut).toBe(manual.tokensOut);
  });
  test("minOutForTolerance floors and clamps", () => {
    expect(minOutForTolerance(1_000_000n, 100)).toBe(990_000n); // 1%
    expect(minOutForTolerance(1_000_000n, 0)).toBe(1_000_000n); // exact-or-revert
    expect(minOutForTolerance(999n, 100)).toBe(989n); // floor division
  });
  test("spot price: equal reserves = 50%, empty pool = 50% sentinel", () => {
    expect(spotPriceScaled(1000n, 1000n)).toBe(500_000n);
    expect(spotPriceScaled(0n, 0n)).toBe(500_000n);
    expect(spotPriceScaled(200n, 1800n)).toBe(900_000n); // scarce side is expensive
  });
});
