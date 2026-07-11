// Human-readable mapping for every ONYX program error code, mirrored from
// programs/onyx/src/error.rs (the authoritative source — keep in sync).
// Also translates the common web3.js / wallet-adapter failure shapes so the
// user never sees a raw `custom program error: 0x1782` or a JSON blob.

const PROGRAM_ERRORS: Record<number, string> = {
  6000: "This account is already initialized.",
  6001: "The program is paused.",
  6002: "Invalid market parameters.",
  6003: "A market with these exact terms already exists — open the existing one instead.",
  6004: "This market is closed to new bets.",
  6005: "Stake amount must be greater than zero.",
  6006: "The market isn't in the right state for that action (e.g. it may already be settled).",
  6007: "The oracle hasn't posted the daily scores root for that day yet — retry later. No funds are at risk.",
  6008: "The oracle proof didn't verify against the anchored Merkle root.",
  6009: "This position didn't win — there's nothing to claim.",
  6010: "This position's winnings were already claimed.",
  6011: "The market hasn't expired yet — refunds only open after the deadline plus the grace period.",
  6012: "Not authorized for that action.",
  6013: "Vault balance is below what's owed — this should never happen; please report it.",
  6017: "The oracle CPI returned no data — transient, retry. No funds are at risk.",
  6018: "Wrong phase for that action — the commit or reveal window may have closed (or not opened yet).",
  6019: "Reveal doesn't match your sealed commitment — the side, size, price, and nonce must be exactly what you committed.",
  6020: "This order was already revealed.",
  6021: "Nothing to refund for this order.",
  6022: "Revealed size exceeds the collateral you locked at commit time.",
  6023: "Too many orders for one batch match.",
  6024: "You already have a sealed order with this nonce on this market.",
  6025: "You already have a position on the other side of this market — one side per wallet per market.",
  6026: "Slippage protection triggered: the pool price moved past your tolerance before the swap landed, so it was reverted — nothing was traded. Re-quote and try again (or widen your tolerance).",
  6027: "The pool doesn't have enough liquidity for that swap.",
  6028: "AMM pools can only be created on plain markets, not sealed-batch ones.",
  6029: "The market hasn't settled yet — LP withdrawal opens after settlement.",
  6030: "This position was already redeemed.",
  6031: "LP liquidity was already withdrawn from this pool.",
  7000: "An account didn't match its expected derivation (client bug — please report).",
  7001: "Account owner mismatch (client bug — please report).",
  7002: "Malformed instruction data (client bug — please report).",
  7003: "Unexpected account size (client bug — please report).",
  7004: "A required signature is missing.",
  7005: "Arithmetic overflow in payout math — please report this.",
  7006: "The oracle CPI failed transiently — retry. This is not a settlement outcome.",
};

/**
 * Any error value -> searchable text. Handles the three real shapes: Error
 * instances (message + optional logs), strings, and PLAIN OBJECTS — the last
 * one because web3.js's confirmTransaction REJECTS with the bare
 * TransactionError object (e.g. {"InstructionError":[0,{"Custom":6026}]})
 * whenever the websocket signature-notification wins its internal race
 * against the polling path. String(err) on that object is "[object Object]",
 * which silently defeated the code extraction below — found live by the
 * Phase D browser proof's deliberate slippage-revert step, where the panel
 * showed "[object Object]" instead of the 6026 message. JSON.stringify is
 * the fix, and it applies to every panel (the ER panel had the same latent
 * race — never observed only because its on-chain failures happened to
 * surface through the resolved path or at send time).
 */
function errText(err: unknown): string {
  if (err instanceof Error) {
    return `${err.message}\n${(err as Error & { logs?: string[] }).logs?.join("\n") ?? ""}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** Pull a Custom(NNNN) program error code out of any web3.js error shape. */
export function extractProgramErrorCode(err: unknown): number | null {
  const text = errText(err);
  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1]!, 16);
  const dec = text.match(/"Custom"\s*:\s*(\d+)/);
  if (dec) return parseInt(dec[1]!, 10);
  return null;
}

/** Best-effort human message for any error thrown by a transaction attempt. */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : errText(err);

  const code = extractProgramErrorCode(err);
  if (code !== null && PROGRAM_ERRORS[code]) return PROGRAM_ERRORS[code];
  if (code !== null) return `Program error ${code} — see the transaction logs for detail.`;

  // Wallet / RPC failure shapes.
  if (/user rejected|rejected the request|declined/i.test(raw))
    return "You declined the signature in your wallet — nothing was sent.";
  if (/invalid account data/i.test(raw))
    return "A required token account doesn't exist yet — place the bet again and the devnet faucet will set it up.";
  if (/insufficient (funds|lamports)/i.test(raw))
    return "Not enough devnet SOL to pay the transaction fee — airdrop some to this wallet (solana airdrop 1).";
  if (/blockhash|expired|block height exceeded/i.test(raw))
    return "The transaction expired before confirming — retry.";
  if (/429|rate limit/i.test(raw)) return "Devnet RPC is rate-limiting — wait a few seconds and retry.";
  if (/fetch failed|network|timed? ?out/i.test(raw)) return "Network problem talking to devnet — retry.";

  return raw;
}

/**
 * Detects the "wrong ledger" failure class specific to ER-fast trading
 * (docs/ER_TRADING_DESIGN.md §3): a transaction sent to the endpoint that no
 * longer (or doesn't yet) hold this account's authoritative state. Returns
 * a clear, actionable message when detected, or null if this doesn't look
 * like that — callers should fall back to `friendlyError` in that case.
 *
 * Three real, distinct shapes, all observed live during Phase 0/1 testing:
 *  1. Sent to the ER for an account that isn't (or is no longer) delegated
 *     there. The ER rejects this at the validator level, before program
 *     logic even runs — confirmed live: "InvalidAccountForFee" as the
 *     confirmTransaction err, with the log line "Feepayer ... was modified
 *     without being delegated", and `solana confirm` against the ER prints
 *     "This account may not be used to pay transaction fees".
 *  1b. Same class, different Solana runtime TransactionError variant:
 *     "InvalidWritableAccount" — observed live in the self-audit pass by
 *     racing a real out-of-band undelegate against a still-open browser tab
 *     whose cached router response hadn't caught up yet, then clicking
 *     Cancel. The ER rejected the write with this exact string (not
 *     InvalidAccountForFee that time), and since it wasn't in either
 *     pattern below it fell all the way through to friendlyError's raw
 *     fallback — a real "Transaction <sig> failed: ..." string overflowed
 *     the error box in the UI. Confirmed distinct enough (never seen outside
 *     this scenario) to intercept alongside case 1's message.
 *  2. Sent to base for an account that's STILL delegated (so base's copy is
 *     zeroed and owned by the Delegation Program, not this program) —
 *     surfaces as OnyxError::InvalidOwner (7001) from this program's own
 *     `is_owned_by(program_id)` checks in open_trading_account.rs /
 *     deposit_trading.rs / delegate_trading_account.rs / withdraw_trading.rs.
 *     Deliberately NOT intercepting 6006 (WrongStatus) here even though it
 *     COULD also stem from a ledger race — that code is reused for many
 *     unrelated "market isn't in the right state" conditions (e.g. a
 *     perfectly normal "already settled"), so masking all of them under a
 *     ledger-specific message would be actively misleading more often than
 *     it would help; its existing generic message already covers this case
 *     reasonably.
 */
export function classifyWrongLedger(err: unknown): string | null {
  const text = errText(err);

  if (
    /InvalidAccountForFee|was modified without being delegated|may not be used to pay transaction fees|InvalidWritableAccount/i.test(
      text,
    )
  ) {
    return "This account isn't delegated to the Ephemeral Rollup right now (it may have just undelegated, or the market hasn't been enabled for fast trading yet). Refreshing and retrying in a moment should fix this.";
  }

  const code = extractProgramErrorCode(err);
  if (code === 7001) {
    return "This account's ownership just changed — most likely the market moved between the Ephemeral Rollup and base right as you clicked (someone's transaction may have delegated, undelegated, or matched it). Refresh and try again.";
  }

  return null;
}
