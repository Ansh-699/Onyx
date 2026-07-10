//! AmmPosition (docs/AMM_TRADING_DESIGN.md §4). PDA at
//! `["ammpos", market, owner]`. One per (user, market) AMM position —
//! independent of TradingAccount and SealedOrder, a wallet can hold all
//! three simultaneously with zero interaction between them.
//!
//! Layout (total 144 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 7
//!   1     7  _pad
//!   8    32  owner
//!  40    32  market
//!  72     8  usdc_available (u64 LE) -- deposited, never yet swapped; riskless
//!  80     8  tokens_a (u64 LE)
//!  88     8  tokens_b (u64 LE)
//!  96     8  withdrawn (u64 LE)      -- cumulative amount ever paid out
//! 104     1  redeemed (0/1)          -- guards the settlement-redemption leg
//! 105     1  bump
//! 106    38  _reserved
//! ```

use crate::constants::DISC_AMM_POSITION;
use crate::error::OnyxError;
use pinocchio::pubkey::Pubkey;

pub const AMM_POSITION_LEN: usize = 144;

const O_DISC: usize = 0;
const O_OWNER: usize = 8;
const O_MARKET: usize = 40;
const O_USDC_AVAILABLE: usize = 72;
const O_TOKENS_A: usize = 80;
const O_TOKENS_B: usize = 88;
const O_WITHDRAWN: usize = 96;
const O_REDEEMED: usize = 104;
const O_BUMP: usize = 105;

pub struct AmmPosition<'a> {
    data: &'a mut [u8],
}

impl<'a> AmmPosition<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < AMM_POSITION_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let p = Self::from_bytes(data)?;
        if p.disc() != DISC_AMM_POSITION {
            return Err(OnyxError::WrongStatus);
        }
        Ok(p)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    pub fn initialize(&mut self, owner: &Pubkey, market: &Pubkey, bump: u8) {
        for b in self.data[..AMM_POSITION_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_AMM_POSITION;
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
    pub fn usdc_available(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_USDC_AVAILABLE).unwrap_or(0)
    }
    #[inline]
    pub fn set_usdc_available(&mut self, v: u64) {
        self.data[O_USDC_AVAILABLE..O_USDC_AVAILABLE + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn tokens_a(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_TOKENS_A).unwrap_or(0)
    }
    #[inline]
    pub fn set_tokens_a(&mut self, v: u64) {
        self.data[O_TOKENS_A..O_TOKENS_A + 8].copy_from_slice(&v.to_le_bytes());
    }
    #[inline]
    pub fn tokens_b(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_TOKENS_B).unwrap_or(0)
    }
    #[inline]
    pub fn set_tokens_b(&mut self, v: u64) {
        self.data[O_TOKENS_B..O_TOKENS_B + 8].copy_from_slice(&v.to_le_bytes());
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
    pub fn redeemed(&self) -> bool {
        self.data[O_REDEEMED] != 0
    }
    #[inline]
    pub fn set_redeemed(&mut self, v: bool) {
        self.data[O_REDEEMED] = v as u8;
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
    }
}
