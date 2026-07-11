// MagicBlock session keys (gpl_session) — client side. One wallet popup
// mints a SessionToken binding (wallet, ONYX, ephemeral key, expiry); after
// that the ephemeral key signs swaps silently. The key lives in
// localStorage: XSS-readable by design, acceptable because the program
// scope-limits it to swap_amm — it can never move funds out (see
// docs/SESSION_TRADING.md). We build the two gpl_session instructions by
// hand instead of pulling their React SDK for ~40 lines of encoding.

import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ONYX_PROGRAM_ID } from "./onchain";

export const SESSION_KEYS_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");

// Anchor global discriminators: sha256("global:<name>")[..8].
const CREATE_SESSION_DISC = Uint8Array.from([242, 193, 143, 179, 150, 25, 122, 227]);
const REVOKE_SESSION_DISC = Uint8Array.from([86, 92, 198, 120, 144, 2, 7, 194]);

export const SESSION_DURATION_SEC = 4 * 60 * 60; // 4h default; gpl_session caps at 7d

export interface TradingSession {
  keypair: Keypair;
  /** unix seconds — mirrors the on-chain SessionToken.valid_until */
  expiry: number;
}

const storageKey = (cluster: string, wallet: PublicKey) => `onyx:session:${cluster}:${wallet.toBase58()}`;

export function sessionTokenPda(sessionSigner: PublicKey, authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session_token"), ONYX_PROGRAM_ID.toBuffer(), sessionSigner.toBuffer(), authority.toBuffer()],
    SESSION_KEYS_PROGRAM_ID,
  )[0];
}

export function loadSession(cluster: string, wallet: PublicKey): TradingSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(cluster, wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { secret: string; expiry: number };
    if (parsed.expiry * 1000 <= Date.now()) {
      window.localStorage.removeItem(storageKey(cluster, wallet));
      return null;
    }
    return { keypair: Keypair.fromSecretKey(Uint8Array.from(Buffer.from(parsed.secret, "base64"))), expiry: parsed.expiry };
  } catch {
    return null;
  }
}

export function createSessionKeypair(): TradingSession {
  return { keypair: Keypair.generate(), expiry: Math.floor(Date.now() / 1000) + SESSION_DURATION_SEC };
}

/** Persist only AFTER the create_session tx confirms — an unconfirmed key is garbage. */
export function saveSession(cluster: string, wallet: PublicKey, session: TradingSession): void {
  window.localStorage.setItem(
    storageKey(cluster, wallet),
    JSON.stringify({ secret: Buffer.from(session.keypair.secretKey).toString("base64"), expiry: session.expiry }),
  );
}

export function clearSession(cluster: string, wallet: PublicKey): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(storageKey(cluster, wallet));
}

/**
 * gpl_session create_session. Signers: BOTH authority (wallet) and
 * session_signer (ephemeral) — their program requires the double signature,
 * which is what makes tokens unforgeable. topUp = false always: session
 * trading is ER-only where fees are validator-sponsored, so the ephemeral
 * key never needs SOL.
 */
export function buildCreateSessionIx(params: { authority: PublicKey; sessionSigner: PublicKey; validUntil: number }): TransactionInstruction {
  const { authority, sessionSigner, validUntil } = params;
  // args: top_up Option<bool> = Some(false), valid_until Option<i64>, lamports Option<u64> = None
  const data = Buffer.alloc(8 + 2 + 9 + 1);
  data.set(CREATE_SESSION_DISC, 0);
  let o = 8;
  data[o++] = 1; // Some
  data[o++] = 0; // false
  data[o++] = 1; // Some
  data.writeBigInt64LE(BigInt(validUntil), o);
  o += 8;
  data[o++] = 0; // None
  return new TransactionInstruction({
    programId: SESSION_KEYS_PROGRAM_ID,
    keys: [
      { pubkey: sessionTokenPda(sessionSigner, authority), isSigner: false, isWritable: true },
      { pubkey: sessionSigner, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: ONYX_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * gpl_session revoke_session — closes the token, rent back to the wallet.
 * Deliberately permissionless upstream (anyone can kill a leaked session);
 * no signer needed beyond the fee payer.
 */
export function buildRevokeSessionIx(params: { authority: PublicKey; sessionSigner: PublicKey }): TransactionInstruction {
  const { authority, sessionSigner } = params;
  return new TransactionInstruction({
    programId: SESSION_KEYS_PROGRAM_ID,
    keys: [
      { pubkey: sessionTokenPda(sessionSigner, authority), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(REVOKE_SESSION_DISC),
  });
}
