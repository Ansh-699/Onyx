//! delegate_market (disc 3): delegate a Market PDA to the MagicBlock ER.
//!
//! Base-layer instruction. Mirrors the SDK's `delegate_account`: buffer the
//! market's data, zero + reassign the account to the Delegation Program, CPI
//! the Delegate instruction, then close the buffer. After this the market is
//! owned by the Delegation Program on base and cloned into the ER (writable at
//! ~10ms). SETTLEMENT NEVER MOVES: settle_market stays an L1 instruction.
//!
//! Accounts: [0] payer (S,W) · [1] market (W) · [2] this program (owner, ro)
//!           · [3] buffer PDA (W, ["buffer", market] under this program)
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
use crate::state::market::{Market, MARKET_LEN};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [payer, market_ai, owner_program, buffer_ai, del_record, del_metadata, del_program, system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !market_ai.is_owned_by(program_id) {
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

    // Read the market's own PDA seeds BEFORE we zero its data.
    let mut fixture_le = [0u8; 8];
    let mut params_hash = [0u8; 32];
    let market_bump;
    {
        let mdata = market_ai.try_borrow_data()?;
        if mdata.len() < MARKET_LEN {
            return Err(OnyxError::InvalidAccountSize.into());
        }
        let m = {
            // load() is &mut; re-borrow immutably-safe fields via a throwaway copy
            let mut tmp = [0u8; MARKET_LEN];
            tmp.copy_from_slice(&mdata[..MARKET_LEN]);
            tmp
        };
        fixture_le.copy_from_slice(&m[8..16]);
        params_hash.copy_from_slice(&m[68..100]);
        market_bump = m[101];
    }

    // Verify the market PDA matches ["market", fixture_le, params_hash].
    let market_seeds_noref: [&[u8]; 3] = [SEED_MARKET, &fixture_le, &params_hash];
    // (trust the stored bump; the runtime rejects a bad signer anyway)

    // Derive + verify the buffer PDA.
    let (buffer_pda, buffer_bump) =
        find_program_address(&[SEED_DELEGATE_BUFFER, market_ai.key().as_ref()], program_id);
    if buffer_ai.key() != &buffer_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    let data_len = market_ai.data_len();
    let rent = Rent::get()?;
    let buffer_lamports = rent.minimum_balance(data_len);

    // Signer seeds.
    let market_bump_arr = [market_bump];
    let market_seeds = [
        Seed::from(SEED_MARKET),
        Seed::from(&fixture_le),
        Seed::from(&params_hash),
        Seed::from(&market_bump_arr),
    ];
    let market_signer = Signer::from(&market_seeds);

    let buffer_bump_arr = [buffer_bump];
    let buffer_seeds = [
        Seed::from(SEED_DELEGATE_BUFFER),
        Seed::from(market_ai.key().as_ref()),
        Seed::from(&buffer_bump_arr),
    ];
    let buffer_signer = Signer::from(&buffer_seeds);

    // 1. Create the buffer PDA (owned by this program, same size as the market).
    CreateAccount {
        from: payer,
        to: buffer_ai,
        lamports: buffer_lamports,
        space: data_len as u64,
        owner: program_id,
    }
    .invoke_signed(&[buffer_signer.clone()])?;

    // 2. Copy market data -> buffer.
    {
        let src = market_ai.try_borrow_data()?;
        let mut dst = buffer_ai.try_borrow_mut_data()?;
        dst.copy_from_slice(&src);
    }

    // 3. Zero the market data.
    {
        let mut m = market_ai.try_borrow_mut_data()?;
        for b in m.iter_mut() {
            *b = 0;
        }
    }

    // 4. Reassign market: this program -> system program (direct; we own it).
    unsafe {
        market_ai.assign(&SYSTEM_PROGRAM_ID);
    }

    // 5. Reassign market: system -> delegation program (system CPI, market signs).
    Assign {
        account: market_ai,
        owner: &DELEGATION_PROGRAM_ID,
    }
    .invoke_signed(&[market_signer.clone()])?;

    // 6. CPI the Delegation Program's Delegate instruction.
    cpi_delegate(
        del_program,
        payer,
        market_ai,
        owner_program,
        buffer_ai,
        del_record,
        del_metadata,
        system_program,
        &market_signer,
        commit_frequency_ms,
        &market_seeds_noref,
    )?;

    // 7. Close the buffer: shrink to 0, hand back to system, refund payer.
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

/// Silence unused import when Market helpers aren't referenced.
#[allow(dead_code)]
fn _use_market(_m: &Market) {}
