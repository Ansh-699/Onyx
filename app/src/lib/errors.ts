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
  7000: "An account didn't match its expected derivation (client bug — please report).",
  7001: "Account owner mismatch (client bug — please report).",
  7002: "Malformed instruction data (client bug — please report).",
  7003: "Unexpected account size (client bug — please report).",
  7004: "A required signature is missing.",
  7005: "Arithmetic overflow in payout math — please report this.",
  7006: "The oracle CPI failed transiently — retry. This is not a settlement outcome.",
};

/** Pull a Custom(NNNN) program error code out of any web3.js error shape. */
export function extractProgramErrorCode(err: unknown): number | null {
  const text =
    err instanceof Error
      ? `${err.message}\n${(err as Error & { logs?: string[] }).logs?.join("\n") ?? ""}`
      : String(err);
  const hex = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1]!, 16);
  const dec = text.match(/"Custom"\s*:\s*(\d+)/);
  if (dec) return parseInt(dec[1]!, 10);
  return null;
}

/** Best-effort human message for any error thrown by a transaction attempt. */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

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
