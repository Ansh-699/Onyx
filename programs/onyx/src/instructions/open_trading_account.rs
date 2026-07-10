//! open_trading_account (disc 20): create a user's TradingAccount for a
//! market — the ER-fast trading path's per-(user,market) account. Base-layer,
//! no token movement (see deposit_trading, disc 21, for that).
//!
//! Deliberately does NOT check market_ai's ownership or status. A real bug,
//! caught live: this instruction is meant to be callable AFTER the market
//! has already been delegated (that's the intended flow -- market delegates
//! first as an explicit user-visible step, then individual traders open
//! their own accounts), but once delegated, market_ai is zeroed and owned
//! by the Delegation Program, not this program -- so a
//! `market_ai.is_owned_by(program_id)` check (present in an earlier version
//! of this file) made EVERY open_trading_account call fail once its market
//! had been delegated, i.e. always, for the actual product flow. The check
//! wasn't protecting anything load-bearing anyway: market_ai's pubkey is
//! baked into trading_ai's own PDA seeds below, so an invalid/bogus market
//! key just wastes the caller's own rent on a TradingAccount nobody can
//! usefully delegate/trade against -- not a security issue for anyone but
//! the caller themselves.
//!
//! Accounts: [0] owner (S,W) · [1] market (read, used only for PDA seeding)
//!           · [2] trading PDA (W, ["trading", market, owner])
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
use crate::state::trading_account::{TradingAccount, TRADING_ACCOUNT_LEN};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, market_ai, trading_ai, _system_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let (trading_pda, bump) = find_program_address(
        &[SEED_TRADING_ACCOUNT, market_ai.key().as_ref(), owner.key().as_ref()],
        program_id,
    );
    if trading_ai.key() != &trading_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    if !trading_ai.data_is_empty() {
        return Err(OnyxError::WrongStatus.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(TRADING_ACCOUNT_LEN);
    let bump_arr = [bump];
    let seeds = [
        Seed::from(SEED_TRADING_ACCOUNT),
        Seed::from(market_ai.key().as_ref()),
        Seed::from(owner.key().as_ref()),
        Seed::from(&bump_arr),
    ];
    let signer = Signer::from(&seeds);
    CreateAccount {
        from: owner,
        to: trading_ai,
        lamports,
        space: TRADING_ACCOUNT_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::from_bytes(&mut tdata)?;
    trading.initialize(owner.key(), market_ai.key(), bump);

    Ok(())
}
