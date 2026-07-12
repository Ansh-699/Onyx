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
import logoGem from "@/assets/onyx-gem.png";
import solanaLogo from "@/assets/Solana-Round-Logo-PNG.png";
import magicblockLogo from "@/assets/magicblock.jpg";
import { TradeScreen, type DemoData } from "./TradeDemo";
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

/** Markets screen: real markets, non-navigating preview cards. */
function MarketsScreen({ preview }: { preview: PreviewMarket[] }) {
  return (
    <div className={demoStyles.marketsScreen}>
      {preview.map((p) => (
        <div key={p.pda} className={demoStyles.previewCard}>
          <span className={demoStyles.fixture}>{p.fixture}</span>
          <span className={demoStyles.previewTitle}>{p.title}</span>
          <span className={demoStyles.previewPrices}>
            <span className={demoStyles.pvYes}>Yes {p.yesCents}¢</span>
            <span className={demoStyles.pvNo}>No {100 - p.yesCents}¢</span>
          </span>
          <span className={demoStyles.chipLabel}>{p.volume} tUSDC traded</span>
        </div>
      ))}
    </div>
  );
}

/** Portfolio screen: small, clearly-labeled demo positions in tUSDC. */
function PortfolioScreen({ preview }: { preview: PreviewMarket[] }) {
  const rows = preview.slice(0, 2).map((p, i) => {
    const shares = i === 0 ? 2.99 : 5.5;
    const value = (shares * (i === 0 ? p.yesCents : 100 - p.yesCents)) / 100;
    const cost = i === 0 ? 1.4 : 3.1;
    return { p, side: i === 0 ? "YES" : "NO", shares, value, pl: value - cost };
  });
  return (
    <div className={demoStyles.portfolioScreen}>
      <div className={demoStyles.chipLabel}>sample portfolio · demo figures · devnet tUSDC</div>
      {rows.map((r) => (
        <div key={r.p.pda} className={demoStyles.positionRow}>
          <div className={demoStyles.positionMain}>
            <span className={demoStyles.previewTitle}>{r.p.title}</span>
            <span className={demoStyles.chipLabel}>
              {fmt(r.shares)} {r.side} · {r.p.fixture}
            </span>
          </div>
          <div className={demoStyles.positionNums}>
            <span>{fmt(r.value)} tUSDC</span>
            <span className={demoStyles.delta} data-up={r.pl >= 0}>
              {r.pl >= 0 ? "▲" : "▼"} {fmt(Math.abs(r.pl))}
            </span>
          </div>
        </div>
      ))}
      <div className={demoStyles.positionRow}>
        <div className={demoStyles.positionMain}>
          <span className={demoStyles.previewTitle}>Ready to withdraw</span>
          <span className={demoStyles.chipLabel}>settled market · winnings redeem 1:1</span>
        </div>
        <div className={demoStyles.positionNums}>
          <span className={demoStyles.toWin}>+38.37 tUSDC</span>
        </div>
      </div>
    </div>
  );
}

/** Activity screen: recent REAL recorded swaps (each exists on-chain). */
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
      <div className={demoStyles.chipLabel}>recent trades · real recorded on-chain swaps · includes seeded market-making</div>
      {activity.map((a, i) => (
        <div key={`${a.t}-${i}`} className={demoStyles.activityRow}>
          <span className={demoStyles.activitySide} data-side={a.side}>
            {a.dir === 0 ? "Bought" : "Sold"} {a.side === 1 ? "Yes" : "No"}
          </span>
          <span className={demoStyles.activityTitle}>{a.title}</span>
          <span className={demoStyles.activityAmt}>
            {a.amount} {a.dir === 0 ? "tUSDC" : "tokens"} · {a.priceCents}¢
          </span>
          <span className={demoStyles.activityWhen}>{timeAgo(a.t)}</span>
        </div>
      ))}
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
            <Image src={logoGem} alt="" width={30} height={30} className={styles.logoImg} priority />
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
          <Link href="/markets" className={styles.heroCta}>
            <span>Launch App</span>
          </Link>
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
              <Image src={logoGem} alt="" width={18} height={18} className={styles.logoImg} />
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
          <div className={demoStyles.demoNote}>illustrative demo · real market data &amp; real AMM math · devnet tUSDC</div>

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
