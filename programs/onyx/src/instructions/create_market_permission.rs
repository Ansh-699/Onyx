//! create_market_permission (disc 14) — MagicBlock PER de-risk spike (task 8).
//!
//! Base-layer, EXPERIMENTAL. Creates a `Permission` account (MagicBlock's
//! access_control program) gating a Market PDA to a single authorized member
//! (the payer). This is step 1 of the "atomic delegate" PER pattern
//! (create permission -> delegate permission -> delegate the account) —
//! only the first step is implemented here; delegating the Permission
//! account itself onto the ER is out of scope for this probe (see
//! OPEN_QUESTIONS.md O3 / BUILD_STATE.md task-8 section for why).
//!
//! Never call this on the L0-proven or ER-proven markets — throwaway
//! fixtures only.
//!
//! Accounts: [0] payer (S,W) · [1] market (S via PDA seeds, ro)
//!           · [2] permission PDA (W, ["permission:", market] under the
//!             Permission Program) · [3] permission program · [4] system

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    ProgramResult,
};

use crate::constants::*;
use crate::cpi::permission::cpi_create_permission;
use crate::error::OnyxError;
use crate::state::market::MARKET_LEN;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, market_ai, permission_ai, permission_program, system_program, ..] = accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !market_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }
    if permission_program.key() != &PERMISSION_PROGRAM_ID {
        return Err(OnyxError::Unauthorized.into());
    }

    let mut fixture_le = [0u8; 8];
    let mut params_hash = [0u8; 32];
    let market_bump;
    {
        let mdata = market_ai.try_borrow_data()?;
        if mdata.len() < MARKET_LEN {
            return Err(OnyxError::InvalidAccountSize.into());
        }
        fixture_le.copy_from_slice(&mdata[8..16]);
        params_hash.copy_from_slice(&mdata[68..100]);
        market_bump = mdata[101];
    }

    let (permission_pda, _permission_bump) = find_program_address(
        &[PERMISSION_SEED, market_ai.key().as_ref()],
        &PERMISSION_PROGRAM_ID,
    );
    if permission_ai.key() != &permission_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    let market_bump_arr = [market_bump];
    let market_seeds = [
        Seed::from(SEED_MARKET),
        Seed::from(&fixture_le),
        Seed::from(&params_hash),
        Seed::from(&market_bump_arr),
    ];
    let market_signer = Signer::from(&market_seeds);

    let members = [(PERMISSION_AUTHORITY_FLAG, *payer.key())];

    cpi_create_permission(
        permission_program,
        market_ai,
        permission_ai,
        payer,
        system_program,
        &market_signer,
        Some(&members),
    )
}
