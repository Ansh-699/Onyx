// Named byte offsets for ONYX account layouts — the TS mirror of the
// program's state modules. Use these instead of magic numbers in any code
// that reads raw account data (the demo-fixture statKey bug was exactly a
// wrong-raw-offset bug; names make that class reviewable at a glance).
// Source of truth: programs/onyx/src/state/*.rs.

/** Account discriminators (byte 0). */
export const DISC = {
  CONFIG: 1,
  MARKET: 2,
  POSITION: 3,
  SEALED_ORDER: 4,
  TRADING_ACCOUNT: 5,
  AMM_POOL: 6,
  AMM_POSITION: 7,
} as const;

/** Market (programs/onyx/src/state/market.rs, 128+ B). */
export const MARKET = {
  DISC: 0,
  FIXTURE_ID: 8, // u64
  STAT_A_KEY: 16, // u32
  STAT_B_KEY: 20, // u32
  OP: 24, // u8
  STATUS: 26, // u8
  OUTCOME: 27, // u8
  DEADLINE: 36, // i64
  PARAMS_HASH: 68, // [u8;32]
  VAULT_BUMP: 100, // u8
} as const;

/** AmmPool (state/amm_pool.rs, 176 B). */
export const AMM_POOL = {
  DISC: 0,
  MARKET: 8, // Pubkey
  LP_OWNER: 40, // Pubkey
  RESERVE_A: 72, // u64
  RESERVE_B: 80, // u64
  SETS_OUTSTANDING: 88, // u64
  FEES_ACCRUED: 96, // u64
  SEED_AMOUNT: 104, // u64
  FEE_BPS: 112, // u16
  LP_WITHDRAWN: 114, // u8 bool
  LEN: 176,
} as const;

/** AmmPosition (state/amm_position.rs, 144 B). */
export const AMM_POSITION = {
  DISC: 0,
  OWNER: 8, // Pubkey
  MARKET: 40, // Pubkey
  USDC_AVAILABLE: 72, // u64
  TOKENS_A: 80, // u64
  TOKENS_B: 88, // u64
  WITHDRAWN: 96, // u64
  REDEEMED: 104, // u8 bool
  LEN: 144,
} as const;

/** SessionToken (MagicBlock gpl_session; Anchor account, 112 B). */
export const SESSION_TOKEN = {
  DISC: 0, // 8-byte Anchor discriminator
  AUTHORITY: 8, // Pubkey
  TARGET_PROGRAM: 40, // Pubkey
  SESSION_SIGNER: 72, // Pubkey
  VALID_UNTIL: 104, // i64
  LEN: 112,
} as const;
