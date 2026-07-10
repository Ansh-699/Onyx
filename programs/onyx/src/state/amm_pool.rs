//! AmmPool (docs/AMM_TRADING_DESIGN.md §4). PDA at `["amm", market]`. One
//! per market; only ever created for a market whose `phase == PHASE_NONE`
//! (plain, non-sealed) — checked by `create_amm_pool`, never by this file.
//!
//! Layout (total 176 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 6
//!   1     7  _pad
//!   8    32  market
//!  40    32  lp_owner
//!  72     8  reserve_a (u64 LE)        -- virtual Side-A token reserve
//!  80     8  reserve_b (u64 LE)        -- virtual Side-B token reserve
//!  88     8  sets_outstanding (u64 LE) -- complete sets minted, not yet burned
//!  96     8  fees_accrued (u64 LE)     -- owed to lp_owner at withdraw_lp_amm
//! 104     8  seed_amount (u64 LE)      -- LP's original seed, for the record
//! 112     2  fee_bps (u16 LE)
//! 114     1  lp_withdrawn (0/1)
//! 115     1  bump
//! 116    60  _reserved
//! ```

use crate::constants::DISC_AMM_POOL;
use crate::error::OnyxError;
use pinocchio::pubkey::Pubkey;

pub const AMM_POOL_LEN: usize = 176;

const O_DISC: usize = 0;
const O_MARKET: usize = 8;
const O_LP_OWNER: usize = 40;
const O_RESERVE_A: usize = 72;
const O_RESERVE_B: usize = 80;
const O_SETS_OUTSTANDING: usize = 88;
const O_FEES_ACCRUED: usize = 96;
const O_SEED_AMOUNT: usize = 104;
const O_FEE_BPS: usize = 112;
const O_LP_WITHDRAWN: usize = 114;
const O_BUMP: usize = 115;

pub struct AmmPool<'a> {
    data: &'a mut [u8],
}

impl<'a> AmmPool<'a> {
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < AMM_POOL_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let p = Self::from_bytes(data)?;
        if p.disc() != DISC_AMM_POOL {
            return Err(OnyxError::WrongStatus);
        }
        Ok(p)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        market: &Pubkey,
        lp_owner: &Pubkey,
        reserve: u64,
        fee_bps: u16,
        bump: u8,
    ) {
        for b in self.data[..AMM_POOL_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_AMM_POOL;
        self.data[O_MARKET..O_MARKET + 32].copy_from_slice(market);
        self.data[O_LP_OWNER..O_LP_OWNER + 32].copy_from_slice(lp_owner);
        self.data[O_RESERVE_A..O_RESERVE_A + 8].copy_from_slice(&reserve.to_le_bytes());
        self.data[O_RESERVE_B..O_RESERVE_B + 8].copy_from_slice(&reserve.to_le_bytes());
        self.data[O_SETS_OUTSTANDING..O_SETS_OUTSTANDING + 8].copy_from_slice(&reserve.to_le_bytes());
        self.data[O_SEED_AMOUNT..O_SEED_AMOUNT + 8].copy_from_slice(&reserve.to_le_bytes());
        self.data[O_FEE_BPS..O_FEE_BPS + 2].copy_from_slice(&fee_bps.to_le_bytes());
        self.data[O_BUMP] = bump;
    }

    #[inline]
    pub fn market(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_MARKET..O_MARKET + 32]);
        p
    }
    #[inline]
    pub fn lp_owner(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_LP_OWNER..O_LP_OWNER + 32]);
        p
    }

    #[inline]
    pub fn reserve_a(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_RESERVE_A).unwrap_or(0)
    }
    #[inline]
    pub fn set_reserve_a(&mut self, v: u64) {
        self.data[O_RESERVE_A..O_RESERVE_A + 8].copy_from_slice(&v.to_le_bytes());
    }
    #[inline]
    pub fn reserve_b(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_RESERVE_B).unwrap_or(0)
    }
    #[inline]
    pub fn set_reserve_b(&mut self, v: u64) {
        self.data[O_RESERVE_B..O_RESERVE_B + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn sets_outstanding(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_SETS_OUTSTANDING).unwrap_or(0)
    }
    #[inline]
    pub fn set_sets_outstanding(&mut self, v: u64) {
        self.data[O_SETS_OUTSTANDING..O_SETS_OUTSTANDING + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn fees_accrued(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_FEES_ACCRUED).unwrap_or(0)
    }
    #[inline]
    pub fn set_fees_accrued(&mut self, v: u64) {
        self.data[O_FEES_ACCRUED..O_FEES_ACCRUED + 8].copy_from_slice(&v.to_le_bytes());
    }

    #[inline]
    pub fn seed_amount(&self) -> u64 {
        crate::util::read_u64_le(self.data, O_SEED_AMOUNT).unwrap_or(0)
    }

    #[inline]
    pub fn fee_bps(&self) -> u16 {
        u16::from_le_bytes([self.data[O_FEE_BPS], self.data[O_FEE_BPS + 1]])
    }

    #[inline]
    pub fn lp_withdrawn(&self) -> bool {
        self.data[O_LP_WITHDRAWN] != 0
    }
    #[inline]
    pub fn set_lp_withdrawn(&mut self, v: bool) {
        self.data[O_LP_WITHDRAWN] = v as u8;
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
    }
}
