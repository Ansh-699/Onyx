//! One module per instruction handler plus shared helpers.

pub mod claim;
pub mod create_market_permission;
pub mod delegate_market;
pub mod initialize_config;
pub mod join_market;
pub mod open_market;
pub mod open_market_sealed;
pub mod process_undelegation;
pub mod refund_expired;
pub mod refund_unrevealed;
pub mod reveal_order;
pub mod run_batch_match;
pub mod settle_market;
pub mod submit_sealed_order;
pub mod touch_market;
pub mod undelegate_market;

use solana_nostd_sha256::hashv;

use crate::state::market::MarketTerms;

/// Compute the canonical `params_hash` = SHA-256 over the market terms in a
/// fixed, canonical byte order. This is the terms-hash binding: the same terms
/// always hash to the same value, and the Market PDA is derived from it, so a
/// market's terms are immutable once created.
///
/// Canonical encoding (all little-endian):
/// `fixture_id(8) || stat_a_key(4) || stat_b_key(4) || op(1) || predicate(1)
///  || threshold(8) || deadline(8)`  = 34 bytes.
pub fn compute_params_hash(terms: &MarketTerms) -> [u8; 32] {
    let mut buf = [0u8; 34];
    buf[0..8].copy_from_slice(&terms.fixture_id.to_le_bytes());
    buf[8..12].copy_from_slice(&terms.stat_a_key.to_le_bytes());
    buf[12..16].copy_from_slice(&terms.stat_b_key.to_le_bytes());
    buf[16] = terms.op;
    buf[17] = terms.predicate;
    buf[18..26].copy_from_slice(&terms.threshold.to_le_bytes());
    buf[26..34].copy_from_slice(&terms.deadline.to_le_bytes());
    hashv(&[&buf])
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    use super::*;

    fn terms() -> MarketTerms {
        MarketTerms {
            fixture_id: 12345,
            stat_a_key: 7,
            stat_b_key: 0,
            op: crate::constants::OP_NONE,
            predicate: crate::constants::CMP_GREATER_THAN,
            threshold: 2,
            deadline: 1_800_000_000,
        }
    }

    #[test]
    fn params_hash_is_deterministic() {
        let t = terms();
        assert_eq!(compute_params_hash(&t), compute_params_hash(&t));
    }

    #[test]
    fn params_hash_changes_with_threshold() {
        let mut t2 = terms();
        t2.threshold = 3;
        assert_ne!(compute_params_hash(&terms()), compute_params_hash(&t2));
    }

    #[test]
    fn params_hash_changes_with_fixture() {
        let mut t2 = terms();
        t2.fixture_id = 99;
        assert_ne!(compute_params_hash(&terms()), compute_params_hash(&t2));
    }
}
