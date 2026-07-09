//! reveal_order (disc 17): reveal a sealed order's contents; rejected unless
//! the preimage hashes to the stored commitment.
//!
//! Commitment = keccak256(side ‖ size_le ‖ limit_price_le ‖ nonce_le ‖ owner),
//! computed with `solana-nostd-keccak` (the same primitive already used for
//! the Merkle receipt work).
//!
//! Accounts: [0] user (S) · [1] market (W) · [2] order (W)
//! Args: side(u8) size(u64 LE) limit_price(u64 LE) nonce(u64 LE) = 25 bytes.

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};
use solana_nostd_keccak::hashv;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;
use crate::state::sealed_order::SealedOrder;
use crate::util::read_u64_le;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [user, market_ai, order_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !user.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let side = *args.first().ok_or(OnyxError::InvalidInstructionData)?;
    let size = read_u64_le(args, 1)?;
    let limit_price = read_u64_le(args, 9)?;
    let nonce = read_u64_le(args, 17)?;
    if side != SIDE_A && side != SIDE_B {
        return Err(OnyxError::BadParams.into());
    }

    // Market guard: sealed market, within [commit_end_ts, reveal_end_ts).
    let now;
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        if market.phase() != PHASE_COMMIT && market.phase() != PHASE_REVEAL {
            return Err(OnyxError::WrongPhase.into());
        }
        now = Clock::get()?.unix_timestamp;
        if now < market.commit_end_ts() || now >= market.reveal_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
        // Lazy phase transition: first reveal after commit_end_ts flips Commit -> Reveal.
        if market.phase() == PHASE_COMMIT {
            market.set_phase(PHASE_REVEAL);
        }
    }
    let _ = now;

    // Order guard + commitment check.
    let mut odata = order_ai.try_borrow_mut_data()?;
    let mut order = SealedOrder::load(&mut odata)?;
    if &order.owner() != user.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &order.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }
    if order.revealed() {
        return Err(OnyxError::AlreadyRevealed.into());
    }
    if order.nonce() != nonce {
        return Err(OnyxError::BadParams.into());
    }
    if size > order.collateral_locked() {
        return Err(OnyxError::SizeExceedsCollateral.into());
    }

    let owner = order.owner();
    let size_le = size.to_le_bytes();
    let price_le = limit_price.to_le_bytes();
    let nonce_le = nonce.to_le_bytes();
    let recomputed = hashv(&[&[side], &size_le, &price_le, &nonce_le, &owner]);
    if recomputed != order.commitment() {
        return Err(OnyxError::CommitmentMismatch.into());
    }

    order.set_revealed(side, size, limit_price);

    Ok(())
}
