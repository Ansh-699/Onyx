//! settle_market (disc 5): resolve the market trustlessly via CPI validate_stat.
//!
//! Permissionless: any signer (keeper OR user) may submit. The submitter has NO
//! fund authority — this only flips the outcome based on the oracle's bool.
//!
//! Accounts: [0] submitter (S,W) · [1] config · [2] market (W)
//!           · [3] txoracle program · [4] daily_scores_merkle_roots PDA (ro)
//! Args: borsh(ValidateStatArgs)  — the exact validate_stat payload (no leading
//!       ONYX disc; the entrypoint already stripped byte 0). We deserialize it,
//!       re-encode with the txoracle discriminator, and CPI.
//!
//! Determinism: same proof in => same bool out => same outcome. No admin
//! discretion. A CPI error / missing return data is TRANSIENT (retry), never a
//! loss; only validate_stat == false is an expected-negative (side B wins).

use borsh::BorshDeserialize;
use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, ProgramResult};

use crate::constants::*;
use crate::cpi::txoracle::{validate_stat, ValidateOutcome, ValidateStatArgs};
use crate::error::OnyxError;
use crate::state::config::Config;
use crate::state::market::Market;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [submitter, config_ai, market_ai, txoracle_ai, roots_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !submitter.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    // Config guard: the passed txoracle program must match the configured one.
    {
        let mut cdata = config_ai.try_borrow_mut_data()?;
        let config = Config::load_checked(&mut cdata, config_ai.key(), program_id)?;
        if &config.txoracle_program() != txoracle_ai.key() {
            return Err(OnyxError::Unauthorized.into());
        }
    }

    // Market must be Open/Live (not already settling/settled).
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        let status = market.status();
        if status != STATUS_OPEN && status != STATUS_LIVE {
            return Err(OnyxError::WrongStatus.into());
        }
    }

    // Decode the validate_stat payload supplied by the submitter.
    let vargs = ValidateStatArgs::try_from_slice(args)
        .map_err(|_| OnyxError::InvalidInstructionData)?;

    // Atomic status flip to Settling BEFORE the CPI (checks-effects-interactions).
    // If the CPI errors, the whole tx reverts and status returns to Open/Live.
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        market.set_status(STATUS_SETTLING);
    }

    // CPI into txoracle validate_stat and read the boolean result.
    // NOTE: this borrows no ONYX account data across the invoke.
    let outcome = validate_stat(txoracle_ai, roots_ai, &vargs)?;

    // Map the boolean to an outcome. Side A = "predicate holds".
    let ValidateOutcome::Predicate(holds) = outcome;
    let outcome_code = if holds { OUTCOME_SIDE_A } else { OUTCOME_SIDE_B };

    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        market.set_outcome(outcome_code);
        market.set_status(STATUS_SETTLED);
    }

    Ok(())
}
