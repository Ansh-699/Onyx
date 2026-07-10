//! create_amm_pool (disc 29): seed a new AmmPool for a market with the
//! creator's own real tUSDC. Base-layer, real SPL transfer into the market's
//! existing vault (same vault the sealed flow and TradingAccount flow both
//! use — one vault per market regardless of which trading mechanism is
//! active on it).
//!
//! Requires `market.phase == PHASE_NONE` (see docs/AMM_TRADING_DESIGN.md
//! §4): AMM pools attach ONLY to plain markets, zero interaction with the
//! sealed-order state machine. A market that has ever called
//! open_market_sealed can never get an AMM pool, and vice versa a market
//! with an AMM pool was never eligible for the sealed flow either (both
//! gate on the same single `phase` byte, which sealed markets alone ever
//! advance past PHASE_NONE).
//!
//! Accounts: [0] creator (S,W) · [1] market (read) · [2] pool PDA (W,
//!           ["amm", market]) · [3] vault (W) · [4] creator_usdc_ata (W)
//!           · [5] token program · [6] system program
//! Args: seed_amount(u64 LE) fee_bps(u16 LE) = 10 bytes

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::rent::Rent,
    sysvars::Sysvar,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::amm_pool::{AmmPool, AMM_POOL_LEN};
use crate::state::market::Market;
use crate::util::{read_u16_le, read_u64_le};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [creator, market_ai, pool_ai, vault_ai, creator_ata, _token_program, _system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !creator.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let seed_amount = read_u64_le(args, 0)?;
    let fee_bps = read_u16_le(args, 8)?;
    if seed_amount == 0 {
        return Err(OnyxError::InsufficientStake.into());
    }

    let market_key = *market_ai.key();
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.phase() != PHASE_NONE {
            return Err(OnyxError::NotPlainMarket.into());
        }
    }

    let (vault_pda, _) = find_program_address(&[SEED_VAULT, market_key.as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    let (pool_pda, bump) =
        find_program_address(&[SEED_AMM_POOL, market_key.as_ref()], program_id);
    if pool_ai.key() != &pool_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    if !pool_ai.data_is_empty() {
        return Err(OnyxError::WrongStatus.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(AMM_POOL_LEN);
    let bump_arr = [bump];
    let seeds = [
        Seed::from(SEED_AMM_POOL),
        Seed::from(market_key.as_ref()),
        Seed::from(&bump_arr),
    ];
    let signer = Signer::from(&seeds);
    CreateAccount {
        from: creator,
        to: pool_ai,
        lamports,
        space: AMM_POOL_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    Transfer {
        from: creator_ata,
        to: vault_ai,
        authority: creator,
        amount: seed_amount,
    }
    .invoke()?;

    let mut pdata = pool_ai.try_borrow_mut_data()?;
    let mut pool = AmmPool::from_bytes(&mut pdata)?;
    pool.initialize(&market_key, creator.key(), seed_amount, fee_bps, bump);

    Ok(())
}
