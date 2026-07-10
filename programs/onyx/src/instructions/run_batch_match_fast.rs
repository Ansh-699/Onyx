//! run_batch_match_fast (disc 26): the ER-fast-path batch match. Permissionless
//! (anyone can call it, same pattern as settle_market/claim/the base
//! run_batch_match) — so the batch-inclusion completeness check below is
//! load-bearing, not optional: without it, a permissionless caller could
//! choose which revealed orders to include and skew the clearing price by
//! omission (the audit finding this fixes).
//!
//! THE CHECK (two parts, both required — see inline comments at each):
//!   1. `remaining.len() == Market.revealed_count` — the caller cannot pass
//!      fewer accounts than the number of orders that have genuinely
//!      revealed, so a straightforward omission (leave N accounts out) is
//!      rejected outright.
//!   2. Status is re-verified as `Revealed` immediately before EACH account
//!      is written in the second pass, not just at the initial read pass.
//!      This closes the remaining hole part 1 alone doesn't: padding the
//!      count by passing the SAME real revealed-order account twice instead
//!      of a genuinely different one. Solana aliases duplicate writable
//!      account entries to the same underlying memory, so by the time the
//!      second occurrence is reached its status already reads `Matched`
//!      (written when the first occurrence was processed) — the immediate
//!      re-check catches that and the WHOLE transaction fails atomically.
//!      A caller cannot satisfy "correct length" AND "every write succeeds"
//!      without every entry being a genuinely distinct, genuinely revealed
//!      order — i.e. the complete set.
//!
//! No token CPI at all — matched_size is pure TradingAccount bookkeeping;
//! real settlement happens at withdraw time on base, after undelegation.
//!
//! Accounts: [0] payer (S, readonly) · [1] market (W)
//!           · remaining: one TradingAccount (W) per revealed order, caller-
//!             selected but count- and status-enforced as above.

use alloc::vec::Vec;
use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};

use crate::constants::*;
use crate::error::OnyxError;
use crate::matching::{run_uniform_price_match, OrderInput};
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, market_ai, remaining @ ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let n = remaining.len();
    if n == 0 || n > MAX_BATCH_ORDERS {
        return Err(OnyxError::TooManyOrders.into());
    }

    let market_key = *market_ai.key();
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
        // CHECK 1 of 2 — see file header. Rejects a straightforward
        // omission: the caller cannot pass fewer accounts than the number
        // of orders that genuinely revealed.
        if n != market.revealed_count() as usize {
            return Err(OnyxError::TooManyOrders.into());
        }
    }

    // Pass 1: read every account, verify it's a genuinely revealed order for
    // THIS market. (A duplicate passed here just reads the same real data
    // twice at this point -- still Revealed, since nothing's been mutated
    // yet. That's fine; the pass-2 re-check below is what actually closes
    // the duplicate-padding hole, not this pass.)
    let mut inputs: Vec<OrderInput> = Vec::with_capacity(n);
    for acc in remaining.iter() {
        let mut tdata = acc.try_borrow_mut_data()?;
        let trading = TradingAccount::load(&mut tdata)?;
        if trading.market() != market_key {
            return Err(OnyxError::BadParams.into());
        }
        if trading.status() != TRADING_STATUS_REVEALED {
            return Err(OnyxError::WrongPhase.into());
        }
        inputs.push(OrderInput {
            side: trading.side(),
            size: trading.size(),
            limit_price: trading.limit_price(),
            commitment: trading.commitment(),
        });
    }

    let (clearing_price, matched_sizes) = run_uniform_price_match(&inputs);

    let mut delta_a: u64 = 0;
    let mut delta_b: u64 = 0;

    // Pass 2: write back. CHECK 2 of 2 -- see file header. Re-verifying
    // `status == Revealed` HERE (not trusting pass 1) is what makes passing
    // the same account twice fail the whole transaction instead of quietly
    // padding the count while a different real order is omitted.
    for (i, acc) in remaining.iter().enumerate() {
        let mut tdata = acc.try_borrow_mut_data()?;
        let mut trading = TradingAccount::load(&mut tdata)?;
        if trading.status() != TRADING_STATUS_REVEALED {
            return Err(OnyxError::WrongPhase.into()); // duplicate/aliased account -> abort
        }
        let matched = matched_sizes[i];
        // Release any unmatched portion of `locked` back to `available` --
        // the TradingAccount equivalent of the base flow's run_batch_match.rs
        // refund transfer (SealedOrder has no "available" balance, so that
        // flow does a real SPL Transfer back to the user's ATA; here it's
        // pure internal bookkeeping, no token movement). This was a real bug
        // caught by inspection before any UI was built on top of it: without
        // it, any partial fill leaves the unmatched remainder permanently
        // stuck -- status becomes Matched, which cancel_order_fast no longer
        // accepts, so there'd be no recovery path at all.
        let unmatched = trading.locked().checked_sub(matched).ok_or(OnyxError::ArithmeticOverflow)?;
        if unmatched > 0 {
            trading.set_available(trading.available().checked_add(unmatched).ok_or(OnyxError::ArithmeticOverflow)?);
        }
        trading.set_locked(0);
        trading.set_matched_size(matched);
        if matched > 0 {
            if trading.side() == SIDE_A {
                delta_a = delta_a.checked_add(matched).ok_or(OnyxError::ArithmeticOverflow)?;
            } else {
                delta_b = delta_b.checked_add(matched).ok_or(OnyxError::ArithmeticOverflow)?;
            }
        }
    }

    let mut mdata = market_ai.try_borrow_mut_data()?;
    let mut market = Market::load(&mut mdata)?;
    let ta = market.total_side_a().checked_add(delta_a).ok_or(OnyxError::ArithmeticOverflow)?;
    market.set_total_side_a(ta);
    let tb = market.total_side_b().checked_add(delta_b).ok_or(OnyxError::ArithmeticOverflow)?;
    market.set_total_side_b(tb);
    market.set_clearing_price(clearing_price);
    market.set_phase(PHASE_MATCHED);

    Ok(())
}
