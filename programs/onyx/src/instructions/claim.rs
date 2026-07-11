//! claim (disc 6): a winning-side position claims its payout from the vault.
//!
//! Payout model (parimutuel): a winner receives their stake back plus a
//! proportional share of the losing pool, minus fee_bps. If the losing pool is
//! empty (one-sided market), the winner simply reclaims their own stake.
//!
//! Accounts: [0] winner (S,W) · [1] config · [2] market (W) · [3] position (W)
//!           · [4] vault (W) · [5] winner_usdc_ata (W) · [6] token program
//!
//! Invariants: I-Once (claimed flag), I-Solvency (assert vault >= payout).

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::config::Config;
use crate::state::market::Market;
use crate::state::position::Position;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [winner, config_ai, market_ai, position_ai, vault_ai, winner_ata, _token_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !winner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !position_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let fee_bps = {
        let mut cdata = config_ai.try_borrow_mut_data()?;
        let config = Config::load_checked(&mut cdata, config_ai.key(), program_id)?;
        config.fee_bps() as u64
    };

    // Read market outcome + pools.
    let (outcome, total_a, total_b, market_key, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.status() != STATUS_SETTLED && market.status() != STATUS_CLAIMED {
            return Err(OnyxError::WrongStatus.into());
        }
        (
            market.outcome(),
            market.total_side_a(),
            market.total_side_b(),
            *market_ai.key(),
            market.vault_bump(),
        )
    };
    if outcome != OUTCOME_SIDE_A && outcome != OUTCOME_SIDE_B {
        return Err(OnyxError::WrongStatus.into());
    }

    // Position must belong to the winner + winning side, not yet claimed.
    let (stake, side, pos_owner) = {
        let mut pdata = position_ai.try_borrow_mut_data()?;
        let pos = Position::load(&mut pdata)?;
        if &pos.owner() != winner.key() {
            return Err(OnyxError::Unauthorized.into());
        }
        if &pos.market() != market_ai.key() {
            return Err(OnyxError::BadParams.into());
        }
        if pos.claimed() {
            return Err(OnyxError::AlreadyClaimed.into());
        }
        (pos.amount(), pos.side(), pos.owner())
    };
    let _ = pos_owner;

    let winning_side = if outcome == OUTCOME_SIDE_A { SIDE_A } else { SIDE_B };
    if side != winning_side {
        return Err(OnyxError::NotWinner.into());
    }

    // Payout = stake + stake/winning_pool * losing_pool, minus fee on winnings.
    let (winning_pool, losing_pool) = if winning_side == SIDE_A {
        (total_a, total_b)
    } else {
        (total_b, total_a)
    };
    if winning_pool == 0 {
        return Err(OnyxError::BadParams.into());
    }

    // winnings = losing_pool * stake / winning_pool  (u128 to avoid overflow)
    let winnings = (losing_pool as u128)
        .checked_mul(stake as u128)
        .ok_or(OnyxError::ArithmeticOverflow)?
        .checked_div(winning_pool as u128)
        .ok_or(OnyxError::ArithmeticOverflow)? as u64;
    let fee = winnings
        .checked_mul(fee_bps)
        .ok_or(OnyxError::ArithmeticOverflow)?
        / BPS_DENOM;
    let payout = stake
        .checked_add(winnings)
        .ok_or(OnyxError::ArithmeticOverflow)?
        .checked_sub(fee)
        .ok_or(OnyxError::ArithmeticOverflow)?;

    // I-Solvency: assert vault holds at least the payout.
    {
        let vault = TokenAccount::from_account_info(vault_ai)
            .map_err(|_| OnyxError::InvalidAccountSize)?;
        if vault.amount() < payout {
            return Err(OnyxError::VaultUnderfunded.into());
        }
    }

    // Effects: mark claimed BEFORE the transfer (checks-effects-interactions).
    {
        let mut pdata = position_ai.try_borrow_mut_data()?;
        let mut pos = Position::load(&mut pdata)?;
        pos.set_claimed(true);
    }

    // PDA-signed transfer vault -> winner. Authority is the vault PDA itself.
    let vault_bump_arr = [vault_bump];
    let seeds = [
        Seed::from(SEED_VAULT),
        Seed::from(market_key.as_ref()),
        Seed::from(&vault_bump_arr),
    ];
    let signer = Signer::from(&seeds);
    Transfer {
        from: vault_ai,
        to: winner_ata,
        authority: vault_ai,
        amount: payout,
    }
    .invoke_signed(&[signer])?;

    // Advance market to Claimed (idempotent; multiple winners each claim once).
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        market.set_status(STATUS_CLAIMED);
    }

    Ok(())
}
