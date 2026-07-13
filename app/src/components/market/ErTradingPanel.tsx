"use client";

// ER-fast trading — the lead trading panel for a sealed market (see
// docs/ER_TRADING_DESIGN.md). Deposit once (base, real SPL transfer),
// delegate once, then commit/reveal/cancel/match all run on MagicBlock's
// Ephemeral Rollup as pure account-data mutation — no token CPI, no
// lamports movement, which is exactly the operation class the Phase 0
// probe proved the ER allows (it hard-rejects anything that would change a
// non-delegated account's balance, including the fee payer itself).
//
// Behaviors that must never regress:
// - open/deposit/delegate_trading_account/withdraw/settle are ALWAYS sent
//   to the BASE connection, never the resolved (possibly-ER) `connection`
//   prop — these instructions need real token movement or run only
//   pre-delegation/post-undelegation. Only submit/reveal/cancel/match are
//   sent to whichever connection currently holds the account (the
//   `connection` prop, resolved by the parent via useRoutedMarket).
// - cancel_order_fast routes through the resolved `connection` too (not
//   hardcoded ER) — it's pure bookkeeping with no ER-specific requirement,
//   so it still works if called after an undelegate races ahead of a
//   forgotten cancel (a real, honest safety net, not a hypothetical).
// - The order secret (nonce/side/size/limitPrice) is saved to localStorage
//   the moment commit lands, same discipline as the classic flow — but
//   cancel does NOT require the secret (cancel_order_fast takes no args),
//   so a wallet can always cancel its own open order even from a browser
//   that never saw the original commit.
// - Every wallet-signed send is timed and logged so the panel can show
//   real, measured latency — never a fabricated "instant" claim.

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, ComputeBudgetProgram, type Connection } from "@solana/web3.js";
import {
  type OnChainMarket,
  PHASE_MATCHED,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  TRADING_STATUS_NONE,
  TRADING_STATUS_LOCKED,
  TRADING_STATUS_REVEALED,
  TRADING_STATUS_MATCHED,
  TRADING_STATUS_NAMES,
  getConfigUsdcMint,
  getConnection,
  priceToPercent,
  explorerTxUrl,
} from "@/lib/onchain";
import { invalidateDelegationStatus } from "@/lib/erRouting";
import { useTradingAccount, useTradingAccountsForMarket } from "@/lib/hooks";
import { friendlyError, classifyWrongLedger } from "@/lib/errors";
import { sendViaWallet, lastExecutionMs } from "@/lib/tx";
import {
  buildDelegateMarketIx,
  buildOpenTradingAccountIx,
  buildDepositTradingIx,
  buildDelegateTradingAccountIx,
  buildSubmitOrderFastIx,
  buildRevealOrderFastIx,
  buildCancelOrderFastIx,
  buildRunBatchMatchFastIx,
  buildUndelegateManyIx,
  buildWithdrawTradingIx,
  sealedCommitment,
  SIDE_A,
  SIDE_B,
} from "@/lib/instructions";
import { WalletButton } from "@/components/WalletButton";
import { Countdown } from "@/components/market/Countdown";
import { fmtUsdc, poolShare, shortAddr } from "@/components/market/format";
import styles from "./ErTradingPanel.module.css";

interface SavedFastOrder {
  nonce: string;
  side: number;
  size: string;
  limitPrice: string;
}

function storageKey(market: string, owner: string) {
  return `onyx:fast:${market}:${owner}`;
}

const CADENCE_SEC = 3;

/** Whole test-USDC string -> 6dp base units, or null if invalid. */
function sizeToBase(input: string): bigint | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  const base = Math.round(n * 1_000_000);
  if (base <= 0 || base > Number.MAX_SAFE_INTEGER) return null;
  return BigInt(base);
}
/** Percent string (0..100 exclusive) -> 0..1_000_000 on-chain scale, or null. */
function pctToScale(input: string): bigint | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return BigInt(Math.round(n * 10_000));
}

export function ErTradingPanel({
  market,
  isDelegated,
  connection,
}: {
  market: OnChainMarket;
  isDelegated: boolean;
  fqdn: string | null;
  connection: Connection;
}) {
  const queryClient = useQueryClient();
  const { connection: walletDefaultConnection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  void walletDefaultConnection; // every send below picks its own connection explicitly — never the wallet-adapter default

  const marketPk = useMemo(() => new PublicKey(market.pda), [market.pda]);
  const myTa = useTradingAccount(market.pda, publicKey, connection);
  const allTas = useTradingAccountsForMarket(market.pda, connection);

  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ label: string; sig: string; ms: number }[]>([]);
  const [saved, setSaved] = useState<SavedFastOrder | null>(null);
  const [houseTriggered, setHouseTriggered] = useState(false);

  const [depositUsdc, setDepositUsdc] = useState("5");
  const [side, setSide] = useState<number>(SIDE_A);
  const [sizeUsdc, setSizeUsdc] = useState("1");
  const [limitPct, setLimitPct] = useState("50");

  useEffect(() => {
    if (!publicKey) {
      setSaved(null);
      return;
    }
    const raw = localStorage.getItem(storageKey(market.pda, publicKey.toBase58()));
    setSaved(raw ? (JSON.parse(raw) as SavedFastOrder) : null);
  }, [market.pda, publicKey]);

  const commitEnd = Number(market.commitEndTs);
  const revealEnd = Number(market.revealEndTs);
  const commitOpen = nowSec < commitEnd;
  const revealWindowOpen = nowSec >= commitEnd && nowSec < revealEnd;
  const matchWindowReady = nowSec >= revealEnd;
  const matched = market.phase === PHASE_MATCHED;
  const settled = market.status === STATUS_SETTLED || market.status === STATUS_CLAIMED;

  const notYetDelegated = !isDelegated && market.phase !== PHASE_MATCHED;

  const cadenceRemaining = matchWindowReady
    ? CADENCE_SEC - ((nowSec - revealEnd) % CADENCE_SEC)
    : CADENCE_SEC;
  const cadenceReady = matchWindowReady && cadenceRemaining >= CADENCE_SEC - 1;

  // Best-effort: once this wallet has an open commit, ask the house
  // counterparty to mirror it (submit, then reveal once the window opens) --
  // same demo-liquidity pattern and disclosure as the classic flow's
  // /api/house-counter, just for the ER-fast route.
  useEffect(() => {
    if (!isDelegated || houseTriggered) return;
    if (myTa.data?.status !== TRADING_STATUS_LOCKED) return;
    const houseSide = myTa.data.side || side;
    const houseSize = (myTa.data.locked || sizeToBase(sizeUsdc) || 1_000_000n).toString();
    setHouseTriggered(true);
    fetch("/api/house-counter-fast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: market.pda, action: "submit", userSide: houseSide, userSize: houseSize }),
    }).catch(() => {});
  }, [isDelegated, houseTriggered, myTa.data?.status, myTa.data?.side, myTa.data?.locked, market.pda, side, sizeUsdc]);

  useEffect(() => {
    if (!revealWindowOpen || !houseTriggered) return;
    const houseSide = myTa.data?.side || side;
    const houseSize = (myTa.data?.locked || myTa.data?.matchedSize || 1_000_000n).toString();
    fetch("/api/house-counter-fast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: market.pda, action: "reveal", userSide: houseSide, userSize: houseSize }),
    }).catch(() => {});
  }, [revealWindowOpen, houseTriggered, market.pda, myTa.data?.side, myTa.data?.locked, myTa.data?.matchedSize, side]);

  async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    // broadcast→confirm time of the tx itself, not the whole flow (which
    // includes the wallet-approval wait)
    const ms = lastExecutionMs() ?? Math.round(performance.now() - t0);
    if (typeof result === "string") {
      setLog((prev) => [{ label, sig: result, ms }, ...prev].slice(0, 8));
    }
    return result;
  }

  // Deliberately NOT wallet-adapter's `sendTransaction` — that would
  // broadcast via the wallet's own RPC and silently defeat ER routing.
  // Shared implementation (incl. the conf.value.err check that a live bug
  // taught us confirmTransaction does NOT do itself) lives in lib/tx.ts.
  async function sendVia(conn: Connection, tx: Transaction): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error("wallet not connected");
    return sendViaWallet(conn, tx, publicKey, signTransaction);
  }

  async function refreshAll() {
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

  async function onEnableMarket() {
    await withGuard("Enabling fast trading (delegating market)…", async () => {
      const ix = buildDelegateMarketIx({ payer: publicKey!, market: marketPk });
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix);
      await timed("delegate_market", () => sendVia(getConnection(), tx));
    });
  }

  async function onDepositAndEnable() {
    const amount = sizeToBase(depositUsdc);
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

      setBusy("Deposit + enable fast trading (one signature)…");
      const { ix: openIx } = buildOpenTradingAccountIx({ owner: publicKey, market: marketPk });
      const depositIx = buildDepositTradingIx({ owner: publicKey, market: marketPk, amount, usdcMint });
      const delegateIx = buildDelegateTradingAccountIx({ payer: publicKey, market: marketPk, owner: publicKey });
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        openIx,
        depositIx,
        delegateIx,
      );
      await timed("deposit + delegate trading account", () => sendVia(getConnection(), tx));
    });
  }

  async function onPlaceBet(e: React.FormEvent) {
    e.preventDefault();
    const sizeBase = sizeToBase(sizeUsdc);
    const priceScaled = pctToScale(limitPct);
    if (!sizeBase || !priceScaled || !publicKey) return;
    await withGuard("Placing bet on the Ephemeral Rollup…", async () => {
      const nonce = BigInt(Math.floor(Math.random() * 1_000_000_000));
      const commitment = sealedCommitment(side, sizeBase, priceScaled, nonce, publicKey);
      const ix = buildSubmitOrderFastIx({ owner: publicKey, market: marketPk, commitment, collateral: sizeBase });
      const tx = new Transaction().add(ix);
      const sig = await timed("submit_order_fast", () => sendVia(connection, tx));
      const record: SavedFastOrder = { nonce: nonce.toString(), side, size: sizeBase.toString(), limitPrice: priceScaled.toString() };
      localStorage.setItem(storageKey(market.pda, publicKey.toBase58()), JSON.stringify(record));
      setSaved(record);
      void sig;
    });
  }

  async function onCancel() {
    if (!publicKey) return;
    await withGuard("Cancelling…", async () => {
      const ix = buildCancelOrderFastIx({ owner: publicKey, market: marketPk });
      const tx = new Transaction().add(ix);
      await timed("cancel_order_fast", () => sendVia(connection, tx));
      localStorage.removeItem(storageKey(market.pda, publicKey.toBase58()));
      setSaved(null);
      setHouseTriggered(false);
    });
  }

  async function onResize(e: React.FormEvent) {
    e.preventDefault();
    const sizeBase = sizeToBase(sizeUsdc);
    const priceScaled = pctToScale(limitPct);
    if (!sizeBase || !priceScaled || !publicKey) return;
    await withGuard("Resizing (cancel + re-place)…", async () => {
      const cancelIx = buildCancelOrderFastIx({ owner: publicKey, market: marketPk });
      await timed("cancel_order_fast (resize)", () => sendVia(connection, new Transaction().add(cancelIx)));

      const nonce = BigInt(Math.floor(Math.random() * 1_000_000_000));
      const commitment = sealedCommitment(side, sizeBase, priceScaled, nonce, publicKey);
      const submitIx = buildSubmitOrderFastIx({ owner: publicKey, market: marketPk, commitment, collateral: sizeBase });
      await timed("submit_order_fast (resize)", () => sendVia(connection, new Transaction().add(submitIx)));

      const record: SavedFastOrder = { nonce: nonce.toString(), side, size: sizeBase.toString(), limitPrice: priceScaled.toString() };
      localStorage.setItem(storageKey(market.pda, publicKey.toBase58()), JSON.stringify(record));
      setSaved(record);
    });
  }

  async function onReveal() {
    if (!publicKey || !saved) return;
    await withGuard("Revealing…", async () => {
      const ix = buildRevealOrderFastIx({
        owner: publicKey,
        market: marketPk,
        side: saved.side,
        size: BigInt(saved.size),
        limitPrice: BigInt(saved.limitPrice),
        nonce: BigInt(saved.nonce),
      });
      await timed("reveal_order_fast", () => sendVia(connection, new Transaction().add(ix)));
    });
  }

  async function onRunMatch() {
    if (!publicKey) return;
    await withGuard("Running batch match on the ER…", async () => {
      const revealed = (allTas.data ?? []).filter((t) => t.status === TRADING_STATUS_REVEALED);
      if (revealed.length === 0) throw new Error("no revealed orders to match");
      const ix = buildRunBatchMatchFastIx({
        payer: publicKey,
        market: marketPk,
        tradingAccounts: revealed.map((t) => new PublicKey(t.pda)),
      });
      await timed("run_batch_match_fast", () => sendVia(connection, new Transaction().add(ix)));
    });
  }

  async function onUndelegate() {
    if (!publicKey) return;
    await withGuard("Moving state back to base…", async () => {
      const all = allTas.data ?? [];
      const delegated = [marketPk, ...all.map((t) => new PublicKey(t.pda))];
      const ix = buildUndelegateManyIx({ payer: publicKey, delegated });
      await timed("undelegate (market + all trading accounts)", () => sendVia(connection, new Transaction().add(ix)));
    });
  }

  async function onWithdraw() {
    if (!publicKey) return;
    await withGuard("Withdrawing…", async () => {
      const usdcMint = await getConfigUsdcMint();
      if (!usdcMint) throw new Error("config not initialized");
      const ix = buildWithdrawTradingIx({ owner: publicKey, market: marketPk, usdcMint });
      await timed("withdraw_trading", () => sendVia(getConnection(), new Transaction().add(ix)));
    });
  }

  const totalPool = market.totalSideA + market.totalSideB;
  const ta = myTa.data;
  const hasOpenOrder = ta && (ta.status === TRADING_STATUS_LOCKED || ta.status === TRADING_STATUS_REVEALED);
  const canWithdraw = ta && (ta.available > 0n || (settled && ta.status === TRADING_STATUS_MATCHED && !ta.claimedWinnings));

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.head}>
        <span className={styles.title}>
          <span className={styles.bolt}>⚡</span> Fast trade (Ephemeral Rollup)
        </span>
        <span className="pill" data-tone={isDelegated ? "green" : "accent"}>
          {isDelegated ? "live on ER" : matched && !isDelegated ? "back on base" : "base"}
        </span>
      </div>
      <p className={styles.blurb}>
        Deposit once, then bet, resize, and cancel with sub-second confirmations on MagicBlock&apos;s
        Ephemeral Rollup — real signed transactions, not simulated. Matches clear in {CADENCE_SEC}s batches once
        the reveal window closes.
      </p>
      <div className={styles.ledgerRow}>
        <span className={styles.ledgerDot} data-live={isDelegated} aria-hidden />
        {isDelegated ? "reading & writing via the Ephemeral Rollup" : "reading & writing via base devnet"}
      </div>

      {!connected && <WalletButton />}

      {connected && notYetDelegated && (
        <div className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>1</span> Enable fast trading for this market
          </div>
          <p className={styles.blurb}>
            Delegates the market to the Ephemeral Rollup (base-layer tx, ~1-2s). Anyone can do this —
            it&apos;s permissionless, same as the program allows on-chain.
          </p>
          <button className="button" type="button" onClick={onEnableMarket} disabled={!!busy}>
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {busy}
              </>
            ) : (
              "Delegate market to Ephemeral Rollup"
            )}
          </button>
        </div>
      )}

      {connected && isDelegated && !ta && myTa.isFetched && commitOpen && (
        <div className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.stepNum}>2</span> Deposit to start trading
          </div>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Deposit (test-USDC)</span>
              <input value={depositUsdc} onChange={(e) => setDepositUsdc(e.target.value)} inputMode="decimal" placeholder="5" />
            </label>
          </div>
          <button className="button" type="button" onClick={onDepositAndEnable} disabled={!!busy || !sizeToBase(depositUsdc)}>
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {busy}
              </>
            ) : (
              "Deposit & enable fast trading"
            )}
          </button>
        </div>
      )}

      {connected && isDelegated && ta && ta.status === TRADING_STATUS_NONE && commitOpen && (
        <form onSubmit={onPlaceBet} className={styles.form}>
          <div className={styles.availRow}>
            <span>Available: {fmtUsdc(ta.available)} tUSDC</span>
            <span>
              Commit closes in <Countdown targetSec={commitEnd} />
            </span>
          </div>
          <div className={styles.sides} role="group" aria-label="Pick a side">
            {(
              [
                { id: SIDE_A, name: "Side A", pool: market.totalSideA },
                { id: SIDE_B, name: "Side B", pool: market.totalSideB },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.sideBtn}
                data-active={side === s.id}
                onClick={() => setSide(s.id)}
                aria-pressed={side === s.id}
              >
                <span className={styles.sideName}>{s.name}</span>
                <span className={styles.sideShare}>
                  pool {poolShare(s.pool, totalPool)} · {fmtUsdc(s.pool)} tUSDC
                </span>
              </button>
            ))}
          </div>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Size (test-USDC)</span>
              <input value={sizeUsdc} onChange={(e) => setSizeUsdc(e.target.value)} inputMode="decimal" placeholder="1" />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Limit price (%)</span>
              <input value={limitPct} onChange={(e) => setLimitPct(e.target.value)} inputMode="decimal" placeholder="50" />
            </label>
          </div>
          <button
            className="button"
            type="submit"
            disabled={!!busy || !sizeToBase(sizeUsdc) || !pctToScale(limitPct) || (sizeToBase(sizeUsdc) ?? 0n) > ta.available}
          >
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {busy}
              </>
            ) : (
              "Place bet (ER)"
            )}
          </button>
        </form>
      )}

      {connected && isDelegated && ta && hasOpenOrder && (
        <div className={styles.orderCard}>
          <div>
            <strong>{TRADING_STATUS_NAMES[ta.status]}</strong> order ·{" "}
            {saved ? (
              <>
                {saved.side === SIDE_A ? "Side A" : "Side B"} · {fmtUsdc(BigInt(saved.size))} tUSDC · limit{" "}
                {priceToPercent(BigInt(saved.limitPrice))}
              </>
            ) : (
              <span className="muted">details not saved in this browser — you can still cancel it</span>
            )}
          </div>
          {commitOpen && saved && (
            <form onSubmit={onResize} className={styles.fields}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>New size</span>
                <input value={sizeUsdc} onChange={(e) => setSizeUsdc(e.target.value)} inputMode="decimal" />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>New limit %</span>
                <input value={limitPct} onChange={(e) => setLimitPct(e.target.value)} inputMode="decimal" />
              </label>
              <div className={styles.orderActions} style={{ gridColumn: "1 / -1" }}>
                <button className="button" type="submit" disabled={!!busy}>
                  Resize
                </button>
                <button className="button" data-variant="ghost" type="button" onClick={onCancel} disabled={!!busy}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {!commitOpen && (
            <div className={styles.orderActions}>
              {revealWindowOpen && ta.status === TRADING_STATUS_LOCKED && saved && (
                <button className="button" type="button" onClick={onReveal} disabled={!!busy}>
                  {busy ? (
                    <>
                      <span className={styles.spinner} aria-hidden /> {busy}
                    </>
                  ) : (
                    "Reveal now"
                  )}
                </button>
              )}
              <button className="button" data-variant="ghost" type="button" onClick={onCancel} disabled={!!busy}>
                Cancel &amp; reclaim
              </button>
            </div>
          )}
        </div>
      )}

      {connected && isDelegated && matchWindowReady && !matched && (
        <div className={styles.step} data-tone={cadenceReady ? "ready" : undefined}>
          <div className={styles.cadenceRow}>
            <div>
              <div className={styles.stepHead}>Batch matching</div>
              <p className={styles.blurb}>
                {market.revealedCount} order{market.revealedCount === 1 ? "" : "s"} revealed. Matches clear every{" "}
                {CADENCE_SEC}s — anyone can trigger it.
              </p>
            </div>
            <div className={styles.cadenceDial} data-ready={cadenceReady}>
              {cadenceReady ? "GO" : cadenceRemaining}
            </div>
          </div>
          <button className="button" type="button" onClick={onRunMatch} disabled={!!busy || market.revealedCount === 0}>
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {busy}
              </>
            ) : (
              "Run batch match now"
            )}
          </button>
        </div>
      )}

      {isDelegated && matched && (
        <div className={styles.step}>
          <div className={styles.stepHead}>Matched — clearing price {priceToPercent(market.clearingPrice)}</div>
          <p className={styles.blurb}>State is still on the ER. Move it back to base to settle and withdraw.</p>
          <button className="button" type="button" onClick={onUndelegate} disabled={!!busy}>
            {busy ? (
              <>
                <span className={styles.spinner} aria-hidden /> {busy}
              </>
            ) : (
              "Move to base (undelegate)"
            )}
          </button>
        </div>
      )}

      {connected && !isDelegated && matched && ta && (
        <div className={styles.payout}>
          <span className={styles.fieldLabel}>
            Your order: {TRADING_STATUS_NAMES[ta.status]}
            {ta.status === TRADING_STATUS_MATCHED && ` · matched ${fmtUsdc(ta.matchedSize)} tUSDC`}
          </span>
          <span className={styles.payoutBig}>
            {settled
              ? "Ready to withdraw"
              : ta.available > 0n
                ? "Unmatched balance withdrawable now — matched winnings need settlement"
                : "Awaiting settlement (see below)"}
          </span>
          {canWithdraw && (
            <button className="button" type="button" onClick={onWithdraw} disabled={!!busy} style={{ marginTop: 8, width: "fit-content" }}>
              {busy ? (
                <>
                  <span className={styles.spinner} aria-hidden /> {busy}
                </>
              ) : (
                `Withdraw ${fmtUsdc(ta.available)} tUSDC`
              )}
            </button>
          )}
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

      {error && <p className={styles.error}>{error}</p>}
      {log[0] && (
        <p className={`muted ${styles.txRow}`}>
          <a href={explorerTxUrl(log[0].sig)} target="_blank" rel="noreferrer">
            last tx ({log[0].label}) ↗
          </a>
        </p>
      )}

      {(allTas.data?.length ?? 0) > 0 && (
        <div className={styles.tableWrap}>
          <p className={styles.tableTitle}>Trading accounts on this market ({allTas.data!.length})</p>
          <table>
            <thead>
              <tr>
                <th>owner</th>
                <th>status</th>
                <th style={{ textAlign: "right" }}>matched</th>
              </tr>
            </thead>
            <tbody>
              {allTas.data!.map((t) => (
                <tr key={t.pda}>
                  <td className="mono">
                    {shortAddr(t.owner)}
                    {publicKey?.toBase58() === t.owner && (
                      <span className={`pill ${styles.youPill}`} data-tone="accent">
                        you
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="pill">{TRADING_STATUS_NAMES[t.status]}</span>
                  </td>
                  <td style={{ textAlign: "right" }} className="mono">
                    {t.status === TRADING_STATUS_MATCHED ? `${fmtUsdc(t.matchedSize)} tUSDC` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
