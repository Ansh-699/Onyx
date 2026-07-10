//! delegate_trading_account (disc 22): delegate a TradingAccount PDA to the
//! MagicBlock ER. Base-layer. Structurally identical to delegate_market.rs
//! (buffer/zero/reassign/CPI-Delegate) — kept as a near-duplicate rather than
//! a shared generic helper, deliberately: delegate_market reads its PDA
//! seeds from Market's own byte layout before zeroing, and doing that
//! generically (seeds as instruction args) would mean trusting caller-
//! supplied seeds for a security-sensitive reassign-to-Delegation-Program
//! step. Reading the seeds from each account's own known layout (as both
//! this file and delegate_market.rs do) is the lower-risk pattern.
//!
//! Accounts: [0] payer (S,W) · [1] trading (W) · [2] this program (owner, ro)
//!           · [3] buffer PDA (W, ["buffer", trading] under this program)
//!           · [4] delegation_record (W) · [5] delegation_metadata (W)
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
use crate::state::trading_account::TRADING_ACCOUNT_LEN;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [payer, trading_ai, owner_program, buffer_ai, del_record, del_metadata, del_program, system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !trading_ai.is_owned_by(program_id) {
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

    // Read the TradingAccount's own seeds (owner@8, market@40, bump@168)
    // BEFORE zeroing its data — same pattern as delegate_market.rs.
    let mut owner_key = [0u8; 32];
    let mut market_key = [0u8; 32];
    let trading_bump;
    {
        let tdata = trading_ai.try_borrow_data()?;
        if tdata.len() < TRADING_ACCOUNT_LEN {
            return Err(OnyxError::InvalidAccountSize.into());
        }
        owner_key.copy_from_slice(&tdata[8..40]); // O_OWNER
        market_key.copy_from_slice(&tdata[40..72]); // O_MARKET
        trading_bump = tdata[168]; // O_BUMP
    }

    let trading_seeds_noref: [&[u8]; 3] = [SEED_TRADING_ACCOUNT, &market_key, &owner_key];

    let (buffer_pda, buffer_bump) =
        find_program_address(&[SEED_DELEGATE_BUFFER, trading_ai.key().as_ref()], program_id);
    if buffer_ai.key() != &buffer_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    let data_len = trading_ai.data_len();
    let rent = Rent::get()?;
    let buffer_lamports = rent.minimum_balance(data_len);

    let trading_bump_arr = [trading_bump];
    let trading_seeds = [
        Seed::from(SEED_TRADING_ACCOUNT),
        Seed::from(&market_key),
        Seed::from(&owner_key),
        Seed::from(&trading_bump_arr),
    ];
    let trading_signer = Signer::from(&trading_seeds);

    let buffer_bump_arr = [buffer_bump];
    let buffer_seeds = [
        Seed::from(SEED_DELEGATE_BUFFER),
        Seed::from(trading_ai.key().as_ref()),
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
        let src = trading_ai.try_borrow_data()?;
        let mut dst = buffer_ai.try_borrow_mut_data()?;
        dst.copy_from_slice(&src);
    }
    {
        let mut t = trading_ai.try_borrow_mut_data()?;
        for b in t.iter_mut() {
            *b = 0;
        }
    }
    unsafe {
        trading_ai.assign(&SYSTEM_PROGRAM_ID);
    }
    Assign {
        account: trading_ai,
        owner: &DELEGATION_PROGRAM_ID,
    }
    .invoke_signed(&[trading_signer.clone()])?;

    cpi_delegate(
        del_program,
        payer,
        trading_ai,
        owner_program,
        buffer_ai,
        del_record,
        del_metadata,
        system_program,
        &trading_signer,
        commit_frequency_ms,
        &trading_seeds_noref,
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
