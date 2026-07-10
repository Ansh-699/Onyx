//! undelegate_trading_account (disc 27): schedule commit+undelegate for ANY
//! set of this program's delegated accounts in one call — generic, not
//! specific to TradingAccount (process_undelegation.rs's callback already
//! re-derives each account from its own seeds, so it doesn't care what kind
//! of account it's restoring). Runs on the ER.
//!
//! This is also the empirical test for whether the Magic Program's
//! ScheduleCommitAndUndelegate accepts multiple committed accounts in one
//! CPI (untested before this — the existing single-account
//! `cpi_schedule_commit_and_undelegate` was the only path proven). If the
//! Magic Program rejects >1 trailing account, this whole instruction fails
//! for ANY caller passing more than one, and the caller falls back to one
//! call per account.
//!
//! Accounts: [0] payer (S,W) · [1] magic_context (W) · [2] magic program
//!           · remaining: one or more delegated accounts (W) to commit+undelegate together

use alloc::vec::Vec;
use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use crate::constants::*;
use crate::cpi::delegation::cpi_schedule_commit_and_undelegate_many;
use crate::error::OnyxError;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, magic_context, magic_program, remaining @ ..] = accounts else {
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
    if remaining.is_empty() {
        return Err(OnyxError::InvalidInstructionData.into());
    }

    let delegated: Vec<&AccountInfo> = remaining.iter().collect();
    cpi_schedule_commit_and_undelegate_many(magic_program, payer, magic_context, &delegated)
}
