"use client";

// Honest price panel. Everything shown is derived from real on-chain state:
// pool-implied probability (totalSideA / total), volume, and — only once a
// batch has actually cleared — the real uniform clearing price. There is NO
// stored price history anywhere in this build, so the chart area renders a
// truthful empty state (with the single real clearing-price point when it
// exists) instead of a fabricated curve.

import { useMemo } from "react";
import type { Connection } from "@solana/web3.js";
import {
  type OnChainMarket,
  type OnChainAmmPool,
  PHASE_MATCHED,
  PHASE_NONE,
  TRADING_STATUS_LOCKED,
  TRADING_STATUS_REVEALED,
  priceToPercent,
} from "@/lib/onchain";
import { useSealedOrders, useTradingAccountsForMarket } from "@/lib/hooks";
import { spotPriceScaled } from "@/lib/ammMath";
import { fmtUsdc } from "./format";
import styles from "./PricePanel.module.css";

/**
 * AMM variant: the pool's live reserves ARE the price, so this shows the
 * real tradeable Yes/No prices in cents — unlike the sealed panel below,
 * whose Market.total_side_a/b figures are only written by batch matches and
 * therefore read 0/empty on an AMM market (the confusing dual-price state
 * this component replaces).
 */
export function AmmPricePanel({ pool, isDelegated }: { pool: OnChainAmmPool; isDelegated: boolean }) {
  const priceA = spotPriceScaled(pool.reserveA, pool.reserveB);
  const priceB = 1_000_000n - priceA;
  const centsA = Math.round(Number(priceA) / 10_000);
  const pctA = Number(priceA) / 10_000;

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.topRow}>
        <div>
          <div className={styles.bigLabel}>Yes (Side A) · pool price</div>
          <div className={styles.big}>{centsA}¢</div>
        </div>
        <dl className={styles.stats}>
          <div>
            <dt>No (Side B)</dt>
            <dd>{100 - centsA}¢</dd>
          </div>
          <div>
            <dt>Pool reserves</dt>
            <dd>
              {fmtUsdc(pool.reserveA)} A / {fmtUsdc(pool.reserveB)} B
            </dd>
          </div>
          <div>
            <dt>Fees accrued</dt>
            <dd>{fmtUsdc(pool.feesAccrued)} tUSDC</dd>
          </div>
        </dl>
      </div>

      <div className={styles.bar} data-empty="false" aria-hidden>
        <span className={styles.barA} style={{ width: `${pctA}%` }} />
      </div>
      <div className={styles.barLegend}>
        <span>Yes {pctA.toFixed(1)}%</span>
        <span>No {(100 - pctA).toFixed(1)}%</span>
      </div>

      <p className="muted" style={{ fontSize: "0.75rem", marginTop: 10 }}>
        Live CPMM price from the pool&apos;s current on-chain reserves ({isDelegated ? "read from the Ephemeral Rollup" : "base devnet"}) —
        price_yes = reserve_no / (reserve_yes + reserve_no). Every buy/sell moves it; nothing here is simulated.
      </p>
    </div>
  );
}

const CHART_W = 600;
const CHART_H = 150;
const PAD_L = 44;
const PAD_R = 16;
const PAD_Y = 14;

function yFor(pct: number): number {
  return PAD_Y + ((100 - pct) / 100) * (CHART_H - PAD_Y * 2);
}

export function PricePanel({ market, connection }: { market: OnChainMarket; connection: Connection }) {
  const total = market.totalSideA + market.totalSideB;
  const hasPool = total > 0n;
  const sideAPct = hasPool ? (Number(market.totalSideA) / Number(total)) * 100 : null;

  // "Volume" above is Market.total_side_a/b — written ONLY by run_batch_match
  // / run_batch_match_fast, from matched size. Real collateral that's been
  // committed (and for revealed orders, escrowed against a known side) but
  // hasn't cleared a batch yet is invisible in that figure — a market can
  // have real locked tUSDC and still read "Volume: 0", which is honest but
  // incomplete. Surface it separately, never folded into Volume itself.
  //
  // Two independent order systems can both have real locked collateral on
  // the SAME market (the classic SealedOrder flow, always base-only; the
  // ER-fast TradingAccount flow, base-or-ER depending on delegation) — this
  // stat must sum BOTH or it silently under-reports on any market using the
  // now-default ER-fast flow. Caught by re-reading this file after building
  // ErTradingPanel: it only ever queried useSealedOrders.
  const isSealed = market.phase !== PHASE_NONE;
  const ordersQuery = useSealedOrders(isSealed ? market.pda : "");
  const classicLocked = useMemo(() => {
    const orders = ordersQuery.data ?? [];
    return orders
      .filter((o) => o.status === 0 || o.status === 1) // Locked or Revealed — not yet Matched/Refunded
      .reduce((sum, o) => sum + o.collateralLocked, 0n);
  }, [ordersQuery.data]);

  const tradingAccountsQuery = useTradingAccountsForMarket(isSealed ? market.pda : "", connection);
  const fastLocked = useMemo(() => {
    const tas = tradingAccountsQuery.data ?? [];
    return tas
      .filter((t) => t.status === TRADING_STATUS_LOCKED || t.status === TRADING_STATUS_REVEALED)
      .reduce((sum, t) => sum + t.locked, 0n);
  }, [tradingAccountsQuery.data]);

  const lockedCollateral = classicLocked + fastLocked;

  // phase stays Matched even after settle/claim, so a settled market still
  // shows the real clearing price its batch produced.
  const cleared = market.phase === PHASE_MATCHED;
  const clearingPct = cleared ? (Number(market.clearingPrice) / 1_000_000) * 100 : null;
  const pricePoints = cleared ? 1 : 0;

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.topRow}>
        <div>
          <div className={styles.bigLabel}>Side A pool-implied probability</div>
          <div className={`${styles.big} live-value`}>
            {sideAPct !== null ? `${sideAPct.toFixed(1)}%` : "—"}
          </div>
          {!hasPool && <div className={styles.empty}>(empty pool — no price yet)</div>}
        </div>
        <dl className={styles.stats}>
          <div>
            <dt title="Matched volume only — the sum of collateral that has actually cleared a batch (run_batch_match), not raw commitments.">
              Volume
            </dt>
            <dd className="live-value">{fmtUsdc(total)} tUSDC</dd>
          </div>
          <div>
            <dt>Side A pool</dt>
            <dd className="live-value">{fmtUsdc(market.totalSideA)} tUSDC</dd>
          </div>
          <div>
            <dt>Side B pool</dt>
            <dd className="live-value">{fmtUsdc(market.totalSideB)} tUSDC</dd>
          </div>
          {isSealed && lockedCollateral > 0n && (
            <div>
              <dt title="Real, on-chain escrowed collateral behind orders that are committed and/or revealed but haven't cleared a batch yet — not counted in Volume above until they match.">
                Locked (pending match)
              </dt>
              <dd className="live-value">{fmtUsdc(lockedCollateral)} tUSDC</dd>
            </div>
          )}
          {cleared && (
            <div>
              <dt>Clearing price</dt>
              <dd className={styles.clearing}>{priceToPercent(market.clearingPrice)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div
        className={styles.bar}
        role="img"
        aria-label={
          sideAPct !== null
            ? `Side A ${sideAPct.toFixed(1)}% of the pool`
            : "Empty pool"
        }
        data-empty={!hasPool}
      >
        {hasPool && <div className={styles.barA} style={{ width: `${sideAPct}%` }} />}
      </div>
      <div className={styles.barLegend}>
        <span>Side A {fmtUsdc(market.totalSideA)}</span>
        <span>Side B {fmtUsdc(market.totalSideB)}</span>
      </div>

      <div className={styles.chartBox}>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {[0, 25, 50, 75, 100].map((pct) => (
            <g key={pct}>
              <line
                x1={PAD_L}
                x2={CHART_W - PAD_R}
                y1={yFor(pct)}
                y2={yFor(pct)}
                className={styles.gridLine}
              />
              <text x={PAD_L - 8} y={yFor(pct) + 3} className={styles.gridLabel} textAnchor="end">
                {pct}%
              </text>
            </g>
          ))}
          {clearingPct !== null && (
            <g>
              <line
                x1={PAD_L}
                x2={CHART_W - 72}
                y1={yFor(clearingPct)}
                y2={yFor(clearingPct)}
                className={styles.pointGuide}
              />
              <circle cx={CHART_W - 72} cy={yFor(clearingPct)} r={5} className={styles.point} />
              <text
                x={CHART_W - 62}
                y={yFor(clearingPct) + 3}
                className={styles.pointLabel}
                textAnchor="start"
              >
                {priceToPercent(market.clearingPrice)}
              </text>
            </g>
          )}
        </svg>
        {pricePoints === 0 && (
          <div className={styles.chartEmpty}>no cleared batches yet — nothing to plot</div>
        )}
      </div>
      <p className={styles.honest}>
        Price history accumulates as batches clear — this market has {pricePoints} real price point
        {pricePoints === 1 ? "" : "s"} so far. Nothing here is simulated.
      </p>
    </div>
  );
}
