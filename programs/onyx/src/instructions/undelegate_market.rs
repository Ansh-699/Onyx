//! undelegate_market (disc 4): schedule commit+undelegate of the market.
//!
//! RUNS ON THE EPHEMERAL ROLLUP, not base layer. CPIs the Magic Program's
//! `ScheduleCommitAndUndelegate`; the ER validator then commits the market's
//! final state back to L1 and returns ownership to this program (via the
//! delegation program's external-undelegate callback, see process_undelegation).
//!
//! Accounts: [0] payer (S,W) · [1] magic_context (W) · [2] market (W)
//!           · [3] magic program

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use crate::constants::*;
use crate::cpi::delegation::cpi_schedule_commit_and_undelegate;
use crate::error::OnyxError;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, magic_context, market_ai, magic_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if magic_program.key() != &MAGIC_PROGRAM_ID {
        return Err(OnyxError::Unauthorized.into());
    }
    if magic_context.key() != &MAGIC_CONTEXT_ID {
        return Err(OnyxError::BadParams.into());
    }

    cpi_schedule_commit_and_undelegate(magic_program, payer, magic_context, market_ai)
}
