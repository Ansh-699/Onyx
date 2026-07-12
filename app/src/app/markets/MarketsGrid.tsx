"use client";

// Polymarket-style market grid for the lobby. Everything rendered here is
// real devnet state via useMarkets() (react-query, ~20s poll,
// keepPreviousData — a poll tick can never blank or flash the grid). The
// first paint shows fixed-height skeleton cards so the content swap causes
// zero layout shift. Search / status filter / sort are pure client state.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  useMarkets,
  useScore,
  useAmmPoolMarkets,
  useLiveFixtures,
  useAmmPriceHistory,
  useAmmTraderCounts,
  useProtocolStats,
  type PoolHistorySeries,
} from "@/lib/hooks";
import {
  type OnChainMarket,
  STATUS_NAMES,
  OUTCOME_NAMES,
  STATUS_OPEN,
  STATUS_LIVE,
  STATUS_SETTLING,
  STATUS_SETTLED,
  STATUS_CLAIMED,
  STATUS_EXPIRED,
  STATUS_REFUNDED,
  volumeFromFees,
} from "@/lib/onchain";
import type { AmmPoolSummary } from "@/lib/onchain";
import { describeMarketPredicate, rawPredicateText } from "@/lib/statKeys";
import { getFixtureInfo, fixtureDisplayName, getFixtureStartTimeMs, primeLiveFixtures } from "@/lib/fixtureMeta";
import { flagFor } from "@/lib/flags";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAmmPositionsForOwner } from "@/lib/hooks";
import { SIDE_A, SIDE_B } from "@/lib/instructions";
import { QuickTradeModal, type QuickTradeTarget } from "@/components/QuickTradeModal";
import styles from "./lobby.module.css";

// ---------------------------------------------------------------------------
// Logic ported from the previous server-rendered lobby — keep these honest.
// ---------------------------------------------------------------------------

// Throwaway fixture ids used for on-chain testing this build (ER/PER/sealed-
// order de-risk spikes, verify-flow.ts runs, etc.) -- never real TxLINE
// fixtures. TxLINE's real fixture ids are 8-digit numbers with no fixed
// pattern (e.g. 18179550); every throwaway id used in this repo happens to
// live in the 900000000-900000999 range, so that's what's filtered here.
// This is purely a lobby display filter -- the accounts are still real and
// on-chain, `listMarkets()` still returns them, nothing is deleted.
function isPlaceholderFixture(fixtureId: bigint): boolean {
  return fixtureId >= 900_000_000n && fixtureId <= 900_000_999n;
}

// Earlier dev/demo runs opened several markets with the IDENTICAL predicate
// on fixture 18179550 (same statA/statB/op/predicate/threshold, different
// deadlines -> different PDAs) before this build had a varied predicate set.
// Rather than hide real on-chain accounts, collapse same-predicate duplicates
// into one card (preferring the one that actually got Settled/Claimed, since
// that's the one demonstrating trustless settlement) and disclose the rest.
function predicateKey(m: OnChainMarket): string {
  return `${m.statAKey}|${m.statBKey}|${m.op}|${m.predicate}|${m.threshold}`;
}
function statusRank(status: number): number {
  if (status === STATUS_CLAIMED) return 3;
  if (status === STATUS_SETTLED) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function statusTone(status: number): "accent" | "amber" | "green" | "red" | undefined {
  if (status === STATUS_OPEN) return "accent";
  if (status === STATUS_LIVE || status === STATUS_SETTLING) return "amber";
  if (status === STATUS_SETTLED || status === STATUS_CLAIMED) return "green";
  if (status === STATUS_EXPIRED || status === STATUS_REFUNDED) return "red";
  return undefined;
}

function formatKickoff(diffMs: number): string {
  if (diffMs <= 0) return "kicked off";
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `Kickoff in ${days}d ${hours % 24}h`;
  if (hours > 0) return `Kickoff in ${hours}h ${mins % 60}m`;
  return `Kickoff in ${Math.max(mins, 1)}m`;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000) return vol.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return vol.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Minute-granularity clock for kickoff countdowns. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ---------------------------------------------------------------------------
// Row model: one card per (fixture, predicate) after dedup
// ---------------------------------------------------------------------------

interface Row {
  market: OnChainMarket;
  extra: number; // collapsed same-predicate duplicates
  fixtureId: number;
  fixtureLabel: string;
  competition: string;
  title: string;
  raw: string;
  searchText: string;
  /** Tradeable now: AMM pool exists, deadline in the future, status Open/Live. */
  active: boolean;
  /** Demo-grade card: real team names AND an AMM pool. Everything else lives in Archive (hidden, never faked). */
  curated: boolean;
}

type StatusFilter = "markets" | "settled" | "archive";
type SortMode = "volume" | "ending" | "newest";
type Category = "all" | "trending" | "new" | "ending" | "goals" | "cards" | "corners";

/** Stat-key bucket for the category chips: 1/2 goals · 3-6 cards · 7/8 corners. */
function statBucket(statAKey: number): "goals" | "cards" | "corners" | null {
  if (statAKey === 1 || statAKey === 2) return "goals";
  if (statAKey >= 3 && statAKey <= 6) return "cards";
  if (statAKey === 7 || statAKey === 8) return "corners";
  return null;
}

function matchesStatusFilter(row: Row, filter: StatusFilter, now: number): boolean {
  // "Markets" = trading-now AND open together (one browsing tab), curated to
  // cards with real names + a real pool + a deadline that hasn't passed
  // (an Open market past its deadline isn't tradeable — Archive keeps it).
  if (filter === "markets") {
    return (
      row.curated &&
      (row.market.status === STATUS_OPEN || row.market.status === STATUS_LIVE) &&
      Number(row.market.deadline) * 1000 > now
    );
  }
  if (filter === "settled") return row.market.status === STATUS_SETTLED || row.market.status === STATUS_CLAIMED;
  return true; // archive = everything, nothing hidden
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Score line for a fixture that has already kicked off. Only mounted for
 * started fixtures, so useScore never fires for upcoming matches. TxLINE's
 * free tier updates on a ~60s cadence — disclosed inline, never sold as
 * real-time.
 */
function ScoreLine({ fixtureId }: { fixtureId: number }) {
  const { data: score } = useScore(fixtureId);
  if (!score) return <span className="faint">fetching score…</span>;
  if (score.source === "unavailable") return <span className="faint">TxLINE score unavailable</span>;
  return (
    <span className={styles.scoreLine}>
      <span className={styles.scoreDot} aria-hidden />
      <span className={styles.scoreDigits}>
        {score.p1Goals}–{score.p2Goals}
      </span>
      <span className={styles.scoreCaption}>TxLINE ~60s cadence</span>
    </span>
  );
}

/**
 * Tiny price sparkline from REAL recorded/sampled on-chain price points (see
 * /api/history — every point is a genuine ledger read). Renders nothing when
 * fewer than 2 points exist: hide, never fabricate.
 */
function Sparkline({ series }: { series: PoolHistorySeries | undefined }) {
  const points = series?.points ?? [];
  if (points.length < 2) return null;
  const W = 92;
  const H = 26;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const span = Math.max(t1 - t0, 1);
  const d = points
    .map((p, i) => {
      const x = ((p.t - t0) / span) * (W - 2) + 1;
      const y = H - 2 - (p.priceA / 1_000_000) * (H - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1]!.priceA >= points[0]!.priceA;
  return (
    <svg
      className={styles.spark}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      aria-label="Recorded on-chain price history"
      data-up={up}
    >
      <path d={d} fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function MarketCard({
  row,
  now,
  pool,
  series,
  traders,
  myPosition,
  onQuickTrade,
}: {
  row: Row;
  now: number;
  pool: AmmPoolSummary | undefined;
  series: PoolHistorySeries | undefined;
  traders: number | undefined;
  myPosition: { tokensA: bigint; tokensB: bigint } | undefined;
  onQuickTrade: (t: QuickTradeTarget) => void;
}) {
  const m = row.market;
  const isAmm = !!pool;
  const total = m.totalSideA + m.totalSideB;
  const startMs = getFixtureStartTimeMs(row.fixtureId);
  const started = startMs !== null && startMs <= now;
  const showOutcome = m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED;
  const info = getFixtureInfo(row.fixtureId);
  const flag1 = info ? flagFor(info.participant1) : "";
  const flag2 = info ? flagFor(info.participant2) : "";

  // Price of YES (side A) in cents. AMM: pool-implied price_A = b/(a+b) —
  // the real, tradeable price. Parimutuel fallback: stake share.
  let yesCents: number | null = null;
  if (pool && pool.reserveA + pool.reserveB > 0n) {
    yesCents = Math.round(Number((pool.reserveB * 1000n) / (pool.reserveA + pool.reserveB)) / 10);
  } else if (total > 0n) {
    yesCents = Math.round(Number((m.totalSideA * 100n) / total));
  }
  const noCents = yesCents !== null ? 100 - yesCents : null;

  // Real figures only: volume derived from on-chain fees, depth = pool custody.
  const volUsd = pool ? Number(volumeFromFees(pool.feesAccrued, pool.feeBps)) / 1e6 : Number(total) / 1e6;
  const depthUsd = pool ? Number(pool.reserveA + pool.reserveB) / 1e6 : 0;

  return (
    <Link href={`/market/${m.pda}`} className={`card ${styles.marketCard}`}>
      <div className={styles.cardTop}>
        <span className={styles.fixture} title={`TxLINE fixtureId ${row.fixtureId}`}>
          {flag1 && <span aria-hidden>{flag1} </span>}
          {row.fixtureLabel}
          {flag2 && <span aria-hidden> {flag2}</span>}
        </span>
        <span style={{ display: "inline-flex", gap: 6 }}>
          {started && row.active && (
            <span className="pill" data-tone="green">
              LIVE
            </span>
          )}
          {!row.active && (
            <span className="pill" data-tone={statusTone(m.status)}>
              {STATUS_NAMES[m.status] ?? m.status}
            </span>
          )}
        </span>
      </div>

      <div className={styles.subline}>
        {started ? (
          <ScoreLine fixtureId={row.fixtureId} />
        ) : startMs !== null ? (
          <span>
            {row.competition} · {formatKickoff(startMs - now)}
          </span>
        ) : (
          <span className="faint">{row.competition}</span>
        )}
      </div>

      <div className={styles.question} title={`On-chain predicate: ${row.raw}`}>
        {row.title}
      </div>
      {row.extra > 0 && (
        <div className={styles.dupeNote}>
          +{row.extra} more market{row.extra === 1 ? "" : "s"} with this same predicate
        </div>
      )}

      {/* implied probability, prominent — with the real recorded price path */}
      {yesCents !== null && (
        <div className={styles.probRow}>
          <span className={styles.probBig}>
            {yesCents}%<span className={styles.probCaption}>chance</span>
          </span>
          <Sparkline series={series} />
        </div>
      )}

      {/* your real on-chain holdings — ABOVE the Yes/No row so every card's
          buttons align on the same baseline regardless of holdings */}
      {myPosition && (myPosition.tokensA > 0n || myPosition.tokensB > 0n) && (
        <div className={styles.myPosition} data-side={myPosition.tokensA >= myPosition.tokensB ? "yes" : "no"}>
          You hold{myPosition.tokensA > 0n && <> {formatVolume(Number(myPosition.tokensA) / 1e6)} YES</>}
          {myPosition.tokensA > 0n && myPosition.tokensB > 0n && " ·"}
          {myPosition.tokensB > 0n && <> {formatVolume(Number(myPosition.tokensB) / 1e6)} NO</>}
        </div>
      )}

      {/* Yes/No are REAL buy buttons: click opens the quick-trade modal
          (stopPropagation so the card link doesn't navigate). */}
      <div className={styles.yesNoRow} aria-hidden={yesCents === null}>
        <button
          type="button"
          className={styles.yesBtn}
          data-empty={yesCents === null}
          disabled={!pool || !row.active}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (pool) onQuickTrade({ marketPda: m.pda, title: row.title, fixtureLabel: row.fixtureLabel, side: SIDE_A, pool });
          }}
          data-testid={`quick-yes-${m.pda.slice(0, 6)}`}
        >
          <span>Yes</span>
          <strong>{yesCents !== null ? `${yesCents}¢` : "—"}</strong>
        </button>
        <button
          type="button"
          className={styles.noBtn}
          data-empty={noCents === null}
          disabled={!pool || !row.active}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (pool) onQuickTrade({ marketPda: m.pda, title: row.title, fixtureLabel: row.fixtureLabel, side: SIDE_B, pool });
          }}
        >
          <span>No</span>
          <strong>{noCents !== null ? `${noCents}¢` : "—"}</strong>
        </button>
      </div>

      <div className={styles.cardBottom}>
        <div className={styles.cardBottomLeft}>
          {isAmm && !showOutcome && (
            <span className={styles.probLabel} title="Buy and sell anytime against a real seeded pool. Flash trades run on MagicBlock's Ephemeral Rollup — ~1s, no gas, no popups with 1-click trading on.">
              {pool?.delegated ? "⚡ Flash trade" : "trade anytime"}
            </span>
          )}
          {showOutcome && (
            <span className="pill" data-tone="green">
              {OUTCOME_NAMES[m.outcome] ?? m.outcome} won
            </span>
          )}
        </div>
        <span
          className={styles.volume}
          title="Volume is derived from on-chain pool fees (fees × 10000 / fee_bps) — includes disclosed seeded market-making; every trade is a real devnet swap."
        >
          {formatVolume(volUsd)} <span className={styles.volumeUnit}>vol</span>
          {traders !== undefined && traders > 0 && (
            <>
              {" · "}
              {traders} <span className={styles.volumeUnit}>trader{traders === 1 ? "" : "s"}</span>
            </>
          )}
          {depthUsd > 0 && (
            <>
              {" · "}
              {formatVolume(depthUsd)} <span className={styles.volumeUnit}>depth</span>
            </>
          )}
        </span>
      </div>
    </Link>
  );
}

/** Same box model as a real card so the loading → data swap shifts nothing. */
function SkeletonCard() {
  return (
    <div className={`card ${styles.marketCard}`} aria-hidden>
      <div className={styles.cardTop}>
        <span className={`skeleton ${styles.skelFixture}`} />
        <span className={`skeleton ${styles.skelPill}`} />
      </div>
      <div className={styles.subline}>
        <span className={`skeleton ${styles.skelSub}`} />
      </div>
      <div className={styles.skelQuestion}>
        <span className={`skeleton ${styles.skelQ1}`} />
        <span className={`skeleton ${styles.skelQ2}`} />
      </div>
      <span className={`skeleton ${styles.skelBar}`} />
      <div className={styles.cardBottom}>
        <div>
          <span className={`skeleton ${styles.skelProb}`} />
          <span className={`skeleton ${styles.skelProbLabel}`} />
        </div>
        <span className={`skeleton ${styles.skelVol}`} />
      </div>
    </div>
  );
}

/** Protocol totals strip — all live on-chain aggregates from /api/stats. */
function StatsStrip() {
  const { data } = useProtocolStats();
  if (!data) return null;
  const fmt = (raw: string) => formatVolume(Number(BigInt(raw)) / 1e6);
  return (
    <div
      className={styles.statsStrip}
      title="Live on-chain aggregates — includes disclosed seeded market-making; every underlying trade is a real devnet transaction."
    >
      <span>
        <strong>{fmt(data.volume)}</strong> tUSDC volume
      </span>
      <span>
        <strong>{fmt(data.openInterest)}</strong> open interest
      </span>
      <span>
        <strong>{data.traders}</strong> traders
      </span>
      <span>
        <strong>{data.settled}</strong> settled
      </span>
      <span className={styles.statsNote}>live from devnet · seeded market-making disclosed</span>
    </div>
  );
}

export function MarketsGrid() {
  const { data, isError, refetch } = useMarkets();
  const marketPdas = useMemo(() => (data ?? []).map((m) => m.pda), [data]);
  // Delegation-agnostic pool probe: finds ER-delegated pools too, with
  // reserves for the ¢ price buttons.
  const { data: ammPools } = useAmmPoolMarkets(marketPdas.length > 0 ? marketPdas : undefined);
  // Live TxLINE fixture names: priming the overlay makes every
  // getFixtureInfo/fixtureDisplayName call below resolve real names.
  const liveFixtures = useLiveFixtures();
  primeLiveFixtures(liveFixtures.data);
  const now = useNow();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("markets");
  const [category, setCategory] = useState<Category>("all");
  const [sort, setSort] = useState<SortMode>("volume");
  // History (sparklines) + trader counts, only for markets that have pools.
  const pooledPdas = useMemo(
    () => marketPdas.filter((p) => ammPools?.has(p)).slice(0, 48),
    [marketPdas, ammPools],
  );
  const { data: history } = useAmmPriceHistory(pooledPdas.length > 0 ? pooledPdas : undefined);
  const { data: traderCounts } = useAmmTraderCounts(pooledPdas.length > 0 ? pooledPdas : undefined);
  // Your holdings per market ("You hold 2.99 YES" banners) + quick-trade modal.
  const { publicKey } = useWallet();
  const { data: myPositions } = useAmmPositionsForOwner(publicKey);
  const myPositionByMarket = useMemo(() => {
    const map = new Map<string, { tokensA: bigint; tokensB: bigint }>();
    for (const p of myPositions ?? []) map.set(p.market, { tokensA: p.tokensA, tokensB: p.tokensB });
    return map;
  }, [myPositions]);
  const [quickTarget, setQuickTarget] = useState<QuickTradeTarget | null>(null);

  const { rows, hiddenCount, collapsedCount } = useMemo(() => {
    const all = data ?? [];
    const kept = all.filter((m) => !isPlaceholderFixture(m.fixtureId));
    const hidden = all.length - kept.length;

    const groups = new Map<string, OnChainMarket[]>();
    for (const m of kept) {
      // Market KIND is part of the dedupe key: an AMM market must never be
      // collapsed behind a sealed/plain market with the same predicate (or
      // vice versa) — they are different products with different panels.
      // Found live: the first two UI-created AMM markets vanished from the
      // lobby because they shared the demo fixture's predicate with older
      // sealed markets and the dedupe kept the settled sealed one.
      const kind = ammPools?.has(m.pda) ? "amm" : m.phase !== 0 ? "sealed" : "plain";
      const key = `${m.fixtureId}|${predicateKey(m)}|${kind}`;
      const list = groups.get(key) ?? [];
      list.push(m);
      groups.set(key, list);
    }

    let collapsed = 0;
    const built: Row[] = [];
    for (const group of groups.values()) {
      const shown = [...group].sort((a, b) => statusRank(b.status) - statusRank(a.status))[0]!;
      collapsed += group.length - 1;
      const fixtureId = Number(shown.fixtureId);
      const info = getFixtureInfo(fixtureId);
      const fixtureLabel = fixtureDisplayName(fixtureId); // honest fallback when unknown
      const title = describeMarketPredicate(shown, info ?? undefined);
      const raw = rawPredicateText(shown);
      const active =
        (ammPools?.has(shown.pda) ?? false) &&
        (shown.status === STATUS_OPEN || shown.status === STATUS_LIVE) &&
        Number(shown.deadline) * 1000 > now;
      built.push({
        market: shown,
        extra: group.length - 1,
        fixtureId,
        fixtureLabel,
        competition: info?.competition ?? "World Cup",
        title,
        raw,
        searchText: `${fixtureLabel} ${title} ${raw} ${fixtureId}`.toLowerCase(),
        active,
        // curated = a card a first-time visitor should see: resolved team
        // names AND a real pool. Everything else stays reachable in Archive.
        curated: info !== null && (ammPools?.has(shown.pda) ?? false),
      });
    }
    return { rows: built, hiddenCount: hidden, collapsedCount: collapsed };
  }, [data, ammPools, now]);

  const counts = useMemo(
    () => ({
      markets: rows.filter((r) => matchesStatusFilter(r, "markets", now)).length,
      settled: rows.filter((r) => matchesStatusFilter(r, "settled", now)).length,
      archive: rows.length,
    }),
    [rows, now],
  );

  // Category predicate needs the volume figure for "trending" — computed
  // against the rows that survived the status filter, so counts stay honest.
  const categoryFilter = useMemo(() => {
    return (list: Row[], cat: Category): Row[] => {
      if (cat === "all") return list;
      if (cat === "new") {
        return [...list].sort((a, b) => (b.market.createdSlot > a.market.createdSlot ? 1 : -1)).slice(0, 3);
      }
      if (cat === "ending") {
        const cutoff = now / 1000 + 24 * 3600;
        return list.filter((r) => Number(r.market.deadline) < cutoff && Number(r.market.deadline) * 1000 > now);
      }
      if (cat === "trending") {
        const withVol = list.map((r) => {
          const p = ammPools?.get(r.market.pda);
          return { r, vol: p ? volumeFromFees(p.feesAccrued, p.feeBps) : r.market.totalSideA + r.market.totalSideB };
        });
        withVol.sort((a, b) => (b.vol > a.vol ? 1 : -1));
        return withVol.slice(0, Math.max(3, Math.ceil(withVol.length / 2))).map((x) => x.r);
      }
      return list.filter((r) => statBucket(r.market.statAKey) === cat);
    };
  }, [ammPools, now]);

  const shownRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows.filter((r) => matchesStatusFilter(r, statusFilter, now));
    list = categoryFilter(list, category);
    if (q) list = list.filter((r) => r.searchText.includes(q));
    const sorted = [...list];
    if (sort === "volume") {
      // Most active first: real fees-derived AMM volume, sealed matched
      // volume as the fallback figure for non-AMM markets.
      const volOf = (r: Row) => {
        const p = ammPools?.get(r.market.pda);
        if (p) return volumeFromFees(p.feesAccrued, p.feeBps);
        return r.market.totalSideA + r.market.totalSideB;
      };
      sorted.sort((a, b) => {
        const av = volOf(a);
        const bv = volOf(b);
        if (av !== bv) return bv > av ? 1 : -1;
        return b.market.createdSlot > a.market.createdSlot ? 1 : -1;
      });
    } else if (sort === "ending") {
      sorted.sort((a, b) => Number(a.market.deadline) - Number(b.market.deadline));
    } else {
      sorted.sort((a, b) =>
        b.market.createdSlot > a.market.createdSlot ? 1 : b.market.createdSlot < a.market.createdSlot ? -1 : 0,
      );
    }
    return sorted;
  }, [rows, search, statusFilter, category, categoryFilter, sort, ammPools, now]);

  const loading = data === undefined && !isError;
  const filtersActive = search.trim() !== "" || statusFilter !== "markets";

  const FILTERS: { id: StatusFilter; label: string; count: number }[] = [
    { id: "markets", label: "Markets", count: counts.markets },
    { id: "settled", label: "Settled", count: counts.settled },
    { id: "archive", label: "Archive", count: counts.archive },
  ];

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="grid-cards">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  } else if (data === undefined && isError) {
    body = (
      <div className={`card ${styles.stateCard}`}>
        <p className="muted">Couldn&apos;t reach devnet RPC to load markets.</p>
        <button type="button" className="button" data-variant="ghost" onClick={() => refetch()}>
          Retry
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <p className="muted" style={{ marginTop: "1.5rem" }}>
        No markets found on devnet yet for program <span className="mono">4LpMzq6…18MB</span>. Run{" "}
        <span className="mono">bun run services/ingestion/src/l0_loop_test.ts</span> to create one.
      </p>
    );
  } else if (shownRows.length === 0) {
    body = (
      <div className={`card ${styles.stateCard}`}>
        <p className="muted">
          {statusFilter === "markets" && !search.trim()
            ? "No markets are trading right now — check the Archive for past markets."
            : "No markets match your search or filters."}
        </p>
        <button
          type="button"
          className="button"
          data-variant="ghost"
          onClick={() => {
            setSearch("");
            setStatusFilter(statusFilter === "markets" ? "archive" : "markets");
          }}
        >
          {statusFilter === "markets" && !search.trim() ? "Browse archive" : "Clear filters"}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="grid-cards">
        {shownRows.map((row) => (
          <MarketCard
            key={row.market.pda}
            row={row}
            now={now}
            pool={ammPools?.get(row.market.pda)}
            series={history?.[row.market.pda]}
            traders={traderCounts?.perMarket.get(row.market.pda)}
            myPosition={myPositionByMarket.get(row.market.pda)}
            onQuickTrade={setQuickTarget}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <StatsStrip />
      <div className={styles.controls}>
        <input
          type="search"
          className={styles.search}
          placeholder="Search teams or questions…"
          aria-label="Search markets by team name or question"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className={styles.filters} role="group" aria-label="Filter markets by status">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={styles.filterBtn}
              data-active={statusFilter === f.id}
              aria-pressed={statusFilter === f.id}
              onClick={() => setStatusFilter(f.id)}
            >
              {f.label}
              {!loading && <span className={styles.filterCount}>{f.count}</span>}
            </button>
          ))}
        </div>
        <select
          className={styles.sort}
          aria-label="Sort markets"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
        >
          <option value="volume">Sort: Most active</option>
          <option value="ending">Sort: Ending soon</option>
          <option value="newest">Sort: Newest</option>
        </select>
      </div>

      {/* category chips — a second filter axis over the status tabs */}
      <div className={styles.catRow} role="group" aria-label="Filter markets by category">
        {(
          [
            { id: "all", label: "All" },
            { id: "trending", label: "🔥 Trending" },
            { id: "new", label: "⭐ New" },
            { id: "ending", label: "⏳ Ending soon" },
            { id: "goals", label: "⚽ Goals" },
            { id: "cards", label: "🟨 Cards" },
            { id: "corners", label: "⛳ Corners" },
          ] as { id: Category; label: string }[]
        ).map((c) => (
          <button
            key={c.id}
            type="button"
            className={styles.catBtn}
            data-active={category === c.id}
            aria-pressed={category === c.id}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className={styles.resultsMeta} aria-live="polite">
        {loading
          ? "Reading market accounts from devnet…"
          : `${shownRows.length}${filtersActive ? ` of ${rows.length}` : ""} market${rows.length === 1 ? "" : "s"} · live devnet reads, ~20s refresh`}
      </p>

      {body}

      <QuickTradeModal target={quickTarget} onClose={() => setQuickTarget(null)} />

      {(hiddenCount > 0 || collapsedCount > 0) && (
        <p className={styles.disclosure}>
          {hiddenCount > 0 && (
            <>
              {hiddenCount} throwaway test market{hiddenCount === 1 ? "" : "s"} from development (fixture ids
              900000000–900000999) hidden from this view — still real on-chain accounts, just not part of the product
              demo.
            </>
          )}
          {hiddenCount > 0 && collapsedCount > 0 && " "}
          {collapsedCount > 0 && (
            <>
              {collapsedCount} duplicate market{collapsedCount === 1 ? "" : "s"} with an identical predicate collapsed
              into a single card (&quot;+N more&quot; on the card), preferring the Settled/Claimed one.
            </>
          )}
        </p>
      )}
    </div>
  );
}
