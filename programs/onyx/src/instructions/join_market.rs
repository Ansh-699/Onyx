//! join_market (disc 2): take a side, escrow USDC into the market vault.
//!
//! Accounts: [0] user (S,W) · [1] config · [2] market (W) · [3] position PDA (W)
//!           · [4] vault (W) · [5] user_usdc_ata (W) · [6] token program · [7] system program
//! Args: side(u8: 1|2) amount(u64 LE)  = 9 bytes

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::Transfer;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::config::Config;
use crate::state::market::Market;
use crate::state::position::{Position, POSITION_LEN};
use crate::util::read_u64_le;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [user, config_ai, market_ai, position_ai, vault_ai, user_ata, token_program, _system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !user.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let side = *args.first().ok_or(OnyxError::InvalidInstructionData)?;
    let amount = read_u64_le(args, 1)?;
    if side != SIDE_A && side != SIDE_B {
        return Err(OnyxError::BadParams.into());
    }
    if amount == 0 {
        return Err(OnyxError::InsufficientStake.into());
    }

    // Config guard.
    {
        let mut cdata = config_ai.try_borrow_mut_data()?;
        let config = Config::load(&mut cdata)?;
        if config.paused() {
            return Err(OnyxError::Paused.into());
        }
    }

    // Market guards: initialized, Open/Live, before deadline.
    let (deadline, status, market_key) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        (market.deadline(), market.status(), *market_ai.key())
    };
    if status != STATUS_OPEN && status != STATUS_LIVE {
        return Err(OnyxError::MarketClosed.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if now >= deadline {
        return Err(OnyxError::MarketClosed.into());
    }

    // Verify + create the Position PDA (one per user/market).
    let (pos_pda, pos_bump) = find_program_address(
        &[SEED_POSITION, market_key.as_ref(), user.key().as_ref()],
        program_id,
    );
    if position_ai.key() != &pos_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    if !position_ai.data_is_empty() {
        // A position already exists -> repeat join is a no-op error.
        return Err(OnyxError::WrongStatus.into());
    }

    // Verify the vault PDA matches ["vault", market].
    let (vault_pda, _vb) =
        find_program_address(&[SEED_VAULT, market_key.as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    // Create Position account.
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(POSITION_LEN);
    let bump_arr = [pos_bump];
    let seeds = [
        Seed::from(SEED_POSITION),
        Seed::from(market_key.as_ref()),
        Seed::from(user.key().as_ref()),
        Seed::from(&bump_arr),
    ];
    let signer = Signer::from(&seeds);
    CreateAccount {
        from: user,
        to: position_ai,
        lamports,
        space: POSITION_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Transfer USDC user -> vault (user is the token-account authority + signer).
    Transfer {
        from: user_ata,
        to: vault_ai,
        authority: user,
        amount,
    }
    .invoke()?;

    // Effects: init Position, bump the side total. (Checks-effects-interactions:
    // token transfer already succeeded; account writes below are atomic with it.)
    {
        let mut pdata = position_ai.try_borrow_mut_data()?;
        let mut pos = Position::from_bytes(&mut pdata)?;
        pos.initialize(user.key(), &market_key, amount, side, pos_bump);
    }
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        if side == SIDE_A {
            let t = market
                .total_side_a()
                .checked_add(amount)
                .ok_or(OnyxError::ArithmeticOverflow)?;
            market.set_total_side_a(t);
        } else {
            let t = market
                .total_side_b()
                .checked_add(amount)
                .ok_or(OnyxError::ArithmeticOverflow)?;
            market.set_total_side_b(t);
        }
    }

    Ok(())
}
