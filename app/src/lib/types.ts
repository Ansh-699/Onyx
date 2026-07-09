// Shared front-end types. These mirror the txoracle IDL (onyx/idl/types/txoracle.ts)
// and the ingestion FixtureSnapshot (services/ingestion/src/scores.ts) so the UI
// stays byte-consistent with the on-chain program and the data layer.
//
// Kept intentionally standalone (no @solana imports) so the pure Merkle logic
// can be unit-tested and reused.

/** ProofNode — mirrors IDL `proofNode { hash:[u8;32], is_right_sibling:bool }`. */
export interface ProofNode {
  /** 32-byte keccak hash, as a plain number[] (each 0..255). */
  hash: number[];
  /** If true the sibling sits on the RIGHT of the accumulator. */
  isRightSibling: boolean;
}

/** ScoreStat — mirrors IDL `scoreStat { key:u32, value:i32, period:i32 }`. */
export interface ScoreStat {
  key: number;
  value: number;
  period: number;
}

/** Comparison ops that actually exist upstream: GT / LT / EQ only. */
export type Comparison = "greaterThan" | "lessThan" | "equalTo";

/** BinaryExpression variants that exist upstream: Add / Subtract only. */
export type BinaryExpression = "add" | "subtract";

/** TraderPredicate — mirrors IDL `traderPredicate { threshold:i32, comparison }`. */
export interface TraderPredicate {
  threshold: number;
  comparison: Comparison;
}

/**
 * FixtureSnapshot — structurally matches
 * services/ingestion/src/scores.ts::FixtureSnapshot.
 */
export interface FixtureSnapshot {
  fixtureId: number;
  competition?: string;
  competitionId?: number;
  participant1?: string;
  participant2?: string;
  startTime?: number;
  [k: string]: unknown;
}

/** A market attached to a fixture (front-end shape; on-chain PDA wiring TBD). */
export interface MarketSummary {
  /** Market PDA (base58). Mocked until on-chain accounts are wired. */
  pda: string;
  fixtureId: number;
  /** Human label for the stat being predicated on. */
  statLabel: string;
  /** ScoreStat key this market resolves against. */
  statKey: number;
  period: number;
  predicate: TraderPredicate;
  /** Kickoff / settlement deadline in ms (TxLINE is milliseconds). */
  deadlineMs: number;
  /** Simple pool figures for display. */
  poolYes: number;
  poolNo: number;
}

/**
 * ReceiptInput — the exact shape the /receipt page recomputes against.
 * `finalStat` is the observed value, `leaf` is its 32-byte keccak leaf hash,
 * `proofPath` folds up to `root` (the anchored on-chain daily-scores root).
 */
export interface ReceiptInput {
  market: string;
  finalStat: ScoreStat;
  /** Anchored root (hex "0x..." or number[32]). */
  root: string | number[];
  /** Leaf hash for finalStat (hex "0x..." or number[32]). */
  leaf: string | number[];
  /** Ordered sibling path from leaf -> root. */
  proofPath: ProofNode[];
  /** Predicate the market settles on (for the pass/fail verdict). */
  predicate: TraderPredicate;
}
