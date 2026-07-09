//! Market account (spec §5.3). PDA at ["market", fixture_id_u64_le, params_hash_32].
//!
//! Layout (total 128 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 2
//!   1     7  _pad
//!   8     8  fixture_id (u64 LE)
//!  16     4  stat_a_key (u32)
//!  20     4  stat_b_key (u32, 0 if unused)
//!  24     1  op (u8: 0xFF none / 0 Add / 1 Subtract)
//!  25     1  predicate (u8: comparison 0 GT / 1 LT / 2 EQ)
//!  26     1  status (u8, see constants)
//!  27     1  outcome (u8: 0 unknown / 1 sideA / 2 sideB)
//!  28     8  threshold (i64 LE)
//!  36     8  deadline (i64 unix secs)
//!  44     8  created_slot (u64)
//!  52     8  total_side_a (u64)
//!  60     8  total_side_b (u64)
//!  68    32  params_hash [u8;32]
//! 100     1  vault_bump
//! 101     1  bump
//! 102    25  sealed-order extension (Level 1, O7) -- carved out of what was
//!            previously pure `_reserved` padding. Every EXISTING market has
//!            zeroed bytes here, so `phase()` reads back PHASE_NONE (0) for
//!            free on any market opened before this extension -- no format
//!            migration, no MARKET_LEN change, zero risk to already-proven
//!            L0/ER markets:
//! 102     8    commit_end_ts (i64 LE)
//! 110     8    reveal_end_ts (i64 LE)
//! 118     1    phase (u8: 0 None / 1 Commit / 2 Reveal / 3 Matched)
//! 119     8    clearing_price (u64 LE, 0..=ODDS_SCALE; set by run_batch_match)
//! 127     1  _reserved (1 byte still spare)
//! ```

use crate::constants::DISC_MARKET;
use crate::error::OnyxError;

pub const MARKET_LEN: usize = 128;

const O_DISC: usize = 0;
const O_FIXTURE_ID: usize = 8;
const O_STAT_A: usize = 16;
const O_STAT_B: usize = 20;
const O_OP: usize = 24;
const O_PREDICATE: usize = 25;
const O_STATUS: usize = 26;
const O_OUTCOME: usize = 27;
const O_THRESHOLD: usize = 28;
const O_DEADLINE: usize = 36;
const O_CREATED_SLOT: usize = 44;
const O_TOTAL_A: usize = 52;
const O_TOTAL_B: usize = 60;
const O_PARAMS_HASH: usize = 68;
const O_VAULT_BUMP: usize = 100;
const O_BUMP: usize = 101;
const O_COMMIT_END_TS: usize = 102;
const O_REVEAL_END_TS: usize = 110;
const O_PHASE: usize = 118;
const O_CLEARING_PRICE: usize = 119;

pub struct Market<'a> {
    data: &'a mut [u8],
}

/// Canonical market terms used for the params_hash binding and for building the
/// validate_stat predicate. Populated from instruction args / account reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketTerms {
    pub fixture_id: u64,
    pub stat_a_key: u32,
    pub stat_b_key: u32,
    pub op: u8,
    pub predicate: u8,
    pub threshold: i64,
    pub deadline: i64,
}

impl<'a> Market<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < MARKET_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let m = Self::from_bytes(data)?;
        if m.disc() != DISC_MARKET {
            return Err(OnyxError::WrongStatus);
        }
        Ok(m)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    #[inline]
    pub fn is_initialized(&self) -> bool {
        self.disc() == DISC_MARKET
    }

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        terms: &MarketTerms,
        params_hash: &[u8; 32],
        created_slot: u64,
        status: u8,
        vault_bump: u8,
        bump: u8,
    ) {
        for b in self.data[..MARKET_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_MARKET;
        self.data[O_FIXTURE_ID..O_FIXTURE_ID + 8].copy_from_slice(&terms.fixture_id.to_le_bytes());
        self.data[O_STAT_A..O_STAT_A + 4].copy_from_slice(&terms.stat_a_key.to_le_bytes());
        self.data[O_STAT_B..O_STAT_B + 4].copy_from_slice(&terms.stat_b_key.to_le_bytes());
        self.data[O_OP] = terms.op;
        self.data[O_PREDICATE] = terms.predicate;
        self.data[O_STATUS] = status;
        self.data[O_OUTCOME] = crate::constants::OUTCOME_UNKNOWN;
        self.data[O_THRESHOLD..O_THRESHOLD + 8].copy_from_slice(&terms.threshold.to_le_bytes());
        self.data[O_DEADLINE..O_DEADLINE + 8].copy_from_slice(&terms.deadline.to_le_bytes());
        self.data[O_CREATED_SLOT..O_CREATED_SLOT + 8].copy_from_slice(&created_slot.to_le_bytes());
        self.data[O_PARAMS_HASH..O_PARAMS_HASH + 32].copy_from_slice(params_hash);
        self.data[O_VAULT_BUMP] = vault_bump;
        self.data[O_BUMP] = bump;
    }

    #[inline]
    pub fn fixture_id(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_FIXTURE_ID).unwrap_or(0)
    }

    #[inline]
    pub fn stat_a_key(&self) -> u32 {
        crate::util::read_u32_le(self.data, O_STAT_A).unwrap_or(0)
    }

    #[inline]
    pub fn stat_b_key(&self) -> u32 {
        crate::util::read_u32_le(self.data, O_STAT_B).unwrap_or(0)
    }

    #[inline]
    pub fn op(&self) -> u8 {
        self.data[O_OP]
    }

    #[inline]
    pub fn predicate(&self) -> u8 {
        self.data[O_PREDICATE]
    }

    #[inline]
    pub fn status(&self) -> u8 {
        self.data[O_STATUS]
    }

    #[inline]
    pub fn set_status(&mut self, status: u8) {
        self.data[O_STATUS] = status;
    }

    #[inline]
    pub fn outcome(&self) -> u8 {
        self.data[O_OUTCOME]
    }

    #[inline]
    pub fn set_outcome(&mut self, outcome: u8) {
        self.data[O_OUTCOME] = outcome;
    }

    #[inline]
    pub fn threshold(&self) -> i64 {
        crate::util::read_i64_le(self.data, O_THRESHOLD).unwrap_or(0)
    }

    #[inline]
    pub fn deadline(&self) -> i64 {
        crate::util::read_i64_le(self.data, O_DEADLINE).unwrap_or(0)
    }

    #[inline]
    pub fn total_side_a(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_TOTAL_A).unwrap_or(0)
    }

    #[inline]
    pub fn total_side_b(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_TOTAL_B).unwrap_or(0)
    }

    #[inline]
    pub fn set_total_side_a(&mut self, v: u64) {
        self.data[O_TOTAL_A..O_TOTAL_A + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn set_total_side_b(&mut self, v: u64) {
        self.data[O_TOTAL_B..O_TOTAL_B + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn params_hash(&self) -> [u8; 32] {
        crate::util::read_array32(self.data, O_PARAMS_HASH).unwrap_or([0u8; 32])
    }

    #[inline]
    pub fn vault_bump(&self) -> u8 {
        self.data[O_VAULT_BUMP]
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
    }

    /// Sets the sealed-order extension fields. Called once by
    /// `open_market_sealed` right after `initialize()`; never touched by
    /// plain `open_market`, so ordinary markets keep phase()==PHASE_NONE.
    #[inline]
    pub fn init_sealed(&mut self, commit_end_ts: i64, reveal_end_ts: i64) {
        self.data[O_COMMIT_END_TS..O_COMMIT_END_TS + 8].copy_from_slice(&commit_end_ts.to_le_bytes());
        self.data[O_REVEAL_END_TS..O_REVEAL_END_TS + 8].copy_from_slice(&reveal_end_ts.to_le_bytes());
        self.data[O_PHASE] = crate::constants::PHASE_COMMIT;
        self.data[O_CLEARING_PRICE..O_CLEARING_PRICE + 8].copy_from_slice(&0u64.to_le_bytes());
    }

    #[inline]
    pub fn commit_end_ts(&self) -> i64 {
        crate::util::read_i64_le(self.data, O_COMMIT_END_TS).unwrap_or(0)
    }

    #[inline]
    pub fn reveal_end_ts(&self) -> i64 {
        crate::util::read_i64_le(self.data, O_REVEAL_END_TS).unwrap_or(0)
    }

    #[inline]
    pub fn phase(&self) -> u8 {
        self.data[O_PHASE]
    }

    #[inline]
    pub fn set_phase(&mut self, phase: u8) {
        self.data[O_PHASE] = phase;
    }

    #[inline]
    pub fn clearing_price(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_CLEARING_PRICE).unwrap_or(0)
    }

    #[inline]
    pub fn set_clearing_price(&mut self, price: u64) {
        self.data[O_CLEARING_PRICE..O_CLEARING_PRICE + 8].copy_from_slice(&price.to_le_bytes());
    }

    #[inline]
    pub fn terms(&self) -> MarketTerms {
        MarketTerms {
            fixture_id: self.fixture_id(),
            stat_a_key: self.stat_a_key(),
            stat_b_key: self.stat_b_key(),
            op: self.op(),
            predicate: self.predicate(),
            threshold: self.threshold(),
            deadline: self.deadline(),
        }
    }
}
