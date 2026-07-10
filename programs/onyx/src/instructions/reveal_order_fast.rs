//! reveal_order_fast (disc 24): reveal a TradingAccount's committed order on
//! the ER. Same commitment scheme as the base reveal_order (keccak256(side
//! || size_le || limit_price_le || nonce_le || owner)) so the client's
//! existing `sealedCommitment()` helper works for both flows unchanged.
//! Increments Market.revealed_count — the batch-inclusion completeness
//! check run_batch_match_fast enforces (see that file).
//!
//! Accounts: [0] owner (S, readonly) · [1] market (W) · [2] trading (W)
//! Args: side(u8) size(u64 LE) limit_price(u64 LE) nonce(u64 LE) = 25 bytes

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};
use solana_nostd_keccak::hashv;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;
use crate::util::read_u64_le;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [owner, market_ai, trading_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let side = *args.first().ok_or(OnyxError::InvalidInstructionData)?;
    let size = read_u64_le(args, 1)?;
    let limit_price = read_u64_le(args, 9)?;
    let nonce = read_u64_le(args, 17)?;
    if side != SIDE_A && side != SIDE_B {
        return Err(OnyxError::BadParams.into());
    }

    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        if market.phase() != PHASE_COMMIT && market.phase() != PHASE_REVEAL {
            return Err(OnyxError::WrongPhase.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if now < market.commit_end_ts() || now >= market.reveal_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
        if market.phase() == PHASE_COMMIT {
            market.set_phase(PHASE_REVEAL);
        }
        market.inc_revealed_count();
    }

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::load(&mut tdata)?;
    if &trading.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &trading.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }
    if trading.status() != TRADING_STATUS_LOCKED {
        return Err(OnyxError::AlreadyRevealed.into());
    }
    if size > trading.locked() {
        return Err(OnyxError::SizeExceedsCollateral.into());
    }

    let owner_key = trading.owner();
    let size_le = size.to_le_bytes();
    let price_le = limit_price.to_le_bytes();
    let nonce_le = nonce.to_le_bytes();
    let recomputed = hashv(&[&[side], &size_le, &price_le, &nonce_le, &owner_key]);
    if recomputed != trading.commitment() {
        return Err(OnyxError::CommitmentMismatch.into());
    }

    trading.set_revealed_order(side, size, limit_price);
    Ok(())
}
