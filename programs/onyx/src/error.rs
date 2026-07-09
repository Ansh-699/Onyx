//! ONYX program error codes (spec §6). Returned as `ProgramError::Custom(u32)`.

use pinocchio::program_error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum OnyxError {
    AlreadyInitialized = 6000,
    Paused = 6001,
    BadParams = 6002,
    MarketExists = 6003,
    MarketClosed = 6004,
    InsufficientStake = 6005,
    WrongStatus = 6006,
    /// daily_scores_roots absent for target slot. TRANSIENT — retry, not a loss.
    RootNotPosted = 6007,
    ProofMismatch = 6008,
    NotWinner = 6009,
    AlreadyClaimed = 6010,
    NotExpired = 6011,
    Unauthorized = 6012,
    /// Invariant I-Solvency breach: vault < obligation.
    VaultUnderfunded = 6013,
    // 6014..=6016 reserved for parlay phase (LegAlreadyTerminal, TooManyLegs, CollateralShort)
    /// validate_stat returned no data via get_return_data.
    CpiReturnDataMissing = 6017,
    // ---- Sealed Order Intent (Level 1, O7) ----
    /// Instruction not valid for the market's current sealed-order phase /
    /// timestamp window (e.g. submit after commit_end_ts, reveal before it).
    WrongPhase = 6018,
    /// Revealed preimage does not hash to the stored commitment.
    CommitmentMismatch = 6019,
    /// reveal_order called on an already-revealed order.
    AlreadyRevealed = 6020,
    /// refund_unrevealed called twice, or on an order that was revealed.
    NothingToRefund = 6021,
    /// Revealed size exceeds the collateral locked at commit time.
    SizeExceedsCollateral = 6022,
    /// run_batch_match's remaining_accounts exceeded MAX_BATCH_ORDERS.
    TooManyOrders = 6023,
    /// submit_sealed_order on a (market, owner, nonce) that already exists.
    OrderExists = 6024,
    /// A matched sealed order's side conflicts with an existing Position's
    /// side for the same (market, owner) — one position per user per market.
    PositionSideMismatch = 6025,
    // ---- ONYX-internal (non-spec) codes, 7xxx range ----
    /// A supplied account did not match its expected PDA derivation.
    InvalidPda = 7000,
    /// Account owner mismatch.
    InvalidOwner = 7001,
    /// Instruction data was too short / malformed.
    InvalidInstructionData = 7002,
    /// Account data length did not match the expected fixed layout.
    InvalidAccountSize = 7003,
    /// An account expected to be a signer was not.
    MissingSignature = 7004,
    /// Arithmetic overflow in payout / accounting math.
    ArithmeticOverflow = 7005,
    /// CPI into txoracle failed for a transient reason (NOT an expected-negative
    /// outcome). Distinct from a `validate_stat == false` result.
    CpiTransientError = 7006,
}

impl From<OnyxError> for ProgramError {
    fn from(e: OnyxError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
