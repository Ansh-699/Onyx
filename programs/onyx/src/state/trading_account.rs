//! TradingAccount (ER-fast trading, additive to the base sealed-order flow —
//! see docs/ER_TRADING_DESIGN.md). PDA at `["trading", market, owner]`.
//! One per (user, market): a single real base-layer deposit funds it, it's
//! delegated once, and every subsequent commit/reveal/cancel/match is a pure
//! field mutation on this already-delegated account — no token CPI, no
//! lamports movement, which is exactly the operation class proven to run on
//! the ER (§0 of the design doc: the ER hard-rejects any tx that would
//! change a non-delegated account's balance, including the fee payer).
//!
//! Layout (total 176 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 5
//!   1     7  _pad
//!   8    32  owner
//!  40    32  market
//!  72     8  deposited (u64 LE)     -- total ever moved in via the one real SPL transfer
//!  80     8  available (u64 LE)     -- deposited - locked - withdrawn
//!  88     8  locked (u64 LE)        -- collateral behind the current open order
//!  96    32  commitment [u8;32]     -- sealed-order hash; all-zero = no open order
//! 128     1  side (u8)              -- 0=none, 1=A, 2=B -- set on reveal
//! 129     1  status (u8)            -- 0 None / 1 Locked / 2 Revealed / 3 Matched
//! 130     6  _pad2 (align u64 fields below to 8)
//! 136     8  size (u64 LE)          -- set on reveal
//! 144     8  limit_price (u64 LE)   -- set on reveal
//! 152     8  matched_size (u64 LE)  -- set by run_batch_match_fast
//! 160     8  withdrawn (u64 LE)     -- cumulative amount ever paid out
//! 168     1  bump
//! 169     1  claimed_winnings (0/1) -- guards the matched-winnings leg of
//!            withdraw_trading against double payout; the unlocked
//!            `available` leg needs no such guard, it's just decremented.
//! 170     6  _reserved
//! ```

use crate::constants::DISC_TRADING_ACCOUNT;
use crate::error::OnyxError;
use pinocchio::pubkey::Pubkey;

pub const TRADING_ACCOUNT_LEN: usize = 176;

const O_DISC: usize = 0;
const O_OWNER: usize = 8;
const O_MARKET: usize = 40;
const O_DEPOSITED: usize = 72;
const O_AVAILABLE: usize = 80;
const O_LOCKED: usize = 88;
const O_COMMITMENT: usize = 96;
const O_SIDE: usize = 128;
const O_STATUS: usize = 129;
const O_SIZE: usize = 136;
const O_LIMIT_PRICE: usize = 144;
const O_MATCHED_SIZE: usize = 152;
const O_WITHDRAWN: usize = 160;
const O_BUMP: usize = 168;
const O_CLAIMED_WINNINGS: usize = 169;

pub struct TradingAccount<'a> {
    data: &'a mut [u8],
}

impl<'a> TradingAccount<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < TRADING_ACCOUNT_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let t = Self::from_bytes(data)?;
        if t.disc() != DISC_TRADING_ACCOUNT {
            return Err(OnyxError::WrongStatus);
        }
        Ok(t)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    #[inline]
    pub fn is_initialized(&self) -> bool {
        self.disc() == DISC_TRADING_ACCOUNT
    }

    pub fn initialize(&mut self, owner: &Pubkey, market: &Pubkey, bump: u8) {
        for b in self.data[..TRADING_ACCOUNT_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_TRADING_ACCOUNT;
        self.data[O_OWNER..O_OWNER + 32].copy_from_slice(owner);
        self.data[O_MARKET..O_MARKET + 32].copy_from_slice(market);
        self.data[O_BUMP] = bump;
    }

    #[inline]
    pub fn owner(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_OWNER..O_OWNER + 32]);
        p
    }

    #[inline]
    pub fn market(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_MARKET..O_MARKET + 32]);
        p
    }

    #[inline]
    pub fn deposited(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_DEPOSITED).unwrap_or(0)
    }
    #[inline]
    pub fn set_deposited(&mut self, v: u64) {
        self.data[O_DEPOSITED..O_DEPOSITED + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn available(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_AVAILABLE).unwrap_or(0)
    }
    #[inline]
    pub fn set_available(&mut self, v: u64) {
        self.data[O_AVAILABLE..O_AVAILABLE + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn locked(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_LOCKED).unwrap_or(0)
    }
    #[inline]
    pub fn set_locked(&mut self, v: u64) {
        self.data[O_LOCKED..O_LOCKED + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn commitment(&self) -> [u8; 32] {
        crate::util::read_array32(self.data, O_COMMITMENT).unwrap_or([0u8; 32])
    }
    #[inline]
    pub fn set_commitment(&mut self, c: &[u8; 32]) {
        self.data[O_COMMITMENT..O_COMMITMENT + 32].copy_from_slice(c);
    }

    #[inline]
    pub fn side(&self) -> u8 {
        self.data[O_SIDE]
    }

    #[inline]
    pub fn status(&self) -> u8 {
        self.data[O_STATUS]
    }
    #[inline]
    pub fn set_status(&mut self, v: u8) {
        self.data[O_STATUS] = v;
    }

    #[inline]
    pub fn size(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_SIZE).unwrap_or(0)
    }

    #[inline]
    pub fn limit_price(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_LIMIT_PRICE).unwrap_or(0)
    }

    #[inline]
    pub fn matched_size(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_MATCHED_SIZE).unwrap_or(0)
    }
    /// Mirrors the base SealedOrder's set_matched_size (state/sealed_order.rs)
    /// exactly, including flipping status -- a real bug caught by the Phase 1
    /// lifecycle proof: this setter originally only wrote the field, never
    /// advanced status to Matched, so withdraw_trading's winnings branch
    /// (gated on status == Matched) silently never fired and both sides of
    /// a real matched trade only ever got their unlocked `available` back.
    #[inline]
    pub fn set_matched_size(&mut self, v: u64) {
        self.data[O_MATCHED_SIZE..O_MATCHED_SIZE + 8].copy_from_slice(&v.to_le_bytes());
        self.data[O_STATUS] = crate::constants::TRADING_STATUS_MATCHED;
    }

    #[inline]
    pub fn withdrawn(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_WITHDRAWN).unwrap_or(0)
    }
    #[inline]
    pub fn set_withdrawn(&mut self, v: u64) {
        self.data[O_WITHDRAWN..O_WITHDRAWN + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
    }

    #[inline]
    pub fn claimed_winnings(&self) -> bool {
        self.data[O_CLAIMED_WINNINGS] != 0
    }
    #[inline]
    pub fn set_claimed_winnings(&mut self, v: bool) {
        self.data[O_CLAIMED_WINNINGS] = v as u8;
    }

    /// Commit: lock `collateral` out of `available`, store the commitment
    /// hash. Caller has already checked `available >= collateral`.
    pub fn set_locked_order(&mut self, commitment: &[u8; 32], collateral: u64) {
        self.set_commitment(commitment);
        self.set_available(self.available() - collateral);
        self.set_locked(collateral);
        self.set_status(crate::constants::TRADING_STATUS_LOCKED);
    }

    /// Reveal: verify has already happened by the caller; write the revealed
    /// fields and advance status.
    pub fn set_revealed_order(&mut self, side: u8, size: u64, limit_price: u64) {
        self.data[O_SIDE] = side;
        self.data[O_SIZE..O_SIZE + 8].copy_from_slice(&size.to_le_bytes());
        self.data[O_LIMIT_PRICE..O_LIMIT_PRICE + 8].copy_from_slice(&limit_price.to_le_bytes());
        self.set_status(crate::constants::TRADING_STATUS_REVEALED);
    }

    /// Cancel (Locked or Revealed, pre-match): restore the locked collateral
    /// to `available` and clear the order fields entirely so a fresh commit
    /// can reuse this same account in the same window.
    pub fn clear_order(&mut self) {
        let locked = self.locked();
        self.set_available(self.available() + locked);
        self.set_locked(0);
        self.set_commitment(&[0u8; 32]);
        self.data[O_SIDE] = 0;
        self.data[O_SIZE..O_SIZE + 8].copy_from_slice(&0u64.to_le_bytes());
        self.data[O_LIMIT_PRICE..O_LIMIT_PRICE + 8].copy_from_slice(&0u64.to_le_bytes());
        self.set_status(crate::constants::TRADING_STATUS_NONE);
    }
}
