//! Native (Pinocchio) CPI mirrors for MagicBlock delegation (L1 ER).
//!
//! The `ephemeral-rollups-sdk` is Anchor/solana-program-typed, so a native
//! `no_std` Pinocchio program cannot use its `#[delegate]`/`#[commit]` macros
//! or its `AccountInfo`-based CpiBuilders directly. These helpers reconstruct
//! the exact byte-level CPIs the SDK issues, verified against
//! `magicblock-delegation-program-api` v3.0.0 and
//! `magicblock-magic-program-api` v0.10.1:
//!
//! * delegate  → CPI to the Delegation Program, discriminator `[0u8;8]`
//!   (`DlpDiscriminator::Delegate`) + borsh(`DelegateAccountArgs`).
//! * commit+undelegate → CPI to the Magic Program (on the ER),
//!   `ScheduleCommitAndUndelegate` = bincode enum variant 2 = `[2,0,0,0]`.
//!
//! Delegation PDA seeds (all `[tag, delegated_account]`):
//!   buffer  `["buffer", acct]`  under OUR program,
//!   record  `["delegation", acct]` and metadata `["delegation-metadata", acct]`
//!   under the Delegation Program (the client derives + passes these).

use alloc::vec::Vec;

use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    pubkey::Pubkey,
    ProgramResult,
};

use crate::constants::*;

/// Hand-encode borsh(`DelegateAccountArgs { commit_frequency_ms: u32,
/// seeds: Vec<Vec<u8>>, validator: Option<Pubkey> }`). `validator = None`.
pub fn encode_delegate_args(commit_frequency_ms: u32, seeds: &[&[u8]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(&commit_frequency_ms.to_le_bytes());
    // Vec<Vec<u8>>: u32 LE element count, then each element = u32 LE len + bytes.
    buf.extend_from_slice(&(seeds.len() as u32).to_le_bytes());
    for s in seeds {
        buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
        buf.extend_from_slice(s);
    }
    // Option<Pubkey>::None
    buf.push(0);
    buf
}

/// CPI into the Delegation Program's `Delegate` instruction.
///
/// Account order (must match dlp exactly):
/// `[payer(s,w), delegated(s,w), owner_program(ro), buffer(w),
///   delegation_record(w), delegation_metadata(w), system_program(ro)]`.
/// The delegated PDA signs via `delegated_signer` seeds.
#[allow(clippy::too_many_arguments)]
pub fn cpi_delegate(
    delegation_program: &AccountInfo,
    payer: &AccountInfo,
    delegated: &AccountInfo,
    owner_program: &AccountInfo,
    buffer: &AccountInfo,
    delegation_record: &AccountInfo,
    delegation_metadata: &AccountInfo,
    system_program: &AccountInfo,
    delegated_signer: &Signer,
    commit_frequency_ms: u32,
    pda_seeds: &[&[u8]],
) -> ProgramResult {
    let mut data = Vec::with_capacity(8 + 64);
    data.extend_from_slice(&DLP_DELEGATE_DISC);
    data.extend_from_slice(&encode_delegate_args(commit_frequency_ms, pda_seeds));

    let metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable_signer(delegated.key()),
        AccountMeta::readonly(owner_program.key()),
        AccountMeta::writable(buffer.key()),
        AccountMeta::writable(delegation_record.key()),
        AccountMeta::writable(delegation_metadata.key()),
        AccountMeta::readonly(system_program.key()),
    ];

    let ix = Instruction {
        program_id: delegation_program.key(),
        accounts: &metas,
        data: &data,
    };

    pinocchio::cpi::invoke_signed(
        &ix,
        &[
            payer,
            delegated,
            owner_program,
            buffer,
            delegation_record,
            delegation_metadata,
            system_program,
        ],
        &[delegated_signer.clone()],
    )
}

/// CPI into the Magic Program (on the ER) to schedule a commit+undelegate of
/// `delegated`. Runs on the ephemeral rollup, never base layer.
///
/// Magic account order: `[payer(s,w), magic_context(w), ...committed(ro)]`.
/// Data = `ScheduleCommitAndUndelegate` bincode variant = `[2,0,0,0]`.
pub fn cpi_schedule_commit_and_undelegate(
    magic_program: &AccountInfo,
    payer: &AccountInfo,
    magic_context: &AccountInfo,
    delegated: &AccountInfo,
) -> ProgramResult {
    // The account being committed+undelegated MUST be writable — the magic
    // program rejects a read-only account here ("required to be writable and
    // delegated in order to be undelegated").
    let metas = [
        AccountMeta::writable_signer(payer.key()),
        AccountMeta::writable(magic_context.key()),
        AccountMeta::writable(delegated.key()),
    ];
    let ix = Instruction {
        program_id: magic_program.key(),
        accounts: &metas,
        data: &MAGIC_SCHEDULE_COMMIT_AND_UNDELEGATE,
    };
    pinocchio::cpi::invoke(&ix, &[payer, magic_context, delegated])
}

/// True if `data` begins with the delegation program's external-undelegate
/// callback discriminator (dlp CPIs the owner program with this on finalize).
#[inline]
pub fn is_undelegation_callback(data: &[u8]) -> bool {
    data.len() >= 8 && data[..8] == EXTERNAL_UNDELEGATE_DISCRIMINATOR
}

/// The delegated PDA's canonical seeds for signing, as owned byte slices.
/// Kept tiny so callers can build a `Signer` from `Seed`s referencing them.
pub struct PdaSeedRefs<'a> {
    pub tag: &'a [u8],
    pub fixture_le: &'a [u8],
    pub params_hash: &'a [u8],
    pub bump: &'a [u8],
}

#[allow(dead_code)]
pub fn _validator_none() -> Option<Pubkey> {
    None
}
