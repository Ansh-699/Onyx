//! deposit_trading (disc 21): the ONE real SPL transfer that funds a
//! TradingAccount. Base-layer only — this is exactly the operation the ER
//! cannot do (§0 of the design doc: it would debit a non-delegated wallet).
//! Callable multiple times (top-ups), before or after delegation... actually
//! only before: once delegated, `trading_ai` is owned by the Delegation
//! Program and `is_owned_by(program_id)` below fails, so a deposit attempt
//! against a delegated account is correctly rejected rather than silently
//! landing on a stale base-layer clone.
//!
//! Accounts: [0] owner (S,W) · [1] market (read) · [2] trading (W)
//!           · [3] vault (W) · [4] owner_usdc_ata (W) · [5] token program
//! Args: amount(u64 LE)

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};
use pinocchio_token::instructions::Transfer;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::trading_account::TradingAccount;
use crate::util::read_u64_le;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [owner, market_ai, trading_ai, vault_ai, owner_ata, _token_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !trading_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let amount = read_u64_le(args, 0)?;
    if amount == 0 {
        return Err(OnyxError::InsufficientStake.into());
    }

    let (vault_pda, _) = pinocchio::pubkey::find_program_address(
        &[SEED_VAULT, market_ai.key().as_ref()],
        program_id,
    );
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    {
        let mut tdata = trading_ai.try_borrow_mut_data()?;
        let trading = TradingAccount::load(&mut tdata)?;
        if &trading.owner() != owner.key() {
            return Err(OnyxError::Unauthorized.into());
        }
        if &trading.market() != market_ai.key() {
            return Err(OnyxError::BadParams.into());
        }
    }

    Transfer {
        from: owner_ata,
        to: vault_ai,
        authority: owner,
        amount,
    }
    .invoke()?;

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::load(&mut tdata)?;
    trading.set_deposited(trading.deposited().checked_add(amount).ok_or(OnyxError::ArithmeticOverflow)?);
    trading.set_available(trading.available().checked_add(amount).ok_or(OnyxError::ArithmeticOverflow)?);

    Ok(())
}
