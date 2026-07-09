# ONYX — Open Questions (for TxODDS / MagicBlock)

Track these until answered. None are on the trust-critical path (the L0
settlement loop is already proven end-to-end on devnet), but they close
out "nice-to-have" flourishes and de-risk later phases.

---

## O2 — txoracle Merkle leaf pre-image byte layout  [ASK IN TxODDS DISCORD]

**Status:** open. Blocks only the *cosmetic* client-side leaf re-derivation on
the receipt page (labeled "experimental" in the UI). Does NOT affect
settlement, which is decided on-chain by `validate_stat` itself.

**What we need:** the exact serialization txoracle hashes to form a stat leaf
before folding, and how the three proof arrays chain to the daily root.

**Copy-paste question for the Discord:**

> Hi — building an on-chain settlement engine that CPIs into `validate_stat`
> (works great, thanks). For an independent "verify-it-yourself" receipt UI
> I'm trying to locally re-derive the stat Merkle root and match it against
> the on-chain `daily_scores_roots` account, but I can't reproduce
> `event_stat_root` from the leaf. Could you confirm the exact byte layout?
>
> Using a real captured `/scores/stat-validation` payload
> (fixtureId 18179550, seq 1315, epochDay 20635, statKeys=1):
> - `statsToProve[0]` = `{ key: 1, value: 3, period: 0 }`
> - target `eventStatRoot` = `54758f29f4d01bf2254117bd2b1bbed91a496d704b89bce1bc21904b27ec9a58`
> - `statProofs[0]` = 5 ProofNodes
>
> I assumed the leaf is `keccak256( key:u32_LE ‖ value:i32_LE ‖ period:i32_LE )`
> = `4d5a0bc8…92fd8196`, then folded through `statProofs[0]` with the rule
> `is_right_sibling ? keccak(acc‖sib) : keccak(sib‖acc)`, giving
> `68dd4490…bda29d88` — which doesn't equal `eventStatRoot`.
>
> Questions:
> 1. What is the exact leaf pre-image? (field order, endianness, packed vs
>    length-prefixed, any domain-separation / tag byte, and is it keccak256
>    or NIST sha3-256?)
> 2. How do the arrays chain to the daily root — is it
>    `leaf → statProof → event_stat_root`, then
>    `event_stat_root (or events_sub_tree_root) → subTreeProof → mainTreeProof → daily root`?
>    Which root feeds which proof?

**Already ruled out empirically** (tested against the real fixture + on-chain
root, none matched): ~15 leaf variants (key/value/period reorderings, u32 vs
u64 widths, BE vs LE, with/without period, 0x00 domain byte, keccak256 vs
sha3_256), proof-order reversal, is_right_sibling inversion, and 4 tree-
topology hypotheses for the event_stat_root → daily-root chain. The fold
*primitive* (keccak256 pairing, is_right_sibling direction) is confirmed
byte-identical between `programs/onyx/src/merkle.rs` and
`app/src/lib/merkle.ts` — so the gap is purely the leaf/tree construction,
not the hashing.

---

## O3 — MagicBlock PER/TEE devnet demo-readiness  [DE-RISK SPIKE — task 8, RESOLVED]

**Status:** RESOLVED — verdict **FALLBACK** (do not build full shielded
matching; demo the sealed-bid + attestation flow instead). Full detail,
tx signatures, and the exact DCAP/CPI evidence in BUILD_STATE.md.

1. PER access-control ergonomics from native Pinocchio: **YES.** Proven
   on-chain (fixture 900000004 throwaway market): our program CPIs
   `CreatePermission` into MagicBlock's Permission Program with the same
   PDA-signer pattern already proven for the Delegation Program in task 7.
   Empirical finding: the Permission Program auto-adds the owning program
   as an implicit member before the caller's member list.
2. Shielded SPL/USDC demo-readiness: **NO, not as an ONYX-integrated flow.**
   The Private Payments API is live on devnet and does move real SPL tokens,
   but there is no generic "validator decrypts arbitrary program data and
   your program matches it inside the enclave" primitive — that decrypt-in-
   TEE mechanism is specific to MagicBlock's own token-transfer routing.
   Wiring it into ONYX's matching engine would mean adopting their entire
   Ephemeral SPL Token custody model, which is out of scope mid-hackathon.

TEE attestation itself (the other de-risk target) is fully verified: a live
Intel TDX DCAP quote fetched from the devnet TEE node, verified end-to-end
against Intel's PKI via `@phala/dcap-qvl`, `TCB status: UpToDate`, with
report_data freshness-bound to a random per-request challenge. This remains
a real, judge-verifiable trust anchor for the demo even under the FALLBACK
scope ("shielded order intent, transparent settlement").

---

## O3b — Private Payments confidential custody: NO-GO  [Phase A spike, RESOLVED]

**Status:** RESOLVED — **NO-GO**, hard gate triggered. Full source-level
evidence in `PRIVATE_PAYMENTS_CUSTODY_ANALYSIS.md`. Read the actual on-chain
`ephemeral-spl-token` program source (pinned commit
`0e41986d23775d36e9e28df47053c90633c98297`), not just SDK builders. Finding:
real confidential (`SchedulePrivateTransfer`) fund routing is decrypted and
executed by the Delegation Program's own logic once a `shuttle` account is
delegated onto a TEE-backed ER — not by any ONYX-verifiable, on-chain
instruction, and not re-checked against `validate_stat`'s outcome at
execution time. This breaks I-Custody for the confidential leg. Plain
(non-confidential) Ephemeral SPL Token deposit/withdraw is ordinary,
publicly-verifiable program logic (no TEE involved) and does NOT have this
problem — but it also isn't confidential. No integration code was written;
stopped per the plan's explicit hard gate before Phase B.

---

## ER-native — ephemeral-rollups-sdk from a native Pinocchio program  [task 7 — RESOLVED]

**Status:** RESOLVED. Proven end-to-end on devnet with native Pinocchio manual
CPI mirrors (no Anchor). delegate -> execute-on-ER -> commit-state-back-to-L1 ->
undelegate -> finalize (ownership restored) all working. The one piece not in the
public api crates — the delegation program's external-undelegate callback account
layout — was recovered empirically from a real failed finalize tx. Full detail +
tx signatures in BUILD_STATE.md. Settlement stays on L1.

**Brittleness note (pinned 2026-07-09):** the `process_undelegation` callback
contract (discriminator, 4-account layout, borsh `Vec<Vec<u8>>` seed payload)
is empirical, not documented in any public MagicBlock crate/doc. Exact raw
bytes decoded from the real failed devnet tx that revealed it, plus the
`ephemeral-rollups-sdk`/`magicblock-delegation-program-api`/
`magicblock-magic-program-api` versions this depends on, are pinned in
BUILD_STATE.md's ER section. A future MagicBlock protocol change to this
callback would surface as a loud `InvalidInstructionData` or PDA-mismatch
error (checked before any state mutation) — not a silent corruption — but
would still break the demo undelegate flow, so re-check that section against
the pinned versions before relying on it after any MagicBlock upgrade.
