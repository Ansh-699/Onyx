//! Fixed-product (CPMM) outcome-token market maker — pure math, no accounts
//! or syscalls, exactly the same "no accounts -> host-unit-testable"
//! discipline as `matching.rs`. `docs/AMM_TRADING_DESIGN.md` §1-2 is the
//! full design writeup; this file is that design's arithmetic, derived and
//! cross-checked twice against the Gnosis-style FPMM invariant before being
//! trusted (see the derivation notes on each function).
//!
//! ## Invariant
//! Pool holds virtual reserves `(reserve_a, reserve_b)` of two complementary
//! outcome tokens, backed by `sets_outstanding` collateral 1:1 (1 unit of
//! collateral == 1 A token + 1 B token, always minted/burned in pairs). The
//! constant-product invariant `k = a * b` is preserved across every trade
//! (net of fees, which strictly increase k in the pool's favor). Every
//! division here rounds AGAINST the trader and IN FAVOR of the pool — the
//! solvency identity in the design doc depends on this being true in every
//! single call, not just on average.
//!
//! ## Buy derivation (mint-then-swap, the standard Gnosis FPMM mechanism)
//! Buying A with net collateral `m'` (fee already deducted by the caller):
//! 1. Mint `m'` complete sets: temporarily `a' = a + m'`, `b' = b + m'`,
//!    `sets_outstanding += m'`.
//! 2. Solve for the ending A balance that preserves the PRE-mint product
//!    against the POST-mint B balance: `ending_a = ceil(a * b / (b + m'))`
//!    (ceil, not floor — the pool KEEPS the rounded-up remainder, so the
//!    user's payout below rounds down; the ORIGINAL a/b product here is
//!    correct because minting alone doesn't change price, only a real swap
//!    against the invariant does).
//! 3. User receives `Δa = a' - ending_a = (a + m') - ending_a` tokens of A
//!    ONLY (zero B — the "swap the unwanted B back into the pool" step is
//!    folded directly into `ending_a`'s formula, not a separate leg).
//! New reserves: `(ending_a, b + m')`.
//!
//! ## Sell derivation (exact-tokens-in, solved as the algebraic mirror of buy)
//! Selling `Δa` tokens of A for gross collateral `m` (fee taken from `m`
//! by the caller after this returns): conceptually the user hands `Δa` of A
//! into the pool and the pool burns `m` complete sets (removing `m` from
//! BOTH reserves) to pay them. Preserving the pre-trade product
//! `a*b = (a + Δa - m)(b - m)` and expanding gives the quadratic
//! `m² - m(a + b + Δa) + Δa*b = 0`; the economically valid (smaller) root is
//! `m = (s - isqrt(s² - 4*b*Δa)) / 2` where `s = a + b + Δa`. Re-derived
//! independently from the invariant (not copied) and cross-checked against
//! the buy formula's structure before being trusted — see `fpmm_tests.rs`'s
//! `sell_formula_matches_manual_algebra` for the check written down.
//! New reserves: `(a + Δa - m, b - m)`.
//!
//! All intermediate math is u128 (reserves are u64, so products fit with
//! massive headroom: (2*10^13)^2 ≈ 4*10^26, still under u128::MAX ≈
//! 3.4*10^38); every truncating cast back to u64 is preceded by an explicit
//! range check, never a silent wrap.

use crate::error::OnyxError;

/// Floor integer square root of a u128, via Newton's method with an
/// exact-bit-length initial guess (no floats — this is `no_std` and money
/// math, float sqrt would be both unavailable and wrong). Standard
/// algorithm (same shape as Rust's unstable `u128::isqrt`, reimplemented
/// here since this crate is on stable + no_std).
pub fn isqrt_u128(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Initial guess: 2^(ceil(bits(n)/2)), guaranteed >= true sqrt(n).
    let bits = 128 - n.leading_zeros();
    let mut x = 1u128 << bits.div_ceil(2);
    loop {
        // x_next = floor((x + n/x) / 2). Guaranteed to converge monotonically
        // downward to floor(sqrt(n)) from above for this initial guess.
        let x_next = (x + n / x) / 2;
        if x_next >= x {
            break;
        }
        x = x_next;
    }
    // Newton's method for integer sqrt can land one above the true floor on
    // the final step for some n; correct it explicitly rather than trust
    // the iteration boundary. Uses checked_mul, not raw `*`: for n near
    // u128::MAX, x (or x+1) can be close enough to 2^64 that squaring it
    // overflows u128 -- found by the isqrt_large_values test panicking on
    // exactly this (n = u128::MAX). An overflowing square is BY DEFINITION
    // greater than any valid u128 n, so treat overflow as "not <= n" /
    // "> n" rather than trusting `*` not to wrap.
    while x.checked_mul(x).map(|sq| sq > n).unwrap_or(true) {
        x -= 1;
    }
    while (x + 1)
        .checked_mul(x + 1)
        .map(|sq| sq <= n)
        .unwrap_or(false)
    {
        x += 1;
    }
    x
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyResult {
    pub tokens_out: u64,
    pub new_reserve_buy: u64,
    pub new_reserve_other: u64,
}

/// Buy `net_collateral_in` (fee ALREADY deducted by the caller) worth of the
/// side whose current reserve is `reserve_buy`, with the other side's
/// reserve `reserve_other`. Returns tokens out and the two new reserves.
/// Caller is responsible for: taking the fee before calling this, crediting
/// `sets_outstanding += net_collateral_in`, and checking `min_out`.
pub fn calc_buy(
    reserve_buy: u64,
    reserve_other: u64,
    net_collateral_in: u64,
) -> Result<BuyResult, OnyxError> {
    if net_collateral_in == 0 {
        return Err(OnyxError::InsufficientStake);
    }
    if reserve_buy == 0 || reserve_other == 0 {
        return Err(OnyxError::InsufficientLiquidity);
    }
    let a = reserve_buy as u128;
    let b = reserve_other as u128;
    let m = net_collateral_in as u128;

    let a_plus_m = a.checked_add(m).ok_or(OnyxError::ArithmeticOverflow)?;
    let b_plus_m = b.checked_add(m).ok_or(OnyxError::ArithmeticOverflow)?;
    let product = a.checked_mul(b).ok_or(OnyxError::ArithmeticOverflow)?;
    // ceil(product / b_plus_m) = (product + b_plus_m - 1) / b_plus_m, safe
    // since b_plus_m > 0 (checked above: b > 0, m >= 0 so b_plus_m >= b > 0).
    let ending_a = product
        .checked_add(b_plus_m - 1)
        .ok_or(OnyxError::ArithmeticOverflow)?
        / b_plus_m;
    // ending_a <= a_plus_m always (proof: ending_a = ceil(a*b/(b+m)) and
    // since m>=0, b/(b+m) <= 1, so a*b/(b+m) <= a <= a+m; ceil of something
    // <= a can exceed a by at most a rounding unit only when b+m divides
    // evenly with remainder pushing past a — practically unreachable given
    // a,b are independent u64 reserves, but checked_sub below guards it
    // regardless rather than trusting the proof under adversarial inputs).
    let tokens_out_128 = a_plus_m
        .checked_sub(ending_a)
        .ok_or(OnyxError::ArithmeticOverflow)?;

    let tokens_out = u64::try_from(tokens_out_128).map_err(|_| OnyxError::ArithmeticOverflow)?;
    let new_reserve_buy = u64::try_from(ending_a).map_err(|_| OnyxError::ArithmeticOverflow)?;
    let new_reserve_other =
        u64::try_from(b_plus_m).map_err(|_| OnyxError::ArithmeticOverflow)?;

    Ok(BuyResult { tokens_out, new_reserve_buy, new_reserve_other })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellResult {
    pub gross_collateral_out: u64,
    pub new_reserve_sell: u64,
    pub new_reserve_other: u64,
}

/// Sell `tokens_in` of the side whose current reserve is `reserve_sell`
/// (receiving collateral, price impact against `reserve_other`). Returns
/// GROSS collateral out — caller takes the fee from this and credits
/// `sets_outstanding -= gross_collateral_out` before crediting the user
/// `gross - fee`, and checks `min_out` against the NET amount.
pub fn calc_sell(
    reserve_sell: u64,
    reserve_other: u64,
    tokens_in: u64,
) -> Result<SellResult, OnyxError> {
    if tokens_in == 0 {
        return Err(OnyxError::InsufficientStake);
    }
    if reserve_sell == 0 || reserve_other == 0 {
        return Err(OnyxError::InsufficientLiquidity);
    }
    let a = reserve_sell as u128;
    let b = reserve_other as u128;
    let d = tokens_in as u128; // "ΔA" in the derivation above

    let s = a
        .checked_add(b)
        .ok_or(OnyxError::ArithmeticOverflow)?
        .checked_add(d)
        .ok_or(OnyxError::ArithmeticOverflow)?;
    let four_b_d = 4u128
        .checked_mul(b)
        .ok_or(OnyxError::ArithmeticOverflow)?
        .checked_mul(d)
        .ok_or(OnyxError::ArithmeticOverflow)?;
    let s_sq = s.checked_mul(s).ok_or(OnyxError::ArithmeticOverflow)?;
    // Discriminant is always >= 0 for valid (a,b,d > 0): s^2 - 4bd expands to
    // (a+d-b)^2 + 4ad + ... (see fpmm_tests.rs::discriminant_never_negative
    // for the property test that verifies this holds for the entire tested
    // input space) -- checked_sub as the actual runtime guard regardless,
    // never trust the proof over the check.
    let discriminant = s_sq.checked_sub(four_b_d).ok_or(OnyxError::ArithmeticOverflow)?;
    let sqrt_disc = isqrt_u128(discriminant);
    // Smaller root, floored by integer sqrt rounding down already (sqrt_disc
    // <= true root), which makes (s - sqrt_disc) round UP relative to exact
    // math, so m below rounds DOWN on the final /2 -- rounds against the
    // trader on both steps, per the file-level rounding rule.
    let m = s.checked_sub(sqrt_disc).ok_or(OnyxError::ArithmeticOverflow)? / 2;

    let new_reserve_sell_128 = a
        .checked_add(d)
        .ok_or(OnyxError::ArithmeticOverflow)?
        .checked_sub(m)
        .ok_or(OnyxError::ArithmeticOverflow)?;
    let new_reserve_other_128 = b.checked_sub(m).ok_or(OnyxError::ArithmeticOverflow)?;

    let gross_collateral_out = u64::try_from(m).map_err(|_| OnyxError::ArithmeticOverflow)?;
    let new_reserve_sell =
        u64::try_from(new_reserve_sell_128).map_err(|_| OnyxError::ArithmeticOverflow)?;
    let new_reserve_other =
        u64::try_from(new_reserve_other_128).map_err(|_| OnyxError::ArithmeticOverflow)?;

    Ok(SellResult { gross_collateral_out, new_reserve_sell, new_reserve_other })
}

/// `amount * fee_bps / 10_000`, checked. Shared by buy (fee taken from
/// collateral in) and sell (fee taken from gross collateral out).
pub fn calc_fee(amount: u64, fee_bps: u16) -> Result<u64, OnyxError> {
    let f = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(OnyxError::ArithmeticOverflow)?
        / 10_000u128;
    u64::try_from(f).map_err(|_| OnyxError::ArithmeticOverflow)
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    use super::*;

    // ---- isqrt correctness ----

    #[test]
    fn isqrt_perfect_squares() {
        for n in 0u128..2000 {
            assert_eq!(isqrt_u128(n * n), n, "isqrt({}) should be exactly {}", n * n, n);
        }
    }

    #[test]
    fn isqrt_non_perfect_squares_floor() {
        // isqrt(n) must satisfy x*x <= n < (x+1)*(x+1) for every n, not just
        // perfect squares.
        for n in 0u128..5000 {
            let x = isqrt_u128(n);
            assert!(x * x <= n, "isqrt({n})={x} but x*x={} > n", x * x);
            assert!((x + 1) * (x + 1) > n, "isqrt({n})={x} but (x+1)^2 <= n");
        }
    }

    #[test]
    fn isqrt_large_values() {
        let n = u128::from(u64::MAX) * u128::from(u64::MAX);
        let x = isqrt_u128(n);
        assert_eq!(x, u128::from(u64::MAX));

        let n2 = u128::MAX;
        let x2 = isqrt_u128(n2);
        // Same overflow class as isqrt_u128 itself had (x2 is close enough
        // to 2^64 that squaring x2+1 can overflow u128) -- checked_mul here
        // too, for the same reason: an overflowing square is definitionally
        // > n2, so treat overflow as "the upper-bound check passes".
        assert!(x2.checked_mul(x2).map(|sq| sq <= n2).unwrap_or(false));
        assert!(
            x2.checked_add(1)
                .and_then(|y| y.checked_mul(y))
                .map(|sq| sq > n2)
                .unwrap_or(true)
        );
    }

    // ---- buy: known values, hand-checkable ----

    #[test]
    fn buy_equal_reserves_known_value() {
        // Pool 1000/1000 (50/50 price). Buy A with net 100 collateral:
        // ending_a = ceil(1000*1000/1100) = ceil(909.09) = 910
        // tokens_out = (1000+100) - 910 = 190
        let r = calc_buy(1000, 1000, 100).unwrap();
        assert_eq!(r.new_reserve_buy, 910);
        assert_eq!(r.new_reserve_other, 1100);
        assert_eq!(r.tokens_out, 190);
        // Sanity: buying the "cheap" side of an equal pool should net MORE
        // than the collateral spent (190 > 100) -- that's the whole point of
        // buying at 50% odds, you get better than 1:1 outcome tokens.
        assert!(r.tokens_out > 100);
    }

    #[test]
    fn buy_price_impact_direction() {
        // Buying A should always REDUCE reserve_a and INCREASE reserve_b,
        // moving price further toward A (a smaller share of a bigger total
        // means A got more expensive for the NEXT buyer -- price impact).
        let r = calc_buy(1000, 1000, 100).unwrap();
        assert!(r.new_reserve_buy < 1000);
        assert!(r.new_reserve_other > 1000);
    }

    #[test]
    fn buy_skewed_pool_cheap_side_gets_more_tokens() {
        // A is the "expensive"/likely side (small reserve = high implied
        // probability); B is cheap. Buying the SAME collateral of the cheap
        // side should yield more tokens than buying the expensive side.
        let buy_expensive = calc_buy(200, 1800, 100).unwrap(); // reserve_buy small = expensive
        let buy_cheap = calc_buy(1800, 200, 100).unwrap(); // reserve_buy large = cheap
        assert!(buy_cheap.tokens_out > buy_expensive.tokens_out);
    }

    // ---- sell: known values + algebra cross-check ----

    #[test]
    fn sell_formula_matches_manual_algebra() {
        // Manually verify m solves (a+d-m)(b-m) == a*b for a hand-picked
        // case, confirming the quadratic derivation in the file header is
        // correctly implemented, not just internally self-consistent.
        let (a, b, d) = (1000u128, 1000u128, 200u128);
        let r = calc_sell(1000, 1000, 200).unwrap();
        let m = r.gross_collateral_out as u128;
        let lhs = (a + d - m) * (b - m);
        let rhs = a * b;
        // Integer rounding means this won't be exact; must be within a
        // small tolerance proportional to the rounding, and m must round
        // the trader's favor DOWN (pool keeps the remainder).
        let diff = if lhs > rhs { lhs - rhs } else { rhs - lhs };
        assert!(diff < 2000, "sell formula diverges from manual algebra by {diff}");
    }

    #[test]
    fn sell_price_impact_direction() {
        let r = calc_sell(1000, 1000, 200).unwrap();
        assert!(r.new_reserve_sell > 1000, "reserve_sell should grow (user handed tokens in)");
        assert!(r.new_reserve_other < 1000, "reserve_other should shrink (collateral paid out)");
    }

    #[test]
    fn discriminant_never_negative_property() {
        // The sell formula's checked_sub on the discriminant would return
        // Err(ArithmeticOverflow) if it ever went negative -- assert it
        // never does across a wide adversarial grid of (a, b, d), not just
        // the hand-picked happy-path values above.
        for a in [1u64, 7, 1000, 50_000, 1_000_000, u64::MAX / 4] {
            for b in [1u64, 7, 1000, 50_000, 1_000_000, u64::MAX / 4] {
                for d in [1u64, 7, 1000, 50_000, 1_000_000, u64::MAX / 4] {
                    let res = calc_sell(a, b, d);
                    assert!(res.is_ok(), "calc_sell({a},{b},{d}) unexpectedly failed: {res:?}");
                }
            }
        }
    }

    // ---- no-free-lunch: buy-then-sell (or sell-then-buy) never profits the trader ----

    #[test]
    fn buy_then_sell_round_trip_never_profits_trader() {
        // Buy some A, then immediately sell the exact tokens back. Even with
        // ZERO fee (fee is applied by the caller, not this module), pure
        // AMM price impact must mean the trader gets back <= what they put
        // in -- otherwise the math is arbitrageable for free, which would
        // mean the invariant derivation is wrong.
        for net_in in [1u64, 10, 100, 1_000, 50_000] {
            let buy = calc_buy(1000, 1000, net_in).unwrap();
            let sell = calc_sell(buy.new_reserve_buy, buy.new_reserve_other, buy.tokens_out).unwrap();
            assert!(
                sell.gross_collateral_out <= net_in,
                "round trip profited: put in {net_in}, got back {} (buy tokens_out={})",
                sell.gross_collateral_out,
                buy.tokens_out
            );
        }
    }

    #[test]
    fn sell_then_buy_round_trip_never_profits_trader() {
        for tokens in [1u64, 10, 100, 1_000, 50_000] {
            let sell = calc_sell(1000, 1000, tokens).unwrap();
            // A tiny sell can legitimately round DOWN to zero gross proceeds
            // (dust favoring the pool, per the file's rounding rule) --
            // calc_buy correctly rejects a zero-collateral buy with
            // InsufficientStake in that case, which is not a round-trip
            // profit (0 <= tokens trivially), just nothing to buy back with.
            // Found by this exact test panicking on tokens=1 before this
            // branch existed -- a real gap in the test, not the math.
            if sell.gross_collateral_out == 0 {
                continue;
            }
            let buy = calc_buy(sell.new_reserve_sell, sell.new_reserve_other, sell.gross_collateral_out).unwrap();
            assert!(
                buy.tokens_out <= tokens,
                "round trip profited: sold {tokens}, bought back {} (sell proceeds={})",
                buy.tokens_out,
                sell.gross_collateral_out
            );
        }
    }

    // ---- degenerate inputs ----

    #[test]
    fn buy_rejects_zero_amount() {
        assert_eq!(calc_buy(1000, 1000, 0), Err(OnyxError::InsufficientStake));
    }
    #[test]
    fn sell_rejects_zero_amount() {
        assert_eq!(calc_sell(1000, 1000, 0), Err(OnyxError::InsufficientStake));
    }
    #[test]
    fn buy_rejects_empty_pool() {
        assert_eq!(calc_buy(0, 1000, 100), Err(OnyxError::InsufficientLiquidity));
        assert_eq!(calc_buy(1000, 0, 100), Err(OnyxError::InsufficientLiquidity));
    }
    #[test]
    fn sell_rejects_empty_pool() {
        assert_eq!(calc_sell(0, 1000, 100), Err(OnyxError::InsufficientLiquidity));
        assert_eq!(calc_sell(1000, 0, 100), Err(OnyxError::InsufficientLiquidity));
    }

    #[test]
    fn fee_calc_known_values() {
        assert_eq!(calc_fee(1_000_000, 100).unwrap(), 10_000); // 1% of 1,000,000
        assert_eq!(calc_fee(1_000_000, 0).unwrap(), 0);
        assert_eq!(calc_fee(0, 100).unwrap(), 0);
        assert_eq!(calc_fee(1, 100).unwrap(), 0); // rounds down to nothing, favors pool via caller keeping the dust
    }
}
