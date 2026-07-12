//! open_amm_position (disc 30): create a user's AmmPosition for a market.
//! Base-layer, no token movement. Mirrors open_trading_account.rs.
//!
//! Market-ownership check (audit Phase 3): the market must be owned by
//! ONYX **or the Delegation Program** — never ONYX-only. In the production
//! session flow the v2 seeder delegates market + pool to the ER up front,
//! so by the time a wallet opens its position on base, the market's base
//! copy is owned by DELeGG…; an ONYX-only check would brick one-signature
//! onboarding on every seeded market. Both directions are test-pinned.
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

    // See header: ONYX-owned (pre-delegation) OR Delegation-Program-owned
    // (post-delegation, the normal seeded-market case). Anything else —
    // e.g. a fabricated market account owned by a random program — is out.
    if !market_ai.is_owned_by(program_id) && !market_ai.is_owned_by(&DELEGATION_PROGRAM_ID) {
        return Err(OnyxError::InvalidOwner.into());
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
