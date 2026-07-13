// Shared sign-then-broadcast helpers. Both trading panels deliberately do
// their own explicit signTransaction + sendRawTransaction instead of
// wallet-adapter's sendTransaction — the wallet would broadcast through its
// OWN RPC and silently defeat ER routing (a swap meant for the Ephemeral
// Rollup would land on base, or nowhere). One implementation, one place to
// keep that discipline.
//
// Confirmation strategy (the "infinite spinner" fix): the websocket
// confirmTransaction stays the FAST path, but browser websockets to devnet
// drop routinely and web3.js then waits forever — so an HTTP status poll
// runs alongside it as the authority: it re-broadcasts the raw tx until it
// lands, detects blockhash expiry (the wallet-approval-took-too-long case),
// and enforces a hard timeout. Websocket errors are never trusted to fail a
// tx; only the poll (or an on-chain err) decides failure.

import type { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

export type SignTransactionFn = <T extends Transaction>(tx: T) => Promise<T>;

const CONFIRM_TIMEOUT_MS = 75_000;
// First status check comes early (ER swaps confirm in ~1s — when the WS
// notification drops, a 3s first poll was the whole perceived latency),
// then settles into a gentler cadence to stay under devnet rate limits.
const FIRST_POLL_MS = 700;
const POLL_MS = 1_500;
const REBROADCAST_MS = 5_000;

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/**
 * Broadcast an already-fully-signed transaction and run the WS+poll confirm
 * race. Exported for flows where the blockhash is fixed by a server partial
 * signature (e.g. /api/buy-usdc) — re-fetching a blockhash there would
 * invalidate the co-signer's signature.
 */
/** broadcast→confirm time of the most recent successful send — the on-chain
 *  execution latency, excluding wallet-approval wait and any follow-up I/O. */
let lastExecMs: number | null = null;
export const lastExecutionMs = () => lastExecMs;

export async function broadcastAndConfirm(
  conn: Connection,
  raw: Buffer | Uint8Array,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<string> {
  lastExecMs = null;
  const tSend = performance.now();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true });
  return await new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        fn();
      }
    };
    const confirmed = () =>
      finish(() => {
        lastExecMs = Math.round(performance.now() - tSend);
        resolve(sig);
      });
    const txFailed = (err: unknown) =>
      finish(() => reject(new Error(`Transaction ${sig} failed: ${JSON.stringify(err)}`)));

    // Fast path. Rejections here are NOT authoritative (WS flake ≠ failure).
    conn
      .confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")
      .then((conf) => (conf.value.err ? txFailed(conf.value.err) : confirmed()))
      .catch(() => {});

    // Authority path: status poll + re-broadcast + expiry + hard cap.
    (async () => {
      const t0 = Date.now();
      let lastSend = t0;
      let firstPoll = true;
      while (!done && Date.now() - t0 < CONFIRM_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, firstPoll ? FIRST_POLL_MS : POLL_MS));
        firstPoll = false;
        if (done) return;
        try {
          const st = (await conn.getSignatureStatuses([sig])).value[0];
          if (st?.err) return txFailed(st.err);
          if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
            return confirmed();
          }
          if (!st) {
            const height = await conn.getBlockHeight("confirmed");
            if (height > lastValidBlockHeight) {
              return finish(() =>
                reject(
                  new Error(
                    "Transaction expired before it could land — usually the wallet approval took too long. Nothing was executed; please try again.",
                  ),
                ),
              );
            }
            if (Date.now() - lastSend >= REBROADCAST_MS) {
              lastSend = Date.now();
              await conn.sendRawTransaction(raw, { skipPreflight: true }).catch(() => {});
            }
          }
        } catch {
          // transient RPC error — keep polling until the hard cap
        }
      }
      finish(() =>
        reject(
          new Error(
            `No confirmation after ${CONFIRM_TIMEOUT_MS / 1000}s — devnet may be congested. Check ${explorerTx(sig)} before retrying.`,
          ),
        ),
      );
    })();
  });
}

/**
 * Wallet-signed path: one popup. feePayer = the wallet. `extraSigners` are
 * partial-signed BEFORE the wallet popup (e.g. the ephemeral session key
 * co-signing create_session).
 */
export async function sendViaWallet(
  conn: Connection,
  tx: Transaction,
  publicKey: PublicKey,
  signTransaction: SignTransactionFn,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;
  for (const s of extraSigners) tx.partialSign(s);
  const signed = await signTransaction(tx);
  return broadcastAndConfirm(conn, signed.serialize(), blockhash, lastValidBlockHeight);
}

/**
 * Keypair-signed path: no popup. Used by session trading (ER-only — fees are
 * validator-sponsored there, so the keypair needs zero SOL).
 */
export async function sendViaKeypair(conn: Connection, tx: Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  return broadcastAndConfirm(conn, tx.serialize(), blockhash, lastValidBlockHeight);
}
