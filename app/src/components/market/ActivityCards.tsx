"use client";

// Price-history chart + recent-trades feed for AMM markets. Both render ONLY
// real data from /api/history: every price point is a genuine on-chain read
// (recorded at swap time by the seeding script, or a 60s live sample the API
// takes itself), and every trade row carries the real transaction signature.
// When there's nothing real to show, the cards hide — never fabricate.

import { useAmmPriceHistory, useRoutedAmmPool } from "@/lib/hooks";
import { explorerTxUrlFor } from "@/lib/onchain";
import styles from "./PricePanel.module.css";

const W = 600;
const H = 150;
const PAD_L = 44;
const PAD_R = 16;
const PAD_Y = 14;

function yFor(pct: number): number {
  return PAD_Y + ((100 - pct) / 100) * (H - PAD_Y * 2);
}

function timeAgo(t: number): string {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PriceHistoryCard({ marketPda }: { marketPda: string }) {
  const { data, isPending } = useAmmPriceHistory([marketPda]);
  const series = data?.[marketPda];
  const points = series?.points ?? [];
  // Skeleton while the first fetch is in flight — same box as the loaded
  // card so the swap shifts nothing.
  if (isPending) {
    return (
      <div className={`card ${styles.wrap}`} aria-hidden>
        <div className="skeleton" style={{ height: 14, width: 180 }} />
        <div className="skeleton" style={{ height: 34, width: 90, marginTop: 8 }} />
        <div className="skeleton" style={{ height: 150, marginTop: 12 }} />
        <div className="skeleton" style={{ height: 14, width: "85%", marginTop: 12 }} />
        <div className="skeleton" style={{ height: 14, width: "55%", marginTop: 6 }} />
      </div>
    );
  }
  if (points.length < 2) return null;

  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(t1 - t0, 1);
  const path = points
    .map((p, i) => {
      const x = PAD_L + ((p.t - t0) / span) * (W - PAD_L - PAD_R);
      const y = yFor(p.priceA / 10_000);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const lastPct = points[points.length - 1]!.priceA / 10_000;
  const up = points[points.length - 1]!.priceA >= points[0]!.priceA;

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.topRow}>
        <div>
          <div className={styles.bigLabel}>Yes price · recorded history</div>
          <div className={styles.big} data-testid="history-last">
            {lastPct.toFixed(1)}%
          </div>
        </div>
      </div>
      <div className={styles.chartBox}>
        <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {[0, 25, 50, 75, 100].map((pct) => (
            <g key={pct}>
              <line x1={PAD_L} x2={W - PAD_R} y1={yFor(pct)} y2={yFor(pct)} className={styles.gridLine} />
              <text x={PAD_L - 8} y={yFor(pct) + 3} className={styles.gridLabel} textAnchor="end">
                {pct}%
              </text>
            </g>
          ))}
          <path d={path} fill="none" strokeWidth="1.8" stroke={up ? "var(--green)" : "var(--red)"} />
        </svg>
      </div>
      <p className={styles.honest}>
        {points.length} real price points — each one a live read of the pool&apos;s on-chain reserves (sampled at
        swap time and every ~60s while the page is open). Nothing here is simulated.
      </p>
    </div>
  );
}

export function RecentTradesCard({ marketPda }: { marketPda: string }) {
  const { data, isPending } = useAmmPriceHistory([marketPda]);
  // ER-delegated market: its swaps live on the ER ledger, so tx links must
  // point the explorer at the ER RPC (a plain devnet link shows Not Found).
  const routed = useRoutedAmmPool(marketPda);
  const txRpc = routed.isDelegated ? routed.connection.rpcEndpoint : null;
  const trades = data?.[marketPda]?.trades ?? [];
  if (isPending) {
    // 10 rows ≈ the loaded card's usual 12-row height — the old 4-row
    // placeholder grew ~260px on load and shoved everything below it down
    return (
      <div className={`card ${styles.wrap}`} aria-hidden>
        <div className="skeleton" style={{ height: 14, width: 240 }} />
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 22, marginTop: 10 }} />
        ))}
        <div className="skeleton" style={{ height: 14, width: "75%", marginTop: 12 }} />
      </div>
    );
  }
  if (trades.length === 0) return null;

  return (
    <div className={`card ${styles.wrap}`}>
      <div className={styles.bigLabel}>Recent trades · recorded on-chain swaps</div>
      <ul className={styles.tradeList}>
        {trades.slice(0, 12).map((t) => (
          <li key={t.sig} className={styles.tradeRow}>
            <span className={styles.tradeSide} data-side={t.side}>
              {t.dir === 0 ? "Bought" : "Sold"} {t.side === 1 ? "YES" : "NO"}
            </span>
            <span className={styles.tradeAmt}>
              {t.amountIn !== "0" ? `${(Number(t.amountIn) / 1e6).toFixed(2)} ${t.dir === 0 ? "tUSDC" : "tokens"}` : ""}
            </span>
            <span className={styles.tradeWhen}>{timeAgo(t.t)}</span>
            <a
              href={explorerTxUrlFor(t.sig, txRpc)}
              target="_blank"
              rel="noreferrer"
              className={styles.tradeLink}
              title={txRpc ? "Ephemeral Rollup transaction — explorer opens pointed at the ER's RPC" : "Base devnet transaction"}
            >
              tx ↗
            </a>
          </li>
        ))}
      </ul>
      <p className={styles.honest}>
        Every row is a real devnet swap — the link opens its transaction on the explorer. Includes disclosed
        seeded market-making.
      </p>
    </div>
  );
}
