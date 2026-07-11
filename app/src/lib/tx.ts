// Shared sign-then-broadcast helpers. Both trading panels deliberately do
// their own explicit signTransaction + sendRawTransaction instead of
// wallet-adapter's sendTransaction — the wallet would broadcast through its
// OWN RPC and silently defeat ER routing (a swap meant for the Ephemeral
// Rollup would land on base, or nowhere). One implementation, one place to
// keep that discipline.

import type { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

export type SignTransactionFn = <T extends Transaction>(tx: T) => Promise<T>;

/** Wallet-signed path: one popup. feePayer = the wallet. */
export async function sendViaWallet(
  conn: Connection,
  tx: Transaction,
  publicKey: PublicKey,
  signTransaction: SignTransactionFn,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = publicKey;
  const signed = await signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
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
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}
