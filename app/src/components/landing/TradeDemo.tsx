"use client";

// The trade screen inside the landing's floating app panel: plays a live
// trade. Honesty rails: the chart is REAL recorded price history for a REAL
// market; the order-panel math runs the SAME quoteBuy the program mirrors
// (lib/ammMath.ts) against the market's real reserves; figures are small
// devnet tUSDC amounts, labeled as a demo. No leverage — ONYX is a spot AMM.
// `active` drives the animations (panel revealed AND this tab selected).

import { useEffect, useMemo, useState } from "react";
import { quoteBuy } from "@/lib/ammMath";
import styles from "./TradeDemo.module.css";

export interface DemoData {
  marketPda: string;
  fixture: string;
  title: string;
  yesCents: number;
  reserveA: string; // bigint as string (server → client)
  reserveB: string;
  feeBps: number;
  volume: string; // whole tUSDC, display
  /** real recorded points: [unix ms, priceA 1e6-scaled] */
  points: [number, number][];
}

const DEMO_TARGET_TUSDC = 25; // small, devnet-honest demo size
const COUNT_MS = 1600;

const CHART_W = 520;
const CHART_H = 210;
const PAD_L = 34;
const PAD_R = 10;
const PAD_Y = 16;

function fmt(n: number, dp = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function TradeScreen({ data, active }: { data: DemoData; active: boolean }) {
  const revealed = active;
  const [amount, setAmount] = useState(0);
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // amount count-up (rAF; reduced motion jumps straight to the end)
  useEffect(() => {
    if (!revealed) return;
    if (reduced) {
      setAmount(DEMO_TARGET_TUSDC);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min((t - t0) / COUNT_MS, 1);
      const eased = 1 - Math.pow(1 - k, 3);
      setAmount(DEMO_TARGET_TUSDC * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [revealed, reduced]);

  // REAL AMM quote at the current animated amount
  const quote = useMemo(() => {
    const amountIn = BigInt(Math.max(1, Math.round(amount * 1e6)));
    const rA = BigInt(data.reserveA);
    const rB = BigInt(data.reserveB);
    const [rIn, rOut] = side === "yes" ? [rA, rB] : [rB, rA];
    const q = quoteBuy(rIn, rOut, amountIn, data.feeBps || 100);
    if (!q) return { shares: 0, cost: amount, toWin: 0 };
    const shares = Number(q.tokensOut) / 1e6;
    // winning tokens redeem 1:1 for tUSDC — To Win = shares (the honest max payout)
    return { shares, cost: amount, toWin: shares };
  }, [amount, side, data.reserveA, data.reserveB, data.feeBps]);

  // chart geometry from the real points
  const chart = useMemo(() => {
    const pts = data.points;
    if (pts.length < 2) return null;
    const t0 = pts[0]![0];
    const t1 = pts[pts.length - 1]![0];
    const span = Math.max(t1 - t0, 1);
    const x = (t: number) => PAD_L + ((t - t0) / span) * (CHART_W - PAD_L - PAD_R);
    const y = (p: number) => PAD_Y + (1 - p / 1_000_000) * (CHART_H - PAD_Y * 2);
    const yes = pts.map(([t, p], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
    const no = pts.map(([t, p], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(1_000_000 - p).toFixed(1)}`).join(" ");
    const first = pts[0]![1] / 10_000;
    const last = pts[pts.length - 1]![1] / 10_000;
    return { yes, no, deltaYes: last - first };
  }, [data.points]);

  const noCents = 100 - data.yesCents;
  const deltaYes = chart ? chart.deltaYes : 0;

  return (
    <div>
      <div className={styles.body}>
        {/* left: real price history */}
        <div className={styles.chartSide}>
          <div className={styles.marketHead}>
            <span className={styles.fixture}>{data.fixture}</span>
            <span className={styles.title}>{data.title}</span>
          </div>
          <div className={styles.priceRow}>
            <span className={styles.bigPrice}>{data.yesCents}¢</span>
            <span className={styles.delta} data-up={deltaYes >= 0}>
              {deltaYes >= 0 ? "▲" : "▼"} {Math.abs(deltaYes).toFixed(1)}¢
            </span>
            <span className={styles.chipLabel}>Yes price</span>
          </div>
          {chart ? (
            <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className={styles.chart} aria-label="Real recorded price history">
              {[0, 25, 50, 75, 100].map((pct) => (
                <g key={pct}>
                  <line
                    x1={PAD_L}
                    x2={CHART_W - PAD_R}
                    y1={PAD_Y + (1 - pct / 100) * (CHART_H - PAD_Y * 2)}
                    y2={PAD_Y + (1 - pct / 100) * (CHART_H - PAD_Y * 2)}
                    className={styles.grid}
                  />
                  <text x={2} y={PAD_Y + (1 - pct / 100) * (CHART_H - PAD_Y * 2) + 3} className={styles.gridLabel}>
                    {pct}¢
                  </text>
                </g>
              ))}
              <path d={chart.no} className={`${styles.lineNo} ${revealed ? styles.draw : ""}`} />
              <path d={chart.yes} className={`${styles.lineYes} ${revealed ? styles.draw : ""}`} />
            </svg>
          ) : (
            <p className={styles.chipLabel}>price history accumulates as this market trades</p>
          )}
          <div className={styles.timeframes} aria-hidden>
            <span>1H</span>
            <span>1D</span>
            <span data-active="true">All</span>
          </div>
          <p className={styles.chartCaption}>real recorded on-chain prices · {data.volume} tUSDC traded</p>
        </div>

        {/* right: order panel running real math */}
        <div className={styles.orderSide}>
          <div className={styles.sideToggle}>
            <button type="button" data-kind="yes" data-active={side === "yes"} onClick={() => setSide("yes")}>
              Yes {data.yesCents}¢
            </button>
            <button type="button" data-kind="no" data-active={side === "no"} onClick={() => setSide("no")}>
              No {noCents}¢
            </button>
          </div>
          <div className={styles.buySellTabs} aria-hidden>
            <span data-active="true">Buy</span>
            <span>Sell</span>
          </div>
          <div className={styles.amount}>
            <span className={styles.amountLabel}>Amount</span>
            <span className={styles.amountValue}>
              {fmt(amount)} <span className={styles.unit}>tUSDC</span>
            </span>
          </div>
          <div className={styles.chips} aria-hidden>
            <span>+1</span>
            <span>+5</span>
            <span>+20</span>
            <span>MAX</span>
          </div>
          <span className={styles.buyBtn} role="presentation">
            Buy {side === "yes" ? "Yes" : "No"}
          </span>
          <dl className={styles.calc}>
            <div>
              <dt>Shares</dt>
              <dd>{fmt(quote.shares)}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{fmt(quote.cost)} tUSDC</dd>
            </div>
            <div>
              <dt>To win</dt>
              <dd className={styles.toWin}>{fmt(quote.toWin)} tUSDC</dd>
            </div>
          </dl>
          <p className={styles.orderCaption}>quoted with the exact on-chain CPMM math · winning shares redeem 1:1</p>
        </div>
      </div>

      {/* outcomes rows */}
      <div className={styles.outcomes}>
        <div className={styles.outcomeRow}>
          <span className={styles.outcomeName}>Yes</span>
          <span className={styles.outcomePrice}>{data.yesCents}¢</span>
          <span className={styles.delta} data-up={deltaYes >= 0}>
            {deltaYes >= 0 ? "▲" : "▼"} {Math.abs(deltaYes).toFixed(1)}
          </span>
          <span className={styles.oYes} role="presentation">
            Buy Yes
          </span>
        </div>
        <div className={styles.outcomeRow}>
          <span className={styles.outcomeName}>No</span>
          <span className={styles.outcomePrice}>{noCents}¢</span>
          <span className={styles.delta} data-up={deltaYes < 0}>
            {deltaYes < 0 ? "▲" : "▼"} {Math.abs(deltaYes).toFixed(1)}
          </span>
          <span className={styles.oNo} role="presentation">
            Buy No
          </span>
        </div>
      </div>
    </div>
  );
}
