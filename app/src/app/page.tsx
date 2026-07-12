// Landing page — server component. The stat strip reads REAL devnet state via
// listMarkets() at request time (force-dynamic); if the RPC read fails the
// strip is simply omitted rather than ever showing fake numbers.

import Link from "next/link";
import {
  listMarkets,
  getAmmPoolsForMarkets,
  volumeFromFees,
  STATUS_SETTLED,
  STATUS_CLAIMED,
} from "@/lib/onchain";
import { LiquidButton } from "@/components/ui/liquid-glass-button";
import styles from "./landing.module.css";

export const dynamic = "force-dynamic";

interface LiveStats {
  totalMarkets: number;
  settledCount: number;
  /** Sealed matched volume + AMM volume derived from on-chain pool fees, raw 6-decimal units. */
  volumeRaw: bigint;
}

async function getLiveStats(): Promise<LiveStats | null> {
  try {
    const markets = await listMarkets();
    let volumeRaw = 0n;
    let settledCount = 0;
    for (const m of markets) {
      volumeRaw += m.totalSideA + m.totalSideB;
      if (m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED) settledCount++;
    }
    // AMM volume is real and derived, never stored: fees × 10000 / fee_bps.
    const pools = await getAmmPoolsForMarkets(markets.map((m) => m.pda));
    for (const p of pools.values()) volumeRaw += volumeFromFees(p.feesAccrued, p.feeBps);
    return { totalMarkets: markets.length, settledCount, volumeRaw };
  } catch {
    // Devnet RPC hiccup — render the page without the stat strip. Never fake.
    return null;
  }
}

/** 6-decimal raw units -> human string, e.g. 12_500_000n -> "12.50". */
function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const cents = (raw % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

const FEATURED_PILLAR = {
  tag: "Real-time",
  title: "Trade in real time, one signature",
  body: (
    <>
      One wallet signature starts a trading session: it funds your position and
      mints a scoped MagicBlock session key. Every trade after that confirms in
      ~1 second on an ephemeral rollup — no popups, no gas. The session key can
      only swap; it can <strong>never</strong> withdraw your funds, and that
      scope is enforced by the on-chain program, not the UI.
    </>
  ),
};

const PILLARS = [
  {
    tag: "Settlement",
    title: "Trustless settlement",
    body: "Outcomes are decided by a CPI into TxODDS's own on-chain validate_stat against an anchored Merkle root — never by ONYX. No admin key, no off-chain resolver: the same proof in always produces the same payout out.",
  },
  {
    tag: "Proof",
    title: "Verifiable receipts",
    body: "Every settlement is independently checkable from public RPC alone: the oracle's return value, its logs, and the market account all have to agree — with zero trust in ONYX's UI.",
  },
  {
    tag: "Markets",
    title: "Parametric props",
    body: "Markets on any TxLINE stat — goals, corners, cards — via a threshold predicate over per-fixture data. Not just “who wins.”",
  },
  {
    tag: "Advanced",
    title: "We also support MEV-proof sealed markets",
    body: "For order-flow privacy, a second market type keeps every bet a 32-byte commitment until a batch clears at one uniform price — nothing to front-run or copy-trade. See “Why sealed orders?” for the live demo.",
  },
] as const;

const STEPS = [
  {
    name: "Start a session",
    body: "One wallet signature funds your position and mints a scoped session key — it can trade, never withdraw.",
  },
  {
    name: "Trade instantly",
    body: "Buy AND sell anytime against the pool. Swaps confirm in ~1s on MagicBlock's Ephemeral Rollup — popup-free, gas-free.",
  },
  {
    name: "Oracle settles",
    body: "A CPI into TxLINE's validate_stat decides the outcome from a Merkle proof of the real match stats — never ONYX.",
  },
  {
    name: "Redeem on-chain",
    body: "Winning tokens redeem 1:1 from the market vault on base. Every payout is a public, checkable receipt.",
  },
] as const;

export default async function LandingPage() {
  const stats = await getLiveStats();

  return (
    <div className={styles.page}>
      {/* ---- Hero: the one liquid-glass brand moment on this page ---- */}
      <section className={styles.hero}>
        <div className={styles.heroGlass}>
          <div className={styles.heroContent}>
            <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
              <span className="pill" data-tone="green">
                <span className={styles.liveDot} aria-hidden="true" />
                Live on Solana devnet
              </span>
              <span className="pill" data-tone="accent">⚡ Powered by MagicBlock</span>
            </span>
            <h1 className={styles.heroTitle}>
              Trade prediction markets in real time.
            </h1>
            <p className={styles.heroSub}>
              Buy and sell World Cup outcomes anytime — near-instant and
              gas-free on MagicBlock ephemeral rollups, one signature to start
              a session, settled on-chain by TxODDS&apos;s own oracle. Every
              price, trade, and payout is verifiable from public RPC.
            </p>
            <div className={styles.ctas}>
              <LiquidButton asChild size="lg" className={styles.ctaLiquid}>
                <Link href="/markets">Launch app →</Link>
              </LiquidButton>
              <Link href="/demo/mev" className={styles.ctaGhost}>
                Why sealed orders?
              </Link>
            </div>
          </div>

          {/* ---- Live stat readout — real devnet reads, omitted on RPC failure ---- */}
          {stats && (
            <div className={styles.statStrip} aria-label="Live devnet statistics">
              <div className={styles.stat}>
                <span className={styles.statValue}>{stats.totalMarkets}</span>
                <span className={styles.statLabel}>markets on-chain</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{stats.settledCount}</span>
                <span className={styles.statLabel}>settled &amp; claimed</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>
                  {formatUsdc(stats.volumeRaw)}
                  <span className={styles.statUnit}> test-USDC</span>
                </span>
                <span className={styles.statLabel}>traded volume (devnet)</span>
              </div>
              <span className={`faint ${styles.statCaption}`}>
                live from devnet — read from the ONYX program at page load
              </span>
            </div>
          )}
        </div>
      </section>

      {/* ---- Why ONYX: one featured claim + a compact secondary list,
             deliberately not a uniform four-card icon grid ---- */}
      <section className={styles.section}>
        <p className={styles.sectionLabel}>Why ONYX</p>
        <h2 className={styles.sectionTitle}>Verify, don&apos;t trust.</h2>

        <div className={styles.featured}>
          <span className="pill" data-tone="accent">
            {FEATURED_PILLAR.tag}
          </span>
          <h3 className={styles.featuredTitle}>{FEATURED_PILLAR.title}</h3>
          <p className={`muted ${styles.featuredBody}`}>{FEATURED_PILLAR.body}</p>
        </div>

        <ul className={styles.pillarList}>
          {PILLARS.map((p) => (
            <li key={p.title} className={styles.pillarRow}>
              <span className={`pill ${styles.pillarTag}`} data-tone="accent">
                {p.tag}
              </span>
              <div>
                <h3 className={styles.pillarTitle}>{p.title}</h3>
                <p className={`muted ${styles.pillarBody}`}>{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- How it works ---- */}
      <section className={styles.section}>
        <p className={styles.sectionLabel}>How it works</p>
        <h2 className={styles.sectionTitle}>
          Session-key trading, four steps.
        </h2>
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.name} className={styles.step}>
              <span className={styles.stepNum} aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className={styles.stepName}>{s.name}</span>
              <span className={`muted ${styles.stepBody}`}>{s.body}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* ---- Honest footer ---- */}
      <footer className={styles.footNote}>
        <p className="muted">
          Devnet build for the TxODDS World Cup Hackathon. Escrow uses
          test-USDC (a devnet SPL token, 6 decimals — not real funds); match
          data comes from TxLINE&apos;s free tier. Program{" "}
          <span className="mono">4LpMz…18MB</span> — every settlement above is
          checkable on public devnet RPC.
        </p>
      </footer>
    </div>
  );
}
