//! run_batch_match (disc 18): the single deterministic uniform-price batch
//! match over all revealed sealed orders (Level 1, O7). Callable once, by
//! anyone, after reveal_end_ts.
//!
//! Accounts: fixed prefix `[0] payer (S,W) · [1] market (W) · [2] vault (W)
//!           · [3] token program · [4] system program`, followed by `remaining_accounts` in
//!           groups of 3 per order: `[order_i (W), position_i (W),
//!           owner_i_usdc_ata (W)]`. The caller selects which revealed
//!           orders are included in this batch (bounded by
//!           MAX_BATCH_ORDERS) — a full production system would enumerate
//!           every revealed order for the market on-chain instead of trusting
//!           the caller's list; documented as a Level-1 scope limit.
//! Args: none.
//!
//! The clearing algorithm itself (`matching::run_uniform_price_match`) is a
//! pure, independently unit-tested function — this instruction is just
//! account plumbing: load orders -> match -> write positions/refunds back.

use alloc::vec::Vec;

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::matching::{run_uniform_price_match, OrderInput};
use crate::state::market::Market;
use crate::state::position::{Position, POSITION_LEN};
use crate::state::sealed_order::SealedOrder;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, market_ai, vault_ai, _token_program, _system_program, rest @ ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if rest.len() % 3 != 0 {
        return Err(OnyxError::InvalidInstructionData.into());
    }
    let n = rest.len() / 3;
    if n == 0 || n > MAX_BATCH_ORDERS {
        return Err(OnyxError::TooManyOrders.into());
    }

    let market_key = *market_ai.key();
    let vault_bump;
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.phase() == PHASE_MATCHED {
            return Err(OnyxError::WrongPhase.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if now < market.reveal_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
        vault_bump = market.vault_bump();
    }

    // Pass 1 (immutable-ish): read every order, build the matcher's input set.
    let mut inputs: Vec<OrderInput> = Vec::with_capacity(n);
    for i in 0..n {
        let order_ai = &rest[3 * i];
        let mut odata = order_ai.try_borrow_mut_data()?;
        let order = SealedOrder::load(&mut odata)?;
        if order.market() != market_key {
            return Err(OnyxError::BadParams.into());
        }
        if !order.revealed() || order.status() != ORDER_STATUS_REVEALED {
            return Err(OnyxError::WrongPhase.into());
        }
        inputs.push(OrderInput {
            side: order.side(),
            size: order.size(),
            limit_price: order.limit_price(),
            commitment: order.commitment(),
        });
    }

    let (clearing_price, matched_sizes) = run_uniform_price_match(&inputs);

    // Pass 2: write matched_size, create/merge Positions, refund unmatched
    // collateral, bump market pool totals.
    let rent = Rent::get()?;
    let vault_bump_arr = [vault_bump];
    let vault_seeds = [Seed::from(SEED_VAULT), Seed::from(market_key.as_ref()), Seed::from(&vault_bump_arr)];
    let vault_signer = Signer::from(&vault_seeds);

    let mut delta_a: u64 = 0;
    let mut delta_b: u64 = 0;

    for i in 0..n {
        let order_ai = &rest[3 * i];
        let position_ai = &rest[3 * i + 1];
        let owner_ata = &rest[3 * i + 2];

        let (owner, side, collateral_locked, matched_size) = {
            let mut odata = order_ai.try_borrow_mut_data()?;
            let mut order = SealedOrder::load(&mut odata)?;
            let matched = matched_sizes[i];
            order.set_matched_size(matched);
            (order.owner(), order.side(), order.collateral_locked(), matched)
        };

        if matched_size > 0 {
            let (pos_pda, pos_bump) =
                find_program_address(&[SEED_POSITION, market_key.as_ref(), owner.as_ref()], program_id);
            if position_ai.key() != &pos_pda {
                return Err(OnyxError::InvalidPda.into());
            }
            if position_ai.data_is_empty() {
                let lamports = rent.minimum_balance(POSITION_LEN);
                let bump_arr = [pos_bump];
                let seeds = [
                    Seed::from(SEED_POSITION),
                    Seed::from(market_key.as_ref()),
                    Seed::from(owner.as_ref()),
                    Seed::from(&bump_arr),
                ];
                let pos_signer = Signer::from(&seeds);
                CreateAccount {
                    from: payer,
                    to: position_ai,
                    lamports,
                    space: POSITION_LEN as u64,
                    owner: program_id,
                }
                .invoke_signed(&[pos_signer])?;
                let mut pdata = position_ai.try_borrow_mut_data()?;
                let mut pos = Position::from_bytes(&mut pdata)?;
                pos.initialize(&owner, &market_key, matched_size, side, pos_bump);
            } else {
                let mut pdata = position_ai.try_borrow_mut_data()?;
                let mut pos = Position::load(&mut pdata)?;
                if &pos.owner() != &owner {
                    return Err(OnyxError::Unauthorized.into());
                }
                if pos.side() != side {
                    return Err(OnyxError::PositionSideMismatch.into());
                }
                let new_amount = pos
                    .amount()
                    .checked_add(matched_size)
                    .ok_or(OnyxError::ArithmeticOverflow)?;
                pos.set_amount(new_amount);
            }

            if side == SIDE_A {
                delta_a = delta_a.checked_add(matched_size).ok_or(OnyxError::ArithmeticOverflow)?;
            } else {
                delta_b = delta_b.checked_add(matched_size).ok_or(OnyxError::ArithmeticOverflow)?;
            }
        }

        let refund = collateral_locked
            .checked_sub(matched_size)
            .ok_or(OnyxError::ArithmeticOverflow)?;
        if refund > 0 {
            {
                // Scoped: the account-data borrow inside TokenAccount MUST be
                // dropped before the Transfer CPI below touches the same
                // account, or pinocchio's runtime borrow tracking panics with
                // AccountBorrowFailed (same pattern as claim.rs's vault check).
                let owner_tok =
                    TokenAccount::from_account_info(owner_ata).map_err(|_| OnyxError::InvalidAccountSize)?;
                if owner_tok.owner() != &owner {
                    return Err(OnyxError::Unauthorized.into());
                }
            }
            Transfer {
                from: vault_ai,
                to: owner_ata,
                authority: vault_ai,
                amount: refund,
            }
            .invoke_signed(&[vault_signer.clone()])?;
        }
    }

    // Finalize market state.
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        if delta_a > 0 {
            let t = market.total_side_a().checked_add(delta_a).ok_or(OnyxError::ArithmeticOverflow)?;
            market.set_total_side_a(t);
        }
        if delta_b > 0 {
            let t = market.total_side_b().checked_add(delta_b).ok_or(OnyxError::ArithmeticOverflow)?;
            market.set_total_side_b(t);
        }
        market.set_phase(PHASE_MATCHED);
        market.set_clearing_price(clearing_price);
    }

    Ok(())
}
