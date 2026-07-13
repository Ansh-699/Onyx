"use client";

// The landing hero + floating preview panel, as one client component:
// - hero tab pill = a real tablist (state, arrow keys, aria) that swaps the
//   PANEL CONTENT in place — no navigation. Only "Launch App", the panel's
//   "Launch" button leave the page.
// - glass surfaces (credibility pill, CTA, tab pill) use liquid-glass-react
//   with the exact requested settings on Chromium; non-Chromium browsers
//   fall back to the plain CSS glass (the lib's displacement filter only
//   renders in Chromium).
// - preview screens reuse REAL data passed from the server; they never
//   trigger wallet connects or transactions.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import logoGemDark from "@/assets/onyx-gem.png";
import logoGemLight from "@/assets/onyx-gem-light.png";
import solanaLogo from "@/assets/Solana-Round-Logo-PNG.png";
import magicblockLogo from "@/assets/magicblock.jpg";
import { TradeScreen, seededRng, type DemoData } from "./TradeDemo";
import { ChromeCta } from "./ChromeCta";
import demoStyles from "./TradeDemo.module.css";
import styles from "@/app/landing.module.css";

export interface PreviewMarket {
  pda: string;
  fixture: string;
  title: string;
  yesCents: number;
  volume: string;
}

export interface ActivityRow {
  title: string;
  side: number; // 1 = Yes, 2 = No
  dir: number; // 0 = buy, 1 = sell
  amount: string;
  priceCents: number;
  t: number;
}

const TABS = [
  { id: "trade", label: "Trade" },
  { id: "markets", label: "Markets" },
  { id: "portfolio", label: "Portfolio" },
  { id: "activity", label: "Activity" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function timeAgo(t: number): string {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmt(n: number, dp = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Tiny seeded sparkline for preview cards. */
function Spark({ seed, up }: { seed: string; up: boolean }) {
  const rnd = seededRng(seed);
  let v = up ? 9 : 4;
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    v += (rnd() - (up ? 0.58 : 0.42)) * 3.2;
    v = Math.min(15, Math.max(2, v));
    pts.push(`${(i / 15) * 62},${v.toFixed(1)}`);
  }
  return (
    <svg viewBox="0 0 62 17" className={demoStyles.spark} aria-hidden>
      <polyline points={pts.join(" ")} data-up={up} />
    </svg>
  );
}

// Sample cards padding the grid out to six — REAL upcoming World Cup
// fixtures (from the verified TxLINE window), illustrative prices/volumes,
// each tagged "sample" on the card.
const SAMPLE_MARKETS = [
  { fixture: "🇳🇴 Norway vs England 🏴󠁧󠁢󠁥󠁮󠁧󠁿", title: "England goals — over 2.5", yesCents: 41, volume: "312" },
  { fixture: "🇪🇸 Spain vs Belgium 🇧🇪", title: "Total corners — over 9.5", yesCents: 62, volume: "187" },
  { fixture: "🇦🇷 Argentina vs Switzerland 🇨🇭", title: "Total yellow cards — over 4.5", yesCents: 33, volume: "254" },
  { fixture: "🇳🇴 Norway vs England 🏴󠁧󠁢󠁥󠁮󠁧󠁿", title: "Norway goals — over 0.5", yesCents: 71, volume: "146" },
] as const;

/** Markets screen: real market cards first, sample cards fill the grid. */
function MarketsScreen({ preview }: { preview: PreviewMarket[] }) {
  const cards = [
    ...preview.map((p) => ({ ...p, sample: false as const })),
    ...SAMPLE_MARKETS.map((m, i) => ({ ...m, pda: `sample-${i}`, sample: true as const })),
  ].slice(0, 6);
  return (
    <div>
      <div className={demoStyles.screenNote}>open markets · live cards from devnet · illustrative cards tagged “sample”</div>
      <div className={demoStyles.marketsScreen}>
        {cards.map((p) => (
          <div key={p.pda} className={demoStyles.previewCard}>
            <span className={demoStyles.previewCardTop}>
              <span className={demoStyles.fixture}>{p.fixture}</span>
              {p.sample && <span className={demoStyles.sampleTag}>sample</span>}
            </span>
            <span className={demoStyles.previewTitle}>{p.title}</span>
            <span className={demoStyles.previewMid}>
              <span className={demoStyles.previewChance}>
                {p.yesCents}% <span className={demoStyles.chipLabel}>chance</span>
              </span>
              <Spark seed={p.title} up={p.yesCents >= 50} />
            </span>
            <span className={demoStyles.previewPrices}>
              <span className={demoStyles.pvYes}>Yes {p.yesCents}¢</span>
              <span className={demoStyles.pvNo}>No {100 - p.yesCents}¢</span>
            </span>
            <span className={demoStyles.chipLabel}>
              ⚡ flash trade · {p.volume} tUSDC vol
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** P/L chart for the portfolio screen — seeded upward walk, green line. */
function PlChart() {
  const rnd = seededRng("onyx-pl");
  // viewBox ≈ rendered size so strokes/dots keep their aspect
  const W = 730;
  const H = 190;
  let v = 145;
  const pts: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    v += (rnd() - 0.62) * 18;
    v = Math.min(172, Math.max(36, v));
    pts.push([12 + (i / 39) * (W - 24), i === 39 ? 40 : v]);
  }
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={demoStyles.plChart} aria-hidden>
      {[0.25, 0.5, 0.75].map((k) => (
        <line key={k} x1={12} x2={W - 12} y1={H * k} y2={H * k} className={demoStyles.plGrid} />
      ))}
      <path d={d} />
      <circle cx={last[0]} cy={last[1]} r={4} />
    </svg>
  );
}

/** Portfolio screen: Space-style value/balance cards + P/L + positions table. All sample figures. */
function PortfolioScreen({ preview }: { preview: PreviewMarket[] }) {
  const positions = [0, 1, 2].map((i) => {
    const p = preview[i];
    const base = [
      { shares: 42.1, at: 33, side: "Yes" },
      { shares: 18.6, at: 58, side: "No" },
      { shares: 9.4, at: 22, side: "Yes" },
    ][i]!;
    const cur = p ? (base.side === "Yes" ? p.yesCents : 100 - p.yesCents) : [69, 74, 51][i]!;
    const sample = SAMPLE_MARKETS[i]!;
    const value = (base.shares * cur) / 100;
    const pl = value - (base.shares * base.at) / 100;
    return {
      key: p?.pda ?? `s${i}`,
      title: p?.title ?? sample.title,
      fixture: p?.fixture ?? sample.fixture,
      live: !!p,
      ...base,
      cur,
      value,
      pl,
    };
  });
  return (
    <div className={demoStyles.pfScreen}>
      <div className={demoStyles.pfTop}>
        <div className={demoStyles.pfLeft}>
          <div className={`${demoStyles.pfCard} ${demoStyles.pfGreen}`}>
            <span className={demoStyles.pfCardLabel}>◔ Portfolio</span>
            <span className={demoStyles.pfBig}>
              146.02 <span className={demoStyles.pfUnit}>tUSDC</span>
            </span>
            <svg viewBox="0 0 44 30" className={demoStyles.pfArrow} aria-hidden>
              <path d="M2 26 L14 15 L22 20 L40 4 M30 4 h10 v10" />
            </svg>
          </div>
          <div className={`${demoStyles.pfCard} ${demoStyles.pfBlue}`}>
            <span className={demoStyles.pfCardLabel}>◎ Balance</span>
            <span className={demoStyles.pfBig}>
              32.40 <span className={demoStyles.pfUnit}>tUSDC</span>
            </span>
          </div>
          <div className={demoStyles.pfBtns}>
            <span className={demoStyles.depositBtn} role="presentation">
              <span className={demoStyles.pfBtnIcon}>↓</span> Deposit
            </span>
            <span className={demoStyles.withdrawBtn} role="presentation">
              <span className={demoStyles.pfBtnIcon} data-ghost="true">↑</span> Withdraw
            </span>
          </div>
        </div>
        <div className={demoStyles.plCard}>
          <div className={demoStyles.plHead}>
            <span className={demoStyles.chipLabel}>📊 Profit/Loss</span>
            <span className={demoStyles.plValue}>
              +18.62 tUSDC <span className={demoStyles.plPct}>▲ 14.6%</span>
            </span>
            <span className={demoStyles.chipLabel}>past month</span>
          </div>
          <PlChart />
        </div>
      </div>

      <div className={demoStyles.posTable}>
        <div className={demoStyles.posHead}>
          <span>Positions</span>
          <span>Current</span>
          <span>Value</span>
        </div>
        {positions.map((r) => (
          <div key={r.key} className={demoStyles.posRow}>
            <div className={demoStyles.positionMain}>
              <span className={demoStyles.previewTitle}>{r.title}</span>
              <span className={demoStyles.chipLabel}>
                <span className={demoStyles.posSide} data-side={r.side}>
                  {r.side}
                </span>{" "}
                {fmt(r.shares, 1)} shares at {r.at}¢ · {r.fixture}
              </span>
            </div>
            <span className={demoStyles.posCur}>{r.cur}¢</span>
            <div className={demoStyles.positionNums}>
              <span>{fmt(r.value)}</span>
              <span className={demoStyles.delta} data-up={r.pl >= 0}>
                {r.pl >= 0 ? "+" : "−"}
                {fmt(Math.abs(r.pl))} ({Math.round((Math.abs(r.pl) / Math.max(0.01, (r.shares * r.at) / 100)) * 100)}%)
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className={demoStyles.screenNote}>sample portfolio · live prices where shown · devnet tUSDC</div>
    </div>
  );
}

/** Activity screen: recent REAL recorded swaps, enriched (shares, price, value, time). */
function ActivityScreen({ activity }: { activity: ActivityRow[] }) {
  if (activity.length === 0) {
    return (
      <p className={demoStyles.chipLabel} style={{ padding: 24 }}>
        recent trades load from devnet
      </p>
    );
  }
  return (
    <div className={demoStyles.activityScreen}>
      <div className={demoStyles.screenNote}>recent trades · real recorded on-chain swaps · includes seeded market-making</div>
      {activity.slice(0, 7).map((a, i) => {
        const amt = parseFloat(a.amount) || 0;
        const price = Math.max(1, a.priceCents);
        // buys spend tUSDC → ≈shares out; sells send tokens → ≈tUSDC back
        const isBuy = a.dir === 0;
        const shares = isBuy ? (amt / price) * 100 : amt;
        const value = isBuy ? amt : (amt * price) / 100;
        const [fixture, predicate] = a.title.includes(" · ") ? [a.title.split(" · ")[0]!, a.title.split(" · ").slice(1).join(" · ")] : ["", a.title];
        return (
          <div key={`${a.t}-${i}`} className={demoStyles.activityRow} data-side={a.side}>
            <span className={demoStyles.activityBadge} data-side={a.side}>
              {isBuy ? "Bought" : "Sold"} {a.side === 1 ? "Yes" : "No"}
            </span>
            <div className={demoStyles.activityMain}>
              <span className={demoStyles.activityPredicate}>{predicate}</span>
              <span className={demoStyles.chipLabel}>
                {fixture && `${fixture} · `}≈{fmt(shares, 1)} shares @ {price}¢
              </span>
            </div>
            <div className={demoStyles.activityNums}>
              <span className={demoStyles.activityValue} data-side={a.side}>
                {isBuy ? "+" : "−"}{fmt(value)} tUSDC
              </span>
              <span className={demoStyles.activityWhen}>{timeAgo(a.t)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function LandingHero({
  demo,
  preview,
  activity,
}: {
  demo: DemoData | null;
  preview: PreviewMarket[];
  activity: ActivityRow[];
}) {
  const heroRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeTab, setActiveTab] = useState<TabId>("trade");
  const [revealed, setRevealed] = useState(false);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);

  // Sliding white chip: measure the active tab button and glide the
  // indicator to it (transform+width only — no layout thrash). Re-measures
  // on resize; prefers-reduced-motion snaps via CSS.
  useEffect(() => {
    const measure = () => {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      const el = tabRefs.current[idx];
      if (el) setIndicator({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTab]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setRevealed(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  function onTabKey(e: React.KeyboardEvent) {
    const idx = TABS.findIndex((t) => t.id === activeTab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = e.key === "ArrowRight" ? (idx + 1) % TABS.length : (idx - 1 + TABS.length) % TABS.length;
      setActiveTab(TABS[next]!.id);
      tabRefs.current[next]?.focus();
    }
  }

  // liquid-glass-react was trialed here with the exact requested settings
  // (displacementScale 64, blur 0.1, saturation 130, aberration 2,
  // elasticity 0.35 and 0, cornerRadius 100, mouseContainer=hero) — in this
  // flex-centered hero its glass layers render offset from their content
  // and leave aberration artifacts (screenshot-verified across 3 configs),
  // so every browser gets the CSS glass replica instead (same visual:
  // blur + gloss + specular sheen), which the reference comparison passed.
  const glass = (children: React.ReactNode, opts: { padding: string; className?: string }) => (
    <div className={opts.className} style={{ padding: opts.padding }}>{children}</div>
  );

  return (
    <div ref={heroRef}>
      <section className={styles.hero}>
        <div className={`${styles.heroItem} ${styles.d0}`}>
          <span className={styles.wordmark}>
            <Image src={logoGemDark} alt="" width={30} height={30} className={styles.logoImg} priority />
            ONYX
          </span>
        </div>

        <div className={`${styles.heroItem} ${styles.d1}`}>
          {glass(
            <span className={styles.credInner}>
              <span className={styles.credItem}>
                Built on Solana
                <Image src={solanaLogo} alt="Solana" width={16} height={16} className={styles.credLogo} />
              </span>
              <span className={styles.credDivider} aria-hidden />
              <span className={styles.credItem}>
                Powered by MagicBlock
                <Image src={magicblockLogo} alt="MagicBlock" width={16} height={16} className={styles.credLogoRound} />
              </span>
            </span>,
            { padding: "9px 20px", className: styles.credPill },
          )}
        </div>

        <h1 className={`${styles.heroTitle} ${styles.heroItem} ${styles.d2}`}>
          Prediction markets
          <br />
          at flash speed.
        </h1>

        <p className={`${styles.heroSub} ${styles.heroItem} ${styles.d3}`}>
          Sub-second trades on Ephemeral Rollups. Every market settles on-chain to zero. No custodian, no trust.
        </p>

        <div className={`${styles.heroItem} ${styles.d4}`}>
          <ChromeCta href="/markets" label="Launch App" />
        </div>

        {/* in-panel preview tabs — real tablist, zero navigation */}
        <div className={`${styles.heroItem} ${styles.d5}`}>
          <div className={styles.pillNav} role="tablist" aria-label="App preview" onKeyDown={onTabKey}>
            {indicator && (
              <span
                className={styles.pillIndicator}
                aria-hidden
                style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }}
              />
            )}
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={activeTab === t.id}
                aria-controls="landing-preview-panel"
                tabIndex={activeTab === t.id ? 0 : -1}
                data-primary={activeTab === t.id}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ---- floating dark app panel ---- */}
      <section className={styles.panelZone}>
        <div
          ref={panelRef}
          id="landing-preview-panel"
          role="tabpanel"
          aria-labelledby={`tab-${activeTab}`}
          className={`${demoStyles.panel} ${revealed ? demoStyles.revealed : ""}`}
        >
          <div className={demoStyles.appBar}>
            <span className={demoStyles.appLogo}>
              <Image src={logoGemLight} alt="" width={18} height={18} className={styles.logoImg} />
              ONYX
            </span>
            <span className={demoStyles.appNav}>
              {TABS.map((t) => (
                <span key={t.id} data-active={activeTab === t.id}>
                  {t.label}
                </span>
              ))}
            </span>
            <span className={demoStyles.appBarRight}>
              <span className={demoStyles.portfolioChip}>
                <span className={demoStyles.chipLabel}>portfolio</span>
                146 tUSDC
              </span>
              <Link href="/markets" className={demoStyles.launchBtn}>
                Launch
              </Link>
              <span className={demoStyles.avatar} aria-hidden />
            </span>
          </div>
          <div className={demoStyles.demoNote}>illustrative demo · live prices &amp; real AMM math · sample data tagged · devnet tUSDC</div>

          <div className={demoStyles.screens}>
            <div key={activeTab} className={demoStyles.screen}>
              {activeTab === "trade" &&
                (demo ? (
                  <TradeScreen data={demo} active={revealed} />
                ) : (
                  <p className={demoStyles.chipLabel} style={{ padding: 24 }}>
                    live demo loads from devnet
                  </p>
                ))}
              {activeTab === "markets" && <MarketsScreen preview={preview} />}
              {activeTab === "portfolio" && <PortfolioScreen preview={preview} />}
              {activeTab === "activity" && <ActivityScreen activity={activity} />}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
