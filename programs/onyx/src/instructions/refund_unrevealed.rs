//! refund_unrevealed (disc 19): I-NoTrap for sealed orders. Any order that
//! was never revealed carries no side/size/price on-chain — it never
//! participated in matching — so once the reveal window is over it is
//! ALWAYS fully refundable, unconditionally. Permissionless (anyone can
//! trigger it, like settle_market/claim), but the refund can only ever land
//! in the order owner's own USDC ATA (checked below), so a third-party
//! caller can't redirect funds.
//!
//! Accounts: [0] payer (S,W) · [1] market (read) · [2] order (W)
//!           · [3] vault (W) · [4] owner_usdc_ata (W) · [5] token program

use pinocchio::{account_info::AccountInfo, instruction::{Seed, Signer}, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};
use pinocchio_token::instructions::Transfer;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;
use crate::state::sealed_order::SealedOrder;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, market_ai, order_ai, vault_ai, owner_ata, _token_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let (market_key, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        let now = Clock::get()?.unix_timestamp;
        if now < market.reveal_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
        (*market_ai.key(), market.vault_bump())
    };

    let (owner, collateral_locked) = {
        let mut odata = order_ai.try_borrow_mut_data()?;
        let mut order = SealedOrder::load(&mut odata)?;
        if order.market() != market_key {
            return Err(OnyxError::BadParams.into());
        }
        if order.revealed() || order.status() != ORDER_STATUS_LOCKED {
            return Err(OnyxError::NothingToRefund.into());
        }
        let owner = order.owner();
        let collateral_locked = order.collateral_locked();
        order.set_status(ORDER_STATUS_REFUNDED);
        (owner, collateral_locked)
    };

    {
        // Scoped: drop this borrow before the Transfer CPI touches owner_ata.
        let owner_tok = TokenAccount::from_account_info(owner_ata).map_err(|_| OnyxError::InvalidAccountSize)?;
        if owner_tok.owner() != &owner {
            return Err(OnyxError::Unauthorized.into());
        }
    }

    let vault_bump_arr = [vault_bump];
    let seeds = [Seed::from(SEED_VAULT), Seed::from(market_key.as_ref()), Seed::from(&vault_bump_arr)];
    let signer = Signer::from(&seeds);
    Transfer {
        from: vault_ai,
        to: owner_ata,
        authority: vault_ai,
        amount: collateral_locked,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}
