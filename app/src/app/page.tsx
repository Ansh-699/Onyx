// Landing page — server component. Centered hero with a liquid-glass CTA,
// then a framed LIVE app preview: the market cards inside it are real
// devnet markets fetched at request time (real prices, real volume) — the
// reference sites embed a screenshot; we embed the product. On RPC failure
// the preview/stats are omitted, never faked.

import Link from "next/link";
import {
  listMarkets,
  getAmmPoolsForMarkets,
  volumeFromFees,
  STATUS_OPEN,
  STATUS_LIVE,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  type OnChainMarket,
  type AmmPoolSummary,
} from "@/lib/onchain";
import { describeMarketPredicate } from "@/lib/statKeys";
import { getFixtureInfo, primeLiveFixtures } from "@/lib/fixtureMeta";
import { getLiveFixtures } from "@/lib/txlineFixtures";
import { flagFor } from "@/lib/flags";
import { Reveal } from "@/components/Reveal";
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
  preview: PreviewMarket[];
}

async function getLiveData(): Promise<LiveData | null> {
  try {
    // Server-side render: the live-fixture overlay is normally primed by a
    // client hook — prime it here so preview cards get real team names.
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

    // Top 3 live, named markets by real volume — the preview cards.
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
      .sort((a, b) => Number(volumeFromFees(b.pool.feesAccrued, b.pool.feeBps) - volumeFromFees(a.pool.feesAccrued, a.pool.feeBps)));

    const preview = candidates.slice(0, 3).map(({ m, pool }) => previewCard(m, pool));
    return { totalMarkets: markets.length, settledCount, volumeRaw, preview };
  } catch {
    return null; // RPC hiccup — hero renders without live sections. Never fake.
  }
}

function previewCard(m: OnChainMarket, pool: AmmPoolSummary): PreviewMarket {
  const info = getFixtureInfo(Number(m.fixtureId))!;
  const total = pool.reserveA + pool.reserveB;
  const yesCents = total > 0n ? Math.round(Number((pool.reserveB * 1000n) / total) / 10) : 50;
  const vol = Number(volumeFromFees(pool.feesAccrued, pool.feeBps)) / 1e6;
  return {
    pda: m.pda,
    fixture: `${flagFor(info.participant1)} ${info.participant1} vs ${info.participant2} ${flagFor(info.participant2)}`.trim(),
    title: describeMarketPredicate(m, info),
    yesCents,
    volume: vol.toLocaleString(undefined, { maximumFractionDigits: 0 }),
  };
}

function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  return whole.toLocaleString("en-US");
}

const FEATURES = [
  {
    icon: "⚡",
    title: "1-click trading",
    body: "One approval mints a scoped session key — every trade after that is instant, popup-free, and gas-free. The key can only trade; it can never withdraw.",
  },
  {
    icon: "🚀",
    title: "~1s flash trades",
    body: "Swaps run on MagicBlock's Ephemeral Rollup and confirm in about a second, with fees sponsored by the validator.",
  },
  {
    icon: "⚖️",
    title: "Trustless settlement",
    body: "Outcomes are decided by a CPI into TxODDS's own validate_stat oracle against a Merkle proof — never by an admin key.",
  },
  {
    icon: "🧾",
    title: "Verifiable receipts",
    body: "Every settlement is independently checkable from public RPC alone — the oracle's return value, its logs, and the market account must all agree.",
  },
  {
    icon: "🔄",
    title: "Sell anytime",
    body: "The pool is the counterparty (CPMM over outcome tokens) — buy AND sell at any moment before kickoff, with slippage protection enforced on-chain.",
  },
  {
    icon: "🕶️",
    title: "MEV-proof sealed mode",
    body: "An advanced second market type keeps bets as commitments until a batch clears at one uniform price — nothing to front-run.",
  },
] as const;

const HOW = [
  {
    n: "1",
    title: "Add funds",
    body: "Free devnet USDC from the faucet, or swap devnet SOL — then one approval moves funds into a market and switches on 1-click trading.",
  },
  {
    n: "2",
    title: "Trade instantly",
    body: "Buy Yes or No at live pool prices. Every trade confirms in ~1s with no popups, no gas — sell the moment the price moves your way.",
  },
  {
    n: "3",
    title: "Withdraw winnings",
    body: "The oracle settles the market from real match stats; winnings appear in your Vault and one approval sends them to your wallet.",
  },
] as const;

export default async function LandingPage() {
  const live = await getLiveData();

  return (
    <div className={styles.page}>
      {/* ---- hero: centered, into.space structure, ONYX glass ---- */}
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={`${styles.heroItem} ${styles.d0}`}>
            <span className={styles.wordmark}>ONYX</span>
          </div>
          <div className={`${styles.badges} ${styles.heroItem} ${styles.d1}`}>
            <span className="pill" data-tone="green">
              <span className={styles.liveDot} aria-hidden />
              Live on Solana devnet
            </span>
            <span className="pill" data-tone="accent">⚡ Powered by MagicBlock</span>
          </div>
          <h1 className={`${styles.heroTitle} ${styles.heroItem} ${styles.d2}`}>
            Prediction markets
            <br />
            at flash speed.
          </h1>
          <p className={`${styles.heroSub} ${styles.heroItem} ${styles.d3}`}>
            Buy and sell World Cup outcomes in ~1 second — one approval, then no popups, no gas.
            Settled on-chain by a real oracle, verifiable by anyone.
          </p>
          <div className={`${styles.heroItem} ${styles.d4}`}>
            <Link href="/markets" className={styles.heroCta}>
              <span>Launch app →</span>
            </Link>
          </div>
          <nav className={`${styles.pillNav} ${styles.heroItem} ${styles.d5}`} aria-label="Sections">
            <Link href="/markets" data-primary="true">Markets</Link>
            <Link href="/portfolio">Portfolio</Link>
            <Link href="/create">Create</Link>
            <Link href="/how-to-trade">How to trade</Link>
          </nav>
        </div>
      </section>

      {/* ---- live app preview: REAL markets, real prices ---- */}
      {live && live.preview.length > 0 && (
        <Reveal>
          <section className={styles.previewFrame} aria-label="Live markets preview">
            <div className={styles.previewChrome}>
              <span className={styles.chromeDot} />
              <span className={styles.chromeDot} />
              <span className={styles.chromeDot} />
              <span className={styles.chromeLabel}>live from devnet — these are real markets, click one</span>
            </div>
            <div className={styles.previewGrid}>
              {live.preview.map((p) => (
                <Link key={p.pda} href={`/market/${p.pda}`} className={styles.previewCard}>
                  <span className={styles.previewFixture}>{p.fixture}</span>
                  <span className={styles.previewTitle}>{p.title}</span>
                  <span className={styles.previewPrices}>
                    <span className={styles.pYes}>Yes {p.yesCents}¢</span>
                    <span className={styles.pNo}>No {100 - p.yesCents}¢</span>
                  </span>
                  <span className={styles.previewVol}>{p.volume} USDC traded</span>
                </Link>
              ))}
            </div>
            <div className={styles.previewStats}>
              <span>
                <strong>{live.totalMarkets}</strong> markets on-chain
              </span>
              <span>
                <strong>{live.settledCount}</strong> settled &amp; verified
              </span>
              <span>
                <strong>{formatUsdc(live.volumeRaw)}</strong> USDC traded (devnet)
              </span>
            </div>
          </section>
        </Reveal>
      )}

      {/* ---- feature grid ---- */}
      <section className={styles.section}>
        <Reveal>
          <h2 className={styles.sectionTitle}>Built different, provably.</h2>
        </Reveal>
        <div className={styles.featureGrid}>
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 90}>
              <div className={styles.featureCard}>
                <span className={styles.featureIcon} aria-hidden>
                  {f.icon}
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className={styles.section}>
        <Reveal>
          <h2 className={styles.sectionTitle}>How it works</h2>
          <p className={styles.sectionSub}>Two wallet approvals total — everything in between is instant.</p>
        </Reveal>
        <div className={styles.howGrid}>
          {HOW.map((s, i) => (
            <Reveal key={s.n} delay={i * 110}>
              <div className={styles.howCard}>
                <span className={styles.howNum}>{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <div className={styles.bottomCta}>
            <Link href="/markets" className={styles.heroCta}>
              <span>Start trading →</span>
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ---- honest footer ---- */}
      <footer className={styles.footNote}>
        <p className="muted">
          Devnet build for the TxODDS World Cup Hackathon. Escrow uses test-USDC (a devnet SPL token — not real
          funds); match data comes from TxLINE. Program <span className="mono">4LpMz…18MB</span> — every
          settlement above is checkable on public devnet RPC.
        </p>
      </footer>
    </div>
  );
}
