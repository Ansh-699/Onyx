//! touch_market (disc 8): minimal in-play mutation to prove ER execution.
//!
//! Flips an OPEN market to LIVE ("kickoff"). When the market is delegated, this
//! only succeeds on the ER (where the market is owned by this program and
//! writable at ~10ms); on base layer the market is owned by the delegation
//! program, so this instruction cannot mutate it there — which is exactly the
//! property that proves the write happened on the ER.
//!
//! Accounts: [0] caller (S) · [1] market (W)

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [caller, market_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !caller.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    // Must be owned by this program to mutate — true on the ER for a delegated
    // market, false on base layer (owned by the delegation program).
    if !market_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let mut mdata = market_ai.try_borrow_mut_data()?;
    let mut market = Market::load(&mut mdata)?;
    if market.status() == STATUS_OPEN {
        market.set_status(STATUS_LIVE);
    }
    Ok(())
}
