//! open_market (disc 1): create a Market PDA + its escrow vault token account.
//!
//! Accounts: [0] creator (S,W) · [1] config · [2] market PDA (W) · [3] vault PDA (W)
//!           · [4] usdc_mint · [5] token program · [6] system program
//! Args: fixture_id(u64) stat_a_key(u32) stat_b_key(u32) op(u8) predicate(u8)
//!       threshold(i64) deadline(i64) params_hash(32)   = 66 bytes

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::InitializeAccount3;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::instructions::compute_params_hash;
use crate::state::config::Config;
use crate::state::market::{Market, MarketTerms, MARKET_LEN};
use crate::util::{read_array32, read_i64_le, read_u32_le, read_u64_le};

/// Shared by `open_market` and `open_market_sealed`: parse+validate terms,
/// derive+verify the Market/vault PDAs, create both accounts, and initialize
/// Market state at `status`. Returns the created `(market_bump, vault_bump)`
/// so a caller (e.g. `open_market_sealed`) can layer additional fields on
/// top via a second borrow, without duplicating any of the account-creation
/// plumbing above.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_market_and_vault(
    program_id: &Pubkey,
    creator: &AccountInfo,
    config_ai: &AccountInfo,
    market_ai: &AccountInfo,
    vault_ai: &AccountInfo,
    usdc_mint: &AccountInfo,
    token_program: &AccountInfo,
    status: u8,
    args: &[u8],
) -> Result<(u8, u8), pinocchio::program_error::ProgramError> {
    // Config guard: not paused.
    {
        let mut cdata = config_ai.try_borrow_mut_data()?;
        let config = Config::load(&mut cdata)?;
        if config.paused() {
            return Err(OnyxError::Paused.into());
        }
        if &config.usdc_mint() != usdc_mint.key() {
            return Err(OnyxError::BadParams.into());
        }
    }

    // Parse args.
    let terms = MarketTerms {
        fixture_id: read_u64_le(args, 0)?,
        stat_a_key: read_u32_le(args, 8)?,
        stat_b_key: read_u32_le(args, 12)?,
        op: *args.get(16).ok_or(OnyxError::InvalidInstructionData)?,
        predicate: *args.get(17).ok_or(OnyxError::InvalidInstructionData)?,
        threshold: read_i64_le(args, 18)?,
        deadline: read_i64_le(args, 26)?,
    };
    let provided_hash: [u8; 32] = read_array32(args, 34)?;

    // Validate op / predicate are in the supported (upstream) set.
    match terms.predicate {
        CMP_GREATER_THAN | CMP_LESS_THAN | CMP_EQUAL_TO => {}
        _ => return Err(OnyxError::BadParams.into()),
    }
    match terms.op {
        OP_NONE | OP_ADD | OP_SUBTRACT => {}
        _ => return Err(OnyxError::BadParams.into()),
    }

    // Terms-hash binding: recompute and require a match.
    let computed = compute_params_hash(&terms);
    if computed != provided_hash {
        return Err(OnyxError::BadParams.into());
    }

    // Deadline must be in the future (seconds).
    let now = Clock::get()?.unix_timestamp;
    if terms.deadline <= now {
        return Err(OnyxError::BadParams.into());
    }

    // Derive + verify the Market PDA: ["market", fixture_id_le, params_hash].
    let fixture_le = terms.fixture_id.to_le_bytes();
    let (market_pda, market_bump) =
        find_program_address(&[SEED_MARKET, &fixture_le, &computed], program_id);
    if market_ai.key() != &market_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    if !market_ai.data_is_empty() {
        return Err(OnyxError::MarketExists.into());
    }

    // Derive + verify the vault PDA: ["vault", market].
    let (vault_pda, vault_bump) = find_program_address(&[SEED_VAULT, market_ai.key().as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    // Create the Market account.
    let rent = Rent::get()?;
    let market_lamports = rent.minimum_balance(MARKET_LEN);
    let market_bump_arr = [market_bump];
    let market_seeds = [
        Seed::from(SEED_MARKET),
        Seed::from(&fixture_le),
        Seed::from(&computed),
        Seed::from(&market_bump_arr),
    ];
    let market_signer = Signer::from(&market_seeds);
    CreateAccount {
        from: creator,
        to: market_ai,
        lamports: market_lamports,
        space: MARKET_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[market_signer])?;

    // Create the escrow vault as a program-owned SPL token account at the vault
    // PDA. The vault PDA is BOTH the account address and its own token-owner
    // authority, so payouts are PDA-signed with ["vault", market].
    let vault_bump_arr = [vault_bump];
    let vault_seeds = [
        Seed::from(SEED_VAULT),
        Seed::from(market_ai.key().as_ref()),
        Seed::from(&vault_bump_arr),
    ];
    let vault_signer = Signer::from(&vault_seeds);
    let token_acc_len = TokenAccount::LEN as u64;
    let vault_lamports = rent.minimum_balance(TokenAccount::LEN);
    CreateAccount {
        from: creator,
        to: vault_ai,
        lamports: vault_lamports,
        space: token_acc_len,
        owner: token_program.key(),
    }
    .invoke_signed(&[vault_signer])?;

    // Initialize the token account with the vault PDA as its owner authority.
    InitializeAccount3 {
        account: vault_ai,
        mint: usdc_mint,
        owner: vault_ai.key(),
    }
    .invoke()?;

    // Initialize Market state.
    let slot = Clock::get()?.slot;
    let mut mdata = market_ai.try_borrow_mut_data()?;
    let mut market = Market::from_bytes(&mut mdata)?;
    market.initialize(&terms, &computed, slot, status, vault_bump, market_bump);

    Ok((market_bump, vault_bump))
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [creator, config_ai, market_ai, vault_ai, usdc_mint, token_program, _system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !creator.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    create_market_and_vault(
        program_id,
        creator,
        config_ai,
        market_ai,
        vault_ai,
        usdc_mint,
        token_program,
        STATUS_OPEN,
        args,
    )?;

    Ok(())
}
