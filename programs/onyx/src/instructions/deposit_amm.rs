//! deposit_amm (disc 31): real SPL transfer funding an AmmPosition's
//! `usdc_available`. Base-layer only, mirrors deposit_trading.rs exactly.
//!
//! Accounts: [0] owner (S,W) · [1] market (read) · [2] position (W)
//!           · [3] vault (W) · [4] owner_usdc_ata (W) · [5] token program
//! Args: amount(u64 LE)

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};
use pinocchio_token::instructions::Transfer;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::amm_position::AmmPosition;
use crate::util::read_u64_le;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [owner, market_ai, position_ai, vault_ai, owner_ata, _token_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !position_ai.is_owned_by(program_id) {
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
        let mut pdata = position_ai.try_borrow_mut_data()?;
        let position = AmmPosition::load(&mut pdata)?;
        if &position.owner() != owner.key() {
            return Err(OnyxError::Unauthorized.into());
        }
        if &position.market() != market_ai.key() {
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

    let mut pdata = position_ai.try_borrow_mut_data()?;
    let mut position = AmmPosition::load(&mut pdata)?;
    position.set_usdc_available(
        position.usdc_available().checked_add(amount).ok_or(OnyxError::ArithmeticOverflow)?,
    );

    Ok(())
}
