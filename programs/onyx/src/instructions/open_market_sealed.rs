//! open_market_sealed (disc 15): like open_market, but starts the market in
//! the sealed-order Commit phase (Level 1, O7).
//!
//! Accounts: identical to open_market — [0] creator (S,W) · [1] config
//!           · [2] market PDA (W) · [3] vault PDA (W) · [4] usdc_mint
//!           · [5] token program · [6] system program
//! Args: the 66-byte open_market args, followed by
//!       commit_end_ts(i64 LE) reveal_end_ts(i64 LE)  = 82 bytes total.
//!
//! Market.status stays STATUS_OPEN throughout Commit/Reveal/Matched (so
//! deadline/settle gating is untouched); Market.phase is the sealed-order
//! sub-state. Optional gating to a member list via the Permission Program
//! (disc 14, create_market_permission) is a separate, composable call this
//! instruction does NOT make — see PRIVATE_PAYMENTS note / OPEN_QUESTIONS.md.

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};

use crate::error::OnyxError;
use crate::instructions::open_market::create_market_and_vault;
use crate::state::market::Market;
use crate::util::read_i64_le;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [creator, config_ai, market_ai, vault_ai, usdc_mint, token_program, _system_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !creator.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let commit_end_ts = read_i64_le(args, 66)?;
    let reveal_end_ts = read_i64_le(args, 74)?;

    let now = Clock::get()?.unix_timestamp;
    if !(now < commit_end_ts && commit_end_ts < reveal_end_ts) {
        return Err(OnyxError::BadParams.into());
    }
    // deadline (parsed again below by create_market_and_vault) must leave
    // room for the whole commit+reveal lifecycle to finish while the market
    // is still live.
    let deadline = read_i64_le(args, 26)?;
    if reveal_end_ts > deadline {
        return Err(OnyxError::BadParams.into());
    }

    create_market_and_vault(
        program_id,
        creator,
        config_ai,
        market_ai,
        vault_ai,
        usdc_mint,
        token_program,
        crate::constants::STATUS_OPEN,
        &args[..66],
    )?;

    let mut mdata = market_ai.try_borrow_mut_data()?;
    let mut market = Market::load(&mut mdata)?;
    market.init_sealed(commit_end_ts, reveal_end_ts);

    Ok(())
}
