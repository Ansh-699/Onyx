//! open_trading_account (disc 20): create a user's TradingAccount for a
//! market — the ER-fast trading path's per-(user,market) account. Base-layer,
//! no token movement (see deposit_trading, disc 21, for that).
//!
//! Accounts: [0] owner (S,W) · [1] market (read) · [2] trading PDA (W,
//!           ["trading", market, owner]) · [3] system program

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
use crate::state::market::Market;
use crate::state::trading_account::{TradingAccount, TRADING_ACCOUNT_LEN};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, market_ai, trading_ai, _system_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !market_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.status() != STATUS_OPEN && market.status() != STATUS_LIVE {
            return Err(OnyxError::MarketClosed.into());
        }
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
