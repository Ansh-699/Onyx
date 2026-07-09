# Private Payments custody/trust analysis — Phase A (task 9 spike)

**Verdict: NO-GO on wiring MagicBlock's confidential (`SchedulePrivateTransfer`)
routing into ONYX's fund-custody/payout path. It requires trusting the
TEE-backed validator's own decrypt-and-execute logic for the fund-moving
step, which is not independently verifiable and is incompatible with
`I-Custody`. Plain (non-confidential) Ephemeral SPL Token deposit/withdraw
does NOT have this problem, but also delivers no confidentiality — it's a
different token-custody wrapper, not "confidential USDC."**

No integration code was written. Per the task's hard gate, this is reported
before any Phase B work.

---

## 0. What "preserves trustlessness" means here

From `09 - Deep-Dive 3 - Expanded Edge-Case & Error Handling.md` §5 (already
in the repo, source of truth for this analysis):

- **I-Custody:** only `claim` / `claim_counterparty` / `refund_expired` move
  funds, and only under their guards. **[CONFIRMED]**
- **I-Solvency:** vault balance ≥ outstanding obligation at all times.
  Asserted before every payout. **[CONFIRMED]**

And from `08 - Deep-Dive 2 - MEV-Proof Shielded Matching (O7).md` §6
(already-confirmed design decision, predates this spike):

> **Suspected TEE breach:** halt shielded mode globally; funds are
> unaffected (custody/settlement are on L1, never in the enclave); disclose.
> **[CONFIRMED — funds safe]**

The spec's own privacy feature (O7 sealed-bid matching) was already designed
to keep custody out of the enclave — only *order intent* (side/size/price)
is meant to be sealed; the commit-to-L1 step publishes net position deltas
via the already-proven ER commit path (task 7), and `claim`/`refund_expired`
remain the only fund-moving instructions, exactly as I-Custody requires.

The test this spike applies to *literal confidential-USDC custody* (moving
actual token balances through MagicBlock's Private Payments / Ephemeral SPL
Token product) is: **does any part of the fund-moving decision or execution
depend on something ONYX's own on-chain program cannot independently verify?**
If yes → NO-GO, because that breaks the "verify, don't trust" thesis the
whole project is built on, even if only for the shielded leg of a transfer.

## 1. What was checked, and how (all real, on-chain or source-level evidence)

### 1.1 Program upgrade authorities (on-chain, devnet — checked directly)

| Program | Upgrade authority | Authority account type |
|---|---|---|
| Delegation Program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) | `3FwNxjbCqdD7G6MkrAdwTd5Zf6R3tHoapam4Pv1X2KBB` | plain System-owned keypair, **no on-chain multisig/timelock** |
| Ephemeral SPL Token (`SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`) | **same key** `3FwNxjbCqdD7G6MkrAdwTd5Zf6R3tHoapam4Pv1X2KBB` | same |
| Hydra crank program (`Hydra17i1feui9deaxu6d1TzSQMRNHeBRkDR1Awy7zea`) | **same key** | same |
| Permission Program (`ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`) | `5Hs51hUxpr9cBz8gwbsFNVcJqdtPeJR8MoUNxoUSGP8a` | different key, same pattern |

This is **not new risk** for the Delegation Program row — task 7's plain ER
integration already implicitly accepted it (never flagged as a blocker).
It's listed here because the Ephemeral SPL Token and Hydra programs (both
load-bearing for Private Payments) share the *exact same* single-keypair
upgrade authority, with no visible governance delay. A unilateral, silent
upgrade of either program is possible at any time. Relevant background risk,
not the disqualifying finding by itself.

### 1.2 Plain deposit/withdraw — read the actual on-chain program source

Repo: `magicblock-labs/ephemeral-spl-token`, pinned at commit
`0e41986d23775d36e9e28df47053c90633c98297` (2026-07-09; **pin this** — the
program can be upgraded by the key above at any time, silently changing this
analysis).

`e-token/src/processor/withdraw_spl_tokens.rs` → `internal/token_vault.rs::
withdraw_ephemeral_ata_tokens`:
```rust
require!(owner.is_signer(), ProgramError::MissingRequiredSignature);
...
require!(ephemeral_ata.owner() == owner.address(), EphemeralSplError::EphemeralAtaMismatch);
...
// transfer from the shared vault token account to the destination,
// authorized by the GlobalVault PDA (ordinary invoke_signed, no encryption,
// no TEE dependency anywhere in this path)
```
This is **ordinary, publicly-verifiable Solana program logic** — a signer
check plus a stored-owner-pubkey match, then a standard `TransferChecked`
CPI signed by the vault PDA's own seeds. `owner` could in principle be a
program PDA (invoke_signed the same way ONYX's own vault/market PDAs already
sign), which would let ONYX's own program gate release. **This path does
not touch a TEE at all and does not threaten I-Custody or I-Solvency any
more than the Delegation Program already does.**

**But it also isn't confidential.** `EphemeralAta { owner, mint, amount }`
is a plain on-chain account — no encryption, amount and owner both visible.
This path is a *different token-custody wrapper*, not "confidential USDC."
It answers "can ONYX gate a payout through this program" (yes, architecturally)
but not "does it hide anything" (no).

### 1.3 Real confidential routing — read the actual decrypt/execute path

The only mechanism that actually hides anything (destination and/or amount)
is `SchedulePrivateTransfer` → `execute_scheduled_private_transfer` → a
self-CPI into `DepositAndDelegateShuttleEphemeralAtaWithMergeAndPrivateTransferAndStashClose`
→ `internal/private_transfer.rs::process_with_merge_and_private_transfer_inner`.

Traced the full call chain (all four files read in full, source-level, not
inferred from SDK builders):

1. `schedule_private_transfer.rs` (**runs on BASE, user-signed**): user
   encrypts a destination pubkey + delay/split metadata client-side, funds a
   `stash` PDA, and schedules a Hydra crank to fire `ExecuteScheduledPrivateTransfer`
   later. The ciphertext is opaque to this instruction — it's just stored.
2. `execute_scheduled_private_transfer.rs` (**runs on BASE**, permissionless
   crank trigger, doc comment: *"Executes on: BASE only. Top-level, triggered
   by Hydra."*): does **not** decrypt anything. It re-derives the stash PDA,
   verifies the Hydra crank's provenance, and self-CPIs into instruction 31,
   forwarding `encrypted_destination`/`encrypted_data_suffix` **verbatim,
   still ciphertext**.
3. That self-CPI lands in `private_transfer.rs::process_with_merge_and_private_transfer_inner`,
   which builds a `PostDelegationActions` structure —
   `MaybeEncryptedPubkey::Encrypted(EncryptedBuffer::new(encrypted_destination...))`
   and `MaybeEncryptedIxData{ suffix: EncryptedBuffer::new(encrypted_data_suffix...) }`
   — and hands it to the **Delegation Program** as part of delegating the
   `shuttle` account onto the ER.

**The actual decryption and the actual fund-routing instruction execution
happen inside the Delegation Program's own logic, replayed once the shuttle
account is running on a TEE-backed ER validator — not in any code ONYX
writes, not as ordinary Solana consensus-verified execution.** Nowhere in
this chain is there a point where Solana's base-layer validators (or ONYX's
own program) can check that the decrypted destination/amount matches what
was intended — that guarantee exists *only* inside that specific TEE
instance, backed by the DCAP attestation chain proven in task 8. Trusting
this path means trusting: (a) Intel TDX's hardware isolation actually holds
(side-channel risk is real and has precedent for TEE-class hardware), (b)
the enclave is running the exact attested build with no operator override,
and (c) there's no support/recovery backdoor — none of which is something
ONYX's own program, or Solana consensus, can check at the moment funds move.

**Also concretely checked: nothing in this chain reads `validate_stat`'s
outcome or any ONYX account.** The Hydra crank fires on a slot interval,
fully decoupled from ONYX's settlement logic. Gating a private transfer by
the oracle outcome would require ONYX to be the one that *constructs and
signs* the `SchedulePrivateTransfer` only after `settle_market` succeeds —
achievable in principle, but the actual execution later is still gated only
by the Hydra crank + TEE decrypt, with no re-check against the outcome at
execution time. That's a new race/replay surface, not just a new dependency.

## 2. GO/NO-GO

| Question | Answer |
|---|---|
| Does confidential custody leave ONYX's escrow-PDA control? | **Yes** — the confidential leg is decrypted and executed by the Delegation Program running inside the TEE-backed ER, not by any ONYX-authorized, on-chain-verifiable instruction. |
| Can ONYX's program authorize/gate a confidential transfer? | Only the *scheduling* step (submit the encrypted intent); the *execution* is on a timer/crank, decoupled from ONYX and from `validate_stat` at the moment funds actually move. |
| Can payout still be gated by the oracle outcome? | Not at the execution instant, for the confidential leg — only at scheduling time, which is a materially weaker guarantee than today's `claim`/`claim_counterparty` (single atomic tx, checks-effects-interactions, I-Once). |
| What's actually shielded on devnet? | Destination pubkey and part of the routing instruction data (both encrypted client-side to the validator's identity key); amount is *not* independently hidden by this mechanism (fee/queue math runs on cleartext `amount` args in the same instruction). So it's destination-shielding, not full confidential-amount privacy. |
| Preserves I-Custody / I-Solvency? | **No**, for the confidential leg specifically. Plain (non-confidential) deposit/withdraw does preserve it, but delivers no privacy. |

**HARD GATE TRIGGERED.** Real confidential USDC via MagicBlock's Private
Payments API requires trusting a hosted TEE validator's own decrypt-and-
execute logic for the fund-moving step. Stopping here per the plan, before
writing any integration code.

## 3. Recommendation (not a decision — yours to make)

Two live options, both consistent with what's already proven:

**A. Fall back to the original O7 design** (sealed order *intent*, not fund
custody) — this is smaller than it sounds because task 8 already proved the
two building blocks it needs: the Permission Program CPI (`create_market_
permission`, disc 14) and the ER commit-to-L1 path (task 7). What's missing
is only an actual order-submission + in-enclave-matching instruction, with
net deltas committed back to L1 where `claim`/`claim_counterparty` (unchanged,
still the only fund-moving instructions) execute the real payout. This
preserves I-Custody/I-Solvency exactly, matches the already-written spec
(`08 - Deep-Dive 2 - MEV-Proof Shielded Matching (O7).md`), and reuses proven
code. Real, judge-verifiable claim: "shielded order intent, transparent
settlement" — the same honest framing from task 8's FALLBACK verdict.

**B. Pivot to parlays (L3)** to keep momentum on committed-scope work while
this gets rethought, per your own fallback instruction.

Not recommended: pursuing (A) is very likely the better use of remaining
time even absolute — it's real, demoable, judge-verifiable privacy (sealed
orders + a genuine DCAP-attested TEE) without the custody compromise, and
most of the hard protocol-reverse-engineering risk is already retired.

I have not started either. Awaiting your call.
