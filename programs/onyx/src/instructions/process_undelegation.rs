//! process_undelegation: the delegation program's external-undelegate callback.
//!
//! NOT user-invokable. The MagicBlock validator, when finalizing a scheduled
//! commit+undelegate, has the delegation program CPI into this program with the
//! fixed discriminator [196,28,41,206,48,37,51,167]. Our job: re-create the
//! delegated PDA under this program and restore its committed state from the
//! undelegate buffer — mirroring the SDK's `undelegate_account`.
//!
//! Interface (empirically confirmed from a real devnet finalize tx):
//!   data     = disc(8) || borsh(Vec<Vec<u8>> seeds)   // the PDA's own seeds
//!   accounts = [0] delegated (W) · [1] undelegate_buffer (W, signer,
//!              delegation-owned) · [2] payer/validator (signer) · [3] system

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, Transfer};

use crate::constants::*;
use crate::error::OnyxError;

/// Max seeds we support parsing from the callback (market uses 3).
const MAX_SEEDS: usize = 6;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data_with_disc: &[u8]) -> ProgramResult {
    let [delegated, buffer, payer, system_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    // Buffer must be the delegation program's undelegate buffer (signer).
    if !buffer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !buffer.is_owned_by(&DELEGATION_PROGRAM_ID) {
        return Err(OnyxError::InvalidOwner.into());
    }
    let _ = system_program;

    // Parse seeds: skip the 8-byte discriminator, then borsh Vec<Vec<u8>>.
    let body = data_with_disc
        .get(8..)
        .ok_or(OnyxError::InvalidInstructionData)?;
    let mut off = 0usize;
    let count = read_u32(body, &mut off)? as usize;
    if count > MAX_SEEDS {
        return Err(OnyxError::InvalidInstructionData.into());
    }
    let mut seed_slices: [&[u8]; MAX_SEEDS] = [&[]; MAX_SEEDS];
    for slot in seed_slices.iter_mut().take(count) {
        let len = read_u32(body, &mut off)? as usize;
        let end = off.checked_add(len).ok_or(OnyxError::InvalidInstructionData)?;
        *slot = body.get(off..end).ok_or(OnyxError::InvalidInstructionData)?;
        off = end;
    }
    let seeds = &seed_slices[..count];

    // Re-derive the PDA + canonical bump and verify it's the delegated account.
    let (pda, bump) = find_program_address(seeds, program_id);
    if &pda != delegated.key() {
        return Err(OnyxError::InvalidPda.into());
    }

    // Build the signer (seeds + bump).
    let bump_arr = [bump];
    let mut signer_seeds: [Seed; MAX_SEEDS + 1] = core::array::from_fn(|_| Seed::from(&[][..]));
    for (i, s) in seeds.iter().enumerate() {
        signer_seeds[i] = Seed::from(*s);
    }
    signer_seeds[count] = Seed::from(&bump_arr);
    let signer = Signer::from(&signer_seeds[..count + 1]);

    let space = buffer.data_len();

    // Fund to rent-exemption if short (payer is a tx signer -> plain invoke).
    let rent = Rent::get()?;
    let needed = rent.minimum_balance(space);
    let cur = delegated.lamports();
    if needed > cur {
        Transfer {
            from: payer,
            to: delegated,
            lamports: needed - cur,
        }
        .invoke()?;
    }

    // Allocate + assign the account back to this program (PDA-signed).
    Allocate {
        account: delegated,
        space: space as u64,
    }
    .invoke_signed(&[signer.clone()])?;
    Assign {
        account: delegated,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Restore the committed state from the buffer.
    {
        let src = buffer.try_borrow_data()?;
        let mut dst = delegated.try_borrow_mut_data()?;
        dst.copy_from_slice(&src);
    }

    Ok(())
}

#[inline]
fn read_u32(buf: &[u8], off: &mut usize) -> Result<u32, OnyxError> {
    let end = off.checked_add(4).ok_or(OnyxError::InvalidInstructionData)?;
    let s = buf.get(*off..end).ok_or(OnyxError::InvalidInstructionData)?;
    *off = end;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
