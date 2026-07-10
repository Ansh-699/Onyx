//! Program entrypoint + 1-byte instruction discriminator dispatch (spec §7.0).

use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::constants::*;
use crate::error::OnyxError;

#[cfg(target_os = "solana")]
pinocchio::program_entrypoint!(process_instruction);

// A real (bump) allocator is required: settle_market builds a Vec<ProofNode>
// / borsh-encodes the validate_stat CPI payload at runtime, which allocates.
// `no_allocator!()` panics on any alloc call and only failed to surface this
// on instructions that never allocate (open_market/join_market/etc. only do
// fixed-offset byte slicing).
#[cfg(target_os = "solana")]
pinocchio::default_allocator!();

#[cfg(target_os = "solana")]
pinocchio::nostd_panic_handler!();

/// Top-level dispatcher. First byte of `data` = instruction discriminator; the
/// remainder is the per-instruction argument buffer.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // The delegation program's external-undelegate callback arrives with an
    // 8-byte discriminator (not our 1-byte scheme). Route it before the
    // 1-byte dispatch, passing the FULL data (the handler skips the 8 bytes).
    if crate::cpi::delegation::is_undelegation_callback(data) {
        return crate::instructions::process_undelegation::process(program_id, accounts, data);
    }

    let (disc, args) = data
        .split_first()
        .ok_or(ProgramError::from(OnyxError::InvalidInstructionData))?;

    match *disc {
        IX_INITIALIZE_CONFIG => {
            crate::instructions::initialize_config::process(program_id, accounts, args)
        }
        IX_OPEN_MARKET => crate::instructions::open_market::process(program_id, accounts, args),
        IX_JOIN_MARKET => crate::instructions::join_market::process(program_id, accounts, args),
        IX_DELEGATE_MARKET => {
            crate::instructions::delegate_market::process(program_id, accounts, args)
        }
        IX_UNDELEGATE_MARKET => {
            crate::instructions::undelegate_market::process(program_id, accounts, args)
        }
        IX_SETTLE_MARKET => {
            crate::instructions::settle_market::process(program_id, accounts, args)
        }
        IX_CLAIM => crate::instructions::claim::process(program_id, accounts, args),
        IX_REFUND_EXPIRED => {
            crate::instructions::refund_expired::process(program_id, accounts, args)
        }
        IX_TOUCH_MARKET => crate::instructions::touch_market::process(program_id, accounts, args),
        IX_CREATE_MARKET_PERMISSION => {
            crate::instructions::create_market_permission::process(program_id, accounts, args)
        }
        IX_OPEN_MARKET_SEALED => {
            crate::instructions::open_market_sealed::process(program_id, accounts, args)
        }
        IX_SUBMIT_SEALED_ORDER => {
            crate::instructions::submit_sealed_order::process(program_id, accounts, args)
        }
        IX_REVEAL_ORDER => crate::instructions::reveal_order::process(program_id, accounts, args),
        IX_RUN_BATCH_MATCH => {
            crate::instructions::run_batch_match::process(program_id, accounts, args)
        }
        IX_REFUND_UNREVEALED => {
            crate::instructions::refund_unrevealed::process(program_id, accounts, args)
        }
        // ---- ER-fast trading (TradingAccount) — additive, see
        // docs/ER_TRADING_DESIGN.md. Disc 20-21/28 base-layer, 22 base
        // (delegate), 23-27 ER-only. ----
        IX_OPEN_TRADING_ACCOUNT => {
            crate::instructions::open_trading_account::process(program_id, accounts, args)
        }
        IX_DEPOSIT_TRADING => {
            crate::instructions::deposit_trading::process(program_id, accounts, args)
        }
        IX_DELEGATE_TRADING_ACCOUNT => {
            crate::instructions::delegate_trading_account::process(program_id, accounts, args)
        }
        IX_SUBMIT_ORDER_FAST => {
            crate::instructions::submit_order_fast::process(program_id, accounts, args)
        }
        IX_REVEAL_ORDER_FAST => {
            crate::instructions::reveal_order_fast::process(program_id, accounts, args)
        }
        IX_CANCEL_ORDER_FAST => {
            crate::instructions::cancel_order_fast::process(program_id, accounts, args)
        }
        IX_RUN_BATCH_MATCH_FAST => {
            crate::instructions::run_batch_match_fast::process(program_id, accounts, args)
        }
        IX_UNDELEGATE_TRADING_ACCOUNT => {
            crate::instructions::undelegate_trading_account::process(program_id, accounts, args)
        }
        IX_WITHDRAW_TRADING => {
            crate::instructions::withdraw_trading::process(program_id, accounts, args)
        }
        // 9..=13 reserved for parlay/pause.
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
