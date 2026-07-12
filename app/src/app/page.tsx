// Marketing landing — into.space-style: full-bleed sky-gradient hero (theme
// variant A), glass credibility pill, one glass CTA, and the signature dark
// app panel that floats up over the hero and plays a live trade using REAL
// market data + the REAL AMM math (see components/landing/TradeDemo).
// Server component: all market data fetched at request time; sections that
// need live data are omitted on RPC failure, never faked. The app nav hides
// itself on this route (Nav.tsx) — the landing brings its own chrome.

import Link from "next/link";
import {
  listMarkets,
  getAmmPoolsForMarkets,
  volumeFromFees,
  STATUS_OPEN,
  STATUS_LIVE,
  STATUS_SETTLED,
  STATUS_CLAIMED,
} from "@/lib/onchain";
import { describeMarketPredicate } from "@/lib/statKeys";
import { getFixtureInfo, primeLiveFixtures } from "@/lib/fixtureMeta";
import { getLiveFixtures } from "@/lib/txlineFixtures";
import { flagFor } from "@/lib/flags";
import { readHistory } from "@/lib/priceHistory";
import { Reveal } from "@/components/Reveal";
import type { DemoData } from "@/components/landing/TradeDemo";
import { LandingHero } from "@/components/landing/LandingHero";
import styles from "./landing.module.css";

export const dynamic = "force-dynamic";

interface PreviewMarket {
  pda: string;
  fixture: string;
  title: string;
  yesCents: number;
  volume: string;
}

interface LiveData {
  totalMarkets: number;
  settledCount: number;
  volumeRaw: bigint;
  demo: DemoData | null;
  preview: PreviewMarket[];
}

async function getLiveData(): Promise<LiveData | null> {
  try {
    await getLiveFixtures().then(primeLiveFixtures).catch(() => {});
    const markets = await listMarkets();
    const pools = await getAmmPoolsForMarkets(markets.map((m) => m.pda));
    let volumeRaw = 0n;
    let settledCount = 0;
    for (const m of markets) {
      volumeRaw += m.totalSideA + m.totalSideB;
      if (m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED) settledCount++;
    }
    for (const p of pools.values()) volumeRaw += volumeFromFees(p.feesAccrued, p.feeBps);

    const now = Math.floor(Date.now() / 1000);
    const candidates = markets
      .filter(
        (m) =>
          (m.status === STATUS_OPEN || m.status === STATUS_LIVE) &&
          Number(m.deadline) > now &&
          pools.has(m.pda) &&
          getFixtureInfo(Number(m.fixtureId)) !== null,
      )
      .map((m) => ({ m, pool: pools.get(m.pda)! }))
      .sort((a, b) =>
        Number(volumeFromFees(b.pool.feesAccrued, b.pool.feeBps) - volumeFromFees(a.pool.feesAccrued, a.pool.feeBps)),
      );

    // demo panel: the top market WITH recorded price history
    const history = readHistory();
    let demo: DemoData | null = null;
    for (const { m, pool } of candidates) {
      const series = history.pools[pool.pool]?.points ?? [];
      if (series.length < 8) continue;
      const info = getFixtureInfo(Number(m.fixtureId))!;
      const total = pool.reserveA + pool.reserveB;
      demo = {
        marketPda: m.pda,
        fixture: `${flagFor(info.participant1)} ${info.participant1} vs ${info.participant2} ${flagFor(info.participant2)}`.trim(),
        title: describeMarketPredicate(m, info),
        yesCents: total > 0n ? Math.round(Number((pool.reserveB * 1000n) / total) / 10) : 50,
        reserveA: pool.reserveA.toString(),
        reserveB: pool.reserveB.toString(),
        feeBps: pool.feeBps,
        volume: (Number(volumeFromFees(pool.feesAccrued, pool.feeBps)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }),
        points: series.map((p) => [p.t, p.priceA] as [number, number]),
      };
      break;
    }

    const preview = candidates.slice(0, 3).map(({ m, pool }) => {
      const info = getFixtureInfo(Number(m.fixtureId))!;
      const total = pool.reserveA + pool.reserveB;
      return {
        pda: m.pda,
        fixture: `${flagFor(info.participant1)} ${info.participant1} vs ${info.participant2} ${flagFor(info.participant2)}`.trim(),
        title: describeMarketPredicate(m, info),
        yesCents: total > 0n ? Math.round(Number((pool.reserveB * 1000n) / total) / 10) : 50,
        volume: (Number(volumeFromFees(pool.feesAccrued, pool.feeBps)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }),
      };
    });

    return { totalMarkets: markets.length, settledCount, volumeRaw, demo, preview };
  } catch {
    return null;
  }
}

const FEATURES = [
  {
    title: "Ephemeral Rollup speed",
    body: "Trades run on MagicBlock's ER and confirm in ~1 second with validator-sponsored fees — proven live with concurrent wallets.",
  },
  {
    title: "Provable solvency",
    body: "Every market's vault drains to exactly zero at settlement — an on-chain identity checked to the lamport in every live proof.",
  },
  {
    title: "Session-key trading",
    body: "One approval mints a browser key scoped to trading only. It mathematically cannot withdraw — and every trade after is popup-free.",
  },
] as const;

export default async function LandingPage() {
  const live = await getLiveData();

  return (
    <div className={styles.bleed}>
      {/* announcement strip */}
      <div className={styles.announce}>
        Now live on Solana devnet ·{" "}
        <a href="https://github.com/Ansh-699/Onyx" target="_blank" rel="noreferrer">
          github.com/Ansh-699/Onyx
        </a>
      </div>

      {/* ---- sky hero + tabbed preview panel (client component) ---- */}
      <div className={styles.skyZone}>
        <LandingHero demo={live?.demo ?? null} preview={live?.preview ?? []} />
      </div>

      {/* ---- light lower sections ---- */}
      <div className={styles.lower}>
        <Reveal>
          <section className={styles.featureRow}>
            {FEATURES.map((f) => (
              <div key={f.title} className={styles.featureCard}>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </section>
        </Reveal>

        {live && live.preview.length > 0 && (
          <Reveal>
            <section className={styles.marketsStrip}>
              <h2 className={styles.stripTitle}>Live markets right now</h2>
              <div className={styles.stripGrid}>
                {live.preview.map((p) => (
                  <Link key={p.pda} href={`/market/${p.pda}`} className={styles.previewCard}>
                    <span className={styles.previewFixture}>{p.fixture}</span>
                    <span className={styles.previewTitle}>{p.title}</span>
                    <span className={styles.previewPrices}>
                      <span className={styles.pYes}>Yes {p.yesCents}¢</span>
                      <span className={styles.pNo}>No {100 - p.yesCents}¢</span>
                    </span>
                    <span className={styles.previewVol}>{p.volume} tUSDC traded</span>
                  </Link>
                ))}
              </div>
              <div className={styles.stripStats}>
                <span>
                  <strong>{live.totalMarkets}</strong> markets on-chain
                </span>
                <span>
                  <strong>{live.settledCount}</strong> settled &amp; verified
                </span>
                <span>
                  <strong>{(Number(live.volumeRaw) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong> tUSDC traded (devnet)
                </span>
              </div>
            </section>
          </Reveal>
        )}

        <footer className={styles.footer}>
          <div className={styles.footerLinks}>
            <a href="https://github.com/Ansh-699/Onyx" target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
            <a
              href="https://explorer.solana.com/address/4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB?cluster=devnet"
              target="_blank"
              rel="noreferrer"
            >
              Program on Explorer ↗
            </a>
            <Link href="/how-to-trade">How to trade</Link>
            <Link href="/demo/mev">Why sealed markets?</Link>
          </div>
          <p className="muted">
            Devnet build for the TxODDS World Cup Hackathon. Escrow uses test-USDC — not real funds. Every
            settlement is checkable on public devnet RPC.
          </p>
        </footer>
      </div>
    </div>
  );
}
