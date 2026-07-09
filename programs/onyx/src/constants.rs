//! Program constants: seeds, discriminators, scales.

use pinocchio::pubkey::Pubkey;

// ---- PDA seed prefixes (spec §4) ----
pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_MARKET: &[u8] = b"market";
pub const SEED_VAULT: &[u8] = b"vault";
pub const SEED_POSITION: &[u8] = b"pos";

/// Seed prefix for the txoracle daily-scores roots PDA. NOTE: the IDL account
/// *arg* is named `daily_scores_merkle_roots`, but the actual PDA seed string
/// is `daily_scores_roots` (verified against the reference script).
pub const SEED_DAILY_SCORES_ROOTS: &[u8] = b"daily_scores_roots";

// ---- Account discriminators (byte 0, spec §5.1) ----
pub const DISC_CONFIG: u8 = 1;
pub const DISC_MARKET: u8 = 2;
pub const DISC_POSITION: u8 = 3;

// ---- Instruction discriminators (spec §7.0) ----
pub const IX_INITIALIZE_CONFIG: u8 = 0;
pub const IX_OPEN_MARKET: u8 = 1;
pub const IX_JOIN_MARKET: u8 = 2;
pub const IX_DELEGATE_MARKET: u8 = 3; // L1 ER: delegate market to MagicBlock ER (base layer)
pub const IX_UNDELEGATE_MARKET: u8 = 4; // L1 ER: schedule commit+undelegate (runs on the ER)
pub const IX_SETTLE_MARKET: u8 = 5;
pub const IX_CLAIM: u8 = 6;
pub const IX_REFUND_EXPIRED: u8 = 7;
pub const IX_TOUCH_MARKET: u8 = 8; // L1 ER: minimal in-play mutation to prove ER execution
// 9..=13 reserved for parlay / pause (see spec §7.0)
pub const IX_CREATE_MARKET_PERMISSION: u8 = 14; // task-8 PER de-risk spike, experimental

// ---- Sealed Order Intent (Level 1, O7) ----
pub const IX_OPEN_MARKET_SEALED: u8 = 15;
pub const IX_SUBMIT_SEALED_ORDER: u8 = 16;
pub const IX_REVEAL_ORDER: u8 = 17;
pub const IX_RUN_BATCH_MATCH: u8 = 18;
pub const IX_REFUND_UNREVEALED: u8 = 19;

pub const DISC_SEALED_ORDER: u8 = 4;
pub const SEED_SEALED_ORDER: &[u8] = b"order";

/// Market.phase (sealed-order sub-state; independent of Market.status, which
/// stays Open/Live throughout so join_market/deadline gating is unaffected).
/// PHASE_NONE (0) means "not a sealed market" -- every existing Market has a
/// zeroed reserved region, so plain markets read as PHASE_NONE for free.
pub const PHASE_NONE: u8 = 0;
pub const PHASE_COMMIT: u8 = 1;
pub const PHASE_REVEAL: u8 = 2;
pub const PHASE_MATCHED: u8 = 3;

/// SealedOrder.status.
pub const ORDER_STATUS_LOCKED: u8 = 0; // committed, not yet revealed
pub const ORDER_STATUS_REVEALED: u8 = 1; // revealed, awaiting batch match
pub const ORDER_STATUS_MATCHED: u8 = 2; // processed by run_batch_match (matched_size may be 0)
pub const ORDER_STATUS_REFUNDED: u8 = 3; // refund_unrevealed processed it (never revealed)

/// Bound on how many orders a single run_batch_match call processes (account
/// list / CU budget for a devnet-scale demo; a production system would need
/// an on-chain order registry + multi-tx batching to lift this).
pub const MAX_BATCH_ORDERS: usize = 16;

// ---- MagicBlock Ephemeral Rollups (L1) ----
// Delegation Program (base layer). Owns delegated accounts while they live on the ER.
pub const DELEGATION_PROGRAM_ID: Pubkey =
    pinocchio_pubkey::from_str("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
// Magic Program (exists only INSIDE the ER; commit/undelegate CPIs target it there).
pub const MAGIC_PROGRAM_ID: Pubkey =
    pinocchio_pubkey::from_str("Magic11111111111111111111111111111111111111");
// Magic Context account (scheduled-commit store; writable in commit/undelegate CPIs).
pub const MAGIC_CONTEXT_ID: Pubkey =
    pinocchio_pubkey::from_str("MagicContext1111111111111111111111111111111");

// dlp delegate-buffer PDA seed prefix (buffer is derived under OUR program id).
pub const SEED_DELEGATE_BUFFER: &[u8] = b"buffer";

// dlp Delegate instruction discriminator = (DlpDiscriminator::Delegate as u64) LE = 0.
pub const DLP_DELEGATE_DISC: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0];

// Magic program `ScheduleCommitAndUndelegate` = serde/bincode enum variant 2 (u32 LE).
pub const MAGIC_SCHEDULE_COMMIT_AND_UNDELEGATE: [u8; 4] = [2, 0, 0, 0];

// Discriminator the delegation program uses when it CPIs back into an owner
// program to finalize undelegation (dlp EXTERNAL_UNDELEGATE_DISCRIMINATOR).
pub const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];

// ---- MagicBlock Private Ephemeral Rollups (PER) — task 8 de-risk spike ----
// Permission Program (gates who can read/write a delegated account on a
// TEE-backed PER validator). Verified against ephemeral-rollups-sdk 0.14.3 +
// its Pinocchio-native sibling crate's acl::consts.
pub const PERMISSION_PROGRAM_ID: Pubkey =
    pinocchio_pubkey::from_str("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
// Permission PDA seed (note the trailing colon — this is exact, not a typo).
pub const PERMISSION_SEED: &[u8] = b"permission:";
// CreatePermission discriminator = (u64 LE 0), Borsh-encoded (8 bytes).
pub const CREATE_PERMISSION_DISC: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 0];
// Member.flags bit (access_control::structs::member — AUTHORITY_FLAG).
pub const PERMISSION_AUTHORITY_FLAG: u8 = 1;

// ---- txoracle validate_stat CPI ----
/// Anchor discriminator for `validate_stat` (verified in txoracle.json).
pub const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

// ---- scales / windows ----
/// Fixed-point odds scale (6 dp). Reserved for parlay phase.
pub const ODDS_SCALE: u64 = 1_000_000;
/// Refund window (seconds) after `deadline` before `refund_expired` is allowed.
pub const SETTLE_GRACE: i64 = 2 * 60 * 60; // 2h
/// Basis-points denominator for fee math.
pub const BPS_DENOM: u64 = 10_000;

/// TxLINE timestamps are milliseconds; epoch day = floor(ts_ms / 86_400_000).
pub const MS_PER_DAY: i64 = 86_400_000;

// ---- Market status enum (spec §5.7) ----
pub const STATUS_DRAFT: u8 = 0;
pub const STATUS_OPEN: u8 = 1;
pub const STATUS_LIVE: u8 = 2;
pub const STATUS_SETTLING: u8 = 3;
pub const STATUS_SETTLED: u8 = 4;
pub const STATUS_CLAIMED: u8 = 5;
pub const STATUS_EXPIRED: u8 = 6;
pub const STATUS_REFUNDED: u8 = 7;

// ---- Outcome enum (Market.outcome) ----
pub const OUTCOME_UNKNOWN: u8 = 0;
pub const OUTCOME_SIDE_A: u8 = 1;
pub const OUTCOME_SIDE_B: u8 = 2;

// ---- Side enum (Position.side) ----
pub const SIDE_A: u8 = 1;
pub const SIDE_B: u8 = 2;

// ---- op enum (BinaryExpression, matches txoracle: Add=0, Subtract=1) ----
pub const OP_NONE: u8 = 0xFF; // single-stat marker (no second stat / op)
pub const OP_ADD: u8 = 0;
pub const OP_SUBTRACT: u8 = 1;

// ---- predicate/comparison enum (Comparison: GT=0, LT=1, EQ=2) ----
pub const CMP_GREATER_THAN: u8 = 0;
pub const CMP_LESS_THAN: u8 = 1;
pub const CMP_EQUAL_TO: u8 = 2;

/// System program id.
pub const SYSTEM_PROGRAM_ID: Pubkey = pinocchio_system::ID;
