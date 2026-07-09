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
        // 9..=13 reserved for parlay/pause. The delegation program's external
        // undelegate callback (disc [196,28,41,206,48,37,51,167]) is not yet
        // handled — see BUILD_STATE.md ER notes (finalization callback is the
        // one remaining piece; its exact account layout isn't in the public
        // magicblock-*-api crates).
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
