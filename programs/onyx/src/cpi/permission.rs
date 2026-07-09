//! Native (Pinocchio) CPI mirror for MagicBlock's Permission Program
//! (`ephemeral-rollups-sdk::access_control`), used to gate a PER-delegated
//! account's ER read/write access to a fixed member list.
//!
//! Task 8 de-risk spike only: this implements `CreatePermission` — the
//! minimal instruction needed to prove a native Pinocchio program can CPI
//! into the Permission Program (PDA-signer ergonomics, same pattern as
//! `cpi/delegation.rs`'s `cpi_delegate`). `DelegatePermission` (routing the
//! Permission account itself onto the ER) is deliberately NOT implemented —
//! out of scope for this probe per the task 8 scope box.
//!
//! Verified against `ephemeral-rollups-sdk` 0.14.3's `access_control` module
//! (Rust SDK `create_permission.rs` + `structs/{permission,member}.rs`):
//!   - discriminator: Borsh `u64` LE, `CreatePermission = 0` (8 zero bytes).
//!   - accounts: `[permissioned_account(signer), permission(w),
//!     payer(w,signer), system_program]`.
//!   - data: disc(8) || Borsh(`MembersArgs { members: Option<Vec<Member>> }`).
//!   - `Member` = `{ flags: u8, pubkey: Pubkey }`, packed 33 bytes/member.
//!   - PDA seed: `[b"permission:", permissioned_account]` (colon is exact),
//!     under `PERMISSION_PROGRAM_ID`.

use alloc::vec::Vec;

use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    pubkey::Pubkey,
    ProgramResult,
};

use crate::constants::*;

/// Hand-encode Borsh `MembersArgs { members: Option<Vec<Member>> }`.
pub fn encode_members_args(members: Option<&[(u8, Pubkey)]>) -> Vec<u8> {
    match members {
        None => alloc::vec![0u8],
        Some(list) => {
            let mut buf = Vec::with_capacity(1 + 4 + list.len() * 33);
            buf.push(1); // Option::Some
            buf.extend_from_slice(&(list.len() as u32).to_le_bytes());
            for (flags, pk) in list {
                buf.push(*flags);
                buf.extend_from_slice(pk);
            }
            buf
        }
    }
}

/// CPI into the Permission Program's `CreatePermission` instruction, gating
/// `permissioned_account` (a PDA of this program, signing via `pda_signer`)
/// to the given member list.
pub fn cpi_create_permission(
    permission_program: &AccountInfo,
    permissioned_account: &AccountInfo,
    permission: &AccountInfo,
    payer: &AccountInfo,
    system_program: &AccountInfo,
    pda_signer: &Signer,
    members: Option<&[(u8, Pubkey)]>,
) -> ProgramResult {
    let mut data = Vec::with_capacity(8 + 1 + 4 + 33 * members.map(|m| m.len()).unwrap_or(0));
    data.extend_from_slice(&CREATE_PERMISSION_DISC);
    data.extend_from_slice(&encode_members_args(members));

    let metas = [
        AccountMeta::readonly_signer(permissioned_account.key()),
        AccountMeta::writable(permission.key()),
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::readonly(system_program.key()),
    ];
    let ix = Instruction {
        program_id: permission_program.key(),
        accounts: &metas,
        data: &data,
    };
    pinocchio::cpi::invoke_signed(
        &ix,
        &[permissioned_account, permission, payer, system_program],
        &[pda_signer.clone()],
    )
}
