//! CPI contract for txoracle `validate_stat` (spec §8.1).
//!
//! The arg buffer is `disc(8) || borsh(ts, fixture_summary, fixture_proof,
//! main_tree_proof, predicate, stat_a, stat_b, op)` in exact field order. The
//! borsh structs below mirror the txoracle IDL v1.5.5 types byte-exact:
//!
//! * `ProofNode { hash:[u8;32], is_right_sibling:bool }`
//! * `ScoreStat { key:u32, value:i32, period:i32 }`  (period is its own field)
//! * `ScoresUpdateStats { update_count:i32, min_timestamp:i64, max_timestamp:i64 }`
//! * `ScoresBatchSummary { fixture_id:i64, update_stats:ScoresUpdateStats, events_sub_tree_root:[u8;32] }`
//! * `StatTerm { stat_to_prove:ScoreStat, event_stat_root:[u8;32], stat_proof:Vec<ProofNode> }`
//! * `TraderPredicate { threshold:i32, comparison:Comparison }`
//! * `Comparison = GreaterThan|LessThan|EqualTo`  (borsh enum: 0,1,2)
//! * `BinaryExpression = Add|Subtract`            (borsh enum: 0,1)
//!
//! `validate_stat(ts:i64, fixture_summary:ScoresBatchSummary,
//! fixture_proof:Vec<ProofNode>, main_tree_proof:Vec<ProofNode>,
//! predicate:TraderPredicate, stat_a:StatTerm, stat_b:Option<StatTerm>,
//! op:Option<BinaryExpression>) -> bool`.
//!
//! ONE read-only account: `daily_scores_merkle_roots` (the daily-roots PDA,
//! derived from seed ["daily_scores_roots", epoch_day_u16_le]).

use alloc::vec::Vec;
use borsh::{BorshDeserialize, BorshSerialize};

use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::constants::VALIDATE_STAT_DISC;
use crate::error::OnyxError;

// ---- byte-exact borsh mirrors of the txoracle types ----

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

/// Comparison enum. borsh serializes unit enums as a single u8 index in
/// declaration order: GreaterThan=0, LessThan=1, EqualTo=2.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

/// BinaryExpression enum: Add=0, Subtract=1.
#[derive(BorshSerialize, BorshDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

/// Full validate_stat argument set (after the 8-byte discriminator).
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ValidateStatArgs {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub predicate: TraderPredicate,
    pub stat_a: StatTerm,
    pub stat_b: Option<StatTerm>,
    pub op: Option<BinaryExpression>,
}

impl ValidateStatArgs {
    /// Encode the full instruction data: `disc(8) || borsh(args)`.
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = Vec::with_capacity(256);
        buf.extend_from_slice(&VALIDATE_STAT_DISC);
        self.serialize(&mut buf)
            .map_err(|_| ProgramError::from(OnyxError::InvalidInstructionData))?;
        Ok(buf)
    }
}

/// Result of a validate_stat CPI. Distinguishes an expected-negative outcome
/// (`Predicate(false)`) from transient failures that MUST NOT be treated as a
/// loss (missing return data, or a CPI error propagated by the caller).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidateOutcome {
    /// validate_stat returned `true` — the predicate holds (side A wins).
    Predicate(bool),
}

/// Invoke txoracle `validate_stat` and read the boolean return value.
///
/// Account order (spec §8.1): `[0] txoracle_program, [1] daily_scores_roots (ro)`.
/// The oracle program account is passed via `account_infos` for the runtime; the
/// `Instruction.accounts` metas describe only the roots PDA the program reads.
///
/// Returns:
/// * `Ok(Predicate(bool))` on success — read immediately via get_return_data.
/// * `Err(CpiReturnDataMissing)` if no return data (treat as transient).
/// * `Err(..)` for any CPI transport error (transient — NEVER a loss).
pub fn validate_stat(
    txoracle_program: &AccountInfo,
    daily_scores_roots: &AccountInfo,
    args: &ValidateStatArgs,
) -> Result<ValidateOutcome, ProgramError> {
    let data = args.encode()?;

    // The instruction references exactly one account: the read-only roots PDA.
    let metas = [AccountMeta::readonly(daily_scores_roots.key())];

    let ix = Instruction {
        program_id: txoracle_program.key(),
        accounts: &metas,
        data: &data,
    };

    // invoke returns Err on any transport-level failure -> propagate as transient.
    invoke(&ix, &[daily_scores_roots])?;

    // Read the bool return data IMMEDIATELY (the global buffer is cleared on the
    // next CPI). Missing return data is transient, not an expected-negative.
    match get_return_data() {
        Some(ret) => {
            // Guard: return data must have come from the oracle program.
            if ret.program_id() != txoracle_program.key() {
                return Err(OnyxError::CpiReturnDataMissing.into());
            }
            let val = ret.as_slice().first().copied().unwrap_or(0);
            Ok(ValidateOutcome::Predicate(val != 0))
        }
        None => Err(OnyxError::CpiReturnDataMissing.into()),
    }
}

/// Build a `Comparison` from the on-chain 1-byte predicate encoding.
pub fn comparison_from_u8(p: u8) -> Result<Comparison, ProgramError> {
    match p {
        crate::constants::CMP_GREATER_THAN => Ok(Comparison::GreaterThan),
        crate::constants::CMP_LESS_THAN => Ok(Comparison::LessThan),
        crate::constants::CMP_EQUAL_TO => Ok(Comparison::EqualTo),
        _ => Err(OnyxError::BadParams.into()),
    }
}

/// Build an `Option<BinaryExpression>` from the on-chain 1-byte op encoding.
/// `OP_NONE` (0xFF) means single-stat (no op / no stat_b).
pub fn op_from_u8(op: u8) -> Result<Option<BinaryExpression>, ProgramError> {
    match op {
        crate::constants::OP_NONE => Ok(None),
        crate::constants::OP_ADD => Ok(Some(BinaryExpression::Add)),
        crate::constants::OP_SUBTRACT => Ok(Some(BinaryExpression::Subtract)),
        _ => Err(OnyxError::BadParams.into()),
    }
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    use super::*;

    #[test]
    fn comparison_borsh_indices() {
        assert_eq!(borsh::to_vec(&Comparison::GreaterThan).unwrap(), vec![0]);
        assert_eq!(borsh::to_vec(&Comparison::LessThan).unwrap(), vec![1]);
        assert_eq!(borsh::to_vec(&Comparison::EqualTo).unwrap(), vec![2]);
    }

    #[test]
    fn binary_expression_borsh_indices() {
        assert_eq!(borsh::to_vec(&BinaryExpression::Add).unwrap(), vec![0]);
        assert_eq!(borsh::to_vec(&BinaryExpression::Subtract).unwrap(), vec![1]);
    }

    #[test]
    fn encode_prefixes_discriminator() {
        let args = ValidateStatArgs {
            ts: 1,
            fixture_summary: ScoresBatchSummary {
                fixture_id: 7,
                update_stats: ScoresUpdateStats {
                    update_count: 1,
                    min_timestamp: 0,
                    max_timestamp: 0,
                },
                events_sub_tree_root: [0u8; 32],
            },
            fixture_proof: vec![],
            main_tree_proof: vec![],
            predicate: TraderPredicate {
                threshold: 2,
                comparison: Comparison::GreaterThan,
            },
            stat_a: StatTerm {
                stat_to_prove: ScoreStat {
                    key: 7,
                    value: 3,
                    period: 0,
                },
                event_stat_root: [0u8; 32],
                stat_proof: vec![],
            },
            stat_b: None,
            op: None,
        };
        let buf = args.encode().unwrap();
        assert_eq!(&buf[..8], &VALIDATE_STAT_DISC);
        // Option::None encodes as a single 0 byte at the tail (stat_b, op).
        assert_eq!(buf[buf.len() - 2..], [0u8, 0u8]);
    }
}
