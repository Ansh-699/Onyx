//! delegate_amm_position (disc 33): delegate an AmmPosition PDA to the
//! MagicBlock ER. Base-layer. Near-duplicate of delegate_trading_account.rs
//! (same pattern, different seeds/offsets) — see that file's header for why
//! this is a deliberate near-duplicate, not a shared generic helper.
//!
//! Accounts: [0] payer (S,W) · [1] position (W) · [2] this program (owner,
//!           ro) · [3] buffer PDA (W, ["buffer", position])
//!           · [4] delegation_record · [5] delegation_metadata
//!           · [6] delegation program · [7] system program
//! Args: commit_frequency_ms (u32 LE, optional; default 30_000)

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Assign, CreateAccount, Transfer};

use crate::constants::*;
use crate::cpi::delegation::cpi_delegate;
use crate::error::OnyxError;
use crate::state::amm_position::AMM_POSITION_LEN;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [payer, position_ai, owner_program, buffer_ai, del_record, del_metadata, del_program, system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !position_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }
    if owner_program.key() != program_id {
        return Err(OnyxError::BadParams.into());
    }
    if del_program.key() != &DELEGATION_PROGRAM_ID {
        return Err(OnyxError::Unauthorized.into());
    }

    let commit_frequency_ms = if args.len() >= 4 {
        u32::from_le_bytes([args[0], args[1], args[2], args[3]])
    } else {
        30_000
    };

    // AmmPosition layout: owner@8(32), market@40(32), bump@105.
    let mut owner_key = [0u8; 32];
    let mut market_key = [0u8; 32];
    let position_bump;
    {
        let pdata = position_ai.try_borrow_data()?;
        if pdata.len() < AMM_POSITION_LEN {
            return Err(OnyxError::InvalidAccountSize.into());
        }
        owner_key.copy_from_slice(&pdata[8..40]);
        market_key.copy_from_slice(&pdata[40..72]);
        position_bump = pdata[105];
    }

    let position_seeds_noref: [&[u8]; 3] = [SEED_AMM_POSITION, &market_key, &owner_key];

    let (buffer_pda, buffer_bump) =
        find_program_address(&[SEED_DELEGATE_BUFFER, position_ai.key().as_ref()], program_id);
    if buffer_ai.key() != &buffer_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    let data_len = position_ai.data_len();
    let rent = Rent::get()?;
    let buffer_lamports = rent.minimum_balance(data_len);

    let position_bump_arr = [position_bump];
    let position_seeds = [
        Seed::from(SEED_AMM_POSITION),
        Seed::from(&market_key),
        Seed::from(&owner_key),
        Seed::from(&position_bump_arr),
    ];
    let position_signer = Signer::from(&position_seeds);

    let buffer_bump_arr = [buffer_bump];
    let buffer_seeds = [
        Seed::from(SEED_DELEGATE_BUFFER),
        Seed::from(position_ai.key().as_ref()),
        Seed::from(&buffer_bump_arr),
    ];
    let buffer_signer = Signer::from(&buffer_seeds);

    CreateAccount {
        from: payer,
        to: buffer_ai,
        lamports: buffer_lamports,
        space: data_len as u64,
        owner: program_id,
    }
    .invoke_signed(&[buffer_signer.clone()])?;

    {
        let src = position_ai.try_borrow_data()?;
        let mut dst = buffer_ai.try_borrow_mut_data()?;
        dst.copy_from_slice(&src);
    }
    {
        let mut t = position_ai.try_borrow_mut_data()?;
        for b in t.iter_mut() {
            *b = 0;
        }
    }
    unsafe {
        position_ai.assign(&SYSTEM_PROGRAM_ID);
    }
    Assign {
        account: position_ai,
        owner: &DELEGATION_PROGRAM_ID,
    }
    .invoke_signed(&[position_signer.clone()])?;

    cpi_delegate(
        del_program,
        payer,
        position_ai,
        owner_program,
        buffer_ai,
        del_record,
        del_metadata,
        system_program,
        &position_signer,
        commit_frequency_ms,
        &position_seeds_noref,
    )?;

    buffer_ai.resize(0)?;
    unsafe {
        buffer_ai.assign(&SYSTEM_PROGRAM_ID);
    }
    let buf_lamports = buffer_ai.lamports();
    if buf_lamports > 0 {
        Transfer {
            from: buffer_ai,
            to: payer,
            lamports: buf_lamports,
        }
        .invoke_signed(&[buffer_signer])?;
    }

    Ok(())
}
