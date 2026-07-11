# Session trading — MagicBlock session keys on the AMM

One wallet signature starts a trading session; every swap after that is
signed silently by a browser-held ephemeral key. No wallet auto-approve, no
popup per trade — and the session key **cannot withdraw funds, ever**.

## Mechanism

MagicBlock's session-keys program (`gpl_session`,
`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`) mints a **SessionToken** PDA
that binds four facts on-chain: *authority* (the user's wallet),
*target_program* (ONYX), *session_signer* (the ephemeral key), and
*valid_until* (expiry, max 1 week — enforced by their program). Creating a
token requires BOTH the wallet and the ephemeral key to sign, so nobody can
mint a session for someone else's wallet.

`swap_amm` accepts the ephemeral key as an alternative signer: when the tx
signer is not the position owner, a trailing `session_token` account must
prove a live session. Our program is native Pinocchio (their `session-keys`
crate is Anchor-only), so validation is hand-rolled account inspection:

1. account owner == gpl_session program
2. 8-byte Anchor discriminator == `sha256("account:SessionToken")[..8]`
3. `authority` (bytes 8..40) == position owner
4. `target_program` (40..72) == ONYX program ID
5. `session_signer` (72..104) == the tx signer
6. `valid_until` (104..112, i64 LE) > Clock now

No PDA re-derivation needed: gpl_session is the only writer of accounts it
owns, `create_session` requires the authority's signature, and it only
initializes tokens whose stored fields match their own PDA seeds — owner +
discriminator + field equality is already unforgeable. (Layout verified
against `magicblock-labs/session-keys` `programs/gpl_session/src/lib.rs`.)

## Scope invariant — session key can ONLY swap

| Instruction | Session key accepted? | Why |
|---|---|---|
| `swap_amm` | **yes** | the whole point |
| `deposit_amm` | no | `position.owner == signer` check unchanged |
| `redeem_amm` | no | same |
| `withdraw_lp_amm` | no | `pool.lp_owner == signer` check unchanged |
| `set`/delegate/undelegate | no | owner/payer signatures unchanged |

Worst case if the ephemeral key leaks (localStorage is XSS-readable by
design): the attacker can make bad swaps inside that one position until
expiry/revocation — value erosion bounded by the position's in-market
balance. Wallet funds and every exit path stay untouched.

## Client flow

- `app/src/lib/session.ts`: ephemeral `Keypair` in localStorage
  (`onyx:session:{cluster}:{wallet}`), plus hand-built `create_session` /
  `revoke_session` instructions (Anchor global discriminators
  `sha256("global:create_session")[..8]` = `[242,193,143,179,150,25,122,227]`,
  `revoke_session` = `[86,92,198,120,144,2,7,194]`). We skip their React SDK
  — two instructions don't justify a dependency.
- **Start session** (ONE popup): faucet top-up → one tx:
  `create_session` (topUp=false, valid_until=now+4h) + `open_amm_position`
  (if new) + `deposit_amm` + `delegate_amm_position`. Market + pool are
  pre-delegated by the market seeder, so the position lands straight on the
  Ephemeral Rollup, session-ready.
- **Swaps** (zero popups): tx feePayer = session key, signed only by the
  session key, sent to the ER — ER fees are validator-sponsored, so the
  session key never needs SOL. Session trading is ER-only; on base the
  wallet-popup path remains.
- **End session** (one popup): `revoke_session` (closes the token, rent
  back to the wallet) + local key wipe. gpl_session lets ANYONE revoke a
  token — by design, so a leaked key can be killed from anywhere.
- **Renewal**: near expiry the panel prompts one popup to mint a fresh
  token for the same ephemeral key.

## Honest limitations (disclosed)

- The SessionToken lives on the base layer; the ER validates against its
  clone of that account. A base-layer revocation therefore propagates at
  the ER's clone-refresh cadence, not instantly. Expiry (default 4h) is the
  hard bound; their program caps validity at 7 days.
- localStorage storage is the standard session-keys pattern (their SDK does
  the same); the scope invariant above is what makes it acceptable.
