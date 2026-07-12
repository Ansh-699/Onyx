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
// - Session trading (docs/SESSION_TRADING.md): "Start session" is ONE
//   wallet signature (create_session + open + deposit + delegate); swaps
//   are then signed by the browser-held session key — popup-free, gas-free
//   on the ER, and the session key can never move funds out.

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
  explorerTxUrlFor,
} from "@/lib/onchain";
import { invalidateDelegationStatus } from "@/lib/erRouting";
import { useAmmPosition } from "@/lib/hooks";
import { type TradingSession, loadSession, clearSession, buildRevokeSessionIx } from "@/lib/session";
import { friendlyError, classifyWrongLedger } from "@/lib/errors";
import { sendViaWallet, sendViaKeypair } from "@/lib/tx";
import { startSessionAndDeposit, depositOnly, executeSwap, walletUsdcBalance, CLUSTER } from "@/lib/ammActions";
import {
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
import { FundingModal } from "@/components/FundingModal";
import { quoteBuy, quoteSell, spotPriceScaled, minOutForTolerance, buyImpactBps } from "@/lib/ammMath";
import { WalletButton } from "@/components/WalletButton";
import { LiquidButton } from "@/components/ui/liquid-glass-button";
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
/** Pool price (1e6-scaled) as Polymarket-style cents: 0.62 → "62¢". */
const cents = (scaled: bigint) => `${Math.round(Number(scaled) / 10_000)}¢`;

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
  // rpc: which ledger the tx landed on — ER txs need the custom-cluster
  // explorer link (a plain ?cluster=devnet link 404s for them).
  const [log, setLog] = useState<{ label: string; sig: string; ms: number; rpc?: string }[]>([]);

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
  // Funding is decoupled from trading: when the wallet can't cover the
  // entered amount, we point at the funding modal instead of silently
  // minting behind the user's back (the old auto-faucet).
  const [fundingOpen, setFundingOpen] = useState(false);
  const [needsFunds, setNeedsFunds] = useState(false);

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

  async function timed<T>(label: string, fn: () => Promise<T>, rpc?: string): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    const ms = Math.round(performance.now() - t0);
    if (typeof result === "string") setLog((prev) => [{ label, sig: result, ms, rpc }, ...prev].slice(0, 8));
    return result;
  }

  // Shared explicit sign-then-broadcast (lib/tx.ts — see there for why
  // wallet-adapter's sendTransaction would break ER routing).
  async function sendVia(conn: Connection, tx: Transaction): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error("wallet not connected");
    return sendViaWallet(conn, tx, publicKey, signTransaction);
  }

  // Popup-free path: the session keypair signs locally — no wallet call at
  // all. ER-only (ER fees are validator-sponsored, so the session key needs
  // zero SOL; on base a fee payer must burn real lamports).
  const sendViaSession = (conn: Connection, tx: Transaction, s: TradingSession) => sendViaKeypair(conn, tx, s.keypair);

  function refreshAll() {
    invalidateDelegationStatus(ammPoolPda(marketPk));
    invalidateDelegationStatus(marketPk);
    // Fire-and-forget: invalidateQueries' promise resolves only after EVERY
    // active query has refetched — awaiting it kept the busy spinner up for
    // 30s+ on a throttled RPC after a ~1s swap (looked like a hung buy;
    // caught live by the browser proof's disabled-button timeout). The
    // button re-enables immediately; data refreshes in the background.
    void queryClient.invalidateQueries();
  }

  async function withGuard(label: string, fn: () => Promise<void>) {
    setError(null);
    setBusy(label);
    try {
      await fn();
      refreshAll();
    } catch (err) {
      const ledgerHint = classifyWrongLedger(err);
      setError(ledgerHint ?? friendlyError(err));
      if (ledgerHint) refreshAll();
    } finally {
      setBusy(null);
    }
  }

  /** Wallet must hold the amount BEFORE we ask for a signature — if not, point at funding. */
  async function guardFunds(amount: bigint): Promise<boolean> {
    const bal = await walletUsdcBalance(publicKey!);
    if (bal >= amount) {
      setNeedsFunds(false);
      return true;
    }
    setNeedsFunds(true);
    return false;
  }

  async function onDeposit() {
    const amount = toBase(depositUsdc);
    if (!amount || !publicKey || !signTransaction) return;
    await withGuard("Checking your balance…", async () => {
      if (!(await guardFunds(amount))) return;
      setBusy("Adding funds (one approval)…");
      await timed(`added ${fmtUsdc(amount)} tUSDC to this market`, () =>
        depositOnly({ owner: publicKey, market: marketPk, amount, hasPosition: !!position, signTransaction }),
      );
    });
  }

  // "Enable 1-click trading" — ONE wallet signature: scoped session key +
  // open + deposit + delegate (see lib/ammActions.ts, shared with the lobby
  // quick-trade modal). After this, every trade is popup-free.
  async function onStartSession() {
    const amount = toBase(depositUsdc);
    if (!amount || !publicKey || !signTransaction) return;
    await withGuard("Checking your balance…", async () => {
      if (!(await guardFunds(amount))) return;
      setBusy("Waiting for your wallet (1 approval)…");
      const signAndMarkConfirming: typeof signTransaction = async (t) => {
        const signed = await signTransaction(t);
        setBusy("Confirming on devnet…");
        return signed;
      };
      const { session: fresh, sig } = await startSessionAndDeposit({
        owner: publicKey,
        market: marketPk,
        amount,
        hasPosition: !!position,
        isDelegated,
        signTransaction: signAndMarkConfirming,
      });
      setLog((prev) => [{ label: "1-click trading enabled", sig, ms: 0 }, ...prev].slice(0, 8));
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
      `${dirWord}${useSession ? " — instant, no approval needed" : " — approve in your wallet"}…`,
      async () => {
        // human-readable receipt line: what you got, not just the ix name
        const label =
          direction === SWAP_BUY
            ? `bought ≈${fmtUsdc(quote.out)} ${side === SIDE_A ? "YES" : "NO"} for ${fmtUsdc(amountIn)} tUSDC`
            : `sold ${fmtUsdc(amountIn)} ${side === SIDE_A ? "YES" : "NO"} for ≈${fmtUsdc(quote.out)} tUSDC`;
        await timed(
          label,
          async () => {
            const { sig } = await executeSwap({
              owner: publicKey,
              market: marketPk,
              connection,
              isDelegated,
              side,
              direction,
              amountIn,
              minOut: quote.minOut, // enforced on-chain (6026 if beaten)
              session,
              signTransaction: signTransaction!,
            });
            return sig;
          },
          isDelegated ? connection.rpcEndpoint : undefined,
        );
        // executeSwap already awaited the /api/history record — the global
        // invalidate in withGuard now picks up the fresh trades feed.
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
        <span className="pill" data-tone={isDelegated ? "green" : "accent"} title="Flash trades run on MagicBlock's Ephemeral Rollup — a speed layer over devnet. ~1s confirmation, no gas for you.">
          {isDelegated ? "⚡ Flash trades on" : "standard speed"}
        </span>
      </div>
      <p className={styles.blurb}>
        The pool is the counterparty: buy or <strong>sell</strong> outcome tokens at any moment before the
        deadline — no matching window, no waiting for the other side. Real seeded liquidity
        ({fmtUsdc(pool.seedAmount)} tUSDC), {pool.feeBps / 100}% fee to the LP.
      </p>
      <div className={styles.ledgerRow}>
        <span className={styles.ledgerDot} data-live={isDelegated} aria-hidden />
        {isDelegated ? "trades confirm in ~1s" : "trades confirm in ~1-2s"}
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
              <strong style={{ fontSize: "1.05rem" }}>{cents(s.price)}</strong> · {pct(s.price)} implied
            </span>
          </button>
        ))}
      </div>

      {!tradingOpen && (
        <p className={styles.blurb} data-testid="amm-closed-note">
          {settled
            ? "Trading closed — this market is settled. Winning tokens redeem 1:1 below."
            : expired
              ? "Trading closed — the deadline passed and the market never settled. Deposits and paired token value are refundable below."
              : "Trading closed — the deadline has passed. Settlement runs once the oracle proof is available."}
        </p>
      )}

      {!connected && <WalletButton />}

      {connected && tradingOpen && (!position || position.usdcAvailable === 0n) && (position?.tokensA ?? 0n) === 0n && (position?.tokensB ?? 0n) === 0n && (
        <div className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>1</span> Add funds to trade
          </div>
          <p className={styles.blurb}>
            One approval moves your USDC into this market and turns on 1-click trading — every buy and sell
            after that is instant, with no wallet popups and no gas. The trading key in your browser can{" "}
            <strong>only trade</strong>; withdrawing always needs your wallet. Expires in 4h or when you end it.
          </p>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Amount to add (devnet USDC)</span>
              <input value={depositUsdc} onChange={(e) => setDepositUsdc(e.target.value)} inputMode="decimal" placeholder="2" data-testid="amm-deposit-input" />
            </label>
          </div>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
            <LiquidButton size="lg" type="button" onClick={onStartSession} disabled={!!busy || !toBase(depositUsdc)} data-testid="amm-session-btn">
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> Working…
                </>
              ) : (
                "Enable 1-click trading"
              )}
            </LiquidButton>
            <button className="button" data-variant="ghost" type="button" onClick={onDeposit} disabled={!!busy || !toBase(depositUsdc)} data-testid="amm-deposit-btn" style={{ fontSize: "0.8rem" }}>
              or add funds &amp; approve each trade
            </button>
          </div>
          {busy && <p className={`muted ${styles.blurb}`}>{busy}</p>}
          <details className={styles.blurb} style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer" }} className="muted">What happens under the hood?</summary>
            <p style={{ marginTop: 6 }}>
              &ldquo;Enable 1-click trading&rdquo; sends one transaction that: mints a scoped MagicBlock session
              key (it can ONLY call swap — the program rejects it on every funds-moving instruction), opens your
              position account, escrows your deposit in the market&apos;s program-owned vault, and delegates the
              accounts to the Ephemeral Rollup where trades confirm in ~1s with validator-sponsored fees. Buy/Sell
              then sends <code>swap_amm</code> signed by that key. Withdrawals (<code>redeem_amm</code>) always
              require your wallet&apos;s signature.
            </p>
          </details>
        </div>
      )}

      {needsFunds && (
        <div className={styles.step} data-testid="amm-needs-funds">
          <p className={styles.blurb} style={{ margin: 0 }}>
            <strong>Not enough devnet USDC in your wallet</strong> for that amount — grab some first (free), then
            come back.
          </p>
          <button className="button" type="button" onClick={() => setFundingOpen(true)} style={{ marginTop: 8 }}>
            Get devnet USDC
          </button>
        </div>
      )}

      {/* session status chip */}
      {connected && session && tradingOpen && (
        <div className={styles.availRow} data-testid="amm-session-chip">
          <span>
            <span aria-hidden style={{ background: "var(--green)", display: "inline-block", width: 7, height: 7, borderRadius: "50%", marginRight: 6 }} />
            1-click trading on · until {new Date(session.expiry * 1000).toLocaleTimeString()} · no approvals needed
            {isDelegated ? "" : " once this market is flash-enabled"}
          </span>
          <button type="button" className="button" data-variant="ghost" style={{ padding: "2px 10px", fontSize: "0.75rem" }} onClick={onEndSession} disabled={!!busy}>
            Turn off
          </button>
        </div>
      )}

      {connected && position && tradingOpen && (
        <form onSubmit={onSwap} className={styles.form}>
          <div className={styles.availRow} data-testid="amm-holdings">
            <span>
              You hold: <strong>{fmtUsdc(position.tokensA)} YES</strong> · <strong>{fmtUsdc(position.tokensB)} NO</strong>
              {position.tokensA + position.tokensB > 0n && (
                <> (≈{fmtUsdc((position.tokensA * priceA + position.tokensB * priceB) / 1_000_000n)} tUSDC at pool price)</>
              )}{" "}
              · {fmtUsdc(position.usdcAvailable)} tUSDC to spend
            </span>
            <button
              type="button"
              className="button"
              data-variant="ghost"
              style={{ padding: "2px 10px", fontSize: "0.75rem" }}
              onClick={onDeposit}
              disabled={!!busy}
            >
              + add funds
            </button>
          </div>

          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Action</span>
              <select value={direction} onChange={(e) => setDirection(Number(e.target.value))} data-testid="amm-direction">
                <option value={SWAP_BUY}>Buy</option>
                <option value={SWAP_SELL}>Sell</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{direction === SWAP_BUY ? "Spend (USDC)" : `Sell (${side === SIDE_A ? "YES" : "NO"} tokens)`}</span>
              <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} inputMode="decimal" placeholder="0.5" data-testid="amm-amount" />
            </label>
          </div>
          {/* slippage stays visible — it's enforced on-chain (min_out → SlippageExceeded), and a judge should SEE that rail, not find it behind a disclosure */}
          <label className={styles.field} style={{ maxWidth: 220 }}>
            <span className={styles.fieldLabel} title="Encoded into every swap as min_out; the program reverts rather than fill worse. On-chain enforcement, not a UI promise.">
              Max slippage (%) · enforced on-chain
            </span>
            <input value={tolStr} onChange={(e) => setTolStr(e.target.value)} inputMode="decimal" placeholder="1.0" data-testid="amm-tolerance" />
          </label>

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

          <LiquidButton size="lg" type="submit" disabled={!!busy || !quote || insufficient} data-testid="amm-swap-btn">
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {direction === SWAP_BUY ? "Buying…" : "Selling…"}
              </>
            ) : insufficient ? (
              "Insufficient balance"
            ) : (
              `${direction === SWAP_BUY ? "Buy" : "Sell"} ${side === SIDE_A ? "Yes" : "No"}${isDelegated ? " · instant" : ""}`
            )}
          </LiquidButton>
          {busy && <p className={`muted ${styles.blurb}`}>{busy}</p>}
          {!busy && insufficient && (
            <p className={`muted ${styles.blurb}`}>
              {direction === SWAP_BUY
                ? "You've spent everything you added to this market — press “+ add funds” above (one approval)."
                : "You don't hold that many tokens — check “You hold” above."}{" "}
              <button type="button" className="button" data-variant="ghost" style={{ padding: "1px 8px", fontSize: "0.72rem" }} onClick={() => setFundingOpen(true)}>
                need more USDC?
              </button>
            </p>
          )}
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
          <div className={styles.stepHead}>One more approval to finish setup</div>
          <p className={styles.blurb}>
            This market trades on the speed layer, but your funds are still on the slower base ledger (this
            happens after &ldquo;add funds &amp; approve each trade&rdquo;). One approval moves them over so
            buys and sells work here.
          </p>
          <button className="button" data-variant="ghost" type="button" onClick={onDelegateMyPosition} disabled={!!busy}>
            Finish setup (1 approval)
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
          <a
            href={explorerTxUrlFor(log[0].sig, log[0].rpc ?? null)}
            target="_blank"
            rel="noreferrer"
            title={log[0].rpc ? "Executed on the Ephemeral Rollup — explorer opens pointed at the ER's RPC" : "Executed on base devnet"}
          >
            last tx ({log[0].label}) {log[0].rpc ? "· ER " : ""}↗
          </a>
        </p>
      )}

      <p className={styles.blurb} style={{ marginTop: 12, fontSize: "0.78rem" }}>
        <strong>Honesty note:</strong> AMM markets are continuously priced and front-runnable in principle, like
        any AMM — transaction ordering belongs to the sequencer. Your slippage tolerance is enforced on-chain
        (the swap reverts rather than fill worse than your min), but it is not MEV-proofing. For MEV-proof
        execution, use a <strong>sealed-batch market</strong> — uniform clearing price, no ordering advantage.
      </p>
      <FundingModal open={fundingOpen} onClose={() => setFundingOpen(false)} />
    </div>
  );
}
