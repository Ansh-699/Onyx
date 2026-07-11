# Private Ephemeral Rollups (PER) — evaluated, not adopted

**Verdict: public ER + MagicBlock session keys. Not a PER.**

The question was whether ONYX's trading should move to a MagicBlock
*Private* Ephemeral Rollup — an ER whose validator runs inside an Intel TDX
TEE, with account-level read/write permissioning enforced at the TEE
ingress. We evaluated it seriously (live DCAP-verified attestation, the
Permission Program CPI from native Pinocchio — both proven on devnet, see
`BUILD_STATE.md` task-8 spike and `PRIVATE_PAYMENTS_CUSTODY_ANALYSIS.md`)
and chose not to ship it. Three reasons:

1. **It reintroduces exactly the trust dependency this project's thesis
   rejects.** ONYX's pitch is that custody and settlement are verifiable by
   anyone on a public ledger — `validate_stat` proofs, lamport-exact
   solvency, public replay audits. A TEE-gated validator makes state
   *unreadable* to outsiders: you trust Intel's silicon, the operator's
   middleware, and a single-keypair upgrade authority (the Delegation
   Program, Ephemeral SPL Token, and Hydra crank share one, no timelock —
   documented in the custody analysis). Our concurrency proof — the replay
   audit that re-derives every swap's landing order from public state —
   is impossible against a PER by construction.

2. **A prediction market WANTS public price discovery.** Polymarket-style
   markets work because everyone sees the same price and the same flow.
   Hiding order flow inside a TEE serves dark-pool use cases; for ONYX's
   product it would subtract value. Where hiding *intent* matters (MEV),
   ONYX already ships a stronger, trustless answer: commit-reveal
   sealed-batch matching with a uniform clearing price on the public L1.

3. **Session keys already solve the UX problem PERs are often reached
   for.** The "deposit once, then click-free trading" experience is live on
   the public ER: one wallet signature mints a scoped, expiring
   gpl_session token; swaps are signed by a browser key that can never
   withdraw funds; ER fees are validator-sponsored (`bun run
   demo:session`, live-proven). PER's session-key-based *read* auth adds
   nothing on top for us.

**What a PER would buy, honestly** (roadmap-if-ever): private order flow
for institutional-size positions (front-running protection beyond slippage
bounds), and jurisdiction gating via the ingress middleware's geofencing/
OFAC screening — relevant for a regulated deployment, not for this
verifiable-settlement demonstration. If that day comes, the task-8 spike
already proved the mechanics: TEE attestation verification
(`@phala/dcap-qvl` against Intel PKI, challenge-fresh), and the Permission
Program (`ACLseoPoy…`) CPI from native Pinocchio (`create_market_permission`,
disc 14, kept EXPERIMENTAL and unshipped).
