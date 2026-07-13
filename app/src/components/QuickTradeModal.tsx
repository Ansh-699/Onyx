"use client";

// Quick-buy from a lobby card: click Yes/No → compact modal → real swap.
// Same shared actions as the market-page panel (lib/ammActions.ts — no
// logic fork): if you already have funds on the market it buys instantly
// (session-signed when 1-click trading is on); if not, one wallet approval
// runs the full enable-bundle and then buys. Quotes use the same BigInt
// math the program runs; min_out is enforced on-chain.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { type AmmPoolSummary, getConnection, getAmmPosition, explorerTxUrlFor } from "@/lib/onchain";
import { resolveConnection } from "@/lib/erRouting";
import { quoteBuy, minOutForTolerance, spotPriceScaled } from "@/lib/ammMath";
import { loadSession } from "@/lib/session";
import { startSessionAndDeposit, executeSwap, walletUsdcBalance, CLUSTER } from "@/lib/ammActions";
import { ammPoolPda, ammPositionPda, SIDE_A, SWAP_BUY } from "@/lib/instructions";
import { friendlyError } from "@/lib/errors";
import { WalletButton } from "./WalletButton";
import { Modal } from "./Modal";
import { toast } from "./Toaster";
import { FundingModal } from "./FundingModal";
import styles from "./QuickTradeModal.module.css";

// Quick-buy uses a slightly wider on-chain slippage bound than the panel's
// default (2% vs 1%): the quote here comes from the lobby's polled reserves,
// so a bit more staleness headroom avoids spurious reverts. Still enforced
// by the program — never advisory.
const QUICK_TOL_BPS = 200;

const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

export interface QuickTradeTarget {
  marketPda: string;
  title: string;
  fixtureLabel: string;
  side: number; // SIDE_A | SIDE_B
  pool: AmmPoolSummary;
}

export function QuickTradeModal({ target, onClose }: { target: QuickTradeTarget | null; onClose: () => void }) {
  const { publicKey, signTransaction, connected } = useWallet();
  const queryClient = useQueryClient();
  const [amountStr, setAmountStr] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string; sig: string; rpc: string | null } | null>(null);
  const [needsFunds, setNeedsFunds] = useState(false);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [topUpOnly, setTopUpOnly] = useState(false);

  useEffect(() => {
    // fresh state per market/side
    setError(null);
    setDone(null);
    setNeedsFunds(false);
    setTopUpOnly(false);
    setBusy(null);
  }, [target?.marketPda, target?.side]);

  const amountIn = useMemo(() => {
    const n = Number(amountStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    return BigInt(Math.round(n * 1e6));
  }, [amountStr]);

  const quote = useMemo(() => {
    if (!target || !amountIn) return null;
    const { reserveA, reserveB, feeBps } = target.pool;
    const [rIn, rOut] = target.side === SIDE_A ? [reserveA, reserveB] : [reserveB, reserveA];
    const q = quoteBuy(rIn, rOut, amountIn, feeBps || 100);
    if (!q) return null;
    return { out: q.tokensOut, minOut: minOutForTolerance(q.tokensOut, QUICK_TOL_BPS) };
  }, [target, amountIn]);

  const priceCents = useMemo(() => {
    if (!target) return null;
    const pA = spotPriceScaled(target.pool.reserveA, target.pool.reserveB);
    const p = target.side === SIDE_A ? pA : 1_000_000n - pA;
    return Math.round(Number(p) / 10_000);
  }, [target]);

  async function onBuy() {
    if (!target || !publicKey || !signTransaction || !amountIn || !quote) return;
    setError(null);
    setNeedsFunds(false);
    setTopUpOnly(false);
    setBusy("Checking your position…");
    try {
      const market = new PublicKey(target.marketPda);
      const poolPda = ammPoolPda(market);
      const positionPda = ammPositionPda(market, publicKey);
      const posRoute = await resolveConnection(positionPda, getConnection(), true);
      const position = await getAmmPosition(posRoute.connection, market, publicKey);
      let session = loadSession(CLUSTER, publicKey);

      if (!(position && posRoute.isDelegated && position.usdcAvailable >= amountIn)) {
        if (position && posRoute.isDelegated && position.usdcAvailable < amountIn) {
          // Delegated position short on funds — topping up needs the market
          // page flow (deposit runs on base). Honest redirect, no dead end.
          setTopUpOnly(true);
          setBusy(null);
          return;
        }
        // No usable position yet → one approval runs the full enable bundle.
        if ((await walletUsdcBalance(publicKey)) < amountIn) {
          setNeedsFunds(true);
          setBusy(null);
          return;
        }
        setBusy("One wallet approval — enabling 1-click trading…");
        const poolRoute = await resolveConnection(poolPda, getConnection(), true);
        const res = await startSessionAndDeposit({
          owner: publicKey,
          market,
          amount: amountIn,
          hasPosition: !!position,
          isDelegated: poolRoute.isDelegated,
          signTransaction,
        });
        session = res.session;
      }

      setBusy("Buying…");
      const swapRoute = await resolveConnection(poolPda, getConnection(), true);
      const { sig } = await executeSwap({
        owner: publicKey,
        market,
        connection: swapRoute.connection,
        isDelegated: swapRoute.isDelegated,
        side: target.side,
        direction: SWAP_BUY,
        amountIn,
        minOut: quote.minOut,
        session,
        signTransaction,
      });
      setDone({
        label: `You bought ≈${fmt(quote.out)} ${target.side === SIDE_A ? "YES" : "NO"} for ${fmt(amountIn)} USDC`,
        sig,
        rpc: swapRoute.isDelegated ? swapRoute.connection.rpcEndpoint : null,
      });
      toast("success", `Bought ≈${fmt(quote.out)} ${target.side === SIDE_A ? "YES" : "NO"} for ${fmt(amountIn)} USDC`);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(friendlyError(err));
      toast("error", "Trade failed", friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Modal open={target !== null} onClose={onClose} title={target ? `Buy ${target.side === SIDE_A ? "Yes" : "No"}` : ""}>
        {target && (
          <>
            <p className={styles.question}>{target.title}</p>
            <p className={styles.fixture}>{target.fixtureLabel}</p>

            {done ? (
              <div className={styles.done} data-testid="quick-done">
                <p className={styles.doneLabel}>✓ {done.label}</p>
                <p className={styles.doneLinks}>
                  <a href={explorerTxUrlFor(done.sig, done.rpc)} target="_blank" rel="noreferrer">
                    view transaction ↗
                  </a>
                  {" · "}
                  <Link href={`/market/${target.marketPda}`} onClick={onClose}>
                    open market →
                  </Link>
                </p>
              </div>
            ) : (
              <>
                <div className={styles.priceRow}>
                  <span>
                    {target.side === SIDE_A ? "Yes" : "No"} price: <strong>{priceCents}¢</strong>
                  </span>
                  {quote && amountIn && (
                    <span className={styles.quoteNote}>
                      ≈ {fmt(quote.out)} shares · min {fmt(quote.minOut)} (enforced on-chain)
                      <br />
                      <span style={{ color: "var(--green)", fontWeight: 650 }}>
                        to win ≈{fmt(quote.out)} tUSDC
                        {quote.out > amountIn && <> (+{fmt(quote.out - amountIn)} profit)</>}
                      </span>{" "}
                      if {target.side === SIDE_A ? "Yes" : "No"} wins — shares redeem 1:1
                    </span>
                  )}
                </div>
                <label className={styles.amountRow}>
                  <span>Spend (devnet USDC)</span>
                  <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} inputMode="decimal" data-testid="quick-amount" />
                </label>

                {!connected ? (
                  <WalletButton />
                ) : (
                  <button className="button" type="button" onClick={onBuy} disabled={!!busy || !quote} data-testid="quick-buy-btn">
                    {busy ?? `Buy ${target.side === SIDE_A ? "Yes" : "No"} · ${fmt(amountIn ?? 0n)} USDC`}
                  </button>
                )}

                {needsFunds && (
                  <p className={styles.hint}>
                    Not enough devnet USDC in your wallet —{" "}
                    <button type="button" className="button" data-variant="ghost" style={{ padding: "1px 8px" }} onClick={() => setFundingOpen(true)}>
                      get some first
                    </button>
                  </p>
                )}
                {topUpOnly && (
                  <p className={styles.hint}>
                    Your trading balance on this market is below that amount —{" "}
                    <Link href={`/market/${target.marketPda}`} onClick={onClose}>
                      top up on the market page →
                    </Link>
                  </p>
                )}
                {error && <p className={styles.error}>{error}</p>}
                <p className={styles.small}>
                  First buy on a market takes one wallet approval (moves funds in &amp; turns on 1-click trading);
                  after that, buys are instant.
                </p>
              </>
            )}
          </>
        )}
      </Modal>
      <FundingModal open={fundingOpen} onClose={() => setFundingOpen(false)} />
    </>
  );
}
