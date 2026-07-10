//! withdraw_trading (disc 28): base-layer payout from a TradingAccount —
//! the other real SPL transfer in this design (deposit_trading is the
//! first), and the only place ER-fast trading's economics touch real money
//! again after the one deposit. Pays out two things in one call:
//!   1. `available` (unlocked funds — never committed, or restored by a
//!      cancel) — always withdrawable, no settlement required.
//!   2. Matched-winnings, if the market has settled and this account's
//!      matched order was on the winning side — same parimutuel formula as
//!      the base flow's `claim.rs` (stake + stake*losingPool/winningPool -
//!      fee), reading the SAME Market.total_side_a/b pools `claim.rs` does:
//!      run_batch_match_fast writes into those same fields, so ER-fast and
//!      base-flow matched volume share one combined pool and one payout
//!      formula — deliberately, not by accident (see design doc).
//! `claimed_winnings` guards leg 2 against double payout; leg 1 just zeroes
//! `available`, no separate guard needed.
//!
//! Accounts: [0] owner (S,W) · [1] config · [2] market (read) · [3] trading (W)
//!           · [4] vault (W) · [5] owner_usdc_ata (W) · [6] token program
//!
//! Requires `trading` to be back on base (owned by this program) -- while
//! delegated it's owned by the Delegation Program and this fails the same
//! way deposit_trading does, which is the correct behavior: you can't
//! withdraw funds the ER might still be actively trading with.

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::config::Config;
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, config_ai, market_ai, trading_ai, vault_ai, owner_ata, _token_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !trading_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let fee_bps = {
        let mut cdata = config_ai.try_borrow_mut_data()?;
        let config = Config::load(&mut cdata)?;
        config.fee_bps() as u64
    };

    let (market_status, outcome, total_a, total_b, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        (
            market.status(),
            market.outcome(),
            market.total_side_a(),
            market.total_side_b(),
            market.vault_bump(),
        )
    };

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::load(&mut tdata)?;
    if &trading.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &trading.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }

    let mut payout = trading.available();

    let settled = market_status == STATUS_SETTLED || market_status == STATUS_CLAIMED;
    if settled && !trading.claimed_winnings() && trading.status() == TRADING_STATUS_MATCHED {
        let winning_side = if outcome == OUTCOME_SIDE_A { SIDE_A } else { SIDE_B };
        if trading.side() == winning_side && trading.matched_size() > 0 {
            let (winning_pool, losing_pool) = if winning_side == SIDE_A {
                (total_a, total_b)
            } else {
                (total_b, total_a)
            };
            if winning_pool > 0 {
                let stake = trading.matched_size();
                let winnings = (losing_pool as u128)
                    .checked_mul(stake as u128)
                    .ok_or(OnyxError::ArithmeticOverflow)?
                    .checked_div(winning_pool as u128)
                    .ok_or(OnyxError::ArithmeticOverflow)? as u64;
                let fee = winnings.checked_mul(fee_bps).ok_or(OnyxError::ArithmeticOverflow)? / BPS_DENOM;
                let win_payout = stake
                    .checked_add(winnings)
                    .ok_or(OnyxError::ArithmeticOverflow)?
                    .checked_sub(fee)
                    .ok_or(OnyxError::ArithmeticOverflow)?;
                payout = payout.checked_add(win_payout).ok_or(OnyxError::ArithmeticOverflow)?;
            }
        }
        trading.set_claimed_winnings(true);
    }

    if payout == 0 {
        return Err(OnyxError::NothingToRefund.into());
    }

    {
        let vault = TokenAccount::from_account_info(vault_ai).map_err(|_| OnyxError::InvalidAccountSize)?;
        if vault.amount() < payout {
            return Err(OnyxError::VaultUnderfunded.into());
        }
    }

    trading.set_available(0);
    trading.set_withdrawn(trading.withdrawn().checked_add(payout).ok_or(OnyxError::ArithmeticOverflow)?);
    drop(tdata);

    let (vault_pda, _) = find_program_address(&[SEED_VAULT, market_ai.key().as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    let vault_bump_arr = [vault_bump];
    let seeds = [Seed::from(SEED_VAULT), Seed::from(market_ai.key().as_ref()), Seed::from(&vault_bump_arr)];
    let signer = Signer::from(&seeds);
    Transfer {
        from: vault_ai,
        to: owner_ata,
        authority: vault_ai,
        amount: payout,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}
