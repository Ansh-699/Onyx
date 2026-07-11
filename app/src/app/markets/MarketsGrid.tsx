"use client";

// Polymarket-style market grid for the lobby. Everything rendered here is
// real devnet state via useMarkets() (react-query, ~20s poll,
// keepPreviousData — a poll tick can never blank or flash the grid). The
// first paint shows fixed-height skeleton cards so the content swap causes
// zero layout shift. Search / status filter / sort are pure client state.

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMarkets, useScore, useAmmPoolMarkets, useLiveFixtures } from "@/lib/hooks";
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
} from "@/lib/onchain";
import type { AmmPoolSummary } from "@/lib/onchain";
import { describeMarketPredicate, rawPredicateText } from "@/lib/statKeys";
import { getFixtureInfo, fixtureDisplayName, getFixtureStartTimeMs, primeLiveFixtures } from "@/lib/fixtureMeta";
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
}

type StatusFilter = "active" | "open" | "settled" | "archive";
type SortMode = "volume" | "newest";

function matchesStatusFilter(row: Row, filter: StatusFilter): boolean {
  if (filter === "active") return row.active;
  if (filter === "open") return row.market.status === STATUS_OPEN || row.market.status === STATUS_LIVE;
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

function MarketCard({ row, now, pool }: { row: Row; now: number; pool: AmmPoolSummary | undefined }) {
  const m = row.market;
  const isAmm = !!pool;
  const total = m.totalSideA + m.totalSideB;
  const startMs = getFixtureStartTimeMs(row.fixtureId);
  const started = startMs !== null && startMs <= now;
  const showOutcome = m.status === STATUS_SETTLED || m.status === STATUS_CLAIMED;

  // Price of YES (side A) in cents. AMM: pool-implied price_A = b/(a+b) —
  // the real, tradeable price. Parimutuel fallback: stake share.
  let yesCents: number | null = null;
  let vol = Number(total) / 1e6;
  if (pool && pool.reserveA + pool.reserveB > 0n) {
    yesCents = Math.round(Number((pool.reserveB * 100n) / (pool.reserveA + pool.reserveB)));
    vol = Number(pool.reserveA + pool.reserveB) / 1e6;
  } else if (total > 0n) {
    yesCents = Math.round(Number((m.totalSideA * 100n) / total));
  }
  const noCents = yesCents !== null ? 100 - yesCents : null;

  return (
    <Link href={`/market/${m.pda}`} className={`card ${styles.marketCard}`}>
      <div className={styles.cardTop}>
        <span className={styles.fixture} title={`TxLINE fixtureId ${row.fixtureId}`}>
          {row.fixtureLabel}
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

      {/* Polymarket-style Yes/No price buttons — real pool prices in cents. */}
      <div className={styles.yesNoRow} aria-hidden={yesCents === null}>
        <span className={styles.yesBtn} data-empty={yesCents === null}>
          <span>Yes</span>
          <strong>{yesCents !== null ? `${yesCents}¢` : "—"}</strong>
        </span>
        <span className={styles.noBtn} data-empty={noCents === null}>
          <span>No</span>
          <strong>{noCents !== null ? `${noCents}¢` : "—"}</strong>
        </span>
      </div>

      <div className={styles.cardBottom}>
        <div className={styles.cardBottomLeft}>
          {isAmm && (
            <span className={styles.probLabel} title="AMM market: continuous trading against a seeded pool — buy AND sell anytime before kickoff. Instant, gas-free on the Ephemeral Rollup with a trading session.">
              AMM · trade anytime{pool?.delegated ? " · ⚡ ER" : ""}
            </span>
          )}
          {showOutcome && (
            <span className="pill" data-tone="green">
              {OUTCOME_NAMES[m.outcome] ?? m.outcome} won
            </span>
          )}
        </div>
        <span className={styles.volume}>
          {formatVolume(vol)} <span className={styles.volumeUnit}>tUSDC {isAmm ? "pool" : "vol"}</span>
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [sort, setSort] = useState<SortMode>("volume");

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
      });
    }
    return { rows: built, hiddenCount: hidden, collapsedCount: collapsed };
  }, [data, ammPools, now]);

  const counts = useMemo(
    () => ({
      active: rows.filter((r) => matchesStatusFilter(r, "active")).length,
      open: rows.filter((r) => matchesStatusFilter(r, "open")).length,
      settled: rows.filter((r) => matchesStatusFilter(r, "settled")).length,
      archive: rows.length,
    }),
    [rows],
  );

  const shownRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows.filter((r) => matchesStatusFilter(r, statusFilter));
    if (q) list = list.filter((r) => r.searchText.includes(q));
    const sorted = [...list];
    if (sort === "volume") {
      sorted.sort((a, b) => {
        const av = a.market.totalSideA + a.market.totalSideB;
        const bv = b.market.totalSideA + b.market.totalSideB;
        if (av !== bv) return bv > av ? 1 : -1;
        return b.market.createdSlot > a.market.createdSlot ? 1 : -1;
      });
    } else {
      sorted.sort((a, b) =>
        b.market.createdSlot > a.market.createdSlot ? 1 : b.market.createdSlot < a.market.createdSlot ? -1 : 0,
      );
    }
    return sorted;
  }, [rows, search, statusFilter, sort]);

  const loading = data === undefined && !isError;
  const filtersActive = search.trim() !== "" || statusFilter !== "active";

  const FILTERS: { id: StatusFilter; label: string; count: number }[] = [
    { id: "active", label: "Trading now", count: counts.active },
    { id: "open", label: "Open", count: counts.open },
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
          {statusFilter === "active" && !search.trim()
            ? "No markets are trading right now — check the Archive for past markets."
            : "No markets match your search or filters."}
        </p>
        <button
          type="button"
          className="button"
          data-variant="ghost"
          onClick={() => {
            setSearch("");
            setStatusFilter(statusFilter === "active" ? "archive" : "active");
          }}
        >
          {statusFilter === "active" && !search.trim() ? "Browse archive" : "Clear filters"}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="grid-cards">
        {shownRows.map((row) => (
          <MarketCard key={row.market.pda} row={row} now={now} pool={ammPools?.get(row.market.pda)} />
        ))}
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
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
          <option value="volume">Sort: Volume</option>
          <option value="newest">Sort: Newest</option>
        </select>
      </div>

      <p className={styles.resultsMeta} aria-live="polite">
        {loading
          ? "Reading market accounts from devnet…"
          : `${shownRows.length}${filtersActive ? ` of ${rows.length}` : ""} market${rows.length === 1 ? "" : "s"} · live devnet reads, ~20s refresh`}
      </p>

      {body}

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
