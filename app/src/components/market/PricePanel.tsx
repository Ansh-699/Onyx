"use client";

// Honest price panel. Everything shown is derived from real on-chain state:
// pool-implied probability (totalSideA / total), volume, and — only once a
// batch has actually cleared — the real uniform clearing price. There is NO
// stored price history anywhere in this build, so the chart area renders a
// truthful empty state (with the single real clearing-price point when it
// exists) instead of a fabricated curve.

import {
  type OnChainMarket,
  PHASE_MATCHED,
  priceToPercent,
} from "@/lib/onchain";
import { fmtUsdc } from "./format";
import styles from "./PricePanel.module.css";

const CHART_W = 600;
const CHART_H = 150;
const PAD_L = 44;
const PAD_R = 16;
const PAD_Y = 14;

function yFor(pct: number): number {
  return PAD_Y + ((100 - pct) / 100) * (CHART_H - PAD_Y * 2);
}

export function PricePanel({ market }: { market: OnChainMarket }) {
  const total = market.totalSideA + market.totalSideB;
  const hasPool = total > 0n;
  const sideAPct = hasPool ? (Number(market.totalSideA) / Number(total)) * 100 : null;

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
            <dt>Volume</dt>
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
