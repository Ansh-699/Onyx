//! Config account (spec §5.2). Singleton PDA at seed ["config"].
//!
//! Layout (total 128 bytes):
//! ```text
//! off  size  field
//!   0     1  disc = 1
//!   1     7  _pad
//!   8    32  admin
//!  40    32  usdc_mint
//!  72    32  txoracle_program
//! 104     2  fee_bps (u16 LE)
//! 106     1  paused (0/1)
//! 107     1  bump
//! 108    20  _reserved
//! ```

use crate::constants::{DISC_CONFIG, SEED_CONFIG};
use crate::error::OnyxError;
use pinocchio::pubkey::{find_program_address, Pubkey};

pub const CONFIG_LEN: usize = 128;

// field offsets
const O_DISC: usize = 0;
const O_ADMIN: usize = 8;
const O_USDC_MINT: usize = 40;
const O_TXORACLE: usize = 72;
const O_FEE_BPS: usize = 104;
const O_PAUSED: usize = 106;
const O_BUMP: usize = 107;

pub struct Config<'a> {
    data: &'a mut [u8],
}

impl<'a> Config<'a> {
    /// Wrap a data slice, validating length. Does not check the discriminator.
    pub fn from_bytes(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        if data.len() < CONFIG_LEN {
            return Err(OnyxError::InvalidAccountSize);
        }
        Ok(Self { data })
    }

    /// Wrap and assert the account is an initialized Config.
    pub fn load(data: &'a mut [u8]) -> Result<Self, OnyxError> {
        let c = Self::from_bytes(data)?;
        if c.disc() != DISC_CONFIG {
            return Err(OnyxError::WrongStatus);
        }
        Ok(c)
    }

    /// `load`, plus a check that `account_key` is the canonical singleton
    /// Config PDA -- callers MUST use this (not bare `load`) whenever
    /// `config_ai` is a caller-supplied account, since `load` alone only
    /// checks the discriminator byte and a forged account could satisfy it.
    pub fn load_checked(
        data: &'a mut [u8],
        account_key: &Pubkey,
        program_id: &Pubkey,
    ) -> Result<Self, OnyxError> {
        let (config_pda, _) = find_program_address(&[SEED_CONFIG], program_id);
        if account_key != &config_pda {
            return Err(OnyxError::InvalidPda);
        }
        Self::load(data)
    }

    #[inline]
    pub fn disc(&self) -> u8 {
        self.data[O_DISC]
    }

    #[inline]
    pub fn is_initialized(&self) -> bool {
        self.disc() == DISC_CONFIG
    }

    pub fn initialize(
        &mut self,
        admin: &Pubkey,
        usdc_mint: &Pubkey,
        txoracle_program: &Pubkey,
        fee_bps: u16,
        bump: u8,
    ) {
        // zero everything first (fresh account already zeroed, but be explicit)
        for b in self.data[..CONFIG_LEN].iter_mut() {
            *b = 0;
        }
        self.data[O_DISC] = DISC_CONFIG;
        self.data[O_ADMIN..O_ADMIN + 32].copy_from_slice(admin);
        self.data[O_USDC_MINT..O_USDC_MINT + 32].copy_from_slice(usdc_mint);
        self.data[O_TXORACLE..O_TXORACLE + 32].copy_from_slice(txoracle_program);
        self.data[O_FEE_BPS..O_FEE_BPS + 2].copy_from_slice(&fee_bps.to_le_bytes());
        self.data[O_PAUSED] = 0;
        self.data[O_BUMP] = bump;
    }

    #[inline]
    pub fn admin(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_ADMIN..O_ADMIN + 32]);
        p
    }

    #[inline]
    pub fn usdc_mint(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_USDC_MINT..O_USDC_MINT + 32]);
        p
    }

    #[inline]
    pub fn txoracle_program(&self) -> Pubkey {
        let mut p = [0u8; 32];
        p.copy_from_slice(&self.data[O_TXORACLE..O_TXORACLE + 32]);
        p
    }

    #[inline]
    pub fn fee_bps(&self) -> u16 {
        u16::from_le_bytes([self.data[O_FEE_BPS], self.data[O_FEE_BPS + 1]])
    }

    #[inline]
    pub fn paused(&self) -> bool {
        self.data[O_PAUSED] != 0
    }

    #[inline]
    pub fn set_paused(&mut self, paused: bool) {
        self.data[O_PAUSED] = paused as u8;
    }

    #[inline]
    pub fn bump(&self) -> u8 {
        self.data[O_BUMP]
    }
}
