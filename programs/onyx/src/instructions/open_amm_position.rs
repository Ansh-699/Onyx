//! open_amm_position (disc 30): create a user's AmmPosition for a market.
//! Base-layer, no token movement. Mirrors open_trading_account.rs exactly,
//! including its lesson: deliberately does NOT check market_ai's ownership
//! or status, since a wallet must be able to open a position after the
//! market's pool has been delegated (pool delegation is independent of
//! market delegation for AMM markets — a plain market with an AMM pool is
//! never itself delegated at all; only the pool and positions are).
//!
//! Accounts: [0] owner (S,W) · [1] market (read, PDA seeding only)
//!           · [2] position PDA (W, ["ammpos", market, owner])
//!           · [3] system program

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::rent::Rent,
    sysvars::Sysvar,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::amm_position::{AmmPosition, AMM_POSITION_LEN};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, market_ai, position_ai, _system_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let (position_pda, bump) = find_program_address(
        &[SEED_AMM_POSITION, market_ai.key().as_ref(), owner.key().as_ref()],
        program_id,
    );
    if position_ai.key() != &position_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    if !position_ai.data_is_empty() {
        return Err(OnyxError::WrongStatus.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(AMM_POSITION_LEN);
    let bump_arr = [bump];
    let seeds = [
        Seed::from(SEED_AMM_POSITION),
        Seed::from(market_ai.key().as_ref()),
        Seed::from(owner.key().as_ref()),
        Seed::from(&bump_arr),
    ];
    let signer = Signer::from(&seeds);
    CreateAccount {
        from: owner,
        to: position_ai,
        lamports,
        space: AMM_POSITION_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    let mut pdata = position_ai.try_borrow_mut_data()?;
    let mut position = AmmPosition::from_bytes(&mut pdata)?;
    position.initialize(owner.key(), market_ai.key(), bump);

    Ok(())
}
