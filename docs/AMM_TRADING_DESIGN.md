# AMM Trading Design — sell-anytime outcome markets on the ER

**Status: DESIGN + FEASIBILITY, no AMM code written.** Direction locked by
the project owner (2026-07-10): pivot ONYX to Polymarket-style continuous
trading via an outcome-token AMM — the curve is the counterparty, so users
can buy AND sell at any moment without another trader on the other side.
Explicitly NOT an order book/CLOB. Built **additively** as a new market
type alongside the sealed-batch flow; the sealed-batch build is the
guaranteed-shippable fallback and must not be broken or deleted.

What this trades away, stated up front: sealed-batch MEV-resistance does
not apply to AMM markets. An AMM is front-runnable in principle like any
AMM; on the ER, transaction ordering belongs to the MagicBlock sequencer.
The "Why sealed?" story stays true for sealed markets; AMM markets get
their own honest framing ("continuous trading, ER-fast, real seeded
liquidity — not MEV-proof").

---

## 0. Phase-0 probes — run BEFORE this design was trusted (same discipline as the ER fee-payer probe)

The design below only works if its riskiest assumptions hold on the real
ER. Ranked by risk, with what was done about each:

### 0.1 Concurrent multi-wallet writes to ONE shared delegated account (THE swap-shaped unknown) — PROBED LIVE, PASS

Every AMM swap is a read-modify-write on the **shared** pool's reserves
plus the swapper's own position. If the ER lost updates or rejected
concurrent writable-account access under contention, the whole design
dies. Nothing in the prior evidence covered *simultaneous* writes from
independent wallets — the existing browser proofs interleaved two wallets
but never fired them concurrently.

Probe (`app/scripts/probe_amm_concurrency.ts`, existing deployed
instructions only, zero new program code): `reveal_order_fast` increments
`Market.revealed_count` and `cancel_order_fast` decrements it — a genuine
accumulating counter on a shared delegated account, i.e. the exact same
write shape as swapping against pool reserves. 4 fresh wallets each
committed an order, then all 4 fired reveals **concurrently**
(`Promise.all`), then all 4 fired cancels concurrently.

Result (2026-07-10, market `E9QbBguPi7b1msHojb4LBSiCUCYo89pwNXsBT3ZxSKcN`,
ER `https://devnet-as.magicblock.app/`):

| step | mode | result | latency |
|---|---|---|---|
| 4× `submit_order_fast` | sequential | 4/4 ok | 416–1180ms (avg 807ms) |
| 4× `reveal_order_fast` (shared-counter ++) | **concurrent** | 4/4 ok | 1093–1094ms |
| `revealed_count` after | — | **4/4 — zero lost updates** | — |
| 4× `cancel_order_fast` (shared-counter −−) | **concurrent** | 4/4 ok | 769–770ms |
| `revealed_count` after | — | **0/0 — exact** | — |

Sigs: reveals `UDWTwN6Za…`, `zWFMakJHk…`, `2R7KLWXGo…`, `4RkPM2CK9…`;
cancels `5aQeTD1yz…`, `2Eckv2x7r…`, `24ARamqXc…`, `uaaxKYrpu…` (full
signatures in the probe output; all Finalized on the ER endpoint).

**Verdict: the SVM account-lock model holds on the ER under real
concurrency — writable-account conflicts serialize; the runtime does not
tear or interleave writes. Swap-shaped shared-state mutation at ~0.8–1.1s
per write, multiple users, no lost updates.**

**Necessary but not sufficient — flagged by the project owner, correctly.**
A counter increment is commutative: `+1` from four wallets in any
interleaving always sums to 4, so this probe cannot distinguish "writes
serialize correctly" from "writes serialize, but each one might price
itself off stale reserves read before an earlier write landed." A CPMM
swap is neither commutative nor order-independent — its output is a
function of whatever reserves it reads, so if the runtime allowed two
transactions to both read the pre-swap reserves and then both write, the
second write would silently overwrite the first's effect even though
both instructions individually succeeded. This IS ruled out by design,
not just by the counter probe: the swap instruction computes its output
**entirely from the reserves it reads at execution time on-chain** — the
client only supplies `amount_in` and `min_out`, never a pre-computed
`amount_out` — so Solana's standard writable-account serialization
(already evidenced by the exact 4-then-0 counter result: a true
lost-update race would have shown a count below 4) is sufficient by
construction *provided the implementation never trusts a client-supplied
output*. Phase A's mollusk suite and Phase C's live ER test upgrade from
this proxy to firing genuinely concurrent REAL swaps and auditing the
result (§5) — the counter probe motivated the design, it doesn't
substitute for testing the real thing.

### 0.2 Everything else ER-hostile maps onto primitives already proven this build — CITED, not re-probed

| AMM requirement | Already-proven primitive (this repo, real devnet sigs in BUILD_STATE/README) |
|---|---|
| Swaps must move no tokens/lamports (ER hard-rejects balance changes on non-delegated accounts, incl. fee payer — the original Phase-0 finding) | Entire ER-fast flow is pure account-data mutation: `submit/reveal/cancel/run_batch_match_fast` all ran Finalized-on-ER / not-found-on-base |
| Fee payer on ER | Signer kept **read-only**; ER accepts it without charging (validator-sponsored) — every ER tx this build |
| Users join while market is delegated | `open_trading_account`+`deposit`+`delegate_trading_account` on base while market delegated — proven (and the market-ownership check that blocked it was found+removed) |
| One-call undelegation of market + N accounts | `cpi_schedule_commit_and_undelegate_many` is **already generic** over any delegated-account list (`delegated: &[&AccountInfo]`) — proven live with market + 2 TradingAccounts |
| Base-layer SPL payouts after undelegation | `withdraw_trading` two-leg payout — proven, mollusk-tested (10 tests) |
| Oracle settlement untouched by any of this | `settle_market` CPI — proven for ANY fixture via the live proof pipeline (three fresh settlements today, true and false outcomes) |
| Delegating a new PDA type | `delegate_trading_account` is a deliberate near-duplicate of `delegate_market` ("read seeds from the account's own layout" pattern) — pool/position delegation is the same copy, new seeds |

### 0.3 Compute headroom for swap math — BOUNDED ANALYTICALLY, assert in Phase A

Swap math = a handful of u128 mul/div plus ONE integer sqrt (sells).
Observed CU this session (mollusk, real SBF): full uniform-price matching
algorithm = **1,626 CU**; withdraw with parimutuel math + token CPI =
**7,668 CU**. Budget is 200k (and we already set 300–400k in ER txs).
u128 isqrt is a few hundred ops. Risk ≈ nil; Phase A mollusk tests will
still assert swap CU < 50k so a regression can't sneak in.

**Feasibility conclusion of the probes: there are NO new ER unknowns. The
risk in this pivot is schedule (UI days) and integer-math correctness
(testable offline in mollusk), not capability.**

---

## 1. Token model — virtual complete-set accounting (not SPL mints in v1)

Polymarket-style outcome tokens, implemented as **program-ledger balances**
on ONYX-owned accounts (exactly the TradingAccount pattern), NOT real SPL
mints:

- Real SPL outcome tokens would make every swap a token-program CPI
  mutating token accounts owned by the SPL Token program — accounts we
  cannot delegate. That is precisely the operation class the ER rejects
  (Phase-0 fee-payer/balance finding). Virtual balances make swaps pure
  data mutation on delegated ONYX accounts → ER-compatible by
  construction. Real SPL mints (wallet-visible, composable) are a
  mainnet/base-layer roadmap item, deliberately out of v1.

**Complete sets.** 1 tUSDC of collateral ⇄ 1 Side-A token + 1 Side-B
token, always and only in pairs:

- **Mint** (inside a buy): user collateral → +1A +1B outstanding.
- **Burn** (inside a sell): −1A −1B outstanding → collateral back.
- **Redeem** (after settlement): winning token → 1 tUSDC; losing token → 0.

All real tUSDC sits in the market's existing vault PDA (same vault the
sealed flow uses; deposits/withdrawals are base-layer SPL transfers exactly
like `deposit_trading`/`withdraw_trading`). Swaps never touch the vault.

**Solvency invariant** (assert in tests, reconcile to the lamport in the
Phase B devnet proof):

```
vault_balance == Σ user.usdc_available  +  sets_outstanding  +  fees_accrued
```

with `sets_outstanding == Σ user.tokens_A + pool.reserve_a
                       == Σ user.tokens_B + pool.reserve_b` at all times.

At settlement (say A wins), total obligations = Σ usdc_available (plain
withdrawals) + Σ tokens_A (1:1 redemption) + reserve_a + fees (LP) =
exactly `vault_balance`. Losing-side tokens die worthless. Solvent by
construction — provided **every rounding remainder is credited to
`fees_accrued`** (rounding always favors the pool; see §2).

## 2. Curve: CPMM (Gnosis-style FPMM) — recommended over LMSR

**Recommendation: CPMM**, the fixed-product construction Gnosis shipped
and Polymarket ran in production.

- CPMM needs integer mul/div and one u128 isqrt. Exhaustively testable.
- LMSR needs fixed-point `ln`/`exp` in `no_std` Rust — genuinely
  error-prone numerics with fund custody attached and days of extra test
  surface. Its bounded-loss property matters for subsidized market-makers,
  not a disclosed seeded demo pool. Roadmap, not v1.

State: pool reserves `(a, b)` of virtual A/B tokens. Invariant `k = a·b`
(fees make k grow). **Price of A = b/(a+b)** (equal reserves → 50%).

**Buy A with `m` collateral** (fee `f` bps, from the user's
`usdc_available`):

```
fee = m·f / 10_000                      (→ fees_accrued)
m'  = m − fee
mint m' sets:            a += m', b += m', sets_outstanding += m'
tokens out (round DOWN): ΔA = a_old + m' − ceil(a_old·b_old / (b_old + m'))
give ΔA:                 a −= ΔA;  user.tokens_a += ΔA
```

**Sell `ΔA` of token A** (exact-in; the quadratic case):

```
solve (a + ΔA − m)(b − m) = a·b  for gross collateral m:
  s = a + ΔA + b
  m = ( s − isqrt(s² − 4·b·ΔA) ) / 2        (u128; round m DOWN)
burn m sets:  a += ΔA − m, b −= m, sets_outstanding −= m
fee = m·f / 10_000 → fees_accrued;  user.usdc_available += m − fee
```

Guards: `min_out` slippage arg on both directions (checked on-chain);
`m ≤ b` and `m ≤ a + ΔA` by construction of the smaller root; every
division rounds against the user with the remainder credited to
`fees_accrued` so the solvency identity stays exact. Overflow: reserves ≤
total deposits (u64 6dp); intermediates in u128 ((3·10¹²)² ≈ 10²⁵ ≪
u128::MAX). All arithmetic checked, per house style.

**Seeding / liquidity — real and disclosed.** `create_amm_pool` takes seed
`S` from the creator's real tUSDC: mints S sets → reserves `(S, S)` →
opening price 50/50 (creator trades to move it to their prior). v1 is
**single-LP, seed-once**: `lp_owner` recorded on the pool; no LP tokens, no
mid-life add/remove liquidity. After settlement `withdraw_lp_amm` pays
`reserve_winning + fees_accrued` to `lp_owner` — including the case where
that's less than S (adverse selection is the LP's real risk; disclosed,
not hidden). Same "no bluff" treatment as the house-counter: the pool is
real capital, the LP can genuinely lose, nothing fabricates order flow.

## 3. Settlement & redemption — the oracle path is untouched

`settle_market` (disc 5) is not modified. The live any-fixture proof
pipeline built today (`/api/settlement-proof`) works unchanged for AMM
markets, since it keys off the market's own on-chain terms.

New base-layer instructions after undelegate+settle:

- `redeem_amm`: pays `usdc_available + (winning ? tokens_winning : 0)` from
  the vault, zeroes both, sets `redeemed` — the two-leg shape and
  double-payout guard copied from the proven `withdraw_trading`. Also
  callable pre-settlement for the `usdc_available` leg only (park-and-leave
  is never trapped; I-NoTrap discipline).
- `withdraw_lp_amm`: `reserve_winning + fees_accrued` → `lp_owner`, zero
  the pool. Settled-only.
- If the market never settles: the existing `refund_expired` philosophy
  applies — deadline+grace refund path for AMM positions (`usdc_available`
  plus complete-set value of min(tokens_a, tokens_b), with unpaired tokens
  refunding at… **decision: refund unpaired outcome tokens at 0.5** is
  wrong (manipulable); v1 honest rule: unresolved-market refund pays
  `usdc_available + min(tokens_a, tokens_b)` (the riskless complete-set
  component); the directional residual is the position's genuine risk. LP
  refund symmetric: `min(reserve_a, reserve_b)` + fees. Documented, tested.

## 4. Account & instruction surface (additive; discs 29–36, account discs 6–7)

**`AmmPool`** (disc 6, PDA `["amm", market]`, 176 B): market(32),
lp_owner(32), reserve_a(8), reserve_b(8), sets_outstanding(8),
fees_accrued(8), seed_amount(8), fee_bps(2), lp_withdrawn(1), bump(1),
reserved. **`AmmPosition`** (disc 7, PDA `["ammpos", market, owner]`,
144 B): owner(32), market(32), usdc_available(8), tokens_a(8), tokens_b(8),
withdrawn(8), redeemed(1), bump(1), reserved.

| disc | instruction | layer | notes |
|---|---|---|---|
| 29 | `create_amm_pool` | base | requires `market.phase == PHASE_NONE` (plain `open_market` markets only — **zero interaction with the sealed state machine**); seeds pool from creator tUSDC |
| 30 | `open_amm_position` | base | mirror of `open_trading_account` (incl. its delegated-market lesson: no market-ownership check) |
| 31 | `deposit_amm` | base | real SPL transfer → vault; credits `usdc_available` |
| 32 | `delegate_amm_pool` | base | near-dup of `delegate_trading_account`, seeds `["amm", market]` |
| 33 | `delegate_amm_position` | base | near-dup, seeds `["ammpos", market, owner]` |
| 34 | `swap` | **ER** (routed) | args: side(u8), direction(u8 buy/sell), amount_in(u64), min_out(u64). Output is computed **entirely on-chain from the reserves read at execution time** — the client sends only `amount_in`/`min_out`, never a pre-computed `amount_out` — this is the property that makes concurrent-swap safety a consequence of Solana's writable-account serialization rather than a hope; tx reverts if the computed output is worse than `min_out` (slippage protection, real, enforced on-chain, not advisory). Writes pool+position; market passed read-only (delegated alongside, so it exists on the ER); gates: status Open/Live and `now < deadline` |
| 35 | `redeem_amm` | base | §3 |
| 36 | `withdraw_lp_amm` | base | §3 |
| 27 (reuse) | `undelegate_trading_account` | ER | already generic over any ONYX-delegated account list — undelegates market+pool+positions (chunked if account limits require) |

Market account layout: **untouched** (all 128 bytes are spoken for; AMM
state lives entirely in the new pool PDA — existing markets and decoders
unaffected, which is what keeps this genuinely additive).

Lifecycle: create+seed (base) → users join: open+deposit (base) → delegate
market+pool+positions (base) → **swap freely on ER, sub-second** → after
deadline: undelegate-many (ER→base) → settle via existing oracle CPI
(base) → redeem / withdraw LP (base). Every arrow is a proven primitive.

## 5. Feasibility & phased plan (9 days to Jul 19, 23:59 UTC)

**Verdict: GO, additive, with abort gates.** Capability risk was retired
by §0. Remaining risk, ranked: (1) UI time, (2) FPMM integer-math edge
cases — offline-testable, (3) devnet/ER flakiness eating a day (observed
repeatedly this session). The sealed-batch fallback makes the worst case
"ship what already works."

| phase | days | scope | on-chain proof required |
|---|---|---|---|
| **A** | 1–2 | `fpmm.rs` pure math + 2 accounts + 8 instructions + mollusk suite: (a) solvency identity across **adversarially-ordered** swap sequences — not one happy path, many random/hostile orderings of buys+sells, proving the path-dependent math itself is correct under reordering, since a CPMM swap (unlike the counter probe) is non-commutative and its output depends on whatever reserves it reads; (b) rounding-favors-pool; (c) slippage/`min_out` reverts on every direction; (d) **a full mint→trade→settle→redeem→LP-withdraw sequence asserting the solvency identity holds EXACTLY POST-SETTLEMENT** (vault ends at the precise expected remainder, nothing stuck, nothing overdrawn) — not just mid-lifecycle; (e) CU < 50k. Sealed-flow's own 44-test suite re-run alongside, unchanged, at this gate. | `cargo test` counts (incl. sealed-flow's 44 still green) + CU numbers (real SBF via mollusk) |
| **Gate 1** (end d2) | | math not green → **abort pivot**, fallback stands | |
| **B** | 3 | deploy upgrade; base-only devnet lifecycle script: create→seed→2 users join→buys+sells→deadline→settle (existing live pipeline)→redeem×2→withdraw_lp, with vault reconciled **to the lamport** against the §1 identity **both mid-lifecycle AND as the final post-redemption state** (explicit standalone assertion, not implied by the script just finishing). Sealed-flow regression re-run at this gate too. | full sig list + balance table, both checkpoints |
| **C** | 4 | ER path: delegate market+pool+positions → **N wallets fire genuinely concurrent REAL swaps (`Promise.all`, not sequential) against one live pool** → assert (1) no lost updates — every swap lands or fails cleanly, no silent drop; (2) the solvency identity holds exactly on the final reserves; (3) **no two swaps were priced off the same stale reserves** — verified by replaying the on-chain-observed landing order through the same CPMM formula off-chain and confirming it reproduces the exact final on-chain reserves (an audit, not an inference from a commutative counter) → undelegate-many → settle → redeem, solvency reconciled again post-settlement. Sealed-flow regression re-run. | sigs Finalized-on-ER + not-found-on-base (the standing standard) + the replay-audit output |
| **Gate 2** (end d4) | | ER swaps failing (lost updates, stale-priced swaps, or solvency breaks) → decide: ship AMM base-only ("ER acceleration: roadmap") vs fallback | |
| **D** | 5–6 | UI: `/create` market-type toggle (Sealed vs AMM), `AmmTradingPanel` (live price from reserves, buy/sell with a real quote engine reading current reserves, **user-set slippage tolerance deriving `min_out`, on-chain-enforced — no swap ships without this wired end-to-end, not just present as an unused arg**), position card, redeem, LP-risk + MEV-story disclosures. MarketDetail routes by pool existence, portfolio section. Sealed-flow regression re-run. | browser-driven proof script + screenshots (wallet-signed, per the standing standard), incl. a deliberate slippage-revert screenshot |
| **E** | 7 | README/docs rewrite (positioning: "Polymarket-style continuous trading on MagicBlock ER"), full regression sweep (sealed flow must still fully pass — this is now the 5th time it's re-run, once per gate, not just at the end), demo prep | 8-route sweep + full sealed-flow re-proof |
| buffer | 8–9 | devnet flakiness + demo video recording | — |

**Sealed-flow regression discipline**: re-run at every gate (A/B/C/D/E),
not deferred to Phase E alone — drift gets caught the day it's introduced,
not on day 7 when it's expensive to trace back.

**Minimal honest version** if compressed: buy+sell on base layer only,
single seeded LP, no portfolio integration — still genuinely
sell-anytime with real liquidity, weaker ER story. **Not** shippable
without: the solvency identity holding in tests, and sells working (a
buy-only AMM would be exactly the fake-market dressing this project
refuses to ship).

Explicitly out of v1 (roadmap): real SPL outcome tokens, LP shares /
add-remove liquidity, LMSR, multi-outcome markets, order book, rolling
re-opening markets.
