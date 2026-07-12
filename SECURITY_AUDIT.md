# Onyx Security Audit

Scope: `onyx/programs/onyx/src` (native Pinocchio Solana program). Read-only
review of every instruction handler, every state module's `load()`/`from_bytes()`
path, the CPI layers (txoracle, MagicBlock delegation), and constants/seeds.
Frontend not yet in scope (see "Not yet covered" at the end).

Overall: arithmetic discipline (checked add/sub/mul/div, u128 intermediates)
is strong and consistent everywhere funds move. `run_batch_match_fast.rs`
already carries a documented fix from a prior audit (anti-omission/anti-padding
check). The negative findings below are concentrated, not diffuse: two classes
of account-authenticity gaps, both stemming from the same root pattern —
`T::load()` on every state type validates only the 1-byte discriminator, and
each instruction handler is individually responsible for verifying the
account is genuinely owned by this program (or PDA-derived) before trusting
its fields. That responsibility was met in most fund-moving instructions but
missed in a few.

---

## 🔴 CRITICAL #1 — Position / SealedOrder forgery → direct vault drainage

**Files:** `instructions/claim.rs`, `instructions/refund_expired.rs`,
`instructions/refund_unrevealed.rs`
**Root cause:** `state/position.rs::Position::load` and
`state/sealed_order.rs::SealedOrder::load` check only `disc()`. Neither
`claim.rs`, `refund_expired.rs`, nor `refund_unrevealed.rs` calls
`position_ai.is_owned_by(program_id)` / `order_ai.is_owned_by(program_id)`
before trusting `owner`, `market`, `amount`/`collateral_locked`, `claimed`,
`side` read from the account.

**Exploit:** An attacker deploys their own (trivial, permissionless) Solana
program, uses it to create an account they own, and writes bytes into it
matching the `Position` layout (`disc=3`, `owner=<attacker>`,
`market=<any real, already-settled market>`, `side=<winning side>`,
`amount=<anything up to the vault balance>`, `claimed=0`) — or the
`SealedOrder` layout (`disc=4`, `status=Locked`, `revealed=0`,
`market=<any real sealed market past reveal_end_ts>`,
`collateral_locked=<anything>`). They then call `claim` / `refund_expired` /
`refund_unrevealed` directly against a real market's real vault. The only
backstop is the vault-sufficiency check (`vault.amount() < payout`), which
caps the theft at 100% of that market's real balance — stealable with zero
actual deposit.

This requires no oracle/CPI trickery — it's a single instruction call with a
hand-fabricated account, and is more directly exploitable than Critical #2.

**Fix:** add the same check already used correctly in `withdraw_trading.rs`,
`redeem_amm.rs`, `withdraw_lp_amm.rs`, `deposit_trading.rs`, `deposit_amm.rs`:

```rust
if !position_ai.is_owned_by(program_id) {
    return Err(OnyxError::InvalidOwner.into());
}
```

in `claim.rs` and `refund_expired.rs` (for `position_ai`), and the same for
`order_ai` in `refund_unrevealed.rs`. Since `Position`/`SealedOrder` accounts
are only ever created via this program's own `CreateAccount` + `initialize()`
at their canonical PDA (in `join_market.rs` / `submit_sealed_order.rs`),
`is_owned_by(program_id)` is a sufficient guarantee here — Solana never lets
another program mutate an account's data once owned by this program.

---

## 🔴 CRITICAL #2 — Config forgery → arbitrary market settlement

**Files:** `state/config.rs`, `instructions/settle_market.rs` (site of impact);
also read (lower-severity impact) by `open_market.rs`, `join_market.rs`,
`claim.rs`, `withdraw_trading.rs`.
**Root cause:** `Config::load` checks only `disc() == DISC_CONFIG` — no PDA
derivation, no `is_owned_by`. `settle_market.rs`'s oracle-pinning guard:

```rust
let config = Config::load(&mut cdata)?;
if &config.txoracle_program() != txoracle_ai.key() {
    return Err(OnyxError::Unauthorized.into());
}
```

trivially passes if `config_ai` is a forged account (attacker-created, own
program, `disc=1`, `txoracle_program=<attacker's own deployed program>`).
`cpi/txoracle.rs::validate_stat`'s return-data check only confirms the return
data came from whichever program was invoked — which is the attacker's own
program in this scenario, so it's vacuous here. The attacker's fake oracle
returns whatever `validate_stat` result they want, `settle_market` flips a
**real** market to `Settled` with an attacker-chosen outcome, and the real
vault is then drained via `claim`/`withdraw_trading` (both correctly validate
position/trading-account identity once Critical #1 is fixed, but ultimately
trust `market.outcome()`).

**Fix:** validate `config_ai` at every load site — cheapest is a PDA
re-derivation (`find_program_address(&[SEED_CONFIG], program_id)`), which
also implies ownership. Since every call site repeats the same three lines,
pull it into one helper (e.g. `Config::load_checked(account, program_id)`) so
all five call sites get it from one change instead of five.

---

## 🟠 HIGH — `refund_unrevealed.rs` has no vault-solvency check

Unlike `refund_expired.rs` and `claim.rs` (both have an explicit
`vault.amount() < payout` guard before transferring), `refund_unrevealed.rs`
transfers `collateral_locked` straight out with no pre-flight check. SPL
Token's own transfer instruction still rejects an over-large amount, so this
isn't a silent-overspend bug, but it means the program has no clean
`VaultUnderfunded` error path here (an opaque SPL error instead), and — more
importantly — once Critical #1 (`order_ai.is_owned_by`) is fixed, add this
guard too for consistency with the sibling refund/claim instructions.

---

## 🟡 MEDIUM — `create_amm_pool.rs`: unbounded `fee_bps`

`fee_bps = read_u16_le(args, 8)?` has no upper-bound check before
`pool.initialize(...)`. Traced through `fpmm.rs::calc_fee` and the
`checked_sub` calls in `swap_amm.rs`: an oversized `fee_bps` (e.g. > 10_000)
makes `calc_fee` return a fee exceeding the trade amount, which then makes a
downstream `checked_sub` return `None` → `Err(ArithmeticOverflow)`. Every
swap against such a pool simply reverts — this is **self-griefing** (the
creator bricks their own pool), not a way to take funds from other traders,
since checked arithmetic reverts rather than overflowing silently. Still,
cap it (e.g. `fee_bps <= 1_000` / 10%) both to avoid user confusion and as
defense-in-depth — don't rely on "it happens to revert safely downstream."

---

## 🔵 LOW / 💡 INFO

- **`cpi/delegation.rs::cpi_schedule_commit_and_undelegate_many`** is
  self-documented as untested against the real Magic Program. If the
  multi-account CPI shape is wrong it should fail closed (invalid-instruction
  error) rather than corrupt state, but verify empirically before depending on
  it for any multi-account undelegation in a real flow.
- **`process_undelegation.rs`**: the state-restore `dst.copy_from_slice(&src)`
  will panic if `delegated`'s allocated size doesn't exactly equal
  `buffer.data_len()`. In practice `Allocate` is called with
  `space = buffer.data_len()` immediately prior, so this should always hold —
  but a panic here aborts the whole finalize callback rather than returning a
  clean `ProgramResult` error. Low risk (griefs the undelegation, doesn't lose
  funds — the whole tx reverts), worth a defensive length check regardless.
  The account-authenticity check itself (`buffer.is_signer() &&
  buffer.is_owned_by(&DELEGATION_PROGRAM_ID)`) is correct and is the one
  inbound CPI trust boundary in the program that's implemented soundly by
  construction — only the real Delegation Program can make an account it
  owns sign a CPI into this handler.

---

## What's *not* broken (so it isn't re-litigated later)

- `fpmm.rs` CPMM math: thorough, checked, property-tested, rounds in the
  pool's favor by design.
- `swap_amm.rs`: computes `amount_out` from live on-chain reserves, not
  client-supplied values — correct under concurrent-swap serialization.
- `run_batch_match_fast.rs`: already carries a documented, tested fix for a
  prior omission/padding audit finding.
- `withdraw_trading.rs`, `redeem_amm.rs`, `withdraw_lp_amm.rs`,
  `deposit_trading.rs`, `deposit_amm.rs`: all correctly check
  `is_owned_by(program_id)` on the state account before trusting it — this is
  the pattern Critical #1 needs copied into the three missing instructions.
- `process_undelegation.rs`'s inbound CPI authentication (see above).

## Not yet covered in this pass

Frontend (`onyx/app/src/lib/*.ts`, API routes under `src/app/api/*`),
`cpi/permission.rs`, `cpi/matching.rs`, `cpi/merkle.rs`,
`create_market_permission.rs`, the full `*_fast` ER order lifecycle
(`submit_order_fast.rs`, `reveal_order_fast.rs`, `cancel_order_fast.rs`) —
these don't move tokens directly (ER pure-data-mutation only) and any
forged `TradingAccount` fed into them is caught downstream at
`withdraw_trading.rs`'s `is_owned_by` check, so they're lower priority but
not yet read line-by-line.

---

## 2026-07-12 audit-response addendum (independent review follow-up)

**Fixed this pass (deployed to devnet):**
- **Fee ceiling** — `create_amm_pool` now rejects `fee_bps > 1_000` (10%,
  `MAX_AMM_FEE_BPS`), not merely `> BPS_DENOM` (100%). Boundary test-pinned
  (1000 passes, 1001 → BadParams 6002). Fee *computation* untouched.
- **Market-ownership checks on AMM entry** — `create_amm_pool` requires the
  market account to be ONYX-owned (pool creation always precedes ER
  delegation). `open_amm_position` requires ONYX **or Delegation Program**
  ownership — the delegated case is the production norm (the seeder
  delegates market+pool before any wallet opens a position), so an
  ONYX-only check would have bricked one-signature onboarding; both
  directions are test-pinned (foreign owner → InvalidOwner 7001).

**Decisions / known-open, by design:**
- **Kill-switch for a live ER market (Phase 2 → option A).** `Config.paused`
  (6001) gates base-layer entry only; `swap_amm` deliberately does NOT load
  Config — adding a Config dependency into the delegated ER execution path
  reintroduces the "account touched without being delegated" bug class we
  already fought and won. The operator kill-switch for a live ER market is
  **undelegate → settle**: undelegation removes the ER copy (ER swaps stop
  routing), and settlement flips status to SETTLED, which `swap_amm`'s
  status gate (OPEN/LIVE only, checked every swap) rejects on any ledger —
  covered by the existing swap-after-settle tests. Pause remains the gate
  for new money entering on base.
- **Expiry-refund directional dust** — a never-settled market past
  deadline+grace refunds deposits + the paired (min-side) token value; the
  directional residual stays in the vault. Over-collateralized by
  construction: funds can be stranded, never created or lost. Acknowledged;
  no code change.
- **`skipPreflight: true` on all client sends is intentional** — preflight
  simulates against possibly-stale state (worst on the ER/base boundary)
  and produces misleading failures; real errors surface through the
  confirm/poll path (`JSON.stringify`ed on-chain error → `friendlyError`
  mapping, e.g. the in-panel SlippageExceeded message, verified live in the
  browser proof).
- **`tx.ts` explorer-URL "double braces"** — reviewed: the source is a
  normal template literal (`${sig}`); the doubled braces were a transcript
  rendering artifact. Links verified working.
