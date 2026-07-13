"use client";

// The market page's client core. One useMarket(pda) poll (8s) drives every
// section; panels invalidate the react-query cache after a successful tx so
// fresh on-chain state flows in WITHOUT a full-page router.refresh (no
// reload, no flash). First load renders a fixed-height skeleton.

import Link from "next/link";
import { notFound } from "next/navigation";
import { useRoutedMarket, useAmmPoolExists, useRoutedAmmPool, useLiveFixtures } from "@/lib/hooks";
import {
  STATUS_NAMES,
  OUTCOME_NAMES,
  STATUS_OPEN,
  STATUS_LIVE,
  STATUS_SETTLING,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  STATUS_EXPIRED,
  STATUS_REFUNDED,
  PHASE_NONE,
  explorerAddressUrl,
} from "@/lib/onchain";
import { describeMarketPredicate, rawPredicateText } from "@/lib/statKeys";
import {
  getFixtureInfo,
  fixtureDisplayName,
  getFixtureStartTimeMs,
  primeLiveFixtures,
} from "@/lib/fixtureMeta";
import { LiveScore } from "@/components/LiveScore";
import { SealedOrderPanel } from "@/components/SealedOrderPanel";
import { SettleClaimPanel } from "@/components/SettleClaimPanel";
import { PhaseTimeline } from "./PhaseTimeline";
import { PricePanel, AmmPricePanel } from "./PricePanel";
import { PriceHistoryCard, RecentTradesCard } from "./ActivityCards";
import { ErTradingPanel } from "./ErTradingPanel";
import { AmmTradingPanel } from "./AmmTradingPanel";
import { shortAddr } from "./format";
import styles from "./MarketDetail.module.css";
import erStyles from "./ErTradingPanel.module.css";

const STATUS_TONES: Record<number, string> = {
  [STATUS_OPEN]: "accent",
  [STATUS_LIVE]: "green",
  [STATUS_SETTLING]: "amber",
  [STATUS_SETTLED]: "green",
  [STATUS_CLAIMED]: "green",
  [STATUS_EXPIRED]: "red",
  [STATUS_REFUNDED]: "amber",
};

export function MarketDetail({ pda }: { pda: string }) {
  const query = useRoutedMarket(pda);
  const market = query.data;
  // AMM routing: a market with an AMM pool renders the continuous-trading
  // panel instead of the sealed flow. Pool existence is a delegation-
  // agnostic base PDA probe; the pool's live state (reserves for the price
  // header) is separately routed to whichever ledger holds it right now.
  const poolExists = useAmmPoolExists(pda);
  const routedPool = useRoutedAmmPool(pda);
  // Live TxLINE fixture names for getFixtureInfo/fixtureDisplayName below.
  const liveFixtures = useLiveFixtures();
  primeLiveFixtures(liveFixtures.data);

  // The account genuinely doesn't exist on devnet.
  if (query.isSuccess && market === null) notFound();
  if (!market) return <DetailSkeleton error={query.isError} />;

  const settled = market.status === STATUS_SETTLED || market.status === STATUS_CLAIMED;
  const fixtureInfo = getFixtureInfo(Number(market.fixtureId));
  const friendlyTitle = describeMarketPredicate(market, fixtureInfo ?? undefined);
  const rawPredicate = rawPredicateText(market);
  const startTimeMs = getFixtureStartTimeMs(Number(market.fixtureId));
  const sealed = market.phase !== PHASE_NONE;
  const amm = market.phase === PHASE_NONE && (poolExists.data ?? false);
  // Until the pool probe + routed pool read land we don't know which layout
  // this page is (AMM vs plain) — committing to one early made the whole AMM
  // column POP IN a second later and reflow the page. Hold skeleton columns
  // in place instead; sealed markets are known immediately from phase.
  const ammLoading = market.phase === PHASE_NONE && (poolExists.data === undefined || (amm && !routedPool.data));

  return (
    <div className={styles.page}>
      <p className={styles.back}>
        <Link href="/markets" className="back-btn" aria-label="Back to markets">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
        </Link>
      </p>

      <header>
        <div className={styles.headRow}>
          <h1 className={styles.title}>{friendlyTitle}</h1>
          <div className={styles.pills}>
            <span className="pill" data-tone={STATUS_TONES[market.status]}>
              {STATUS_NAMES[market.status] ?? market.status}
            </span>
            {settled && (
              <span className="pill" data-tone="green">
                outcome: {OUTCOME_NAMES[market.outcome] ?? market.outcome}
              </span>
            )}
          </div>
        </div>
        <p className={`mono muted ${styles.raw}`}>
          raw predicate:{" "}
          <span title="Exactly what's encoded on-chain and checked in the validate_stat CPI.">
            {rawPredicate}
          </span>
        </p>
        <div className={styles.meta}>
          <span>
            {fixtureInfo
              ? `${fixtureDisplayName(Number(market.fixtureId))} (fixture #${market.fixtureId})`
              : fixtureDisplayName(Number(market.fixtureId))}{" "}
            · live on-chain market (devnet)
          </span>
          <span className="mono">
            market{" "}
            <a href={explorerAddressUrl(market.pda)} target="_blank" rel="noreferrer">
              {shortAddr(market.pda)} ↗
            </a>
          </span>
          <span className="mono" title="Betting deadline (unix seconds on-chain)">
            deadline {new Date(Number(market.deadline) * 1000).toLocaleString()}
          </span>
        </div>
      </header>

      <section className={styles.section} aria-label="Live score">
        <LiveScore
          fixtureId={Number(market.fixtureId)}
          homeLabel={fixtureInfo?.participant1 ?? "Participant 1"}
          awayLabel={fixtureInfo?.participant2 ?? "Participant 2"}
          startTimeMs={startTimeMs}
        />
      </section>

      {sealed && (
        <section className={styles.section} aria-label="Market lifecycle">
          <PhaseTimeline
            phase={market.phase}
            status={market.status}
            commitEndTs={market.commitEndTs}
            revealEndTs={market.revealEndTs}
          />
        </section>
      )}

      <div className={styles.cols} data-sealed={sealed || amm || ammLoading}>
        <div className={styles.colMain}>
          {/* AMM markets price off pool reserves; the sealed panel's batch-
              derived figures read 0/empty there and looked broken next to
              the trade panel's real ¢ price. */}
          {ammLoading ? (
            <>
              <div className="skeleton" style={{ height: 360 }} aria-hidden />
              <div className="skeleton" style={{ height: 200 }} aria-hidden />
            </>
          ) : amm && routedPool.data ? (
            <AmmPricePanel pool={routedPool.data} isDelegated={routedPool.isDelegated} />
          ) : (
            <PricePanel market={market} connection={query.connection} />
          )}
          {amm && !ammLoading && (
            <>
              <PriceHistoryCard marketPda={market.pda} />
              <RecentTradesCard marketPda={market.pda} />
            </>
          )}
          {!(sealed || amm || ammLoading) && <SettleClaimPanel market={market} isAmm={amm} />}
        </div>
        {(sealed || amm || ammLoading) && (
          <div className={styles.colSide}>
            {ammLoading && (
              <>
                <div className="skeleton" style={{ height: 420 }} aria-hidden />
                <div className="skeleton" style={{ height: 160 }} aria-hidden />
              </>
            )}
            {!ammLoading && amm && routedPool.data && (
              <AmmTradingPanel
                market={market}
                pool={routedPool.data}
                isDelegated={routedPool.isDelegated}
                connection={routedPool.connection}
              />
            )}
            {sealed && (
              <div>
                <ErTradingPanel market={market} isDelegated={query.isDelegated} fqdn={query.fqdn} connection={query.connection} />
                <details className={erStyles.classicToggle}>
                  <summary>Show classic sealed-order flow (non-ER, always available)</summary>
                  <div className={erStyles.classicBody}>
                    {query.isDelegated && (
                      <p className={erStyles.classicWarning}>
                        This market is currently delegated to the Ephemeral Rollup for fast trading. The classic flow
                        below only reads/writes base devnet, so it&apos;s seeing a snapshot frozen at delegation time —
                        avoid placing new classic orders until the market moves back to base. If you already have a
                        classic order here, revealing it may fail while the market is delegated (confirmed live: the
                        first reveal after commit close tries to advance the market&apos;s phase, which base devnet
                        rejects while the market is owned by the Ephemeral Rollup) — if that happens, your locked
                        collateral is still recoverable via a refund once the reveal window closes, not stuck.
                      </p>
                    )}
                    <SealedOrderPanel market={market} />
                  </div>
                </details>
              </div>
            )}
            {!ammLoading && <SettleClaimPanel market={market} isAmm={amm} />}
          </div>
        )}
      </div>
    </div>
  );
}

// Fixed-height placeholders — same rough layout as the loaded page so
// nothing jumps when real data arrives.
function DetailSkeleton({ error }: { error: boolean }) {
  return (
    <div className={styles.page}>
      <div className="skeleton" style={{ height: 14, width: 90 }} />
      <div className="skeleton" style={{ height: 32, width: "62%", marginTop: 14 }} />
      <div className="skeleton" style={{ height: 14, width: 240, marginTop: 10 }} />
      <div className="skeleton" style={{ height: 14, width: 360, marginTop: 8 }} />
      {error && (
        <p className="muted" style={{ marginTop: 12, fontSize: "0.85rem" }}>
          Devnet RPC is being slow — retrying automatically…
        </p>
      )}
      <div className="skeleton" style={{ height: 132, marginTop: 24 }} />
      <div className="skeleton" style={{ height: 84, marginTop: 16 }} />
      <div className={styles.cols}>
        <div className={styles.colMain}>
          <div className="skeleton" style={{ height: 360 }} />
          <div className="skeleton" style={{ height: 200 }} />
        </div>
        <div className={styles.colSide}>
          <div className="skeleton" style={{ height: 420 }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      </div>
    </div>
  );
}
