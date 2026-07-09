//! Position account (spec §5.4). PDA at ["pos", market_pubkey, owner_pubkey].
//!
//! Layout (total 96 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 3
//!   1     7  _pad
//!   8    32  owner
//!  40    32  market
//!  72     8  amount (u64 LE)
//!  80     1  side (1=A, 2=B)
//!  81     1  claimed (0/1)
//!  82     1  bump
//!  83    13  _reserved
//! ```

use crate::constants::DISC_POSITION;
use crate::error::OnyxError;
use pinocchio::pubkey::Pubkey;

pub const POSITION_LEN: usize = 96;

const O_DISC: usize = 0;
const O_OWNER: usize = 8;
const O_MARKET: usize = 40;
const O_AMOUNT: usize = 72;
const O_SIDE: usize = 80;
const O_CLAIMED: usize = 81;
const O_BUMP: usize = 82;

pub struct Position<'a> {
    data: &'a mut [u8],
}

impl<'a> Position<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < POSITION_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let p = Self::from_bytes(data)?;
        if p.disc() != DISC_POSITION {
            return Err(OnyxError::WrongStatus);
        }
        Ok(p)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    #[inline]
    pub fn is_initialized(&self) -> bool {
        self.disc() == DISC_POSITION
    }

    pub fn initialize(
        &mut self,
        owner: &Pubkey,
        market: &Pubkey,
        amount: u64,
        side: u8,
        bump: u8,
    ) {
        for b in self.data[..POSITION_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_POSITION;
        self.data[O_OWNER..O_OWNER + 32].copy_from_slice(owner);
        self.data[O_MARKET..O_MARKET + 32].copy_from_slice(market);
        self.data[O_AMOUNT..O_AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
        self.data[O_SIDE] = side;
        self.data[O_CLAIMED] = 0;
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
    pub fn amount(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_AMOUNT).unwrap_or(0)
    }

    /// Used by `run_batch_match` to merge matched sealed-order volume into an
    /// existing position (e.g. a user who also has a plain `join_market`
    /// stake, or multiple matched sealed orders, on the same market).
    #[inline]
    pub fn set_amount(&mut self, amount: u64) {
        self.data[O_AMOUNT..O_AMOUNT + 8].copy_from_slice(&amount.to_le_bytes());
    }

    #[inline]
    pub fn side(&self) -> u8 {
        self.data[O_SIDE]
    }

    #[inline]
    pub fn claimed(&self) -> bool {
        self.data[O_CLAIMED] != 0
    }

    #[inline]
    pub fn set_claimed(&mut self, claimed: bool) {
        self.data[O_CLAIMED] = claimed as u8;
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
    }
}
