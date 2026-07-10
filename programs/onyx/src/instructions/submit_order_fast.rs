//! submit_order_fast (disc 23): commit a hidden order on the ER, against an
//! already-deposited, already-delegated TradingAccount. Pure data mutation —
//! no token CPI, no lamports movement — the operation class proven to run
//! on the ER (§0 of the design doc). `owner` MUST stay read-only: any
//! writable non-delegated account (including the fee payer) makes the ER
//! reject the whole transaction, which is exactly what killed the naive
//! "just call submit_sealed_order on the ER" attempt in the Phase 0 probe.
//!
//! Accounts: [0] owner (S, readonly) · [1] market (W) · [2] trading (W)
//! Args: commitment([u8;32]) collateral(u64 LE) = 40 bytes

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;
use crate::util::{read_array32, read_u64_le};

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [owner, market_ai, trading_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let commitment: [u8; 32] = read_array32(args, 0)?;
    let collateral = read_u64_le(args, 32)?;
    if collateral == 0 {
        return Err(OnyxError::InsufficientStake.into());
    }

    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.phase() != PHASE_COMMIT {
            return Err(OnyxError::WrongPhase.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if now >= market.commit_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
    }

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::load(&mut tdata)?;
    if &trading.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &trading.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }
    if trading.status() != TRADING_STATUS_NONE {
        return Err(OnyxError::WrongPhase.into()); // one open order at a time
    }
    if trading.available() < collateral {
        return Err(OnyxError::InsufficientStake.into());
    }

    trading.set_locked_order(&commitment, collateral);
    Ok(())
}
