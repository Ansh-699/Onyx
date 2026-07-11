"use client";

// AMM continuous trading — the lead panel for a market with an AMM pool
// (docs/AMM_TRADING_DESIGN.md Phase D). Polymarket-style sell-anytime: the
// pool is the counterparty, so buys AND sells fill instantly at the curve's
// price with no matching window and no counterparty wait.
//
// Behaviors that must never regress:
// - Every quote comes from lib/ammMath.ts — the SAME BigInt math the
//   on-chain program runs (proven unit-exact in the Phase B devnet proof:
//   min_out was set to the exact predicted output on every swap and all
//   landed). The quote's min-received figure IS the on-chain min_out arg —
//   slippage protection is enforced by the program (SlippageExceeded 6026),
//   never advisory.
// - deposit/redeem/withdraw-LP/delegate always go to BASE; swaps go to
//   whichever connection currently holds the POOL (resolved by the parent
//   via useRoutedAmmPool) — same explicit sign-then-send routing as
//   ErTradingPanel (never wallet-adapter's sendTransaction, which would
//   broadcast through the wallet's own RPC and silently defeat ER routing).
// - Honesty rails: AMM markets are NOT MEV-protected (ordering belongs to
//   the ER sequencer / base leader) — disclosed inline, with the sealed
//   flow named as the MEV-proof alternative. The LP's capital is genuinely
//   at risk (observed live both ways in the Phase C runs) — disclosed on
//   the LP card.

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, ComputeBudgetProgram, type Connection } from "@solana/web3.js";
import {
  type OnChainMarket,
  type OnChainAmmPool,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  OUTCOME_SIDE_A,
  SETTLE_GRACE_SEC,
  getConfigUsdcMint,
  getConnection,
  explorerTxUrl,
} from "@/lib/onchain";
import { invalidateDelegationStatus } from "@/lib/erRouting";
import { useAmmPosition } from "@/lib/hooks";
import {
  type TradingSession,
  loadSession,
  createSessionKeypair,
  saveSession,
  clearSession,
  sessionTokenPda,
  buildCreateSessionIx,
  buildRevokeSessionIx,
} from "@/lib/session";
import { friendlyError, classifyWrongLedger } from "@/lib/errors";
import {
  buildOpenAmmPositionIx,
  buildDepositAmmIx,
  buildSwapAmmIx,
  buildRedeemAmmIx,
  buildWithdrawLpAmmIx,
  buildDelegateMarketIx,
  buildDelegateAmmPoolIx,
  buildDelegateAmmPositionIx,
  buildUndelegateManyIx,
  ammPoolPda,
  ammPositionPda,
  SIDE_A,
  SIDE_B,
  SWAP_BUY,
  SWAP_SELL,
} from "@/lib/instructions";
import { quoteBuy, quoteSell, spotPriceScaled, minOutForTolerance, buyImpactBps } from "@/lib/ammMath";
import { WalletButton } from "@/components/WalletButton";
import { fmtUsdc } from "@/components/market/format";
import styles from "./ErTradingPanel.module.css";

/** Whole test-USDC string -> 6dp base units, or null if invalid. */
function toBase(input: string): bigint | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  const base = Math.round(n * 1_000_000);
  if (base <= 0 || base > Number.MAX_SAFE_INTEGER) return null;
  return BigInt(base);
}
/** Tolerance % string (0..50) -> bps, or null. 0 is allowed — "exact fill or revert". */
function tolToBps(input: string): number | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0 || n > 50) return null;
  return Math.round(n * 100);
}
const pct = (scaled: bigint) => `${(Number(scaled) / 10_000).toFixed(1)}%`;
const CLUSTER = "devnet";

export function AmmTradingPanel({
  market,
  pool,
  isDelegated,
  connection,
}: {
  market: OnChainMarket;
  pool: OnChainAmmPool;
  isDelegated: boolean;
  connection: Connection;
}) {
  const queryClient = useQueryClient();
  const { publicKey, signTransaction, connected } = useWallet();

  const marketPk = useMemo(() => new PublicKey(market.pda), [market.pda]);
  const myPosition = useAmmPosition(market.pda, publicKey, connection);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ label: string; sig: string; ms: number }[]>([]);

  const [depositUsdc, setDepositUsdc] = useState("2");
  const [side, setSide] = useState<number>(SIDE_A);
  const [direction, setDirection] = useState<number>(SWAP_BUY);
  const [amountStr, setAmountStr] = useState("0.5");
  const [tolStr, setTolStr] = useState("1.0");
  // Trading session (MagicBlock session keys): ephemeral browser key that
  // signs ER swaps popup-free; the wallet signed one create_session tx to
  // scope it. Loaded per wallet; null = no live session.
  const [session, setSession] = useState<TradingSession | null>(null);
  useEffect(() => {
    setSession(publicKey ? loadSession(CLUSTER, publicKey) : null);
  }, [publicKey]);

  const settled = market.status === STATUS_SETTLED || market.status === STATUS_CLAIMED;
  const deadlinePassed = Math.floor(Date.now() / 1000) >= Number(market.deadline);
  const tradingOpen = !settled && !deadlinePassed;
  // Mirrors the program gate (strict >): never-settled market past
  // deadline + grace opens the expiry-refund path in redeem/withdraw_lp.
  const expired = !settled && Math.floor(Date.now() / 1000) > Number(market.deadline) + SETTLE_GRACE_SEC;

  const priceA = spotPriceScaled(pool.reserveA, pool.reserveB);
  const priceB = 1_000_000n - priceA;

  const position = myPosition.data;
  const isLp = connected && publicKey?.toBase58() === pool.lpOwner;

  // ---- live quote (recomputed every render from the freshest pool read) ----
  const amountIn = toBase(amountStr);
  const tolBps = tolToBps(tolStr);
  const quote = useMemo(() => {
    if (!amountIn || tolBps === null) return null;
    if (direction === SWAP_BUY) {
      const q = side === SIDE_A ? quoteBuy(pool.reserveA, pool.reserveB, amountIn, pool.feeBps) : quoteBuy(pool.reserveB, pool.reserveA, amountIn, pool.feeBps);
      if (!q) return null;
      return {
        kind: "buy" as const,
        out: q.tokensOut,
        minOut: minOutForTolerance(q.tokensOut, tolBps),
        fee: q.fee,
        impactBps: side === SIDE_A ? buyImpactBps(pool.reserveA, pool.reserveB, q) : buyImpactBps(pool.reserveB, pool.reserveA, q),
      };
    }
    const q = side === SIDE_A ? quoteSell(pool.reserveA, pool.reserveB, amountIn, pool.feeBps) : quoteSell(pool.reserveB, pool.reserveA, amountIn, pool.feeBps);
    if (!q) return null;
    return { kind: "sell" as const, out: q.netOut, minOut: minOutForTolerance(q.netOut, tolBps), fee: q.fee, impactBps: 0 };
  }, [amountIn, tolBps, direction, side, pool.reserveA, pool.reserveB, pool.feeBps]);

  const held = direction === SWAP_SELL ? (side === SIDE_A ? (position?.tokensA ?? 0n) : (position?.tokensB ?? 0n)) : (position?.usdcAvailable ?? 0n);
  const insufficient = amountIn !== null && amountIn > held;

  async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    const ms = Math.round(performance.now() - t0);
    if (typeof result === "string") setLog((prev) => [{ label, sig: result, ms }, ...prev].slice(0, 8));
    return result;
  }

  // Same explicit sign-then-broadcast as ErTradingPanel (see that file's
  // comment for why wallet-adapter's sendTransaction would break ER routing).
  async function sendVia(conn: Connection, tx: Transaction): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error("wallet not connected");
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = publicKey;
    const signed = await signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  // Popup-free path: the session keypair signs locally — no wallet call at
  // all. ER-only (ER fees are validator-sponsored, so the session key needs
  // zero SOL; on base a fee payer must burn real lamports).
  async function sendViaSession(conn: Connection, tx: Transaction, s: TradingSession): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = s.keypair.publicKey;
    tx.sign(s.keypair);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  async function refreshAll() {
    invalidateDelegationStatus(ammPoolPda(marketPk));
    invalidateDelegationStatus(marketPk);
    await queryClient.invalidateQueries();
  }

  async function withGuard(label: string, fn: () => Promise<void>) {
    setError(null);
    setBusy(label);
    try {
      await fn();
      await refreshAll();
    } catch (err) {
      const ledgerHint = classifyWrongLedger(err);
      setError(ledgerHint ?? friendlyError(err));
      if (ledgerHint) await refreshAll();
    } finally {
      setBusy(null);
    }
  }

  async function onDeposit() {
    const amount = toBase(depositUsdc);
    if (!amount || !publicKey) return;
    await withGuard("Getting devnet test-USDC…", async () => {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized on devnet yet");
      const faucetRes = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: publicKey.toBase58() }),
      });
      const faucetBody = await faucetRes.json();
      if (!faucetRes.ok || !faucetBody.ok) throw new Error(`devnet faucet failed: ${faucetBody.error ?? faucetRes.status}`);

      setBusy("Deposit (one signature)…");
      const ixs = [];
      if (!position) ixs.push(buildOpenAmmPositionIx({ owner: publicKey, market: marketPk }).ix);
      ixs.push(buildDepositAmmIx({ owner: publicKey, market: marketPk, amount, usdcMint }));
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...ixs);
      await timed(position ? "deposit_amm" : "open_amm_position + deposit_amm", () => sendVia(getConnection(), tx));
    });
  }

  // "Start trading session" — ONE wallet popup for everything: faucet
  // top-up, then a single tx that mints the MagicBlock SessionToken, opens
  // + funds the position, and delegates it (plus market+pool if this market
  // isn't on the ER yet). After this, every swap is popup-free.
  async function onStartSession() {
    const amount = toBase(depositUsdc);
    if (!amount || !publicKey || !signTransaction) return;
    await withGuard("Getting devnet test-USDC…", async () => {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized on devnet yet");
      const faucetRes = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: publicKey.toBase58() }),
      });
      const faucetBody = await faucetRes.json();
      if (!faucetRes.ok || !faucetBody.ok) throw new Error(`devnet faucet failed: ${faucetBody.error ?? faucetRes.status}`);

      setBusy("Starting session (one signature)…");
      const fresh = createSessionKeypair();
      const ixs = [
        buildCreateSessionIx({ authority: publicKey, sessionSigner: fresh.keypair.publicKey, validUntil: fresh.expiry }),
      ];
      if (!position) ixs.push(buildOpenAmmPositionIx({ owner: publicKey, market: marketPk }).ix);
      ixs.push(buildDepositAmmIx({ owner: publicKey, market: marketPk, amount, usdcMint }));
      if (!isDelegated) {
        ixs.push(buildDelegateMarketIx({ payer: publicKey, market: marketPk }));
        ixs.push(buildDelegateAmmPoolIx({ payer: publicKey, market: marketPk }));
      }
      ixs.push(buildDelegateAmmPositionIx({ payer: publicKey, market: marketPk, owner: publicKey }));
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ...ixs);
      // Two signers: the wallet (fee payer + session authority) and the
      // ephemeral key (gpl_session requires the session_signer to co-sign).
      const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      tx.partialSign(fresh.keypair);
      const signed = await signTransaction(tx);
      const sig = await getConnection().sendRawTransaction(signed.serialize(), { skipPreflight: true });
      const conf = await getConnection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`Transaction ${sig} failed: ${JSON.stringify(conf.value.err)}`);
      setLog((prev) => [{ label: "start session (create+deposit+delegate)", sig, ms: 0 }, ...prev].slice(0, 8));
      // Persist only after confirmation — an unconfirmed key is garbage.
      saveSession(CLUSTER, publicKey, fresh);
      setSession(fresh);
    });
  }

  async function onEndSession() {
    if (!publicKey || !session) return;
    await withGuard("Ending session…", async () => {
      const ix = buildRevokeSessionIx({ authority: publicKey, sessionSigner: session.keypair.publicKey });
      await timed("revoke_session", () => sendVia(getConnection(), new Transaction().add(ix)));
      clearSession(CLUSTER, publicKey);
      setSession(null);
    });
  }

  async function onSwap(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey || !amountIn || !quote) return;
    // Session path: ER-delegated + live session = popup-free, signed by the
    // browser-held session key with the SessionToken proving its scope.
    const useSession = isDelegated && session !== null && session.expiry * 1000 > Date.now();
    const dirWord = direction === SWAP_BUY ? "Buying" : "Selling";
    await withGuard(
      `${dirWord} on ${isDelegated ? "the Ephemeral Rollup" : "base devnet"}${useSession ? " (session-signed, no popup)" : ""}…`,
      async () => {
        const ix = buildSwapAmmIx({
          owner: publicKey,
          market: marketPk,
          side,
          direction,
          amountIn,
          minOut: quote.minOut, // the quote's min-received — enforced on-chain (6026 if beaten)
          ...(useSession
            ? {
                sessionSigner: session.keypair.publicKey,
                sessionToken: sessionTokenPda(session.keypair.publicKey, publicKey),
              }
            : {}),
        });
        await timed(`swap_amm (${direction === SWAP_BUY ? "buy" : "sell"} ${side === SIDE_A ? "A" : "B"})`, () =>
          useSession
            ? sendViaSession(connection, new Transaction().add(ix), session)
            : sendVia(connection, new Transaction().add(ix)),
        );
      },
    );
  }

  async function onAccelerate() {
    if (!publicKey) return;
    await withGuard("Delegating market + pool + your position to the ER…", async () => {
      // Three delegations, one signature: after this, swaps confirm on the
      // ER in ~1s and cost the trader nothing (validator-sponsored fees).
      const ixs = [
        buildDelegateMarketIx({ payer: publicKey, market: marketPk }),
        buildDelegateAmmPoolIx({ payer: publicKey, market: marketPk }),
        buildDelegateAmmPositionIx({ payer: publicKey, market: marketPk, owner: publicKey }),
      ];
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
      await timed("delegate market+pool+position", () => sendVia(getConnection(), tx));
    });
  }

  async function onDelegateMyPosition() {
    if (!publicKey) return;
    await withGuard("Delegating your position to the ER…", async () => {
      const ix = buildDelegateAmmPositionIx({ payer: publicKey, market: marketPk, owner: publicKey });
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix);
      await timed("delegate_amm_position", () => sendVia(getConnection(), tx));
    });
  }

  async function onMoveToBase() {
    if (!publicKey) return;
    await withGuard("Moving market + pool + your position back to base…", async () => {
      const delegated = [marketPk, ammPoolPda(marketPk), ammPositionPda(marketPk, publicKey)];
      const ix = buildUndelegateManyIx({ payer: publicKey, delegated });
      await timed("undelegate (market+pool+position)", () => sendVia(connection, new Transaction().add(ix)));
    });
  }

  async function onRedeem() {
    if (!publicKey) return;
    await withGuard("Redeeming…", async () => {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const ix = buildRedeemAmmIx({ owner: publicKey, market: marketPk, usdcMint });
      await timed("redeem_amm", () => sendVia(getConnection(), new Transaction().add(ix)));
    });
  }

  async function onWithdrawLp() {
    if (!publicKey) return;
    await withGuard("Withdrawing LP capital + fees…", async () => {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const ix = buildWithdrawLpAmmIx({ lpOwner: publicKey, market: marketPk, usdcMint });
      await timed("withdraw_lp_amm", () => sendVia(getConnection(), new Transaction().add(ix)));
    });
  }

  const winningTokens = settled ? (market.outcome === OUTCOME_SIDE_A ? (position?.tokensA ?? 0n) : (position?.tokensB ?? 0n)) : 0n;
  // Expiry pays the riskless complete-set component; the directional residual dies.
  const setTokens = position ? (position.tokensA < position.tokensB ? position.tokensA : position.tokensB) : 0n;
  const redeemable =
    (position?.usdcAvailable ?? 0n) +
    (position?.redeemed ? 0n : settled ? winningTokens : expired ? setTokens : 0n);

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.head}>
        <span className={styles.title}>
          <span className={styles.bolt}>⇄</span> Trade anytime (AMM)
        </span>
        <span className="pill" data-tone={isDelegated ? "green" : "accent"}>
          {isDelegated ? "live on ER" : "base"}
        </span>
      </div>
      <p className={styles.blurb}>
        The pool is the counterparty: buy or <strong>sell</strong> outcome tokens at any moment before the
        deadline — no matching window, no waiting for the other side. Real seeded liquidity
        ({fmtUsdc(pool.seedAmount)} tUSDC), {pool.feeBps / 100}% fee to the LP.
      </p>
      <div className={styles.ledgerRow}>
        <span className={styles.ledgerDot} data-live={isDelegated} aria-hidden />
        {isDelegated ? "swaps confirm on the Ephemeral Rollup (~1s)" : "swaps confirm on base devnet (~1-2s)"}
      </div>

      {/* live prices straight from reserves */}
      <div className={styles.sides} role="group" aria-label="Live prices">
        {(
          [
            { id: SIDE_A, name: "Side A · YES", price: priceA, reserve: pool.reserveA },
            { id: SIDE_B, name: "Side B · NO", price: priceB, reserve: pool.reserveB },
          ] as const
        ).map((s) => (
          <button
            key={s.id}
            type="button"
            className={styles.sideBtn}
            data-active={side === s.id}
            onClick={() => setSide(s.id)}
            aria-pressed={side === s.id}
            data-testid={`amm-side-${s.id === SIDE_A ? "a" : "b"}`}
          >
            <span className={styles.sideName}>{s.name}</span>
            <span className={styles.sideShare}>
              {pct(s.price)} · reserve {fmtUsdc(s.reserve)}
            </span>
          </button>
        ))}
      </div>

      {!connected && <WalletButton />}

      {connected && tradingOpen && (!position || position.usdcAvailable === 0n) && (position?.tokensA ?? 0n) === 0n && (position?.tokensB ?? 0n) === 0n && (
        <div className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>1</span> Start a trading session
          </div>
          <p className={styles.blurb}>
            One signature: funds your position AND mints a scoped MagicBlock session key — every trade after this
            is instant, popup-free, and gas-free on the Ephemeral Rollup. The session key can only swap; it can
            never withdraw your funds. Expires in 4h or when you end it.
          </p>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Deposit (test-USDC)</span>
              <input value={depositUsdc} onChange={(e) => setDepositUsdc(e.target.value)} inputMode="decimal" placeholder="2" data-testid="amm-deposit-input" />
            </label>
          </div>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <button className="button" type="button" onClick={onStartSession} disabled={!!busy || !toBase(depositUsdc)} data-testid="amm-session-btn">
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> {busy}
                </>
              ) : (
                "Start session (1 signature)"
              )}
            </button>
            <button className="button" data-variant="ghost" type="button" onClick={onDeposit} disabled={!!busy || !toBase(depositUsdc)} data-testid="amm-deposit-btn">
              Deposit only (sign each trade)
            </button>
          </div>
        </div>
      )}

      {/* session status chip */}
      {connected && session && tradingOpen && (
        <div className={styles.availRow} data-testid="amm-session-chip">
          <span>
            <span aria-hidden style={{ background: "var(--green)", display: "inline-block", width: 7, height: 7, borderRadius: "50%", marginRight: 6 }} />
            Session active · expires {new Date(session.expiry * 1000).toLocaleTimeString()} · trades are popup-free
            {isDelegated ? "" : " once this market is on the ER"}
          </span>
          <button type="button" className="button" data-variant="ghost" style={{ padding: "2px 10px", fontSize: "0.75rem" }} onClick={onEndSession} disabled={!!busy}>
            End session
          </button>
        </div>
      )}

      {connected && position && tradingOpen && (
        <form onSubmit={onSwap} className={styles.form}>
          <div className={styles.availRow}>
            <span>
              Available: {fmtUsdc(position.usdcAvailable)} tUSDC · {fmtUsdc(position.tokensA)} A · {fmtUsdc(position.tokensB)} B
            </span>
            <button
              type="button"
              className="button"
              data-variant="ghost"
              style={{ padding: "2px 10px", fontSize: "0.75rem" }}
              onClick={onDeposit}
              disabled={!!busy}
            >
              + deposit more
            </button>
          </div>

          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Action</span>
              <select value={direction} onChange={(e) => setDirection(Number(e.target.value))} data-testid="amm-direction">
                <option value={SWAP_BUY}>Buy {side === SIDE_A ? "A" : "B"} (spend tUSDC)</option>
                <option value={SWAP_SELL}>Sell {side === SIDE_A ? "A" : "B"} (receive tUSDC)</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{direction === SWAP_BUY ? "Spend (tUSDC)" : `Sell (${side === SIDE_A ? "A" : "B"} tokens)`}</span>
              <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} inputMode="decimal" placeholder="0.5" data-testid="amm-amount" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Slippage tolerance (%)</span>
              <input value={tolStr} onChange={(e) => setTolStr(e.target.value)} inputMode="decimal" placeholder="1.0" data-testid="amm-tolerance" />
            </label>
          </div>

          {quote && (
            <div className={styles.availRow} data-testid="amm-quote">
              <span>
                {direction === SWAP_BUY ? (
                  <>
                    ≈ <strong>{fmtUsdc(quote.out)}</strong> {side === SIDE_A ? "A" : "B"} tokens
                    {quote.impactBps > 0 && ` · impact ${(quote.impactBps / 100).toFixed(2)}%`}
                  </>
                ) : (
                  <>
                    ≈ <strong>{fmtUsdc(quote.out)}</strong> tUSDC back
                  </>
                )}{" "}
                · fee {fmtUsdc(quote.fee)}
              </span>
              <span title="Encoded into the transaction as min_out — the program reverts with SlippageExceeded if the fill would be worse. On-chain enforcement, not a UI promise.">
                min received: <strong data-testid="amm-minout">{fmtUsdc(quote.minOut)}</strong>
              </span>
            </div>
          )}

          <button className="button" type="submit" disabled={!!busy || !quote || insufficient} data-testid="amm-swap-btn">
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {busy}
              </>
            ) : insufficient ? (
              direction === SWAP_BUY ? "Not enough deposited tUSDC" : "Not enough tokens"
            ) : (
              `${direction === SWAP_BUY ? "Buy" : "Sell"} ${side === SIDE_A ? "Side A" : "Side B"} ${isDelegated ? "(ER)" : ""}`
            )}
          </button>
        </form>
      )}

      {/* ER acceleration — optional, additive; swaps work on base too */}
      {connected && position && tradingOpen && !isDelegated && (
        <div className={styles.step}>
          <div className={styles.stepHead}>⚡ Accelerate on the Ephemeral Rollup</div>
          <p className={styles.blurb}>
            Delegates the market, pool, and your position to MagicBlock&apos;s ER — swaps then confirm in ~1s with
            validator-sponsored fees. Proven live with 4 wallets swapping concurrently (see BUILD_STATE).
          </p>
          <button className="button" data-variant="ghost" type="button" onClick={onAccelerate} disabled={!!busy}>
            Delegate market + pool + my position
          </button>
        </div>
      )}
      {connected && tradingOpen && isDelegated && !position && myPosition.isFetched && (
        <div className={styles.step}>
          <div className={styles.stepHead}>Pool is on the ER — bring your position along</div>
          <p className={styles.blurb}>
            Your position account isn&apos;t delegated yet (or doesn&apos;t exist — deposit first on base, then
            delegate it). Swaps need both pool and position on the same ledger.
          </p>
          <button className="button" data-variant="ghost" type="button" onClick={onDelegateMyPosition} disabled={!!busy}>
            Delegate my position
          </button>
        </div>
      )}
      {connected && isDelegated && (settled || deadlinePassed) && (
        <div className={styles.step}>
          <div className={styles.stepHead}>Trading closed — move state back to base</div>
          <p className={styles.blurb}>Undelegates market + pool + your position so settlement and redemption can run on base.</p>
          <button className="button" type="button" onClick={onMoveToBase} disabled={!!busy}>
            Move to base (undelegate)
          </button>
        </div>
      )}

      {/* position card + redeem */}
      {connected && position && (redeemable > 0n || settled || expired) && !isDelegated && (
        <div className={styles.payout}>
          <span className={styles.fieldLabel}>Your position</span>
          <span className={styles.payoutBig} data-testid="amm-redeemable">
            {settled || expired
              ? position.redeemed
                ? "Redeemed ✓"
                : settled
                  ? `Redeemable now: ${fmtUsdc(redeemable)} tUSDC${winningTokens > 0n ? ` (incl. ${fmtUsdc(winningTokens)} winning tokens @ 1:1)` : ""}`
                  : `Refundable now: ${fmtUsdc(redeemable)} tUSDC — market never settled; refund = deposits + paired token value (min of both sides); the directional residual is lost`
              : `Withdrawable deposit: ${fmtUsdc(position.usdcAvailable)} tUSDC (tokens stay tradeable)`}
          </span>
          {!position.redeemed && redeemable > 0n && (
            <button className="button" type="button" onClick={onRedeem} disabled={!!busy} style={{ marginTop: 8, width: "fit-content" }} data-testid="amm-redeem-btn">
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> {busy}
                </>
              ) : (
                `Redeem ${fmtUsdc(redeemable)} tUSDC`
              )}
            </button>
          )}
        </div>
      )}

      {/* LP card */}
      {isLp && (
        <div className={styles.step}>
          <div className={styles.stepHead}>Your liquidity (you seeded this pool)</div>
          <p className={styles.blurb}>
            Seed {fmtUsdc(pool.seedAmount)} tUSDC · fees accrued {fmtUsdc(pool.feesAccrued)} tUSDC.{" "}
            <strong>LP capital is genuinely at risk</strong> — if traders load up on the side that wins, the
            winning-side reserve you withdraw can be worth less than your seed (observed live in testing: both a
            gain and a loss). Withdrawable after settlement: winning-side reserve + fees.
            {expired && (
              <> This market never settled — past the 2h grace you can withdraw the paired reserve value
              (min of both sides) + fees; the directional residual is lost.</>
            )}
          </p>
          {(settled || expired) && !pool.lpWithdrawn && !isDelegated && (
            <button className="button" type="button" onClick={onWithdrawLp} disabled={!!busy}>
              Withdraw LP capital + fees
            </button>
          )}
          {pool.lpWithdrawn && <p className={styles.blurb}>LP withdrawn ✓</p>}
        </div>
      )}

      {log.length > 0 && (
        <ul className={styles.latencyLog}>
          {log.map((entry, i) => (
            <li key={i}>
              <span>{entry.label}</span>
              <span className={styles.latencyMs}>{entry.ms}ms</span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className={styles.error} data-testid="amm-error">{error}</p>}
      {log[0] && (
        <p className={`muted ${styles.txRow}`}>
          <a href={explorerTxUrl(log[0].sig)} target="_blank" rel="noreferrer">
            last tx ({log[0].label}) ↗
          </a>
        </p>
      )}

      <p className={styles.blurb} style={{ marginTop: 12, fontSize: "0.78rem" }}>
        <strong>Honesty note:</strong> AMM markets are continuously priced and front-runnable in principle, like
        any AMM — transaction ordering belongs to the sequencer. Your slippage tolerance is enforced on-chain
        (the swap reverts rather than fill worse than your min), but it is not MEV-proofing. For MEV-proof
        execution, use a <strong>sealed-batch market</strong> — uniform clearing price, no ordering advantage.
      </p>
    </div>
  );
}
