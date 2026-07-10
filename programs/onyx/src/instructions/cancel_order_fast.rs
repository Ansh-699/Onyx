//! cancel_order_fast (disc 25): cancel a TradingAccount's open order (Locked
//! or Revealed, i.e. anything pre-match) on the ER — the "exit before match"
//! half of the real-time trading model (docs/ER_TRADING_DESIGN.md §5).
//! Restores the locked collateral to `available` and, if the order had been
//! revealed, decrements Market.revealed_count so run_batch_match_fast's
//! completeness check stays accurate. Status-gated, not time-gated: if the
//! order hasn't been consumed by a match yet, cancelling is always safe —
//! matching only touches whatever accounts are explicitly passed into that
//! specific transaction.
//!
//! Accounts: [0] owner (S, readonly) · [1] market (W) · [2] trading (W)

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, market_ai, trading_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::load(&mut tdata)?;
    if &trading.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &trading.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }
    let was_revealed = trading.status() == TRADING_STATUS_REVEALED;
    if trading.status() != TRADING_STATUS_LOCKED && trading.status() != TRADING_STATUS_REVEALED {
        return Err(OnyxError::NothingToRefund.into());
    }

    trading.clear_order();

    if was_revealed {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        market.dec_revealed_count();
    }

    Ok(())
}
