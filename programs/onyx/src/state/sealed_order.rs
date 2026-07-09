//! SealedOrder account (Level 1 sealed-order-intent, O7). PDA at
//! `["order", market_pubkey, owner_pubkey, nonce_u64_le]`.
//!
//! Layout (total 160 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 4
//!   1     7  _pad
//!   8    32  owner
//!  40    32  market
//!  72    32  commitment [u8;32] = keccak256(side‖size_le‖limit_price_le‖nonce_le‖owner)
//! 104     8  collateral_locked (u64 LE)
//! 112     8  nonce (u64 LE) -- stored for convenience; also a PDA seed
//! 120     1  revealed (0/1)
//! 121     1  side (0=none, 1=A, 2=B) -- set on reveal
//! 122     1  status (0=Locked,1=Revealed,2=Matched,3=Refunded)
//! 123     1  bump
//! 124     4  _pad2 (align size/limit_price/matched_size to 8)
//! 128     8  size (u64 LE) -- set on reveal
//! 136     8  limit_price (u64 LE, 0..=ODDS_SCALE) -- set on reveal
//! 144     8  matched_size (u64 LE) -- set by run_batch_match
//! 152     8  _reserved
//! ```

use crate::constants::DISC_SEALED_ORDER;
use crate::error::OnyxError;
use pinocchio::pubkey::Pubkey;

pub const SEALED_ORDER_LEN: usize = 160;

const O_DISC: usize = 0;
const O_OWNER: usize = 8;
const O_MARKET: usize = 40;
const O_COMMITMENT: usize = 72;
const O_COLLATERAL: usize = 104;
const O_NONCE: usize = 112;
const O_REVEALED: usize = 120;
const O_SIDE: usize = 121;
const O_STATUS: usize = 122;
const O_BUMP: usize = 123;
const O_SIZE: usize = 128;
const O_LIMIT_PRICE: usize = 136;
const O_MATCHED_SIZE: usize = 144;

pub struct SealedOrder<'a> {
    data: &'a mut [u8],
}

impl<'a> SealedOrder<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < SEALED_ORDER_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let o = Self::from_bytes(data)?;
        if o.disc() != DISC_SEALED_ORDER {
            return Err(OnyxError::WrongStatus);
        }
        Ok(o)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    pub fn initialize(
        &mut self,
        owner: &Pubkey,
        market: &Pubkey,
        commitment: &[u8; 32],
        collateral_locked: u64,
        nonce: u64,
        bump: u8,
    ) {
        for b in self.data[..SEALED_ORDER_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_SEALED_ORDER;
        self.data[O_OWNER..O_OWNER + 32].copy_from_slice(owner);
        self.data[O_MARKET..O_MARKET + 32].copy_from_slice(market);
        self.data[O_COMMITMENT..O_COMMITMENT + 32].copy_from_slice(commitment);
        self.data[O_COLLATERAL..O_COLLATERAL + 8].copy_from_slice(&collateral_locked.to_le_bytes());
        self.data[O_NONCE..O_NONCE + 8].copy_from_slice(&nonce.to_le_bytes());
        self.data[O_REVEALED] = 0;
        self.data[O_SIDE] = 0;
        self.data[O_STATUS] = crate::constants::ORDER_STATUS_LOCKED;
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
    pub fn commitment(&self) -> [u8; 32] {
        crate::util::read_array32(self.data, O_COMMITMENT).unwrap_or([0u8; 32])
    }

    #[inline]
    pub fn collateral_locked(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_COLLATERAL).unwrap_or(0)
    }

    #[inline]
    pub fn nonce(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_NONCE).unwrap_or(0)
    }

    #[inline]
    pub fn revealed(&self) -> bool {
        self.data[O_REVEALED] != 0
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
    pub fn set_status(&mut self, status: u8) {
        self.data[O_STATUS] = status;
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
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

    /// Sets the revealed fields (side/size/limit_price), flips `revealed`,
    /// and advances status to Revealed. Caller has already verified the
    /// commitment hash matches.
    pub fn set_revealed(&mut self, side: u8, size: u64, limit_price: u64) {
        self.data[O_SIDE] = side;
        self.data[O_SIZE..O_SIZE + 8].copy_from_slice(&size.to_le_bytes());
        self.data[O_LIMIT_PRICE..O_LIMIT_PRICE + 8].copy_from_slice(&limit_price.to_le_bytes());
        self.data[O_REVEALED] = 1;
        self.data[O_STATUS] = crate::constants::ORDER_STATUS_REVEALED;
    }

    #[inline]
    pub fn set_matched_size(&mut self, matched_size: u64) {
        self.data[O_MATCHED_SIZE..O_MATCHED_SIZE + 8].copy_from_slice(&matched_size.to_le_bytes());
        self.data[O_STATUS] = crate::constants::ORDER_STATUS_MATCHED;
    }
}
