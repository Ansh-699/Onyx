# ONYX ER Trading — Design Doc (Phase 0)

Status: **ROADMAP — not part of the submission build. Decision made
2026-07-10: do not start Phase 1.** This is a major architectural migration
(new account type, new base-layer deposit/withdraw lifecycle, ER-RPC
routing in the frontend), it delivers an unscored capability the demo
doesn't need, and it would eat the runway that demo-critical fixes still
needed at the time (`refund_unrevealed` wasn't wired into the UI yet). The
Phase 0 probe finding stands as real, evidence-backed work — the ER
fee-payer boundary is a genuine architectural constraint worth having
found and designed around — but this stays a design doc, not code, unless
and until there's runway to spend on an unscored feature post-submission.

## §6 decisions (confirmed 2026-07-10)

1. **Single enforced order-per-wallet-per-market: yes.** Take the simple
   `TradingAccount`-per-`(user, market)` shape. It structurally closes the
   audit's UI-only-order-limit gap, and the multi-slot alternative adds real
   complexity for little gain in a uniform-price batch model.
2. **Real-time definition confirmed as written in §5**: short-cadence ER
   batches + cancel-before-match. Explicitly, permanently **not**
   instant-sell-a-matched-position — a parimutuel pool has no counterparty
   for a mid-match sell, and faking one would violate the project's
   no-fabrication rule and the sealed-batch thesis itself. Don't promise it.
3. **Additive-only, never replace — and not in the submission build at
   all.** If this is ever built, `TradingAccount` + the ER-fast instructions
   live alongside the existing, working, base-only sealed-order flow.
   Replacing a proven flow before a deadline is exactly the risk this
   decision avoids. For the submission, this document is the only artifact;
   zero lines of the proposed schema/instructions are implemented.
4. **The multi-account undelegate probe (§2's open question) is optional
   roadmap work**, cheap and zero-risk to run (throwaway script, same shape
   as `er_order_probe.ts`) whenever this doc is picked back up — not before
   P0/P1 submission fixes.

Everything below this line is the original Phase 0 research and proposal,
unchanged, kept as the reference design for whenever this is picked up.

---

Everything below is
either (a) read directly from the current program source, cited by file:line,
or (b) verified empirically against live devnet + the MagicBlock ER just now,
with real tx signatures. Anything neither of those is labeled **UNVERIFIED /
ASSUMPTION** and flagged as a decision point at the end.

## 0. The one fact that shapes everything else

**Question**: can a Pinocchio program create a brand-new PDA (via System
Program `CreateAccount`, debiting a normal user wallet for rent) inside a
transaction sent to the ER RPC, when only the Market account is delegated?

**Answer, empirically proven just now**: **No.** The ER rejects the
transaction outright — not a program error, a validator-level rejection —
because `CreateAccount`'s `from: payer` debits the fee payer's lamports, and
**the ER will not allow any non-delegated account's balance to change,
including the fee payer itself.**

Proof (real devnet + ER, `services/ingestion/src/er_order_probe.ts`):

1. Opened a fresh throwaway sealed market `BWPbsJFudwsp7KoDy5FZwm7QXPxjRp5c6gRztzbBQVtW`
   (fixture 900000005) — base tx
   `4aj5e9fZKrGzVa5wvGj4cfQNdTWVTFGHpNFt8RGSVFhP6QVSszcvRBhcPBqPPaMVXes4wrmtuJ8pxNRr7PYwWAXh`
   — **Finalized on base**.
2. Delegated it — base tx
   `2Y9qJPCKUrKtrMU7ZQBJZxGZQa3hgBpdSh986mjTddVXcUsAprZxjzYia8nnm5hr7643jFemeCasiK7KuU5CZU2F`
   — **Finalized on base**. Router `getDelegationStatus` confirms
   `isDelegated:true`, `fqdn: devnet-as.magicblock.app`.
3. Sent `submit_sealed_order` (disc 16 — creates a brand-new `SealedOrder` PDA
   via `CreateAccount` + an SPL `Transfer` for collateral, exactly the
   existing base-layer instruction, unmodified) straight to the ER RPC,
   targeting the now-delegated market. Sig
   `5xq1yPqpbaP7hV2nL35V8ghxZ5EmSNz41LG159BW8HBN4x3dWMVXZmVmGjNqijy9MszBBxRPcebmRiP8JuhSNdGw`.
   - `solana confirm <sig> --url https://devnet-as.magicblock.app/` →
     **"Transaction failed: This account may not be used to pay transaction fees"**
   - `solana confirm <sig> --url devnet` → **"Not found"** (never touched base — proves the attempt really happened only on the ER)
   - Program logs show `System Program` and `Token Program` sub-invocations
     both individually logging `success`, then the ER's own runtime rejects
     the transaction with: `Feepayer A5sV4Pkk...was modified without being delegated`
   - The target order PDA (`GmZ1axJhny2irUSyCBSRW1M4ZG6U99VMFEQWhxHm9roR`)
     does not exist on the ER or on base afterward.

This matches (and explains) why the existing ER work only ever proved
`touch_market` on the ER: `touch_market`'s accounts are `[caller (S, **not
writable**), market (W)]` (`programs/onyx/src/instructions/touch_market.rs`)
— the caller's balance never changes, only the already-delegated market's
data does. `submit_sealed_order`'s accounts are `[user (S, **W**), ...]`
(`submit_sealed_order.rs:14`) — the user is debited for rent, which is exactly
the operation the ER refuses.

**Consequence**: the existing `SealedOrder`/`Position` account model — fresh
`CreateAccount` per order, funded straight from the bettor's own wallet — is
structurally incompatible with running on the ER, full stop, regardless of
how much CPI-wrapper code is written around it. Getting bets onto the ER
requires a different account shape, not a thin routing layer over the
existing instructions.

## 1. Account topology: what delegates, when, and why

The current `open_market_sealed → submit_sealed_order → reveal_order →
run_batch_match → settle_market → claim` flow uses four account types:
`Market` (128B, `state/market.rs`), `SealedOrder` (160B, one per bet,
`state/sealed_order.rs`), `Position` (96B, one per matched user,
`state/position.rs`), and `Vault` (a standard SPL Token account, owned by the
Token Program, created in `open_market.rs`'s shared
`create_market_and_vault`).

Given §0, here's the account model that actually works on the ER:

| Account | Type | Created where | Delegated when | Committed back when | Why |
|---|---|---|---|---|---|
| **Market** | existing, unchanged | base (`open_market_sealed`) | right after commit phase opens | before `settle_market` | Already proven end-to-end (BUILD_STATE.md ER spike + re-verified live above). No change needed. |
| **Vault** | existing SPL Token account, unchanged | base | **never** | n/a | It's owned by the Token Program, not ONYX — MagicBlock's delegation model delegates *your* program's PDAs. Moving real token balances onto the ER at all requires MagicBlock's separate Ephemeral SPL Token program (`SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`, mentioned in BUILD_STATE.md, **zero lines of code reference it anywhere in this repo**). Adopting it is a second, independent reverse-engineering project on the scale of what `cpi/delegation.rs` already was — out of scope for this pass. Vault stays base-only; see §2 for how that still yields fast trading. |
| **TradingAccount** *(new)* | new account type, ONYX-owned | base, one `deposit` tx per (user, market) | immediately after creation, same tx or next | when the user is done trading (or the window closes) | This is the actual fix. See below. |

### Why a new account type, not "delegate SealedOrder instead"

`SealedOrder` is created **fresh, per bet, funded by the bettor's own
wallet** — exactly the pattern §0 proved doesn't work on the ER. The fix
is to separate **money movement** (must happen on base, where the real SPL
Token program and the user's real wallet live) from **trading logic** (can
happen on the ER, *if* it's pure account-data mutation with no lamports or
token-balance change).

**`TradingAccount`** — new PDA, seeds `["trading", market, owner]`, owned by
ONYX:

```
disc            u8
owner           Pubkey (32)
market          Pubkey (32)
deposited       u64   -- total ever moved in via the one real SPL transfer
available       u64   -- deposited - locked - withdrawn
locked          u64   -- collateral behind the current open commitment (0 or 1 order)
commitment      [u8;32] -- sealed-order hash (zero = no open order)
side            u8    -- revealed side (0 = not revealed / no order)
size            u64   -- revealed size
limit_price     u64   -- revealed limit price
status          u8    -- None(0) / Locked(1) / Revealed(2) / Matched(3) / Cancelled(4)
matched_size    u64   -- set by run_batch_match
withdrawn       u64
bump            u8
```

Lifecycle of ONE `TradingAccount`:

1. **`open_trading_account`** *(new ix, base)* — user creates it, pays their
   own rent. One-time per (user, market).
2. **`deposit`** *(new ix, base)* — real SPL `Transfer` from the user's ATA
   into Vault, exactly the transfer leg `submit_sealed_order` does today,
   just decoupled from placing a bet. Increments `deposited`/`available`.
   Can be combined into the same tx as step 1.
3. **`delegate_trading_account`** *(new ix, base)* — same buffer/zero/reassign/CPI-Delegate
   dance `delegate_market.rs` already does, generalized to take PDA seeds as
   args instead of reading a Market-shaped byte layout (see §4). Any signer
   can call it for their own account (the program signs via the PDA seeds,
   same as today).
4. On the ER, **all of**: commit (write `commitment`+`locked`, checked
   against `available`), reveal (verify hash, write `side`/`size`/`limit_price`),
   cancel-before-match (clear the commitment, restore `available`), and the
   match write-back (`matched_size`, `status`) are **pure field mutations on
   an account that already exists and is already delegated** — exactly the
   operation `touch_market` already proved works on the ER, just on a
   different account shape.
5. **`undelegate_trading_account`** *(new ix, ER)* — same
   `ScheduleCommitAndUndelegate` CPI `undelegate_market.rs` already does,
   generalized. Returns the account to base with its final state.
6. **`withdraw`/`claim`** *(base)* — the other one real SPL transfer, out of
   Vault, using the now-committed `matched_size`/`side` exactly as `claim.rs`
   does today against `Position`. (`Position` either goes away and `claim.rs`
   reads `TradingAccount` directly, or `TradingAccount` *is* renamed
   `Position` with these fields added — an implementation detail for Phase 1,
   not a design fork.)

Net result: **two real SPL-token-moving base transactions per user per
market** (deposit once, withdraw once) and **everything in between —
commit, reveal, cancel, match — is ER-fast**, because none of it touches a
non-delegated account. This is the same shape as a perps/CLOB program that
makes you deposit collateral once and trades against an internal ledger
(the `design-judgment` reference file's "Workstation Dense" category —
Drift, Jupiter Perps — uses exactly this split for the same reason: the
matching engine can't be gated by base-layer settlement speed).

**This also directly answers Phase 3's "is one-order-per-wallet a real
rule?"**: this design gives each `(user, market)` exactly one `TradingAccount`
with one `commitment` field — one open order at a time, *enforced by the
account shape itself*, not a UI convention. If the user wants multiple
concurrent orders per wallet, this design would need to change (an array of
slots instead of one), which is materially more complex (see §6, decision
point 1). I'm recommending single-order-per-wallet as the real, on-chain rule.

### `Position` accounts and the batch-inclusion integrity fix (Phase 3), for free

`run_batch_match` today (`run_batch_match.rs:8-13`) lets **any signer**
call it — permissionless, matching `settle_market`/`claim`'s pattern — and
lets that caller choose which revealed orders are in `remaining_accounts`
(bounded by `MAX_BATCH_ORDERS = 16`, `constants.rs`), which is the omission
vulnerability: a caller can leave out revealed orders to skew the clearing
price.

The `TradingAccount` redesign fixes this as a side effect, cheaply: add a
`revealed_count: u32` field to `Market` (there's exactly 1 reserved byte left
in the current 128-byte layout per `state/market.rs`'s doc comment, so this
needs `MARKET_LEN` to grow — a small, well-scoped change), incremented every
time a `TradingAccount` reveals. `run_batch_match` then **requires the
passed account list's length to exactly equal `Market.revealed_count`** (in
addition to the existing per-account PDA-derivation + status check it
already does). A caller can't pad the count with duplicates — a duplicate
entry is the same account passed twice, and the second pass sees
`status != Revealed` (already consumed) and the whole tx fails — so the only
way to satisfy "exact count, all valid, all distinct" is to genuinely
include every revealed order. This closes the omission attack without
needing a full on-chain registry/enumeration.

## 2. Lifecycle: exact instruction sequence, base vs ER

For a sealed market using the redesigned flow:

| Step | Instruction | Runs on | Why |
|---|---|---|---|
| Open | `open_market_sealed` | base | Creates Market + Vault. Unchanged. |
| — | `delegate_market` | base | Market → Delegation Program on base, cloned onto ER. |
| Per user, once | `open_trading_account` + `deposit` | base | The one real SPL transfer in. |
| Per user, once | `delegate_trading_account` | base | TradingAccount → Delegation Program on base, cloned onto ER. |
| Commit | submit (write commitment+lock) | **ER** | Pure data mutation on an already-delegated TradingAccount. |
| (optional) | cancel | **ER** | Same — clears commitment, restores `available`. |
| Reveal | reveal (verify hash, write side/size/price) | **ER** | Same. |
| Match | `run_batch_match` (reads all revealed TradingAccounts for the market, count-checked against `Market.revealed_count`) | **ER** | Pure computation + data mutation (`matching::run_uniform_price_match` is already a pure function, `matching.rs`). |
| — | `undelegate_market` + `undelegate_trading_account` (per participant) | **ER**, fires the commit | Must happen before settle — settlement CPIs into TxODDS's base-layer oracle program, so Market (status/outcome) and every TradingAccount (matched_size) must be back on base first. |
| — | delegation program's external-undelegate callback → `process_undelegation` | base (validator-driven, not user-invoked) | Restores committed state under ONYX ownership on base. Already generic (reads seeds from the callback, not Market-specific — `process_undelegation.rs:44-63` — so it needs zero changes to also handle TradingAccount). |
| Settle | `settle_market` | base | CPIs `validate_stat` into TxODDS's program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (base-layer only, confirmed executable in the last audit). |
| Claim | `withdraw`/`claim` | base | The one real SPL transfer out, using the now-committed `matched_size`. |

**Open engineering question (flagged, not resolved)**: `undelegate_market` +
one `undelegate_trading_account` per participant is N+1 separate
`ScheduleCommitAndUndelegate` CPIs if the Magic Program only accepts one
delegated account per call, as the current `cpi_schedule_commit_and_undelegate`
wrapper does (`cpi/delegation.rs:107-126`, single `delegated: &AccountInfo`).
The account-meta comment in that same file (`payer(s,w), magic_context(w),
...committed(ro)`) hints the real Magic Program instruction may accept a
**list** of committed accounts in one call — **UNVERIFIED**, needs a probe
before Phase 1 commits to either "commit market once, commit each
TradingAccount as its own tx" (simple, O(n) ER txs at window-close, still
fast since ER txs are cheap) or "extend the CPI to batch them" (fewer txs,
more wrapper code). Doesn't block the design, just sizes Phase 1 work.

## 3. Frontend routing: two Connections, phase-based

Today: one hardcoded `Connection`, `NEXT_PUBLIC_SOLANA_RPC_URL ??
clusterApiUrl("devnet")` (`WalletProvider.tsx:24-25`, `onchain.ts:20`).

New: a small `getConnectionForPhase(market)` resolver, not two globally
swapped connections — **which endpoint a tx/read goes to depends on that
specific market's current delegation state**, not a static app-wide setting
(the same page has some markets delegated and some not).

| Market state | Reads (`getAccountInfo`) | Writes (sendTransaction) |
|---|---|---|
| Not a sealed market / not yet delegated | base | base |
| Delegated (Market.owner == Delegation Program on base, OR router `getDelegationStatus(market).isDelegated`) | **ER** (`router.getDelegationStatus(market).fqdn`, cached client-side, same pattern as `er_order_probe.ts`) | **ER**, for TradingAccount-scoped instructions (commit/reveal/cancel/match) |
| Undelegated again (post-commit) | base | base |

Concretely: the client caches the router's `getDelegationStatus` result per
market (short TTL, it changes exactly twice per market lifecycle — delegate,
undelegate), and `useMarket`/`useSealedOrders`-equivalent hooks pick their
`Connection` from that cache instead of always using the single app-wide one.
`buildXIx` functions don't change; only *which connection `sendTransaction`
is called against* changes.

**Failure case — user tx hits the wrong ledger**: this happens if the
client's cached delegation state is stale (e.g., undelegation just happened
and the client hasn't refreshed). Two sub-cases, both need explicit handling
in `friendlyError` (`lib/errors.ts`):
- **Sent to ER, account no longer delegated there**: the ER RPC returns
  "account not found" or a stale-clone error (needs a live probe to pin the
  exact error shape once Phase 1 exists — flagging as TODO, not guessing).
  Fix: re-fetch delegation status, retry against base once.
- **Sent to base, account still delegated (owned by Delegation Program)**:
  the base-layer tx fails because ONYX's own account-ownership check
  rejects it (e.g. `submit_sealed_order`'s implicit expectation that
  `market_ai` is ONYX-owned) — this is exactly the mechanism `touch_market.rs`
  already documents ("cannot mutate it there — which is exactly the property
  that proves the write happened on the ER"), so the error is a normal,
  already-defined program error, not a crash. Fix: same retry-against-the-
  other-endpoint-once pattern.

Both cases get one automatic retry against the other endpoint before
surfacing an error to the user — cheap, since a `getDelegationStatus` call
is cheap, and it turns "stale client cache" from a hard failure into an
invisible retry.

## 4. Program-side refactor needed (scope, not code yet)

- Generalize `delegate_market` → `delegate_account(seeds: Vec<Vec<u8>>)`:
  currently reads Market's own fixture_id/params_hash/bump from known byte
  offsets to reconstruct its signer seeds (`delegate_market.rs:60-75`); needs
  to instead take seeds as instruction args (mirroring how
  `process_undelegation.rs` already does it generically) so it works for
  `TradingAccount` too, not just `Market`.
- New account/state module: `state/trading_account.rs`.
- New instructions: `open_trading_account`, `deposit`, `delegate_trading_account`,
  `undelegate_trading_account`, `withdraw`, plus ER-native `submit`/`reveal`/`cancel`
  that operate on `TradingAccount` instead of `SealedOrder`.
- `run_batch_match` rewritten to read `TradingAccount`s and enforce the
  `revealed_count` completeness check (§1).
- `Market` grows by ≥4 bytes for `revealed_count` (1 reserved byte isn't
  enough) — needs a decision on whether to shrink something else or just
  grow `MARKET_LEN` (safe — every instruction already validates length with
  `>=`, not `==`, per `Market::from_bytes`, so growing is backwards-compatible
  with already-open plain markets).
- The existing `SealedOrder`/`Position`/`submit_sealed_order`/`reveal_order`
  base-only flow: **kept as-is, untouched, still the base-only path** for
  markets that don't opt into ER trading. This is additive, not a rip-and-replace
  — see decision point 3.

## 5. What "real-time" actually means here (the A vs B decision)

Given §0-4: matching (`run_uniform_price_match`) is a pure, cheap function
over `TradingAccount` reads, runnable on ER for the cost of one ER tx. There
is no reason to batch on a long timer anymore — **recommendation: (A) very
short batch cadence**, e.g. re-run `run_batch_match` on ER any time ≥1 new
order has revealed since the last run, gated by a minimum interval (target:
every 3-5 seconds during an active commit/reveal window) rather than a fixed
long window. Concretely wired as: a lightweight interval on the client (or a
keeper cron, same permissionless pattern `settle_market`/`claim` already
use — anyone can call it) that calls `run_batch_match` on ER on that cadence.
ER tx confirmation is the thing that was measured at "~10ms" in the existing
proven spike (BUILD_STATE.md) — the real end-to-end latency for a full
commit→reveal→match round trip on ER needs to be **measured, not assumed**,
in Phase 1/2 and reported with real timestamps, not asserted here.

**Plus (B), narrowly scoped**: a `cancel` instruction (ER-native, §1) lets a
user pull an unmatched order (still `Locked` or `Revealed`, not yet
`Matched`) at any time before the next match run — sub-second, since it's
a single ER tx on an already-delegated account.

**What this does NOT deliver, and why**: "sell a *matched* position in
real time" — i.e., a continuous secondary market / instant exit after a
batch has cleared. A parimutuel pool has no natural counterparty to sell
to mid-match; delivering that would require fabricating either a synthetic
AMM or fake resting counter-liquidity, which is exactly what this project's
core constraint forbids ("do not fake a CLOB, fake resting depth, or
fabricate price history"). So the honest claim after this work is: **placing
and cancelling a bet feels instant (ER-fast, sub-second, cancellable up to
the moment it matches), and matches clear every few seconds instead of
whenever someone happens to click "run batch match" — not "you can sell a
settled position whenever you want."** That distinction needs to be in the
product copy, not glossed over.

## 6. Decisions needed before Phase 1 starts

1. **One order per wallet per market becomes a real, on-chain-enforced rule**
   (a structural consequence of one `TradingAccount` per `(user, market)`).
   Confirm this is acceptable, or ask for the more complex multi-slot
   variant instead.
2. **Confirm the real-time definition in §5** — short-cadence batches +
   cancel-before-match, explicitly NOT instant-sell-a-matched-position.
3. **Scope: additive or replacing?** This is a new account type and five+
   new instructions living *alongside* the existing base-only sealed-order
   flow (§4's last bullet), not a replacement of it. Existing markets/tests/
   the whole current UI keep working unmodified. Confirm that's the right
   call for a devnet hackathon build, versus migrating the one existing flow
   in place (higher risk, touches everything that currently works).
4. **The undelegate-batching open question in §2** needs one more empirical
   probe (does `ScheduleCommitAndUndelegate` accept multiple committed
   accounts?) before Phase 1 can finalize the withdraw-time UX (one tx vs N).

Nothing in Phase 1-3 of the original ask gets implemented until these are
confirmed — this doc is the checkpoint.
