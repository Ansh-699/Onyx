//! Deterministic uniform-price sealed-order batch match (O7a, Level 1).
//!
//! Pure function, no accounts/syscalls, so the property "same inputs -> same
//! output regardless of the order they're passed in" is directly unit-testable
//! on the host. `run_batch_match` (instructions/) is a thin account-plumbing
//! wrapper around `run_uniform_price_match` below.
//!
//! ## The rule (documented precisely, per spec)
//! Every revealed order has `side` (A/B), `size` (desired matched notional)
//! and `limit_price` (0..=ODDS_SCALE, an abstract 0=worst..ODDS_SCALE=best
//! score on a single axis — ONYX's markets are parimutuel pools, not a priced
//! order book, so `limit_price` does NOT set a payout rate: it is purely a
//! *batch-admission* threshold. Once matched, `matched_size` becomes an
//! ordinary parimutuel stake (a `Position`, exactly like `join_market`), and
//! the actual payout at settlement is still `stake + stake/winning_pool *
//! losing_pool` (unmodified `claim`). This is the Level 1 simplification:
//! the auction decides *who gets in and how much*, not what they're paid.
//!
//! Side A orders are "buyers": eligible to transact at any price <= their
//! limit (limit = the worst/highest price they'll accept). Side B orders are
//! "sellers": eligible at any price >= their limit (limit = the worst/lowest
//! price they'll accept). This is the standard two-sided call-auction shape.
//!
//! 1. Candidate prices = the sorted set of distinct `limit_price` values
//!    across ALL orders (both sides).
//! 2. For each candidate `p` (ascending): `buy_vol(p)` = sum of `size` over
//!    side-A orders with `limit_price >= p`; `sell_vol(p)` = sum of `size`
//!    over side-B orders with `limit_price <= p`; `matched(p) = min(buy_vol(p),
//!    sell_vol(p))`.
//! 3. `p* = ` the SMALLEST candidate price that maximizes `matched(p)`
//!    (iterate ascending, only update the running best on a STRICT increase
//!    — this alone is what makes price selection order-independent and
//!    tie-broken deterministically without touching commitment hashes at all).
//! 4. `M = matched(p*)`. If `M == 0`, no orders cross; `clearing_price = 0`
//!    and every order gets `matched_size = 0`.
//! 5. Otherwise: the short side (whichever side's eligible volume == M) is
//!    fully filled. The long side is filled pro-rata by size:
//!    `matched_size_i = floor(size_i * M / long_vol)`. Flooring can leave up
//!    to `(eligible_long_orders - 1)` units of `M` undistributed ("dust");
//!    dust is handed out one unit at a time to the long-side orders with the
//!    SMALLEST `commitment` bytes first (deterministic tie-break by
//!    commitment hash, exactly as specified), capped at each order's own
//!    `size`, until dust is exhausted.
//!
//! Orders that don't cross `p*` (side A with `limit_price < p*`, or side B
//! with `limit_price > p*`) always get `matched_size = 0`.

use alloc::vec::Vec;

use crate::constants::{SIDE_A, SIDE_B};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OrderInput {
    pub side: u8,
    pub size: u64,
    pub limit_price: u64,
    pub commitment: [u8; 32],
}

/// Runs the match. Returns `(clearing_price, matched_size)` where
/// `matched_size[i]` corresponds to `orders[i]` (same order as input --
/// callers don't need to pre-sort; this function is fully order-independent).
pub fn run_uniform_price_match(orders: &[OrderInput]) -> (u64, Vec<u64>) {
    let n = orders.len();
    let mut matched = alloc::vec![0u64; n];
    if n == 0 {
        return (0, matched);
    }

    // 1. Candidate prices: sorted, deduped limit_price values.
    let mut candidates: Vec<u64> = orders.iter().map(|o| o.limit_price).collect();
    candidates.sort_unstable();
    candidates.dedup();

    // 2-3. Scan candidates ascending; track the smallest price achieving the
    // running-max matched volume.
    let mut best_price = 0u64;
    let mut best_matched = 0u64;
    for &p in candidates.iter() {
        let buy_vol: u128 = orders
            .iter()
            .filter(|o| o.side == SIDE_A && o.limit_price >= p)
            .map(|o| o.size as u128)
            .sum();
        let sell_vol: u128 = orders
            .iter()
            .filter(|o| o.side == SIDE_B && o.limit_price <= p)
            .map(|o| o.size as u128)
            .sum();
        let m = core::cmp::min(buy_vol, sell_vol);
        if m > best_matched as u128 {
            best_matched = m as u64;
            best_price = p;
        }
    }

    if best_matched == 0 {
        return (0, matched);
    }
    let p_star = best_price;
    let m = best_matched;

    // 4-5. Recompute eligibility + volumes at p*, then allocate.
    let buy_vol: u128 = orders
        .iter()
        .filter(|o| o.side == SIDE_A && o.limit_price >= p_star)
        .map(|o| o.size as u128)
        .sum();
    let sell_vol: u128 = orders
        .iter()
        .filter(|o| o.side == SIDE_B && o.limit_price <= p_star)
        .map(|o| o.size as u128)
        .sum();

    let fill_side_fully = |target_side: u8, matched: &mut [u64]| {
        for (i, o) in orders.iter().enumerate() {
            let eligible = (o.side == SIDE_A && o.limit_price >= p_star)
                || (o.side == SIDE_B && o.limit_price <= p_star);
            if o.side == target_side && eligible {
                matched[i] = o.size;
            }
        }
    };

    let pro_rate_side = |target_side: u8, long_vol: u128, matched: &mut [u64]| {
        if long_vol == 0 {
            return;
        }
        let mut distributed: u128 = 0;
        for (i, o) in orders.iter().enumerate() {
            let eligible = (o.side == SIDE_A && o.limit_price >= p_star)
                || (o.side == SIDE_B && o.limit_price <= p_star);
            if o.side == target_side && eligible {
                let alloc = (o.size as u128 * m as u128) / long_vol;
                matched[i] = alloc as u64;
                distributed += alloc;
            }
        }
        // Dust: M - distributed units left over from flooring. Hand out one
        // unit at a time to eligible target-side orders, smallest
        // commitment first, capped at each order's own size.
        let mut dust = (m as u128).saturating_sub(distributed);
        if dust == 0 {
            return;
        }
        let mut idxs: Vec<usize> = (0..orders.len())
            .filter(|&i| {
                let o = &orders[i];
                let eligible = (o.side == SIDE_A && o.limit_price >= p_star)
                    || (o.side == SIDE_B && o.limit_price <= p_star);
                o.side == target_side && eligible
            })
            .collect();
        idxs.sort_by(|&a, &b| orders[a].commitment.cmp(&orders[b].commitment));
        for i in idxs {
            if dust == 0 {
                break;
            }
            if matched[i] < orders[i].size {
                matched[i] += 1;
                dust -= 1;
            }
        }
    };

    if buy_vol == sell_vol {
        fill_side_fully(SIDE_A, &mut matched);
        fill_side_fully(SIDE_B, &mut matched);
    } else if buy_vol > sell_vol {
        // Sell side is short -> fully filled; buy side is long -> pro-rata.
        fill_side_fully(SIDE_B, &mut matched);
        pro_rate_side(SIDE_A, buy_vol, &mut matched);
    } else {
        fill_side_fully(SIDE_A, &mut matched);
        pro_rate_side(SIDE_B, sell_vol, &mut matched);
    }

    (p_star, matched)
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    use super::*;

    fn order(side: u8, size: u64, limit_price: u64, tag: u8) -> OrderInput {
        let mut commitment = [0u8; 32];
        commitment[31] = tag;
        OrderInput { side, size, limit_price, commitment }
    }

    #[test]
    fn no_orders_no_match() {
        let (p, m) = run_uniform_price_match(&[]);
        assert_eq!(p, 0);
        assert!(m.is_empty());
    }

    #[test]
    fn no_crossing_no_match() {
        // Buyer willing to pay at most 40; seller wants at least 60 -> no cross.
        let orders = [order(SIDE_A, 100, 40, 1), order(SIDE_B, 100, 60, 2)];
        let (p, m) = run_uniform_price_match(&orders);
        assert_eq!(p, 0);
        assert_eq!(m, alloc::vec![0, 0]);
    }

    #[test]
    fn exact_balanced_cross_full_fill() {
        // Buyer up to 60, seller down to 40, equal size 100 -> full match.
        let orders = [order(SIDE_A, 100, 60, 1), order(SIDE_B, 100, 40, 2)];
        let (_p, m) = run_uniform_price_match(&orders);
        assert_eq!(m, alloc::vec![100, 100]);
    }

    #[test]
    fn worked_example_pro_rata_with_dust() {
        // Two buyers (side A) crossing a single seller (side B):
        //   A1: size 100, limit 70   A2: size 200, limit 60
        //   B1: size 90,  limit 50
        // Candidates: {50, 60, 70}.
        //   p=50: buy_vol(A limit>=50)=100+200=300, sell_vol(B limit<=50)=90 -> matched=90
        //   p=60: buy_vol(A limit>=60)=100+200=300, sell_vol(B limit<=60)=90 -> matched=90
        //   p=70: buy_vol(A limit>=70)=100,          sell_vol(B limit<=70)=90 -> matched=90
        // All three candidates tie at matched=90 -> smallest wins -> p* = 50.
        // Short side = sell (90 == M) -> B1 fully filled: 90.
        // Long side = buy, long_vol = 300 -> pro-rata:
        //   A1: floor(100*90/300) = 30
        //   A2: floor(200*90/300) = 60
        //   sum = 90 == M, no dust in this example.
        let a1 = order(SIDE_A, 100, 70, 1);
        let a2 = order(SIDE_A, 200, 60, 2);
        let b1 = order(SIDE_B, 90, 50, 3);
        let orders = [a1, a2, b1];
        let (p, m) = run_uniform_price_match(&orders);
        assert_eq!(p, 50);
        assert_eq!(m, alloc::vec![30, 60, 90]);
        assert_eq!(m[0] + m[1], m[2]); // matched volume balances both sides
    }

    #[test]
    fn dust_redistributed_by_commitment_order() {
        // Seller B1 size 10 fully eligible; two equal buyers competing for it,
        // 10/2=5 each divides evenly -> no dust; use a case that doesn't divide.
        // A1 size 10 limit 60 (tag 9, larger commitment), A2 size 20 limit 60 (tag 1, smaller commitment), B1 size 10 limit 50.
        // long_vol = 30, M = 10. floor(10*10/30)=3, floor(20*10/30)=6, sum=9, dust=1.
        // Dust goes to smallest commitment first -> A2 (tag 1) gets the extra unit.
        let a1 = order(SIDE_A, 10, 60, 9);
        let a2 = order(SIDE_A, 20, 60, 1);
        let b1 = order(SIDE_B, 10, 50, 5);
        let orders = [a1, a2, b1];
        let (_p, m) = run_uniform_price_match(&orders);
        assert_eq!(m[2], 10); // seller fully filled
        assert_eq!(m[0] + m[1], 10); // all dust redistributed, nothing wasted
        assert_eq!(m[1], 7); // a2 (smallest commitment) got the dust unit: 6+1
        assert_eq!(m[0], 3);
    }

    #[test]
    fn order_independence() {
        // Same orders, different input order -> identical result (the whole
        // point: no time/submission-order advantage).
        let a1 = order(SIDE_A, 100, 70, 1);
        let a2 = order(SIDE_A, 200, 60, 2);
        let b1 = order(SIDE_B, 90, 50, 3);
        let (p1, m1) = run_uniform_price_match(&[a1, a2, b1]);
        let (p2, m2) = run_uniform_price_match(&[b1, a1, a2]);
        let (p3, m3) = run_uniform_price_match(&[a2, b1, a1]);
        assert_eq!(p1, p2);
        assert_eq!(p1, p3);
        // matched amounts are per-order, not per-slot, so compare by commitment.
        let find = |orders: &[OrderInput], m: &[u64], tag: u8| -> u64 {
            let i = orders.iter().position(|o| o.commitment[31] == tag).unwrap();
            m[i]
        };
        for tag in [1u8, 2, 3] {
            let v1 = find(&[a1, a2, b1], &m1, tag);
            let v2 = find(&[b1, a1, a2], &m2, tag);
            let v3 = find(&[a2, b1, a1], &m3, tag);
            assert_eq!(v1, v2);
            assert_eq!(v1, v3);
        }
    }

    #[test]
    fn unmatched_orders_get_zero() {
        // A3 limit too low to cross -> gets 0 even though same side as a winner.
        let a1 = order(SIDE_A, 100, 70, 1);
        let a_low = order(SIDE_A, 500, 10, 4);
        let b1 = order(SIDE_B, 50, 50, 3);
        let orders = [a1, a_low, b1];
        let (_p, m) = run_uniform_price_match(&orders);
        assert_eq!(m[1], 0);
    }
}
