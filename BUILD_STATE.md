# ONYX — Shared Build State (source of truth for all agents)

> Single coordination doc. Every subagent reads this before writing code and
> appends its outputs here. Verified facts are tagged [VERIFIED]; assumptions [ASSUMPTION].

## Runtime & tooling (locked)
- **Runtime: Bun** (`bun install`, `bunx`, `bun run`, `bun test`). Commit `bun.lock`. [VERIFIED bun 1.3.14]
- **Deps: latest stable**, EXCEPT pin exact for ABI-sensitive pieces:
  - MagicBlock `ephemeral-rollups-sdk` **=0.14.3** (Rust) / `@magicblock-labs/ephemeral-rollups-sdk` **=0.14.3** (TS)
  - Anything byte-matching `txoracle.json` (mirror IDL exactly).
- Toolchain present: Solana 3.1.14, Anchor 1.0.1, Rust 1.96.1, jq 1.8.1. [VERIFIED]
- Build in place under `onyx/`. [DONE]

## TxLINE facts (verified against txodds/tx-on-chain + live docs)
- Hosts: devnet `https://txline-dev.txodds.com`, mainnet `https://txline.txodds.com`. NEVER cross-activate. [VERIFIED]
- **3-step auth** [VERIFIED, implemented in services/ingestion/src/auth.ts]:
  1. `POST /auth/guest/start` -> `{ token }` (JWT, 30d)
  2. on-chain `subscribe(serviceLevelId u16, weeks u8)` via txoracle (free tier = 0 cost; weeks multiple of 4)
  3. `POST /api/token/activate { txSig, walletSignature(base64 nacl over `${txSig}:${leagues.join(",")}:${jwt}`), leagues }` -> apiToken
  - Data calls send BOTH `Authorization: Bearer <jwt>` and `X-Api-Token: <apiToken>`.
- Endpoints [VERIFIED from reference scripts]:
  - `GET /fixtures/snapshot?competitionId=&startEpochDay=`
  - `GET /odds/snapshot/{fixtureId}` · `GET /odds/stream` (SSE)
  - `GET /scores/snapshot/{fixtureId}` · `GET /scores/stream` (SSE)
  - `GET /scores/stat-validation?fixtureId=&seq=&statKeys=`  <- settlement proof payload
- **Timestamps are MILLISECONDS.** `epochDay = floor(ts_ms / 86_400_000)`. [VERIFIED]
- Subscription mint is **Token-2022** TxL (devnet `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`). Betting escrow mint is a SEPARATE choice (USDC-classic fine). [VERIFIED]

## txoracle program (IDL v1.5.5, saved to onyx/idl/txoracle.json) [VERIFIED]
- Devnet program: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- Mainnet program: `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`
- `validate_stat` disc `[107,197,232,90,191,136,105,185]`, ONE ro account `daily_scores_merkle_roots`, returns `bool`.
  - args: `ts:i64, fixture_summary:ScoresBatchSummary, fixture_proof:Vec<ProofNode>, main_tree_proof:Vec<ProofNode>, predicate:TraderPredicate, stat_a:StatTerm, stat_b:Option<StatTerm>, op:Option<BinaryExpression>`
- `validate_stat_v2` disc `[208,215,194,214,241,71,246,178]`: `payload:StatValidationInput, strategy:NDimensionalStrategy` -> bool (n-dimensional; good for parlays).
- **Daily-roots PDA seed: `["daily_scores_roots", epochDay as u16 LE]`** (NOTE: seed string differs from the IDL account arg name `daily_scores_merkle_roots`). [VERIFIED from reference script]
- Roots posted on 5-min boundaries. Error 6007 RootNotAvailable = transient (retry), NOT a loss.
- Key types (exact):
  - `ProofNode { hash:[u8;32], is_right_sibling:bool }`
  - `ScoreStat { key:u32, value:i32, period:i32 }`  (period is its OWN field, not folded into key)
  - `ScoresBatchSummary { fixture_id:i64, update_stats:ScoresUpdateStats{update_count:i32,min_timestamp:i64,max_timestamp:i64}, events_sub_tree_root:[u8;32] }`
  - `StatTerm { stat_to_prove:ScoreStat, event_stat_root:[u8;32], stat_proof:Vec<ProofNode> }`
  - `TraderPredicate { threshold:i32, comparison: GreaterThan|LessThan|EqualTo }`
  - `BinaryExpression: Add|Subtract`
- **Comparison set is only GT/LT/EQ; BinaryExpression only Add/Subtract.** ONYX spec's GTE/LTE/PARITY ops do NOT exist upstream — drop or remap them.

## MagicBlock facts (verified via installed skill + live status API 2026-07-08) [VERIFIED]
- Devnet ER live; **devnet TEE node `devnet-tee-as.magicblock.app` live (er:true)**.
- Base RPC `https://rpc.magicblock.app/devnet`; router `https://devnet-router.magicblock.app/`; ER endpoint from router `getDelegationStatus.fqdn`.
- Program IDs: Delegation `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, Magic `Magic1111...`, MagicContext `MagicContext111...`, Permission(PER) `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`, Ephemeral SPL Token `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`.
- SDK 0.14.3: `#[ephemeral]`+`#[delegate]`+`#[commit]`; `MagicIntentBundleBuilder` for commit/undelegate (free fns deprecated). PER via `access-control` feature.

## Architecture (locked scope: MagicBlock core + Pinocchio + parlays/MEV)
- L0 Solana L1: escrow PDAs, settle via CPI validate_stat, verifiable receipt. Trust root; settlement NEVER in a rollup.
- L1 MagicBlock ER: delegate market/position at kickoff for ~10ms in-play; commit+undelegate at end.
  **[UPDATED, see "L1 MagicBlock ER — PHASE 1 SHIPPED" below]** what actually
  got built is a new `TradingAccount` type (not `Position`, which stays
  classic/parimutuel/base-only) delegated alongside the market, with a
  3s-cadence batch-match loop rather than continuous ~10ms in-play state —
  this line is the original pre-build plan, kept for history; the entry
  below is what's real.
- L2 MagicBlock PER (TEE): shielded bet side/size; MEV-proof sealed-bid batch.
  Still exactly the de-risk-spike-only status described below — unchanged.
- L3 sauce: on-chain parlays (per-leg validate_stat) + MEV-proof demo.
  Parlays not started; MEV-proof demo shipped as the classic sealed-order
  commit-reveal-batch flow, and now ALSO as the ER-fast flow (same
  commit-reveal-batch shape, executing on the rollup for speed).
- Escrow mint: devnet USDC-classic (separate from TxL Token-2022 sub mint).

## Repo layout (in place under onyx/)
```
onyx/
  idl/txoracle.json + idl/types/txoracle.ts   [DONE]
  programs/onyx/           Pinocchio program   [TODO]
  clients/ts/              generated/handwritten client [stub]
  services/
    ingestion/             TxLINE auth+scores+fixture [DONE, phase0]
    indexer/ keeper/ backend-api/ batch-coordinator/  [TODO]
  app/                     Next.js frontend    [stub]
  fixtures/                captured proofs      [written by phase0]
  vendor/tx-on-chain/      reference (gitignored)
```

## Status log
- [DONE] Phase 0 auth step-1 live-verified (276-char JWT from devnet). Ingestion typechecks clean.
- [DONE] txoracle IDL v1.5.5 + TS types vendored into idl/.
- [DONE] Fixed pinocchio-family version mismatch (Cargo.toml pinned 0.11.2 against
  0.9.x-API code); pinned pinocchio=0.9.3 + matching pinocchio-system/token/ata.
  `cargo check`: 0 errors. `cargo build-sbf`: produces target/deploy/onyx.so.
- [DONE] Full 3-step TxLINE auth verified end-to-end on devnet (not just step 1):
  fixed auth.ts using the IDL's embedded MAINNET address instead of the devnet
  TXORACLE_PROGRAM_ID, fixed a Bun fetch zstd-decoding failure on
  /api/token/activate, fixed activate() assuming a JSON body when the endpoint
  returns a bare plain-text token. Real `subscribe` tx landed on devnet:
  52QN28ZCQPagb59UUqhPek1dvDCmc4zGM5GnF73HuNkRWEFXSyLrCf37qZurJwrpznWuLgU4WHNBKtxqULrhuFW4
- [DONE] Real validate_stat proof fixture captured -> fixtures/scores-validation.sample.json
  (fixtureId 18179550, seq 1315, epochDay 20635).
- [DONE] onyx.so deployed to devnet at the canonical program id (matches
  declare_id! in lib.rs, deployed via the committed onyx-keypair.json so the
  address never drifts on rebuild):
  **ONYX_PROGRAM_ID = 4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB**
  Deploy tx: 63rUWimMTx7Kpa2nXa77QcmnfdXsbr3aqj6UE6GgH5JHhGmDZ6em1ZzHARzPVp5PExqrpcryVBhmHQTWeNRcd17W
- [DONE] Found + fixed a second real bug via the devnet integration test itself:
  entrypoint.rs declared `no_allocator!()`, which panics on ANY heap alloc.
  Invisible on open_market/join_market/etc (fixed-offset byte slicing only),
  but settle_market builds a `Vec<ProofNode>` + borsh-encodes the CPI payload,
  which allocates. Caught live: panic at pinocchio entrypoint/mod.rs:681 after
  only 327 CU (before reaching our dispatcher). Fixed -> `default_allocator!()`
  (bump allocator). Binary grew 64KB -> 75KB; redeployed at the same program id.
- [DONE] **L0 LOOP GREEN END-TO-END ON DEVNET — Phase 1 exit criterion met.**
  initialize_config -> open_market -> join_market(sideA) -> join_market(sideB)
  -> settle_market (REAL CPI into the live txoracle program, using the real
  captured proof fixture) -> claim, all executed and confirmed on devnet.
  Program: 4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB
  settle_market tx: 5a4scCzjPPgVovtpz9mEfpLBXS1XCWMA6ZGdpZAmLjQZyd9PRCAjbqosNpRywkT4MAejQu5EyTqNe2fUeSBte6s4
  On-chain logs from the REAL txoracle program (6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J):
    "Instruction: ValidateStat" / "Pass fixture-level validation" /
    "Perform single-stat predicate validation" / "Evaluate predicate to: true"
  Return data: 0x01 (true). ONYX settle_market mapped this to OUTCOME_SIDE_A,
  status -> Settled. Winner then claimed via `claim`: balance 980000000 ->
  999900000 (+19900000, i.e. stake 10.0 + winnings 10.0 - 1% fee 0.1 = 19.9,
  matching the parimutuel payout formula in claim.rs exactly).
  Test script: services/ingestion/src/l0_loop_test.ts.
  Escrow token used: a devnet test SPL mint created for this test (not real
  devnet USDC) — config.usdc_mint is a permanent singleton once set, so
  swapping to real devnet USDC before final submission requires a fresh
  program deploy + re-init (cheap; the settlement logic doesn't care which
  mint). See mint HmXznVLzmCH5DUysWQKQ9DFWCSB66eArRthZP1ft8Nai.
- [DEFERRED] refund_expired not exercised live on devnet: it requires
  `now > deadline + SETTLE_GRACE` (2h), impractical to wait out interactively.
  Logic reviewed by hand; plan to cover it with a mollusk-svm host-side unit
  test (simulated Clock) once that dep is reintroduced (see below).
- [DONE] `cargo test` fixed at the root cause, no system/root changes needed.
  It was never a Perl problem: mollusk-svm/solana-sdk were declared as
  dev-dependencies but unused by any actual test, and mollusk-svm transitively
  forces `openssl`'s `vendored` feature (agave-precompiles ->
  solana-secp256r1-program's `openssl-vendored`, for secp256r1 precompile
  simulation) — which needs a full Perl toolchain to build OpenSSL from
  source, and this box's Perl is missing FindBin/IPC::Cmd/Time::Piece.
  Removed the unused dev-dependencies entirely: `cargo test` now runs with
  zero Perl/OpenSSL involvement, no root/PERL5LIB needed. 12/12 host tests
  pass. mollusk-svm will be reintroduced only when a test actually needs it
  (the refund_expired Clock test above); at that point use
  `cpanm --local-lib="$HOME/perl5" Time::Piece` (C toolchain already present)
  rather than a system package install.
- [DONE] **L1 MagicBlock ER PROVEN END-TO-END, NATIVE PINOCCHIO (no Anchor).**
  This was the biggest remaining technical unknown (the whole
  `ephemeral-rollups-sdk` + delegation skill is Anchor/solana-program-typed;
  our program is native `no_std` pinocchio). Reconstructed the exact byte-level
  CPIs from `magicblock-delegation-program-api` v3.0.0 +
  `magicblock-magic-program-api` v0.10.1 and implemented them natively:
  - `delegate_market` (disc 3, base): buffer the market, zero + reassign it to
    the Delegation Program, CPI Delegate (disc `[0u8;8]` + borsh
    DelegateAccountArgs), close buffer. `cpi/delegation.rs` + `instructions/`.
  - `undelegate_market` (disc 4, ER): CPI the Magic Program
    `ScheduleCommitAndUndelegate` (bincode variant `[2,0,0,0]`). NOTE: the
    committed account MUST be writable — a first attempt passed it read-only and
    the magic program rejected it ("required to be writable and delegated");
    fixed.
  - `touch_market` (disc 8): minimal OPEN->LIVE mutation, used to prove ER
    execution (only mutates when the market is program-owned = on the ER).
  - `process_undelegation` (callback, disc `[196,28,41,206,48,37,51,167]`):
    re-creates the PDA from the undelegate buffer + restores committed state.
    Its exact account layout isn't in the public api crates — recovered it
    empirically from a real failed devnet finalize tx: accounts
    `[delegated(w), undelegate_buffer(w,signer), validator/payer(signer), system]`,
    data = disc + borsh(Vec<Vec<u8>> = the PDA's own seeds).
  - **[PINNED — housekeeping, 2026-07-09] Exact ground-truth bytes**, decoded
    from the raw base58 inner-instruction data of finalize attempt
    `5jzgeQhcU2p9iCpCvDhSsqA2khvTj1yyJRZUCwwN5acjM94d14htbZEPNrq7dV6qnFVxfaqpoenBe2W82AvuWYP1`
    (slot 474881922, devnet; instruction 3 = Delegation Program's own
    finalize ix `[3,0,0,0,0,0,0,0]`, whose CPI into ONYX at stackHeight 2
    failed `invalid instruction data` — this predates `process_undelegation`
    existing, and is the exact failure that revealed the interface).
    Fetched via `getTransaction` (encoding `json`) → `meta.innerInstructions`,
    the entry with `programIdIndex` = ONYX:
    - accounts (indices into the tx's account list) = `[5, 6, 0, 8]` =
      `[market(CxYGwZucBH4AtW8CZ558wcKFuuvHNB4HHKMr67hVTnVu) W,
      undelegate_buffer(GJPYcJXT1A5Y9vf3drraJJPT2quUhxPHoypxPu6JQtaz) W,
      payer/validator(MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57) — fee
      payer of the outer tx, System Program]` — confirms the 4-account
      layout exactly, in this order.
    - data (70 bytes total), hex:
      `c41c29ce302533a703000000060000006d61726b65740800000002e9a4350000000
      020000000efa9908953661792322ecdfe8d94af3b16c5e307668d67ee6c33a7004cd
      2c8bf`, parsed field-by-field:
      - `[0..8]`   = `c4 1c 29 ce 30 25 33 a7` = `EXTERNAL_UNDELEGATE_DISCRIMINATOR`
      - `[8..12]`  = `03 00 00 00` = u32 LE `3` (borsh `Vec` len — 3 seeds, matches Market's `["market", fixture_id, params_hash]`)
      - `[12..16]` = `06 00 00 00` = u32 LE `6` (len of seed 0)
      - `[16..22]` = `6d 61 72 6b 65 74` = ASCII `"market"` (seed 0)
      - `[22..26]` = `08 00 00 00` = u32 LE `8` (len of seed 1)
      - `[26..34]` = `02 e9 a4 35 00 00 00 00` = u64 LE `900000002` (seed 1 = fixture_id — confirms this tx was against throwaway fixture 900000002)
      - `[34..38]` = `20 00 00 00` = u32 LE `32` (len of seed 2)
      - `[38..70]` = `ef a9 90 89 53 66 17 92 32 2e cd fe 8d 94 af 3b 16 c5 e3 07 66 8d 67 ee 6c 33 a7 00 4c d2 c8 bf` (seed 2 = that market's `params_hash`)
      This byte-for-byte matches the implementation in `process_undelegation.rs`
      (disc check, `read_u32` seed-count/len parsing, `MAX_SEEDS=6`) with zero
      slack — nothing inferred, everything read directly off a real tx.
    - **Version pins this interface depends on** (a MagicBlock upgrade to any
      of these could silently change the callback contract):
      `ephemeral-rollups-sdk` **0.14.3**, `magicblock-delegation-program-api`
      **3.0.0**, `magicblock-magic-program-api` **0.10.1** (crates.io, not
      vendored — fetched to scratchpad for reference, not a repo dependency
      since the CPIs are hand-rolled). On-chain: Delegation Program
      `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, Magic Program
      `Magic11111111111111111111111111111111111111`, Magic Context
      `MagicContext1111111111111111111111111111111` (all devnet-verified
      live, 2026-07-08). If any devnet redeploy of the Delegation Program
      changes `EXTERNAL_UNDELEGATE_DISCRIMINATOR` or this account/data shape,
      the undelegate round-trip will fail loudly (`InvalidInstructionData`
      from our own dispatcher, or a PDA mismatch) — it cannot silently
      corrupt state, since `process_undelegation.rs` re-derives and checks
      the PDA before writing anything.
  Proven on a THROWAWAY market (fixture 900000003, never the L0 market):
    delegate tx  42NoN3evZQKvEbYeigRZfwLF3EBHSJjoZVWCH9LkANy3smmCWreyP1ANrCQ24ijxh1VemKF4URzDnB9HxD9ibhP5
    touch tx(ER) 3B3wDyNB7rVhCmHvLdXfiLVtAfQmL2PDZDueKsTTnNDauKDy738rCXVB8mim1EVro8fAEgmVYdmZoPesbHyHvHZy  (status 1->2 on the ER)
    undelegate   2g8BpiAjMUn6PW9qksd2c4Qvite1DUnAnpHCwnjcvKZowv3krdHZNHNpmPEJr1TbGDayCYQThi5EkVsaPPoPhTVi
    finalize     65xem... (err=None; my process_undelegation callback ran)
  Verified: market owner base ONYX -> Delegation Program -> back to ONYX; router
  getDelegationStatus isDelegated=true w/ fqdn devnet-as; account cloned into
  the ER owned by ONYX; and the ER-side OPEN->LIVE change PERSISTED back to L1
  (base account status byte = 2 after finalize) — i.e. state genuinely
  committed from the ER to base. Settlement was NEVER moved to the ER (L0
  settle_market untouched; the L0 program upgrade is purely additive — 12/12
  host tests still pass, existing markets still decode).
  Test harness: services/ingestion/src/er_delegate_test.ts.
  Devnet endpoints used: base rpc.magicblock? no — standard devnet RPC for
  delegate/base, router https://devnet-router.magicblock.app/, ER
  https://devnet-as.magicblock.app/ (from getDelegationStatus.fqdn).
  Note: earlier throwaway markets 900000001/900000002 are stuck delegated
  (from the pre-fix read-only undelegate attempts) — disposable, left as-is.
  **[Housekeeping confirmation, 2026-07-09]** Re-verified all three on-chain,
  fresh, via `solana account <pubkey>`: 900000001 and 900000002 (`CxYGwZuc...`)
  are still owned by `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (expected —
  pre-fix, permanently stuck, disposable). 900000003 (`9prh2ttKFPFCZ7MjoNi6L
  P73sDS4ASV6y49CB6E5Nwc5`) — the one run entirely under the fixed code (both
  the writable-account fix and the `process_undelegation` callback) — is owned
  by `4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB` (ONYX), confirming the
  round-trip is durable, not a one-time artifact of the test run. The
  writable-account fix is verified on a real fresh market and safe to rely on
  for the demo.

- [DONE] **L1 MagicBlock PER/TEE DE-RISK SPIKE — GO on access-control,
  FALLBACK on shielded matching.** Strict probe (per plan, no
  batch-coordinator built). Two concrete, real-evidence results:

  **1. TEE attestation — fully verified, real Intel DCAP chain, live devnet
  TEE node (`devnet-tee-as.magicblock.app`).** Fetched a fresh quote via
  `GET {node}/quote?challenge=<base64 64 random bytes>` (this endpoint lives
  on the ER validator node itself, not on any MagicBlock-hosted verification
  service — confirmed by reading `ephemeral-rollups-sdk`'s `ts/kit/src/
  access-control/verify.ts`). Verified with `@phala/dcap-qvl` 0.5.2
  (`getCollateralAndVerify`, PCCS `https://pccs.phala.network`): quote is a
  genuine Intel TDX quote (version 4, tee_type `0x81`), full DCAP chain
  verification against Intel's PKI succeeded, **TCB status `UpToDate`**,
  zero advisory IDs. Freshness/anti-replay binding independently confirmed
  by manually parsing the TD10 report body (`report_data` = bytes
  `[568..632]` of the raw quote) and checking it equals the exact 64-byte
  challenge sent — `true`, byte-for-byte. This is real attestation, not a
  format check: the DCAP verifier call took ~3-5s and hits Intel's actual
  certificate-chain trust path via Phala's PCCS mirror. Script:
  `scratchpad/dcap-verify/verify.mjs` (not in repo — reference only, uses
  no secrets).

  **2. PER access-control ergonomics from native Pinocchio — YES, proven.**
  New instruction `create_market_permission` (disc 14, EXPERIMENTAL,
  `instructions/create_market_permission.rs`) CPIs into MagicBlock's
  Permission Program (`ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`,
  `access_control` module of `ephemeral-rollups-sdk` 0.14.3) using the exact
  same PDA-signer pattern as `cpi_delegate`: `CreatePermission` discriminator
  = Borsh `u64` LE `0` (8 zero bytes — coincidentally identical to
  `DLP_DELEGATE_DISC` but a different target program), data = disc ||
  Borsh(`Option<Vec<Member>>`), accounts `[permissioned_account(signer via
  PDA seeds), permission(w), payer(w,signer), system_program]`. New
  `cpi/permission.rs::cpi_create_permission`. Tested on a fresh throwaway
  market (fixture 900000004, `FpUtA9ZjjExoxaj5cWW9uJioLSsByb8wC4LVmWEjQi46`
  — never the L0 or ER markets):
    create_market_permission tx `3k8fwyAGcXuvjPjaQHu9vcug6gGQCGCUA3hJyaVALmrxTB29UsH2REWbzCkwZNBNjAevhtowgDKo7KDZ2r1DGXTU`
  Read back and decoded the resulting Permission account
  (`AsvWBokB1yGAYvYWX8xfvAesiHa9fu8Hm34MQDWwaCBW`) directly via raw bytes:
  owned by the Permission Program ✓, `permissioned_account` == our market
  PDA ✓. **Empirical finding not in any doc**: the Permission Program
  auto-prepends an implicit member for the owning program itself
  (`{flags:0, pubkey: ONYX program}`) BEFORE the caller-supplied member list
  — we submitted one member (`{flags:AUTHORITY(1), pubkey: admin wallet}`)
  and the account ended up with two: `[{flags:0, ONYX}, {flags:1, admin}]`.
  This is sensible behavior (the owning program always retains access to its
  own delegated PDA) and directly answers unknown #1: **yes, our program can
  cleanly gate a PDA it owns to a fixed member list from native Pinocchio,
  with the same CPI-with-PDA-signer ergonomics already proven for plain ER.**
  `DelegatePermission` (routing the Permission account itself onto the ER,
  the second step of MagicBlock's "atomic delegate" pattern) was
  **deliberately not implemented** — out of scope for this probe (needs
  buffer/delegation-record/delegation-metadata PDAs derived under the
  Permission Program as owner, a materially bigger reconstruction task; see
  scope box below). Test harness: `services/ingestion/src/per_spike_test.ts`.

  **3. Shielded SPL/USDC (Private Payments API) — partial, real signal, NOT
  demo-ready as an ONYX-integrated flow.** `https://payments.magicblock.app`
  is a live, separate hosted REST service (not part of the SDK/on-chain
  program surface) that builds unsigned transactions for confidential SPL
  transfers; it does support `cluster=devnet` and does move real SPL tokens
  (not just non-token state). Live-probed (read-only, no funds moved):
    `GET /health` -> `{"status":"ok"}`
    `GET /v1/spl/challenge?...cluster=devnet` -> real challenge string
      (labeled `"MOCK: Login to Query Filtering Service"` in the response
      itself — devnet auth runs in a documented mock mode, not production
      auth; worth knowing before demoing this as "real" auth)
    `GET /v1/spl/is-mint-initialized?mint=<devnet USDC-equivalent>&cluster=devnet`
      -> `{"initialized": true, "validator": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57", ...}`
      — the same validator identity that appears as fee-payer/validator in
      our own ER finalize transactions (task 7), i.e. one consistent devnet
      MagicBlock validator across both surfaces.
  **Did not** execute an actual deposit/transfer (real value movement on a
  third-party-hosted service, out of scope for a read-evidence probe without
  explicit sign-off). **Critical protocol-level finding** (from reading the
  full `ephemeral-rollups-sdk` `spl/` module source): there is **no generic
  "submit encrypted data, validator decrypts it, your own program's logic
  matches it inside the enclave" primitive**. The only validator-side
  decrypt-in-TEE mechanism (`dlp_api::encryption::encrypt_ed25519_recipient`,
  ed25519-as-X25519 encryption to the validator's identity key) is baked
  specifically into MagicBlock's own `SchedulePrivateTransfer` /
  `DepositAndDelegateShuttle...WithMergeAndPrivateTransfer` instructions for
  routing token destinations — it is not exposed as a facility any
  third-party program (including ONYX) can invoke for arbitrary order data.
  Wiring real confidential USDC into ONYX's own matching engine would mean
  adopting MagicBlock's entire Ephemeral SPL Token account graph (eATA per
  user, global vault, transfer queue, Hydra crank) as the settlement asset
  model — a materially larger integration than "reuse the commit path",
  not something to start mid-hackathon on an unproven premise.

  **GO/FALLBACK VERDICT: FALLBACK.** Two yes/no unknowns:
    - PER access-control ergonomics from native Pinocchio: **YES** (proven,
      real tx + decoded on-chain account, see #2 above).
    - Shielded SPL/USDC demo-ready on devnet: **NO, not as an
      ONYX-integrated flow** — the infra exists and is live (#3 above), but
      "confidential order execution decrypted and matched inside our own
      program's logic" is not a capability MagicBlock exposes generically,
      and wiring their separate token-custody model into ONYX's matching
      engine is out of scope for the time remaining.
  Per the plan's explicit instruction ("do not fake privacy in the demo —
  same discipline as the Merkle leaf"): the demo should claim exactly what's
  proven — a MEV-proof sealed-bid batch on a **real, attested TEE-backed ER**
  (orders sealed until batch close, protected by hardware TEE process
  isolation + Permission-Program-gated reads, with a genuine, judge-
  verifiable DCAP attestation quote as the trust anchor), settlement
  transparent on L1 via the already-proven L0 loop. Scope the claim as
  **"shielded order intent, transparent settlement"** — not "confidential
  USDC" and not "in-program decryption." This is honest, still a strong
  differentiator (a live, cryptographically-verified TEE attestation is not
  something most hackathon entries will have), and requires no further
  protocol reverse-engineering to demo safely.

- [DONE] **PHASE A: Private Payments custody analysis — NO-GO** on wiring
  MagicBlock's confidential (SchedulePrivateTransfer) routing into ONYX's
  fund-custody/payout path. Read the real on-chain `ephemeral-spl-token`
  program source (pinned commit `0e41986...`), not just SDK builders:
  confidential fund routing is decrypted+executed by the Delegation
  Program's own logic once a `shuttle` account is delegated onto a
  TEE-backed ER — not by anything ONYX-verifiable, and not re-checked
  against `validate_stat`'s outcome at execution time. Breaks I-Custody
  for the confidential leg. Plain (non-confidential) deposit/withdraw is
  ordinary, publicly-verifiable program logic and does NOT have this
  problem, but delivers no privacy. No integration code written. Full
  detail: `PRIVATE_PAYMENTS_CUSTODY_ANALYSIS.md`.

- [DONE] **SEALED ORDER INTENT (Level 1, O7) — PROVEN END-TO-END ON
  DEVNET.** Commit-reveal MEV-proof batch match, native Pinocchio, zero
  MagicBlock dependency, zero confidential-USDC. Five new instructions
  continuing the disc registry (15 open_market_sealed, 16
  submit_sealed_order, 17 reveal_order, 18 run_batch_match, 19
  refund_unrevealed), one new account (`SealedOrder`, disc 4, 160 bytes),
  and a Market extension (commit_end_ts/reveal_end_ts/phase/clearing_price
  carved out of what was previously pure `_reserved` padding at offsets
  102-127 — MARKET_LEN unchanged at 128, zero risk to any market opened
  before this change). Full spec in the Impl Spec doc §5.8, §7.13-7.17,
  §12a, §15.4 — this section is the proof log.

  **Design decision**: ONYX's markets are parimutuel pools
  (`total_side_a`/`total_side_b`), not a priced order book, so
  `limit_price` is a **batch-admission threshold**, not a locked payout
  rate. Once `run_batch_match` decides `matched_size`, that volume becomes
  an ordinary `Position` — the exact same PDA and fields `join_market`
  already produces — and settles through the completely unmodified
  parimutuel formula in `claim`. This is what let `settle_market`/`claim`
  stay byte-for-byte untouched (verified: git diff shows zero changes to
  either file).

  **Matching algorithm** (`programs/onyx/src/matching.rs`) is a pure,
  host-unit-tested function, independent of any account/CPI plumbing:
  uniform clearing price = the smallest candidate price maximizing crossed
  volume (deterministic and order-independent by construction — no
  time-priority, ever); pro-rata fill on the long side; integer-division
  dust redistributed one unit at a time by ascending commitment-hash bytes
  (the spec's exact tie-break rule). 7 host tests including a worked
  numeric example and an explicit `order_independence` test (same orders,
  three different input orderings, bit-identical result — this is what
  actually proves "no order benefits from ordering," more rigorously than
  any single on-chain run could).

  **Two real bugs found and fixed by actually running it on devnet**
  (not just trusting the host build): (1) `run_batch_match` was missing
  the System Program account — the `CreateAccount` CPI for a
  freshly-matched order's `Position` needs it discoverable in the calling
  instruction's account list; failed with `MissingAccount`. (2)
  `run_batch_match` and `refund_unrevealed` both held a `TokenAccount`
  borrow (from the refund-destination ownership check) open across the
  `Transfer` CPI touching the same account, panicking with
  `AccountBorrowFailed`; fixed by scoping the check to drop the borrow
  first — the same pattern `claim.rs` already used for its vault-balance
  check, which I should have followed from the start.

  **Proven on a THROWAWAY market** (fresh fixture id each run, never the
  L0/ER markets), two throwaway bettor keypairs funded fresh from the
  admin wallet (which is the devnet test-USDC mint authority):
  worked example — A1(side A, size 100, limit 70), A2(side A, size 200,
  limit 60, same owner as A1, different nonce), B1(side B, size 90, limit
  50). Devnet result matched the hand-computed prediction exactly:
    clearing_price = 50, matched_size = [30, 60, 90], total_side_a/b = 90/90
    Position(bettorA) = {side: A, amount: 90}  <- A1+A2 correctly MERGED
    Position(bettorB) = {side: B, amount: 90}
  Also proven: an order account during Commit exposes only the commitment
  hash + collateral_locked (side/size/price fields read back as zero,
  confirmed by decoding the raw account bytes); a wrong-preimage reveal
  attempt is rejected with `Custom(6019)` CommitmentMismatch; a
  deliberately-never-revealed fourth order is fully refunded via
  `refund_unrevealed` after the reveal window closes (I-NoTrap) — its
  owner's USDC balance came back to exactly the pre-order amount.
  `run_batch_match` was called with its remaining_accounts in a
  DELIBERATELY REORDERED sequence (B1, A2, A1) vs submission order, and
  still produced the predicted result.
  Test harness: `services/ingestion/src/sealed_order_test.ts`.
  Redeployed by explicit program address each time
  (`4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB`), confirming
  `declare_id!` matches the target before every deploy — per the carry-over
  discipline (two keypair near-misses earlier this session; the fix each
  time was deploying by address rather than trusting the local
  `target/deploy/*-keypair.json`, which is NOT the canonical program
  keypair and must never be used for `--program-id`).

  **Not built** (deliberately, per the plan's scope box): Level 2 (the
  optional PER-based encrypted-envelope upgrade, §12 in the Impl Spec) —
  only start this after the Level 1 build is confirmed solid; and
  anything from MagicBlock's Private Payments/Ephemeral SPL Token
  product, permanently out of scope per the Phase A NO-GO above.

## Frontend (Next.js app/, Bun) [DONE — next build + tsc --noEmit both green]
- Stack: Next 15.5 App Router + React 19 + TypeScript, plain CSS modules (no UI lib).
  Wallet: `@solana/wallet-adapter-react` (Phantom + Solflare, **devnet**), provider in
  `src/components/WalletProvider.tsx`; RPC override via `NEXT_PUBLIC_SOLANA_RPC_URL`
  (defaults to `clusterApiUrl(Devnet)`).
- Build/verify (Bun, NOT npm/node): `bun install` · `bunx tsc --noEmit` · `bun run build`.
  Added dep `js-sha3@^0.9.3` (keccak256) + `@types/node`, `@types/react-dom`.
- **[DONE] L0 thin slice wired to LIVE devnet data — no mocks on this path.**
  New `src/lib/onchain.ts`: hand-rolled Market account decoder (mirrors
  state/market.rs's 128-byte layout byte-for-byte, no Anchor IDL since this is
  a native Pinocchio program), `listMarkets()` via `getProgramAccounts` +
  memcmp on the disc byte, `getMarket()`, and `findSettleTx()` (scans recent
  signatures for the one whose logs mention the oracle CPI). All three routes
  below are now `export const dynamic = "force-dynamic"` server components
  that read devnet on every request — runtime-verified by curling a live
  `bun run start` and confirming the real market PDA, real settle_market tx
  signature, and the real oracle log lines ("Evaluate predicate to: true")
  render correctly.
  - `/` lobby — lists real Market PDAs from devnet, grouped by fixture id.
  - `/market/[pda]` — real on-chain status/outcome/pools for that market.
  - `/receipt/[market]` — see below, substantially redesigned.
  - `/create` and `/demo/mev` are explicitly OUT of scope for this slice
    (per plan: thin slice only, no parlay/MEV screens yet) — `/create` still
    reads `src/lib/mock.ts` for its fixture dropdown, intentionally.
- **[IMPORTANT FINDING] The old leaf-serialization assumption is WRONG, and
  the full multi-stage tree topology is still unknown.** Empirically tested
  (against the real captured fixture + the real on-chain daily_scores_roots
  account) ~15 leaf-encoding variants (byte order, field order, domain
  separation, keccak256 vs sha3_256, with/without period, proof
  direction/order reversed) for `leaf -> stat_proof -> event_stat_root`, and
  4 topology hypotheses for `events_sub_tree_root/event_stat_root ->
  fixture_proof -> main_tree_proof -> daily root`. **None matched.** The
  fold *primitive* itself (keccak256, is_right_sibling-directed pairing) is
  still correct/locked — confirmed byte-identical between
  `programs/onyx/src/merkle.rs::hash_pair` and `app/src/lib/merkle.ts::hashPair`.
  What's unconfirmed is txoracle's internal leaf pre-image byte layout and
  how the 3 proof arrays (stat_proof, fixture_proof i.e. subTreeProof,
  main_tree_proof) chain together — this is proprietary to txoracle and
  isn't in the public IDL/docs. Downgraded from "[VERIFIED]" to an open
  item; carries forward the existing O2 open item in `00 - README.md`.
  Real unblock for this: ask in the TxODDS Discord for the leaf/tree
  construction, or capture several more fixture samples and brute-force at
  scale (not attempted here — time-boxed).
  **Product impact:** the receipt page no longer claims a full independent
  Merkle re-derivation as the trust source. It shows two things instead: (1)
  the AUTHORITATIVE verdict, sourced from the Market account's own
  `status`/`outcome` fields plus the real txoracle program's own log lines
  from the settle transaction (fetched live, not hardcoded) — this is fully
  trustless already, since anyone can pull both facts from a public RPC
  without trusting ONYX's UI; and (2) a clearly-labeled "local re-derivation
  attempt (experimental)" section that performs the one-hop
  leaf->stat_proof->event_stat_root fold and honestly reports match/no-match
  without implying the settlement itself is in question either way.
- `src/lib/merkle.ts` (fold primitive — **locked/correct**) + leaf
  serialization (**open**, see above):
  - `ProofNode { hash: number[32], isRightSibling: boolean }` (mirrors IDL `proofNode`)
  - Pair hash: `hashPair(l,r) = keccak256( concat(l, r) )` over two 32-byte hashes
    (raw 64-byte concat, no domain-separation byte) — confirmed identical to
    on-chain `merkle.rs::hash_pair`.
  - Fold rule (exact, confirmed correct):
    ```
    verifyMerkleProof(leaf, proofPath, root):
      acc = leaf
      for node in proofPath:
        acc = node.isRightSibling
            ? keccak256(concat(acc, node.hash))   // sibling on the RIGHT
            : keccak256(concat(node.hash, acc))   // sibling on the LEFT
      return toHex(acc) === toHex(root)
    ```
  - Leaf binding: `leafFromScoreStat({key:u32, value:i32, period:i32})` =
    `keccak256( key(u32 LE) ‖ value(i32 LE) ‖ period(i32 LE) )` (12-byte buffer).
    ⚠ CONFIRMED WRONG (or incomplete) against the real oracle — see finding
    above. Kept as the best-effort guess for the experimental section only.
  - Predicate eval: GT/LT/EQ via `evaluatePredicate(value, {threshold, comparison})`.
- Shared FE types in `src/lib/types.ts` (ProofNode, ScoreStat, TraderPredicate,
  FixtureSnapshot, MarketSummary, ReceiptInput) — `FIXTURES`/`STAT_KEYS` from
  `mock.ts` still back `/create`'s dropdown (no on-chain source for fixture
  metadata exists); everything else in `mock.ts` is dead/unused. Real
  captured proof bundled at `src/lib/fixtures/scores-validation.sample.json`
  for the receipt page AND for real `settle_market` calls from the UI.

- [DONE] **/create + the full sealed-order demo journey are wired to real
  wallet-signed transactions — the last mock in the frontend is gone.**
  Every write path (create market, place bet, reveal, run match, settle,
  claim) now builds and submits a real instruction through a connected
  wallet; nothing in the app fakes a transaction anymore.
  - `src/lib/instructions.ts` (new): single source of truth for every
    instruction's byte encoding — the SAME functions are called by the
    wallet-signed UI and by a plain-keypair verification script, so the UI
    can't silently drift from what's actually been proven on-chain.
  - `/create`: real `open_market_sealed` tx. Defaults to fixtureId
    `18179550` (the one with a bundled real captured oracle proof), so a
    market created here can be genuinely settled live, not just browsed;
    other fixtures are explicitly labeled browsing-only.
  - `SealedOrderPanel` (market detail page, new client component): the
    full Commit → Reveal → Matched lifecycle as live UI. Persists the
    user's own order secret (nonce/side/size/price) to `localStorage`,
    since — by design — it's unrecoverable from on-chain state until
    revealed.
  - **Liquidity**: `src/app/api/house-counter/route.ts` (new, server-only
    Next.js route, never bundled to the client) submits a deterministically
    opposite-side/opposite-priced sealed order from the admin wallet
    (already the test-USDC mint authority) so a solo demo user still gets
    a fill. Fully stateless: house parameters are a pure function of
    `(userSide, userSize)`, recomputed identically on the submit and
    reveal calls — no server-side session state needed.
  - `SettleClaimPanel` (new): real `settle_market` (CPI into the real
    `validate_stat`) + `claim` buttons, gated to fixtures with a bundled
    proof.
  - **Verified for real, not just typechecked**: `app/scripts/verify-flow.ts`
    drives the exact shared instruction builders end-to-end against a live
    `bun run dev` server, including a genuine HTTP call into
    `/api/house-counter` (not mocked). One run: `open_market_sealed` →
    `submit_sealed_order` → live house-counter seed → `reveal_order` (both
    sides) → `run_batch_match`, landing on `phase=Matched` with
    `clearing_price=100000` — exactly what the matching algorithm predicts
    from the two orders' limit prices (user 500000 side A, house 100000
    side B → both candidates tie at full-volume match → smallest price
    wins → 100000). `next build` and `bunx tsc --noEmit` both clean.
  - **Known gap, stated plainly**: this environment cannot click through
    an actual browser wallet extension (Phantom/Solflare) — that needs a
    human with one installed. Everything up to that final click (byte
    encoding, PDA derivation, account plumbing, the live API route, the
    full on-chain lifecycle) is now proven for real; only the literal
    "click Approve in the wallet popup" step is unverified by me.

- [DONE] **L1 MagicBlock ER — PHASE 1 SHIPPED (this log stopped updating
  before this work; the README briefly and incorrectly said it was "held
  back from the submission" until that was caught and corrected — it is
  shipped and is the default trading flow).** Reverses the earlier
  "bank the ER design doc as roadmap" call per explicit direction.
  New account type `state/trading_account.rs` (176 bytes, one per
  user-per-market, seeds `["trading", market, owner]`) + 9 new instructions
  (disc 20-28): `open_trading_account`/`deposit_trading` (base, the one real
  SPL transfer in), `delegate_trading_account` (base),
  `submit_order_fast`/`reveal_order_fast`/`cancel_order_fast`/
  `run_batch_match_fast` (ER-only), `undelegate_trading_account` (ER,
  generic — accepts any set of this program's delegated accounts in ONE
  call, proven with market + 2 TradingAccounts together), `withdraw_trading`
  (base, parimutuel payout reusing claim.rs's exact formula against the SAME
  `Market.total_side_a/b` pools `run_batch_match_fast` writes into — ER-fast
  and classic matched volume share one combined pool by design). `Market`
  gained a `revealed_count` byte, repurposed from an already-zeroed reserved
  byte (not grown), so existing 128-byte market accounts keep passing every
  length check. `SealedOrder`/`Position`/classic instructions untouched —
  25/25 existing host tests still pass. Deployed as a program upgrade.
  - Proven server-side end-to-end twice
    (`services/ingestion/src/er_trading_lifecycle_proof.ts`): deposit →
    delegate → ER submit/reveal/match → undelegate → settle → withdraw, ER
    steps confirmed Finalized on the ER endpoint AND "not found" on base.
    First run surfaced a real bug (`TradingAccount::set_matched_size` never
    flipped status to `Matched`, so withdraw's winnings branch silently
    never fired) — fixed, redeployed, re-run clean.
  - Batch-inclusion completeness check (the most safety-critical piece)
    live-verified with a two-variant attack test
    (`er_omission_attack_test.ts`): wrong-count omission rejected
    (`Custom(6023)`/TooManyOrders), duplicate-account padding rejected
    (`Custom(6018)`/WrongPhase on the second occurrence's status re-check —
    a duplicated writable account aliases the same memory, so its status
    already flipped to `Matched` by the time the second occurrence is
    processed), legitimate complete set succeeds.
  - `cancel_order_fast` live-verified (`er_cancel_test.ts`): commit, cancel,
    collateral restored, slot reusable for a fresh commit same window.
  - **Bug found and fixed later, before UI work started** (caught by
    re-reading the code, not by a failing test): `run_batch_match_fast` set
    `matched_size` but never released `locked - matched` back to
    `available` on a partial fill — collateral above the matched amount was
    permanently stranded (status flips to `Matched`, which `cancel_order_fast`
    no longer accepts once matched). Fixed; proven with a deliberately
    unequal match (`er_partial_fill_test.ts`: 2,000,000 locked, 1,000,000
    matched, the other 1,000,000 correctly released and genuinely withdrawn).

- [DONE] **ER-fast frontend — full browser UI, wired as the DEFAULT trading
  flow (not opt-in, not a side demo).** `ErTradingPanel` (new,
  `app/src/components/market/ErTradingPanel.tsx`) drives the whole
  lifecycle from a real connected wallet: enable-market (`delegate_market`)
  → deposit & enable (`open_trading_account`+`deposit_trading`+
  `delegate_trading_account` combined into ONE signature) → bet →
  resize/cancel (works even post-undelegate, as a safety net) → reveal →
  batch-match countdown (3s cadence, live revealed-order count) →
  undelegate (market + every `TradingAccount` in one call) → withdraw.
  Classic `SealedOrderPanel` kept fully intact, demoted to a collapsed
  disclosure — additive, not a replacement.
  - New `app/src/lib/erRouting.ts`: `getDelegationStatus`/`resolveConnection`
    against the MagicBlock router (`https://devnet-router.magicblock.app/`,
    `getDelegationStatus` method), 3s TTL cache (backs both live polling and
    the just-before-send check on every ER-bound tx). `useRoutedMarket`
    (`app/src/lib/hooks.ts`) makes every child panel (PricePanel,
    PhaseTimeline, SettleClaimPanel) read whichever ledger currently holds
    the market's state instead of a frozen base snapshot.
  - `app/src/app/api/house-counter-fast/` mirrors the existing
    house-counter demo-liquidity pattern for the new account type.
  - `app/src/lib/errors.ts::classifyWrongLedger` detects the wrong-ledger
    failure class specific to phase-based routing and returns a plain
    retry message instead of a raw RPC error — see its own doc comment for
    the exact error-string patterns this matches, all observed live (most
    recently `InvalidWritableAccount`, found and fixed during a later
    self-audit pass below).
  - Two real program bugs found only by driving this through an actual
    browser with a real signing wallet, both fixed and redeployed:
    `open_trading_account` required `market_ai` to be ONYX-owned, which is
    never true once the market has been delegated — exactly the intended
    flow (market delegates first, then traders join) — check removed
    outright, wasn't protecting anything load-bearing; and the
    `run_batch_match_fast` partial-fill bug above (found independently
    twice, once by code review before this UI existed, once again live
    here — both fixes are the same underlying change).
  - Two real frontend bugs the same live testing surfaced: `sendVia` was
    using wallet-adapter's `sendTransaction()` convenience wrapper, which
    delegates broadcast to the wallet's own `signAndSendTransaction` — real
    Phantom submits that through ITS OWN internal RPC, decoupled from
    whatever `connection` is passed in, which would silently defeat ER
    routing for ER-bound instructions; switched to explicit
    `signTransaction` + `connection.sendRawTransaction`. And `sendVia`
    never checked `confirmTransaction`'s `.value.err` — a program-level
    failure doesn't throw there, so a failed tx was logging a "successful"
    signature with no error shown, which is how the `open_trading_account`
    bug above went unnoticed until direct on-chain inspection.
  - Full lifecycle proven end-to-end through the actual website with a real
    signing wallet (Playwright-injected provider backed by a real devnet
    Keypair, signing genuine transactions the real `ErTradingPanel`/
    `instructions.ts` code builds via actual button clicks —
    `app/scripts/er_browser_proof.ts`, see its header comment for the exact
    honesty framing). Every ER-bound step independently confirmed Finalized
    on the ER endpoint and absent from base; every base-bound step
    confirmed Finalized on base.

- [DONE] **Self-audit pass on the above** (triggered by re-reading the
  Phase 1 work rather than trusting the "Done" report; this project's
  pattern all along has been that a second, skeptical pass finds real
  gaps). Found and fixed three real issues purely through re-testing, not
  user reports:
  - `PricePanel`'s "Locked (pending match)" stat only ever summed the
    classic `SealedOrder` flow's collateral — blind to the new default
    ER-fast `TradingAccount` flow, silently under-reporting on any market
    using it. Fixed (sums both); live-verified against a real delegated
    market with real locked ER-fast collateral.
  - `classifyWrongLedger` only matched two of (at least) three real
    wrong-ledger error shapes. Found the third by actually forcing the race
    live: placed a real bet, froze a browser tab's belief that the market
    was still ER-delegated (Playwright-intercepted the router response),
    undelegated for real out-of-band, then clicked Cancel in the stale tab.
    It rendered a raw `Transaction <sig> failed: "InvalidWritableAccount"`
    string that overflowed the error box instead of the friendly message.
    Fixed the missing pattern AND added `overflow-wrap` as a safety net for
    any future unclassified error. Re-ran the same live race after the fix
    and confirmed the friendly message now renders
    (`app/scripts/er_browser_error_paths.ts`).
  - Once a market is ER-delegated, base's copy freezes at its last known
    state rather than disappearing (confirmed live: still readable, stale
    phase/fields) — the classic sealed-order flow reads that frozen
    snapshot with no staleness check, so a market mid-ER-lifecycle can show
    "phase: Commit" in the classic panel while the real (routed) state has
    already moved to Match/Settled (confirmed in a live screenshot). Added
    an inline warning in the classic disclosure when the market is
    currently delegated, rather than touching `SealedOrderPanel`'s
    deliberately-unchanged internals.
  - Portfolio page (`app/src/app/portfolio/page.tsx`) had the exact same
    blind spot as PricePanel: zero awareness of `TradingAccount` positions,
    so a wallet's ER-fast bets/matches/withdrawable balances were invisible
    on the one page meant to show "what do I hold." Fixing this needed more
    than copying the PricePanel pattern: TradingAccount is delegatable, so
    a naive base-only `getProgramAccounts` scan (the pattern
    `listPositionsByOwner`/`listSealedOrdersByOwner` correctly use, since
    Position/SealedOrder never delegate) would silently miss every
    currently-delegated account, since its base copy is owned by the
    Delegation Program at that point. `listTradingAccountsByOwner`
    (`app/src/lib/positions.ts`) instead resolves each known market's
    current ledger via the router and does one targeted read there —
    O(markets) round trips, correct at hackathon scale; a real cross-ledger
    index (the still-pending off-chain-services item) is the honest
    long-term answer if the market count ever gets large.
  - Also corrected `README.md` and this file: an earlier README draft
    claimed ER work was "held back from the submission... kept as roadmap"
    — true of the pre-Phase-1 de-risk spike, false once Phase 1 shipped,
    left uncorrected until this audit caught it. The TEE/PER claim in that
    same paragraph was NOT touched, since it's still accurate — that track
    genuinely remains a de-risk spike, unlike ER.

- [DONE] **mollusk-svm SBF test coverage for the two highest-risk untested
  ER-fast instructions (25 -> 44 host tests).** None of the 9 new ER-fast
  instructions had dedicated unit tests before this — proven only by live
  devnet scripts. Rather than mechanically pad coverage onto all 9
  (inconsistent with this codebase's own established pattern: unit tests are
  reserved for `refund_expired`-tier custody-critical/logic-dense code, not
  every account-mutating instruction — `submit_sealed_order`/`reveal_order`/
  `run_batch_match` etc. have none either), applied the same bar `refund_expired`
  was held to and picked the two ER-fast instructions that actually meet it:
  - `withdraw_trading.rs` (10 tests): the other real-money-out instruction
    (real-money-in is `deposit_trading`, lower-risk — a plain transfer with
    no branching payout math). Covers both payout legs independently and
    combined, the double-payout guard on the winnings leg, the losing-side
    case, and all the reject paths (wrong owner/market, still-delegated,
    vault-underfunded, nothing-to-withdraw, double-withdraw-after-claimed).
    One test — winnings math — deliberately reuses the exact numbers from
    the classic flow's README-documented claim example (1,000,000 stake,
    matching pools, 1% fee -> 1,990,000) as a byte-for-byte cross-check that
    withdraw_trading really does reuse claim.rs's formula, not just something
    close to it.
  - `run_batch_match_fast.rs` (9 tests): the batch-inclusion completeness
    check (previously live-tested only via `er_omission_attack_test.ts`) and
    the partial-fill unmatched-locked-release fix (the real bug this exact
    file caught by inspection earlier this session), now covered in
    isolation. The duplicate-account-padding test is the one worth noting:
    it required confirming mollusk-svm actually aliases two same-pubkey
    account-meta entries to the same underlying account memory the way real
    Solana transaction processing does — it does, confirmed live by the test
    passing for the RIGHT reason (second occurrence's pre-write status
    re-check sees `Matched`, written by the first occurrence), not by luck.
  Both test files caught a real authoring mistake in the process (a
  withdraw_trading "wrong owner" test that accidentally passed a matching
  owner on its first assertion) — fixed before either suite was trusted.

- [FOUND, NOT FIXED] **Live-verifying the classic-vs-fast phase-collision
  hypothesis (both `run_batch_match`/`run_batch_match_fast` share the same
  `if market.phase() == PHASE_MATCHED { WrongPhase }` guard, so whichever
  flow matches first permanently blocks the other) surfaced a different,
  more immediate bug first, before that scenario could even be reached.**
  Real devnet repro: committed a classic sealed order, then delegated the
  market for fast trading (both ordinary, permissionless actions, no
  particular sequence required), then attempted the classic `reveal_order`.
  It failed with a raw runtime-level `ExternalAccountDataModified` — NOT a
  program-level `OnyxError` — because `reveal_order.rs`'s "lazy phase
  transition" (`if market.phase() == PHASE_COMMIT { market.set_phase(PHASE_REVEAL) }`,
  a genuine WRITE to the market account, on the first reveal call after
  commit close) hits a market whose base-layer copy is now owned by the
  Delegation Program, not ONYX — the SVM runtime itself rejects the write
  before the program's own logic ever runs. **This means: once ANY market
  gets delegated for fast trading, the classic flow's reveal_order is
  broken for whichever wallet is first to reveal after commit close** — a
  raw, confusing error, not a friendly one (`friendlyError`/
  `classifyWrongLedger` don't have a pattern for
  `ExternalAccountDataModified` yet).
  **The good news, also confirmed live, not assumed:** since the order
  never actually got marked revealed (the failed tx fully reverts — no
  partial state), it stays genuinely `status=Locked`, `revealed()=false` —
  exactly what `refund_unrevealed` requires, and unlike `reveal_order`,
  `refund_unrevealed` never writes to the market account (verified by
  reading it fully), so it does NOT hit the same runtime rejection. Ran it
  against the stuck order for real: succeeded, full collateral back. The
  UI's existing Reclaim button (`SealedOrderPanel.tsx`, gated on
  `nowSec >= revealEnd`, wired since the P0/P1 pass) already covers this —
  confirmed, not assumed.
  **What this means the original hypothesis leaves unresolved:** this repro
  never reached "classic order successfully revealed, then stuck by the
  fast flow matching first" — reveal itself failed first. To actually test
  that scenario needs revealing the classic order BEFORE delegating the
  market (so the lazy phase-transition write lands while the market is
  still ONYX-owned), then delegating and letting fast trading match after.
  Not yet done. Whether a genuinely-revealed, genuinely-stuck order (no
  `refund_unrevealed` recourse, since that instruction explicitly rejects
  already-revealed orders) is actually reachable remains **code-verified,
  not live-reproduced**.
  Not fixed yet, on purpose — this is fund-custody-adjacent program logic
  (`reveal_order.rs`) and any fix deserves the same mollusk-svm test rigor
  as withdraw_trading/run_batch_match_fast above before shipping, not a
  rushed patch. The classic-flow disclosure's UI warning
  (`MarketDetail.tsx`) was updated to mention this specific failure mode and
  reassure that funds aren't stuck in this exact case, pending a real fix.

- [RESOLVED] **The original phase-collision hypothesis (a genuinely-revealed
  classic order permanently stranded because the fast flow wins the match
  race) is DISPROVEN — structurally unreachable, not just unreproduced.**
  Two more decisive live repros, plus a full live-funds audit, settle this:
  - **Structural reason, confirmed empirically**: `Market.phase` is a SINGLE
    field shared by both flows, and each flow's submit/reveal instructions
    gate on it strictly (`submit_order_fast` requires `phase==Commit`
    exactly; `reveal_order` requires `phase==Commit || phase==Reveal`
    exactly). If a classic order successfully reveals, that lazily flips
    `phase` Commit->Reveal — which permanently blocks ALL further
    `submit_order_fast` calls on that market (confirmed live: real
    `Custom(6018)`/WrongPhase rejections on both fast-side submit attempts,
    immediately after a classic reveal had already landed). So by the time
    the fast flow could possibly reach a completed match, no classic order
    on that market could have been revealed — the two preconditions
    ("classic order revealed" and "fast flow completes a match") cannot
    co-occur on the same market, by construction.
  - **The temporary-block tail case, also confirmed empirically, not just
    reasoned through**: if a classic order reveals successfully (only
    possible pre-delegation) and someone THEN delegates the market anyway
    (blocking classic `run_batch_match` at the runtime level the same way
    `reveal_order` was blocked earlier), the block is temporary, not
    permanent — undelegating (a normal, permissionless, always-eventually-
    available step) restores base ownership and the market's true phase,
    and classic `run_batch_match` then works exactly as designed. Proven by
    literally doing this THREE separate times against three different real
    revealed classic orders sitting on devnet (one from a controlled repro,
    two recovered from this session's own accumulated test debris): each
    time, undelegate -> `run_batch_match` succeeded and the order's full
    collateral landed back in the owner's ATA via that same instruction's
    own internal refund transfer (no counterparty in any of the three, so
    `matched_size=0`, `refund=collateral_locked` in full).
  - **Reachability of the (harmless) temporary block, precisely**: real,
    via ordinary UI actions, no scripting — `ErTradingPanel`'s
    `notYetDelegated` gate has zero awareness of a market's existing
    classic `SealedOrder`s (grep-confirmed), the classic flow is presented
    as "always available" (collapsed but fully functional, not
    deprecated), and `/markets` lists every market for anyone to click
    into and try either flow on. Most likely trigger in practice: a judge
    or QA pass deliberately trying both documented flows on the same
    market (exactly what the README invites), not the default single-flow
    happy path a typical bettor would take.
  - **Live-funds audit (the explicit "are funds stuck right now" check)**:
    scanned every SealedOrder this program has ever created on devnet (36
    total, `getProgramAccounts` + manual byte-layout decode, offsets
    cross-checked against `onchain.ts`'s own `decodeSealedOrder`). Zero are
    permanently stuck. 8 are revealed-and-unresolved leftovers from earlier
    testing this session, all on markets that are NOT currently delegated,
    all immediately rescuable by anyone calling classic `run_batch_match`
    (permissionless). One additional order WAS found sitting on a
    currently-delegated market (an abandoned artifact of an earlier repro
    in this same investigation, interrupted by a transient devnet airdrop
    faucet failure) — cleaned it up live as part of this audit: undelegated
    the market, ran classic `run_batch_match`, watched the bettor's full
    1,000,000 base units land back in their ATA for real. Not left as
    stray state.
  - **A separate, smaller gap found in the process, NOT yet fixed**: the
    classic flow's "Reveal" and "Run batch match" buttons
    (`SealedOrderPanel.tsx`) both surface the raw
    `ExternalAccountDataModified` runtime string if clicked while their
    market happens to be delegated — `SealedOrderPanel.tsx` only calls
    `friendlyError` (never `classifyWrongLedger`), and neither has a
    pattern for this exact string yet (only `ErTradingPanel`'s wrong-ledger
    cases are covered). This is a UX-polish gap only — the underlying state
    is always recoverable, per the above — same size/category as the
    `InvalidWritableAccount` gap already found and fixed earlier this
    session in `errors.ts`, just a different string, in a different panel.
    Not fixed yet — flagged for a decision on priority rather than
    unilaterally patched, consistent with "report before fixing."

- [DONE] **Core-functionality gap review, then fixed the two items that
  didn't require reversing a locked decision or a multi-day redesign.**
  Asked to look past submission logistics/testing at the actual product:
  found (1) settlement genuinely only worked for the one bundled demo
  fixture — no live proof-fetch pipeline existed, just a static captured
  JSON; (2) `/create` exposed 6 of the on-chain program's stat options and
  no path to combined two-stat markets, even though the program and
  `describeMarketPredicate` already supported both. Both fixed; three other
  identified gaps (one-shot markets vs rolling continuous matching, no real
  liquidity beyond seeded demo, early-exit/multi-order reversing explicit
  locked decisions, binary-only outcomes) were deliberately NOT touched —
  flagged back for a scope decision rather than silently attempted, since
  they're either large redesigns incompatible with the remaining runway or
  direct reversals of this session's own earlier locked calls.

  - **`/create` now exposes red cards + combined ADD/SUBTRACT two-stat
    markets** (`statKeys.ts::pairedStatKey` finds the same-label/same-period
    counterpart generically, not hardcoded pairs). Disabled for the demo
    fixture specifically, since its bundled proof only covers one stat.
    Verified two ways: UI screenshot, then a real browser-driven submission
    with on-chain bytes confirmed (`statA=5, statB=6, op=ADD`).

  - **General live settlement pipeline** (`txlineSettlementProof.ts` +
    `/api/settlement-proof/[market]`, same server-only credential-isolation
    pattern as `/api/scores`/`/api/odds`): given ANY market, reads its real
    on-chain fixtureId/statAKey/statBKey, finds the right TxLINE `seq` via
    the same binary-search pattern the live score ticker already uses (keyed
    on the market's REAL stat keys, not hardcoded to "1"), fetches the full
    proof, and shapes it for `buildSettleMarketIx`. Verified against
    multiple real, distinct sandbox fixtures beyond the one bundled demo
    fixture (18179549, 18179551 confirmed to have real, genuinely
    progressing — not frozen — data, live-probed before committing to the
    build).
    - **Real bug found via this work, unrelated to the new pipeline itself**:
      `buildSettleMarketIx` had two hardcoded `w.option(null, ...)` writes,
      always encoding `stat_b`/`op` as `None` in the CPI regardless of a
      market's real terms — meaning combined two-stat markets (the ones
      `/create` can now make) were structurally unsettleable even though
      `txoracle`'s own `validate_stat` fully supports `stat_b: Option<StatTerm>`/
      `op: Option<BinaryExpression>` at the program level. Fixed by
      conditionally encoding both from a second `statsToProve`/`statProofs`
      entry. Confirmed no regression to the already-proven single-stat path
      first (fresh demo-fixture market, settled via the refactored function,
      byte-for-byte same encoding for the no-`stat_b` case) before relying on
      it for anything new.
    - **Second real bug found by testing against a genuinely different
      fixture rather than trusting the demo fixture's shape**: `targetTsMs`
      (the CPI's top-level `ts` arg, used by txoracle for PDA/seed
      generation) was being read from the response's top-level `ts` field
      (== `maxTimestamp`) — this happened to work for the bundled demo
      capture only because it has `updateCount:1` with
      `minTimestamp===maxTimestamp===ts`, coincidentally satisfying whatever
      the real requirement is. A live fixture with `updateCount:2` (batched
      updates, `minTimestamp !== maxTimestamp`) exposed it for real: settling
      failed with `txoracle`'s own `Custom(6010)`/`TimestampMismatch`
      ("timestamp provided for seed generation does not match the timestamp
      in the snapshot payload"). Root-caused empirically (not guessed) by
      diffing every timestamp field between the working bundled capture and
      the failing live fetch, forming the hypothesis that `targetTsMs` must
      equal `summary.updateStats.minTimestamp` specifically, and confirming
      it by retrying the SAME failed market with only that one field
      changed — settled successfully. Fixed at the source
      (`txlineSettlementProof.ts`) rather than patched around.
    - Verified end-to-end, three real cases, each with its own fresh market
      and a real on-chain outcome check: a non-demo fixture settling true, a
      combined two-stat market settling true (3+2=5>4), and a non-demo
      fixture settling false (1>100) — confirming the pipeline evaluates
      correctly in both directions, not just "always resolves true."

- [DONE] **AMM pivot Phase 0: design doc + feasibility call + live probe —
  NO AMM code written** (per explicit direction: design + honest
  feasibility before any feature code, sealed-batch preserved as the
  guaranteed fallback). Direction locked by the owner 2026-07-10:
  Polymarket-style sell-anytime via an outcome-token AMM (curve as
  counterparty), explicitly NOT an order book, additive as a new market
  type. Full design in `docs/AMM_TRADING_DESIGN.md`. The load-bearing
  outputs:
  - **The one genuinely untested ER assumption was probed live and
    PASSED** (`app/scripts/probe_amm_concurrency.ts`, existing deployed
    instructions only): concurrent multi-wallet read-modify-write to ONE
    shared delegated account — the exact write shape of an AMM swap
    against pool reserves. 4 fresh wallets fired truly concurrent
    (`Promise.all`) reveal_order_fast txs (each increments the shared
    `Market.revealed_count`), then concurrent cancels (each decrements):
    8/8 landed, counter read exactly 4 then exactly 0 — zero lost
    updates — at 0.77–1.1s per write. Market
    `E9QbBguPi7b1msHojb4LBSiCUCYo89pwNXsBT3ZxSKcN`, sigs in the probe
    output/design doc.
  - Every other ER-hostile requirement maps onto primitives already
    proven this build (pure-data swaps, read-only fee payer, join-while-
    delegated, generic undelegate-many, base payouts, untouched oracle
    settlement) — cited, not re-probed. Compute headroom bounded
    analytically from this session's measured CU (1.6k–7.7k for heavier
    logic vs 200k budget); Phase A will assert swap CU < 50k anyway.
  - Design decisions: CPMM/FPMM over LMSR (integer-exact + one u128
    isqrt vs error-prone fixed-point ln/exp; what Gnosis/Polymarket
    actually shipped); VIRTUAL outcome-token balances rather than real
    SPL mints in v1 (SPL CPIs are exactly the operation class the ER
    rejects — the original Phase-0 finding; real mints = roadmap);
    complete-set accounting with an exact solvency identity
    (vault == Σ usdc_available + sets_outstanding + fees, rounding always
    credited to fees) to be asserted in tests and reconciled to the
    lamport in the devnet proof; single disclosed seed-once LP in v1 (LP
    can genuinely lose — disclosed, same "no bluff" treatment as the
    house-counter); AMM pools attach ONLY to phase==PHASE_NONE plain
    markets (zero interaction with the sealed state machine; Market
    layout untouched — all AMM state in a new pool PDA).
  - Feasibility verdict: GO, additive, ~7 instructions + 2 account types
    (discs 29–36, account discs 6–7), phased A–E with per-phase on-chain
    proof and two abort gates (end day 2: math not green in mollusk →
    abort; end day 4: ER swaps failing → base-only AMM or fallback).
    Risk ranking after the probe: (1) UI days, (2) integer-math edge
    cases (offline-testable), (3) devnet flakiness — NOT ER capability.
    Honest trade acknowledged: sealed-batch MEV-resistance does not apply
    to AMM markets; disclosed in-product rather than glossed.

## 2026-07-11 — AMM Phase A COMPLETE: math + accounts + 8 instructions + property suite — GATE 1 GREEN

- **Gate 1 result: `cargo test --release` → 92 passed / 0 failed** (44
  pre-existing sealed-flow/core tests re-run unchanged alongside, per the
  every-gate regression discipline, + 48 new AMM tests). Swap CU measured
  on real SBF via mollusk: **993 CU buy / 1,994 CU sell** (sell includes
  the u128 isqrt) vs the 50k budget assertion — ~25–50× headroom.
- **`fpmm.rs`** (pure CPMM math, host-testable like matching.rs): calc_buy
  (mint-then-swap vs the ORIGINAL pre-mint product, ceil against the
  trader), calc_sell (quadratic smaller root, m = (s − isqrt(s²−4bΔ))/2,
  floored), calc_fee, isqrt_u128 (Newton + explicit correction). 16 unit
  tests incl. no-free-lunch round-trip properties and a u128::MAX isqrt
  boundary — which caught TWO real overflow bugs in the correction loops
  (raw x*x near 2^64 panics; fixed with checked_mul treating overflow as
  "> n by definition").
- **Accounts**: AmmPool (disc 6, 176 B, `["amm", market]`), AmmPosition
  (disc 7, 144 B, `["ammpos", market, owner]`). Market layout untouched.
- **8 instructions wired** (discs 29–36): create_amm_pool (PHASE_NONE-only
  gate, real SPL seed into the existing market vault), open_amm_position /
  deposit_amm (mirrors of the proven TradingAccount pair, incl. the
  no-market-ownership-check lesson), delegate_amm_pool /
  delegate_amm_position (near-dups of delegate_trading_account's
  read-seeds-from-own-layout pattern), **swap_amm** (ER class: pure data
  mutation, owner read-only; output computed ENTIRELY on-chain from
  reserves read at execution time — client sends only amount_in/min_out,
  the property that makes concurrent-swap safety follow from SVM
  writable-account serialization; min_out enforced on-chain with the
  specific SlippageExceeded error), redeem_amm (two-leg like
  withdraw_trading: usdc_available anytime = I-NoTrap; winning tokens 1:1
  post-settlement; AlreadyRedeemed vs NothingToRefund distinguished),
  withdraw_lp_amm (reserve_winning + fees to lp_owner, settled-only —
  losing-side reserve correctly NOT the LP's).
- **Property suite beyond per-instruction units**
  (`amm_lifecycle_tests.rs`, real dispatch path end-to-end): two full
  create→open→deposit→adversarially-interleaved buys+sells (both users,
  both sides, both directions, different orderings AND different winning
  outcomes and fee tiers per scenario)→settle→redeem×2→withdraw_lp runs.
  The §1 solvency identity (Σusdc_available + sets_outstanding + fees ==
  total deposited; Σtokens_X + reserve_X == sets_outstanding on BOTH
  sides) asserted after EVERY step, vault asserted untouched by every
  swap, and — the post-settlement tightening — **vault drains to EXACTLY
  zero** after the final withdraw in both scenarios, plus a repeat-redeem
  is rejected with the specific AlreadyRedeemed. One test-harness bug
  found+fixed en route: the world map was masking mollusk's executable
  program stubs with defaulted accounts → UnsupportedProgramId (harness,
  not program).
- Fallback-readiness (tightening #4) re-confirmed from last night's
  fresh full 11-step browser proof: settle
  `4ACVHMayu…` and withdraw_trading `2mrbpjs3q…` landed, bettor ATA
  76.47 → 82.46 tUSDC (+5.99). Sealed flow is presentable today, as-is.
- Next: Phase B (deploy upgrade + base-only devnet lifecycle with
  lamport-exact vault reconciliation at BOTH checkpoints) — pending the
  Gate 1 report-back.

## 2026-07-11 — AMM Phase B COMPLETE: upgrade deployed, base devnet lifecycle SOLVENT to the lamport at both checkpoints

- **Deploy**: programdata was 212,448 B vs the new 226,056 B binary — first
  `solana program extend` of the project (+20,000 B; the first deploy
  attempt failed for funds because extend rent is ~6,966 lamports/BYTE ≈
  0.139 SOL, not the 1000×-smaller figure naively assumed; topped the
  deployer up 0.4 SOL from the project's own test-bettor wallet and
  redeployed). Upgrade sig `28yPJ7yYv7FgTc5QANW2a6pJMs5YEkXuSR1GPZ1S4V3ncJJbb6HJriH6oTJngPLSdXXtg673aoWahBdE4hKujAvt`,
  now Last Deployed In Slot 475357763, data length 232,448 B.
- **Sealed-flow regression on the UPGRADED binary** (gate discipline): full
  `verify-flow.ts` run — open_sealed→submit→house-counter→reveal→match→
  settle (real validate_stat CPI)→claim, user +1,990,000 exactly per the
  documented formula. Market `5pV9nvUffLtWZkxHAfziMwDX7716SJcyFvjdJezp48FX`,
  settle `5LEG6dUzAjJLjUVJfbqq…`, claim `25GA8SV9uj5MWuxh9g8R…`. The 8 new
  instructions broke nothing.
- **`app/scripts/amm_base_lifecycle.ts`** (new, permanent): full base-layer
  AMM lifecycle on market `8PAJAkwZKxao5NCLbZpuaGZpJVi5b2gKc8Gf71EXZheg` —
  open_market (plain) → create_amm_pool (1.0 tUSDC seed, 1% fee) → 2 users
  open+deposit (0.4 each) → 6 interleaved swaps (both users/sides/
  directions) → settle via the LIVE TxLINE pipeline → redeem×2 →
  withdraw_lp. 17 sigs total, all in the script output.
- **The two load-bearing results**:
  - **CHECKPOINT 1** (after swaps): vault 1,800,000 ==
    Σusdc_available(271,676+242,445) + sets_outstanding(1,280,727) +
    fees(5,152) EXACTLY; ΣtokensA+reserveA == sets == ΣtokensB+reserveB;
    vault untouched by all 6 swaps. Additionally the entire on-chain pool+
    position state equalled an off-chain BigInt simulation unit-for-unit —
    and every swap's `min_out` was set to the EXACT simulated output, so
    any on-chain/quote-engine divergence would have reverted the swap:
    the on-chain math and the client math are provably identical.
  - **CHECKPOINT 2** (post settle+redeem+LP): **vault drained to exactly
    0**; payouts alice 419,246 + bob 403,329 + lp 977,425 == 1,800,000
    deposited; each wallet's payout individually matched its predicted
    usdc_available + winning-tokens (users) / winning-reserve + fees (LP).
    LP P&L −22,575 (adverse selection, real and disclosed).
- **Slippage guard proven on-chain**: deliberate buy with min_out =
  expected+1 landed and reverted Custom(6026)/SlippageExceeded, sig
  `5d7vh1NkStEeGbRMgKE9JW9mRLbLE4RmxmUjNWXP3N5z7TUqBqBdutfm7wF8rAqau4cycFXtDfhiRDPsGPLU1Hvr`.
- **Live-pipeline settle, not bundled**: proof fetched at seq 1316 (the
  bundled demo capture is seq 1315 — the fetch found a NEWER snapshot,
  confirming genuinely live retrieval), settle sig
  `3exyJQKK8VQBEW4jdHtJ2UC33vv9nYQSz6KizWDv1x3uDYy6DKHnQgNj3ixEjfsWhLXpYpJSkc236mqTr7hi1D8x`.
- Gate: **Phase B PASS**. Next: Phase C (ER path: delegate market+pool+
  positions, genuinely concurrent real swaps under Promise.all with the
  3-assertion audit incl. the landing-order replay, undelegate, settle,
  post-settlement reconciliation) — pending report-back.

## 2026-07-11 — AMM Phase C COMPLETE: concurrent REAL swaps on the ER, replay-audited, solvent end-to-end

Two full live runs (markets `4Pi3qdV7z5mXEZQ4XLkxqi8f8bsBCSsScd3ZWYK6UhXb`,
`uiUoQP7Pk4KupNcaZxDeUAdx1HtmcwYuEF9ryB7ondH`), both PASS. The second run
used the strengthened inline audit; the first run's audit was verified
offline with identical method. `app/scripts/amm_er_lifecycle.ts` is the
permanent artifact.

- **First live use of discs 32/33** (`delegate_amm_pool`,
  `delegate_amm_position`): both worked first try; market+pool+4 positions
  all co-located on one ER node (router-verified) —
  `https://devnet-as.magicblock.app/`.
- **2 rounds × 4 genuinely concurrent real swaps** (Promise.all): round 1
  all-buys, round 2 two sells + two buys. All 8 landed Finalized-on-ER
  (sample sig confirmed not-found-on-base, the standing evidence bar).
  Batch wall-clock 1.0–1.6s for 4 concurrent swaps; the ER batched 3–4 of
  them into the SAME slot both rounds — maximal write contention on the
  shared pool, which is exactly the case under test.
- **The replay audit (the tightening from the pivot approval): PASS with
  UNIQUENESS.** For each round, every serialization consistent with the
  slot partial-order was enumerated and simulated through the mirrored
  CPMM math; consistency required reproducing the final pool state AND
  every wallet's individual position delta. Result both rounds, both runs:
  **exactly 1 of 6 (or 1/24 in run 1's all-same-slot round) candidate
  orders reproduces the on-chain end state** — the landing order is
  uniquely determined, all 4 swaps' effects composed sequentially, no lost
  update, no swap priced off stale reserves. Live bonus finding: run 1
  round 1 contained a DECOY permutation matching pool-state-only that the
  per-wallet-delta check eliminated — the position deltas are load-bearing
  discriminators, now baked into the script. Genuine reordering observed
  (submission order ≠ landing order in both runs), so the audit exercised
  a real case, not a trivial FIFO.
- **Solvency**: exact (2,600,000 invariant) on ER-read state after each
  concurrent round; **delegation round-trip integrity** — all 16 pool+
  position fields identical base-vs-ER after undelegate-many (market+pool+
  4 positions in ONE call); vault untouched throughout; post-settlement
  (LIVE TxLINE proof again) **vault drained to exactly 0**, Σ payouts ==
  2,600,000, every wallet's payout individually matched prediction.
- LP P&L: run 1 **+4,071** (fees beat adverse selection), run 2 **−32,162**
  (adverse selection won) — both directions of disclosed LP risk observed
  live.
- **Sealed-flow regression re-run at this gate**: verify-flow full
  lifecycle green again (payout +1,990,000 exact), market
  `6XcxgVmFWjJ7FpHGFe23sgp3378ShNaNLEP4PDS9iBy1`.
- Gate 2 (design doc): **PASS — ER swaps are real, concurrent, correctly
  serialized, and solvent.** Next: Phase D (UI: /create market-type
  toggle, AmmTradingPanel with live-reserve quote engine + user slippage
  tolerance wired to on-chain min_out, positions, redeem, disclosures) —
  pending report-back.

## 2026-07-11 — AMM Phase D COMPLETE: full trading UI, browser-proven with a real slippage revert on screen

Everything below verified through the REAL UI with the real-signing
injected wallet (`app/scripts/amm_browser_proof.ts`, permanent), on a
market CREATED THROUGH /create: `B4XdJKU36ctz9PQsDMyWR2KLCF2iE4f8PH7Fi5c1wHKi`.
Screenshots amm-01 … amm-12 in the session scratchpad.

- **Lib layer**: `ammMath.ts` (client BigInt mirror of fpmm.rs — the exact
  math Phase B proved unit-exact on-chain; quotes, spot price, impact,
  `minOutForTolerance`), 9 new builders in `instructions.ts` (discs 1 +
  29-36; swap keeps owner READ-ONLY per ER discipline), AmmPool/AmmPosition
  decoders + existence/scan helpers in `onchain.ts`, routed hooks in
  `hooks.ts` (`useRoutedAmmPool` resolves the POOL's own delegation via the
  router, 2.5s poll).
- **/create**: market-type toggle (Sealed vs AMM). AMM path = faucet →
  `open_market` + `create_amm_pool` in ONE wallet-signed tx; seed/fee/
  trading-hours inputs; LP-risk disclosure in the preview. Browser-proven.
- **AmmTradingPanel**: live prices from reserves, buy/sell with live quote
  (expected out, fee, impact, **min received == the on-chain min_out arg**),
  user slippage tolerance, deposit (faucet + open+deposit one sig), redeem
  (two-leg), LP card (fees accrued + explicit at-risk disclosure), ER
  accelerate (delegate market+pool+position one sig) / move-to-base,
  wrong-ledger recovery, latency log, MEV honesty note naming sealed
  markets as the MEV-proof alternative. MarketDetail routes to it purely on
  pool existence (delegation-agnostic base PDA probe).
- **The gate deliverable — deliberate slippage revert IN THE BROWSER**
  (amm-07-slippage-reverted.png): tolerance 0%, the injected wallet stalls
  the signature while a script-side trader moves the pool price (the honest
  real-world race min_out exists for) → the already-built tx lands, fails
  on-chain Custom(6026), and the panel shows the friendly slippage message.
  Real sigs for everything: UI create, deposit `2762V36t…`, BUY
  `5yQ8Z9Ed…` (836ms), SELL `4N1vZM4s…` (968ms — sell-anytime in the
  browser), settle (real validate_stat), redeem `5n6mdAME…`, LP withdraw
  `3Sk63KB3…`; after the script-side mover also redeemed, the vault
  **drained to exactly 0** — the browser lifecycle is solvent to the
  lamport too.
- **Two REAL bugs found by the proof, both fixed**:
  1. **App-wide latent error-shape bug**: web3.js `confirmTransaction`
     REJECTS with the bare `TransactionError` OBJECT (not an Error) when
     its websocket signature-notification wins the internal race vs
     polling. `friendlyError`/`extractProgramErrorCode` stringified it to
     "[object Object]" — no code extraction, unreadable panel error. Fixed
     in `errors.ts` (`errText()` JSON-stringifies non-Error throws); this
     also protects ErTradingPanel, which had the same latent race. Plus:
     AMM error codes 6026-6031 added to the friendly map.
  2. **Lobby dedupe hid AMM markets**: same-predicate collapsing folded the
     new AMM markets behind an old settled SEALED market with an identical
     predicate. Market KIND (amm/sealed/plain) is now part of the dedupe
     key. Verified: "AMM · sell anytime" badge renders on /markets.
- **Portfolio**: "AMM positions" section (deposits, token balances,
  redeemable state, Go-redeem link; honest footer about ER-delegated
  positions being temporarily absent from the base scan). Verified rendering
  a live unredeemed position.
- **Sealed-flow regression re-run at this gate**: verify-flow full
  lifecycle green again (exit 0, settle `2c8yZ3S9…`).
- Next: Phase E (README/docs repositioning + full regression sweep + demo
  prep) — pending report-back.

## 2026-07-11 — AMM Phase E COMPLETE: README repositioned, full regression sweep green — PIVOT SHIPPED (A–E all done)

- **README rewritten** around the pivot: headline is now "Polymarket-style
  continuous trading on a MagicBlock Ephemeral Rollup" with trustless
  TxLINE settlement; five-part story → six parts (part 4 = sell-anytime
  AMM with the solvency/slippage evidence; part 5 = ER for BOTH market
  types incl. the concurrency replay audit; part 6 = the MEV honesty
  framing: sealed = MEV-proof by construction, AMM = not MEV-proof and
  says so in-panel). New AMM architecture diagram + lifecycle (all 3
  mermaid blocks verified rendering via mermaid-cli before commit — the
  quoted-parens lesson holds). New "AMM lifecycle (real tx signatures)"
  proof section: three tiers (base solvency run, ER concurrency run,
  browser run) with explorer-linked sigs and what-to-check columns,
  including the on-chain SlippageExceeded revert and the LP-loss run.
  No-bluff updated: the old "a proper liquidity pool ... isn't built here"
  paragraph now honestly says the AMM IS that pool (single seed-once LP
  disclosed), plus new entries for demonstrated LP risk (up once, down
  twice across recorded runs) and the AMM-not-MEV-proof disclosure.
  cargo test count corrected 44 → 92; repo layout + submission checklist
  refreshed (demo-video suggestion now leads with the AMM sell journey).
- **Demo prep**: `bun run demo:amm` (base lifecycle + lamport-exact
  solvency) and `bun run demo:amm-er` (ER concurrency + replay audit)
  wired into the root package.json alongside the sealed `bun run demo`.
  `demo:amm` verified end-to-end post-wiring: fresh market
  `DuE49QGF9LAtcCLNgaQF3qfn1j8H9xMjXdGtZxwBgmR9`, PASS, both checkpoints
  exact.
- **`docs/AMM_TRADING_DESIGN.md`** status header updated: DESIGN →
  SHIPPED, with the per-phase evidence summary (A: 92/92 + CU; B: both
  checkpoints + live revert; C: unique replay serialization; D: browser
  incl. on-screen revert; E: this sweep).
- **Full regression sweep, all green**:
  - `cargo test --release`: **92/92** (re-run, unchanged).
  - **Sealed-flow re-proof** (the per-gate discipline, final run): full
    verify-flow lifecycle green, market
    `9CVcj671CPNkjyF7qSucGwY7dujZeswoKaAVYRFiC7wd`, settle
    `2U3JfJhbwcS3…`, claim `5jXMdDtgu2L1…`, payout formula exact.
  - **8-route browser sweep**: / , /markets, /create, sealed market page,
    AMM market page, /portfolio, /demo/mev, /receipt/[market] — all HTTP
    200 with the expected content rendered (two initial "failures" were
    sweep-expectation bugs, not product bugs: /portfolio correctly
    wallet-gates, /demo/mev's copy says "front-running" not "MEV";
    re-checked with honest expectations, 8/8).
- **The pivot, end to end**: 8 new instructions + 2 account types + pure
  CPMM math on-chain; 48 new tests; a devnet upgrade; three tiers of live
  proof runs (5 distinct markets, every one drained to a zero vault);
  concurrent-swap safety upgraded from a counter proxy to a uniqueness
  replay audit; a full trading UI with on-chain-enforced slippage; and the
  sealed-batch flow re-proven at every single gate along the way. Additive
  throughout — Market layout untouched, zero sealed-flow regressions.

## 2026-07-11 — AMM expiry refund SHIPPED: the last custody gap closed (no funds can ever be trapped, period)

- **The gap**: on an AMM market whose fixture never gets oracle data,
  outcome-token complete-set value and the LP seed had no recovery path
  (design doc §3 was honest about it: "designed, NOT implemented in v1").
- **The fix, additively inside the existing instructions** (no new discs,
  no market-status flip): `redeem_amm` and `withdraw_lp_amm` now open after
  `deadline + SETTLE_GRACE` (2h, existing constant) on an unsettled market.
  Position refund = `usdc_available + min(tokens_a, tokens_b)`; LP payout =
  `min(reserve_a, reserve_b) + fees_accrued`. The directional residual
  (`|ta−tb|` / `|ra−rb|`) is each party's genuine risk and dies unpaid —
  refunding it at 0.5 would be manipulable (design doc §3's own reasoning).
- **Why no status flip is needed** (unlike `refund_expired`): `min ≤
  winning-side` always, so every expiry refund pays ≤ that same account's
  settlement payout — a late permissionless settle landing after partial
  refunds stays solvent by construction, and both paths zero balances
  behind the same `redeemed`/`lp_withdrawn` guards.
- **Tests: 92 → 100, all green** (`cargo test --release`). New: expiry
  pays exactly / grace-boundary strictness (`>` not `≥`) / expired
  double-refund + refund-then-late-settle both hit the same guards / LP
  expired variants / and lifecycle scenario 3 — swaps, NO settle, warp
  Clock past grace, refund everyone — asserting each payout to the lamport
  and the vault landing on the EXACT computed directional residual
  (non-zero by design; the settled scenarios still drain to exactly zero).
- **Deployed to devnet** (upgrade
  `2kdcBYwji4S8u5r9Q1hQFcCd9ppavRBgQkLfZ2KqwftuYNz9crKPrrdckUBBXgGzpFNkTKJH3bYVjXCfYeTR7x9A`,
  226,848 B < 232,448 B programdata, no extend needed). **Post-deploy live
  regression green on the upgraded binary**: full `demo:amm` lifecycle
  (market `EqJhZ5NpTzz6euWuRNByPsVhryWV4MabBMUZ6vDM6vDw`, vault drained to
  exactly zero, incl. the live slippage revert) + full sealed verify-flow
  (market `BXPeFxCPtDusykMQ6oBhmHAfeHNPzZqKZ38MoR67Gh57`). The expiry path
  itself is mollusk-proven with a warped Clock — a live proof needs a real
  2h+ wait; same disclosed precedent as `refund_expired` (README updated).
- **UI mirrors the gate** (`SETTLE_GRACE_SEC` in onchain.ts): the trade
  panel's position card shows "Refundable now" with the residual-loss copy
  past expiry, the LP card's withdraw opens on settled OR expired,
  /portfolio shows a "Refundable (expired)" pill, and the 6029 error text
  names the grace path. Design doc §3 flipped to "SHIPPED, mollusk-proven".

## 2026-07-11 — v2 Phase 1 COMPLETE: MagicBlock session keys — one popup, then popup-free gas-free ER trading

- **The UX problem**: every swap cost a wallet popup, even on the ER. Fixed
  with MagicBlock's session-keys program (`gpl_session`,
  `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` — live on devnet, verified):
  one wallet signature mints a SessionToken binding (wallet, ONYX, ephemeral
  browser key, expiry ≤ 7d, ours defaults 4h); the ephemeral key then signs
  swaps silently. NO wallet auto-approve anywhere — the wallet's one
  signature is a real, scoped, on-chain grant.
- **Program**: `swap_amm` accepts the session key as an alternative signer —
  non-owner signer must present the SessionToken as trailing account [4];
  native validation (their crate is Anchor-only): account owner ==
  gpl_session + Anchor discriminator + authority == position owner +
  target_program == ONYX + session_signer == signer + valid_until > now. No
  PDA re-derivation needed (gpl_session only initializes tokens whose fields
  match their own seeds, and create_session requires the authority to sign —
  owner+fields is unforgeable). New error 6032 SessionInvalid.
  **Scope invariant: a session key can ONLY swap** — deposit/redeem/
  withdraw_lp keep their direct owner checks.
- **Tests 100 → 108**: session swap ok; expired/wrong-signer/wrong-authority/
  wrong-target/forged-owner/bad-discriminator all → 6032; non-owner without
  token still 6012 (pre-session behavior preserved). Deployed
  (`2ECHFEf19cnAjz1dQXpoMdrFXXzVZLaZ75UJBNKxLq1AyduZqQM8cW2DZkmJX2Ma...`).
- **LIVE devnet proof** (`bun run demo:session`, market
  `GM27Kw36GMntR4ShjShqiJjUNtKAGzo8qkyZDwSaiPQi`):
  - ONE-SIGNATURE onboarding tx: create_session + open_amm_position +
    deposit_amm + delegate market/pool/position
    (`XNTzU6FN7PwzV5CkmaQi71uXv3azLDkBvTbzhdWLeTmiQTa3eGsERxByXYoSmEETb...`).
  - 3 swaps on the ER signed ONLY by the session key with **0 SOL ever**
    (balance asserted zero) — validator-sponsored, 510–2267ms.
  - Live negatives: stranger swap → 6012; session key redeem_amm → 6012
    (funds-exit pin); post-revoke session swap → 6032.
  - Settle (live TxLINE proof) + redeem + LP withdraw → vault EXACTLY zero.
- **Client**: `lib/session.ts` (localStorage ephemeral key + hand-built
  create/revoke_session ixs — skipped their React SDK, 2 ixs don't justify a
  dependency), `buildSwapAmmIx` sessionSigner/sessionToken params (position
  PDA stays wallet-derived), AmmTradingPanel "Start session (1 signature)" /
  session chip / End session / popup-free swap path (ER-only; base keeps the
  wallet path). `docs/SESSION_TRADING.md` has the full design + disclosed
  limitation (base-layer revocation propagates at ER clone-refresh cadence;
  expiry is the hard bound).

## 2026-07-11 — v2 Phase 2 COMPLETE: live TxLINE data layer — no more hardcoded fixtures

- **/api/fixtures** (new): live `/fixtures/snapshot` window merged over the
  verified static fallback table (the window rolls, aged-out fixtures keep
  their names), 5-min server cache, per-fixture `source: live|static`
  honesty flag. Verified live: mixed live+static entries returned.
- **fixtureMeta.ts**: static tables renamed `*_STATIC` + a live overlay
  (`primeLiveFixtures`) that the existing sync getters prefer — every
  call site (lobby, market page, portfolio) resolves real, current team
  names the moment `useLiveFixtures` loads, zero call-site rewrites.
- **Scores extended to the full match-stat set**: statKeys 1–8 (goals,
  yellows, reds, corners both sides) in one call with goals-only fallback;
  LiveScore renders a cards/corners row when nonzero. Verified live
  (18179550: 3:2, seq 1316).
- **Reference odds finally rendered**: `useReferenceOdds` (built in
  excellence pass A, zero consumers until now) wired into LiveScore as a
  "bookmaker ref" row — implied 1X2 percents labeled reference-only.
- **/create picker** now lists the live upcoming fixture window
  (kickoff-date labels), static list as fallback.
