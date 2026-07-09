//! submit_sealed_order (disc 16): commit a hidden order + lock collateral.
//!
//! The ONLY thing this puts on-chain during Commit is a 32-byte commitment
//! hash and the locked collateral amount — side, size, and price are not
//! derivable from it (J1: an order is only eligible to match if its
//! collateral is locked on-chain at commit time).
//!
//! Accounts: [0] user (S,W) · [1] market (W, read phase/commit_end_ts)
//!           · [2] order PDA (W, ["order", market, user, nonce_le])
//!           · [3] vault (W) · [4] user_usdc_ata (W) · [5] token program
//!           · [6] system program
//! Args: nonce(u64 LE) commitment([u8;32]) collateral(u64 LE) = 48 bytes.

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
use crate::state::market::Market;
use crate::state::sealed_order::{SealedOrder, SEALED_ORDER_LEN};
use crate::util::{read_array32, read_u64_le};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [user, market_ai, order_ai, vault_ai, user_ata, _token_program, _system_program, ..] = accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !user.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let nonce = read_u64_le(args, 0)?;
    let commitment: [u8; 32] = read_array32(args, 8)?;
    let collateral = read_u64_le(args, 40)?;
    if collateral == 0 {
        return Err(OnyxError::InsufficientStake.into());
    }

    // Market guard: must be a sealed market in Commit, before commit_end_ts.
    let market_key = *market_ai.key();
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.phase() != PHASE_COMMIT {
            return Err(OnyxError::WrongPhase.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if now >= market.commit_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
    }

    // Verify + create the SealedOrder PDA.
    let (order_pda, order_bump) = find_program_address(
        &[SEED_SEALED_ORDER, market_key.as_ref(), user.key().as_ref(), &nonce.to_le_bytes()],
        program_id,
    );
    if order_ai.key() != &order_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    if !order_ai.data_is_empty() {
        return Err(OnyxError::OrderExists.into());
    }

    // Verify the vault PDA (same escrow vault join_market uses).
    let (vault_pda, _vb) = find_program_address(&[SEED_VAULT, market_key.as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    // Create the SealedOrder account.
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(SEALED_ORDER_LEN);
    let nonce_le = nonce.to_le_bytes();
    let bump_arr = [order_bump];
    let seeds = [
        Seed::from(SEED_SEALED_ORDER),
        Seed::from(market_key.as_ref()),
        Seed::from(user.key().as_ref()),
        Seed::from(&nonce_le),
        Seed::from(&bump_arr),
    ];
    let signer = Signer::from(&seeds);
    CreateAccount {
        from: user,
        to: order_ai,
        lamports,
        space: SEALED_ORDER_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Lock collateral: user -> vault (same pattern as join_market).
    Transfer {
        from: user_ata,
        to: vault_ai,
        authority: user,
        amount: collateral,
    }
    .invoke()?;

    // Effects (token transfer already succeeded; this write is atomic with it).
    let mut odata = order_ai.try_borrow_mut_data()?;
    let mut order = SealedOrder::from_bytes(&mut odata)?;
    order.initialize(user.key(), &market_key, &commitment, collateral, nonce, order_bump);

    Ok(())
}
