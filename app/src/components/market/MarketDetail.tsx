"use client";

// The market page's client core. One useMarket(pda) poll (8s) drives every
// section; panels invalidate the react-query cache after a successful tx so
// fresh on-chain state flows in WITHOUT a full-page router.refresh (no
// reload, no flash). First load renders a fixed-height skeleton.

import Link from "next/link";
import { notFound } from "next/navigation";
import { useRoutedMarket } from "@/lib/hooks";
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
} from "@/lib/fixtureMeta";
import { LiveScore } from "@/components/LiveScore";
import { SealedOrderPanel } from "@/components/SealedOrderPanel";
import { SettleClaimPanel } from "@/components/SettleClaimPanel";
import { PhaseTimeline } from "./PhaseTimeline";
import { PricePanel } from "./PricePanel";
import { ErTradingPanel } from "./ErTradingPanel";
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

  // The account genuinely doesn't exist on devnet.
  if (query.isSuccess && market === null) notFound();
  if (!market) return <DetailSkeleton error={query.isError} />;

  const settled = market.status === STATUS_SETTLED || market.status === STATUS_CLAIMED;
  const fixtureInfo = getFixtureInfo(Number(market.fixtureId));
  const friendlyTitle = describeMarketPredicate(market, fixtureInfo ?? undefined);
  const rawPredicate = rawPredicateText(market);
  const startTimeMs = getFixtureStartTimeMs(Number(market.fixtureId));
  const sealed = market.phase !== PHASE_NONE;

  return (
    <div className={styles.page}>
      <p className={styles.back}>
        <Link href="/markets">← Markets</Link>
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

      <div className={styles.cols} data-sealed={sealed}>
        <div className={styles.areaPrice}>
          <PricePanel market={market} />
        </div>
        {sealed && (
          <div className={styles.areaTrade}>
            <ErTradingPanel market={market} isDelegated={query.isDelegated} fqdn={query.fqdn} connection={query.connection} />
            <details className={erStyles.classicToggle}>
              <summary>Show classic sealed-order flow (non-ER, always available)</summary>
              <div className={erStyles.classicBody}>
                <SealedOrderPanel market={market} />
              </div>
            </details>
          </div>
        )}
        <div className={styles.areaSettle}>
          <SettleClaimPanel market={market} />
        </div>
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
        <div className={styles.areaPrice}>
          <div className="skeleton" style={{ height: 360 }} />
        </div>
        <div className={styles.areaTrade}>
          <div className="skeleton" style={{ height: 420 }} />
        </div>
        <div className={styles.areaSettle}>
          <div className="skeleton" style={{ height: 200 }} />
        </div>
      </div>
    </div>
  );
}
