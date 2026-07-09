//! initialize_config (disc 0): create the singleton Config PDA.
//!
//! Accounts: [0] payer (S,W) · [1] config PDA (W) · [2] system program
//! Args: admin(32) usdc_mint(32) txoracle_program(32) fee_bps(u16 LE)  = 98 bytes

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::rent::Rent,
    sysvars::Sysvar,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::constants::{SEED_CONFIG, SYSTEM_PROGRAM_ID};
use crate::error::OnyxError;
use crate::state::config::{Config, CONFIG_LEN};
use crate::util::{read_array32, read_u16_le};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [payer, config_ai, system_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if system_program.key() != &SYSTEM_PROGRAM_ID {
        return Err(OnyxError::BadParams.into());
    }

    // Parse args.
    let admin: Pubkey = read_array32(args, 0)?;
    let usdc_mint: Pubkey = read_array32(args, 32)?;
    let txoracle_program: Pubkey = read_array32(args, 64)?;
    let fee_bps = read_u16_le(args, 96)?;

    // Derive + verify the Config PDA.
    let (expected, bump) = find_program_address(&[SEED_CONFIG], program_id);
    if config_ai.key() != &expected {
        return Err(OnyxError::InvalidPda.into());
    }

    // Must not already be initialized.
    if !config_ai.data_is_empty() {
        return Err(OnyxError::AlreadyInitialized.into());
    }

    // Create the account (rent-exempt, owned by this program).
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(CONFIG_LEN);
    let bump_arr = [bump];
    let seeds = [Seed::from(SEED_CONFIG), Seed::from(&bump_arr)];
    let signer = Signer::from(&seeds);

    CreateAccount {
        from: payer,
        to: config_ai,
        lamports,
        space: CONFIG_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Populate.
    let mut data = config_ai.try_borrow_mut_data()?;
    let mut config = Config::from_bytes(&mut data)?;
    config.initialize(&admin, &usdc_mint, &txoracle_program, fee_bps, bump);

    Ok(())
}
