// Shared AMM trade actions — the ONE implementation of the flows both the
// market-page trade panel and the lobby quick-trade modal run. Extracted so
// the modal can't fork the logic (same instruction bundle, same recording,
// same session handling).

import { PublicKey, Transaction, ComputeBudgetProgram, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection, getConfigUsdcMint } from "./onchain";
import { sendViaWallet, sendViaKeypair, type SignTransactionFn } from "./tx";
import {
  type TradingSession,
  createSessionKeypair,
  saveSession,
  sessionTokenPda,
  buildCreateSessionIx,
} from "./session";
import {
  buildOpenAmmPositionIx,
  buildDepositAmmIx,
  buildSwapAmmIx,
  buildDelegateMarketIx,
  buildDelegateAmmPoolIx,
  buildDelegateAmmPositionIx,
} from "./instructions";

export const CLUSTER = "devnet";

/** Wallet's test-USDC balance in base units (0n if no ATA yet). */
export async function walletUsdcBalance(owner: PublicKey): Promise<bigint> {
  const mint = await getConfigUsdcMint();
  if (!mint) return 0n;
  const ata = getAssociatedTokenAddressSync(mint, owner);
  return getConnection()
    .getTokenAccountBalance(ata)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
}

/**
 * The "Enable 1-click trading" bundle — ONE wallet signature covering:
 * scoped session key mint + open position (if needed) + deposit + delegate
 * market/pool (if not yet on the ER) + delegate position. Persists the
 * session only after on-chain confirmation. Returns the new session.
 */
export async function startSessionAndDeposit(params: {
  owner: PublicKey;
  market: PublicKey;
  amount: bigint;
  hasPosition: boolean;
  isDelegated: boolean;
  signTransaction: SignTransactionFn;
}): Promise<{ session: TradingSession; sig: string }> {
  const { owner, market, amount, hasPosition, isDelegated, signTransaction } = params;
  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) throw new Error("config not initialized on devnet yet");

  const fresh = createSessionKeypair();
  const ixs = [buildCreateSessionIx({ authority: owner, sessionSigner: fresh.keypair.publicKey, validUntil: fresh.expiry })];
  if (!hasPosition) ixs.push(buildOpenAmmPositionIx({ owner, market }).ix);
  ixs.push(buildDepositAmmIx({ owner, market, amount, usdcMint }));
  if (!isDelegated) {
    ixs.push(buildDelegateMarketIx({ payer: owner, market }));
    ixs.push(buildDelegateAmmPoolIx({ payer: owner, market }));
  }
  ixs.push(buildDelegateAmmPositionIx({ payer: owner, market, owner }));
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...ixs);
  const sig = await sendViaWallet(getConnection(), tx, owner, signTransaction, [fresh.keypair]);
  saveSession(CLUSTER, owner, fresh);
  return { session: fresh, sig };
}

/** Plain deposit (open if needed) — wallet signs; trading then needs per-trade approval. */
export async function depositOnly(params: {
  owner: PublicKey;
  market: PublicKey;
  amount: bigint;
  hasPosition: boolean;
  signTransaction: SignTransactionFn;
}): Promise<string> {
  const { owner, market, amount, hasPosition, signTransaction } = params;
  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) throw new Error("config not initialized on devnet yet");
  const ixs = [];
  if (!hasPosition) ixs.push(buildOpenAmmPositionIx({ owner, market }).ix);
  ixs.push(buildDepositAmmIx({ owner, market, amount, usdcMint }));
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs);
  return sendViaWallet(getConnection(), tx, owner, signTransaction);
}

/**
 * One swap on whichever ledger holds the pool. Session-signed (popup-free)
 * when a live session is provided and the pool is on the ER; wallet-signed
 * otherwise. Records the trade to /api/history (real sig) and returns it.
 */
export async function executeSwap(params: {
  owner: PublicKey;
  market: PublicKey;
  connection: Connection;
  isDelegated: boolean;
  side: number;
  direction: number;
  amountIn: bigint;
  minOut: bigint;
  session: TradingSession | null;
  signTransaction: SignTransactionFn;
}): Promise<{ sig: string; viaSession: boolean }> {
  const { owner, market, connection, isDelegated, side, direction, amountIn, minOut, session, signTransaction } = params;
  const useSession = isDelegated && session !== null && session.expiry * 1000 > Date.now();
  const ix = buildSwapAmmIx({
    owner,
    market,
    side,
    direction,
    amountIn,
    minOut,
    ...(useSession
      ? { sessionSigner: session.keypair.publicKey, sessionToken: sessionTokenPda(session.keypair.publicKey, owner) }
      : {}),
  });
  const tx = new Transaction().add(ix);
  const sig = useSession
    ? await sendViaKeypair(connection, tx, session.keypair)
    : await sendViaWallet(connection, tx, owner, signTransaction);
  // Recent-trades feed: await so the caller's invalidate sees the new row.
  await fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market: market.toBase58(), side, dir: direction, amountIn: amountIn.toString(), sig }),
  }).catch(() => {});
  return { sig, viaSession: useSession };
}
