"use client";

// Client-side live-data hooks. Every hook polls real devnet / TxLINE state
// through the existing read functions in onchain.ts — no mocks — and uses
// keepPreviousData so a poll tick can never blank or flash the UI.

import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  listMarkets,
  getMarket,
  listSealedOrders,
  getConnection,
  getTradingAccount,
  listTradingAccountsForMarket,
  ammPoolPda,
  ammPoolExists,
  getAmmPool,
  getAmmPosition,
  getAmmPoolsForMarkets,
  type AmmPoolSummary,
  listAmmPositionsForOwner,
  type OnChainMarket,
  type OnChainSealedOrder,
  type OnChainTradingAccount,
  type OnChainAmmPool,
  type OnChainAmmPosition,
} from "./onchain";
import { getDelegationStatus, getErConnection, type DelegationStatus } from "./erRouting";

/** All ONYX markets on devnet, newest first. ~20s poll (getProgramAccounts is heavy). */
export function useMarkets(initialData?: OnChainMarket[]) {
  return useQuery({
    queryKey: ["markets"],
    queryFn: listMarkets,
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
    initialData,
  });
}

/** One market account. ~8s poll — cheap single getAccountInfo. */
export function useMarket(pda: string, initialData?: OnChainMarket | null) {
  return useQuery({
    queryKey: ["market", pda],
    queryFn: () => getMarket(pda),
    refetchInterval: 8_000,
    placeholderData: keepPreviousData,
    initialData,
    enabled: !!pda,
  });
}

/** Sealed orders for a market. ~10s poll. */
export function useSealedOrders(marketPda: string, initialData?: OnChainSealedOrder[]) {
  return useQuery({
    queryKey: ["sealedOrders", marketPda],
    queryFn: () => listSealedOrders(marketPda),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
    initialData,
    enabled: !!marketPda,
  });
}

// =====================================================================
// ER-fast trading hooks (docs/ER_TRADING_DESIGN.md). Polled faster than the
// base-only hooks above (2s vs 8-20s) — the whole point of this flow is
// that state changes fast, so the UI needs to actually show that.
// =====================================================================

/** This account's live delegation status, via the MagicBlock router. ~2.5s poll — routing decisions need to be fresh, not just display-fresh. */
export function useDelegationStatus(pubkey: PublicKey | null) {
  return useQuery<DelegationStatus>({
    queryKey: ["delegationStatus", pubkey?.toBase58()],
    queryFn: () => getDelegationStatus(pubkey!, true),
    refetchInterval: 2_500,
    placeholderData: keepPreviousData,
    enabled: !!pubkey,
  });
}

/**
 * A market's live state, read from whichever ledger currently holds it —
 * base if not delegated (or already undelegated again), the resolved ER
 * endpoint if delegated. This is what makes "phase-based routing" visible
 * in the UI: while delegated, this hook's data reflects ER-fast trading as
 * it happens (pool totals, phase, clearing price), not a frozen base-layer
 * snapshot from the moment of delegation.
 */
export function useRoutedMarket(pda: string) {
  const marketPk = useMemo(() => (pda ? new PublicKey(pda) : null), [pda]);
  const delegation = useDelegationStatus(marketPk);

  const connection = useMemo(() => {
    if (delegation.data?.isDelegated && delegation.data.fqdn) return getErConnection(delegation.data.fqdn);
    return getConnection();
  }, [delegation.data?.isDelegated, delegation.data?.fqdn]);

  const marketQuery = useQuery({
    queryKey: ["routedMarket", pda, delegation.data?.isDelegated ?? false, delegation.data?.fqdn ?? null],
    queryFn: () => getMarket(pda, connection),
    refetchInterval: 2_500,
    placeholderData: keepPreviousData,
    enabled: !!pda && delegation.isFetched,
  });

  return {
    ...marketQuery,
    isDelegated: delegation.data?.isDelegated ?? false,
    fqdn: delegation.data?.fqdn ?? null,
    connection,
    delegationLoading: delegation.isLoading,
  };
}

/** One wallet's TradingAccount for a market, read from the market's currently-resolved connection. */
export function useTradingAccount(marketPda: string, owner: PublicKey | null, connection: ReturnType<typeof getConnection>) {
  const marketPk = useMemo(() => (marketPda ? new PublicKey(marketPda) : null), [marketPda]);
  return useQuery<OnChainTradingAccount | null>({
    queryKey: ["tradingAccount", marketPda, owner?.toBase58(), connection.rpcEndpoint],
    queryFn: () => getTradingAccount(connection, marketPk!, owner!),
    refetchInterval: 2_000,
    placeholderData: keepPreviousData,
    enabled: !!marketPk && !!owner,
  });
}

/** Every TradingAccount on a market — the batch-match trigger's account list, and the undelegate-everything list. */
export function useTradingAccountsForMarket(marketPda: string, connection: ReturnType<typeof getConnection>) {
  const marketPk = useMemo(() => (marketPda ? new PublicKey(marketPda) : null), [marketPda]);
  return useQuery<OnChainTradingAccount[]>({
    queryKey: ["tradingAccounts", marketPda, connection.rpcEndpoint],
    queryFn: () => listTradingAccountsForMarket(connection, marketPk!),
    refetchInterval: 2_000,
    placeholderData: keepPreviousData,
    enabled: !!marketPk,
  });
}

// =====================================================================
// AMM trading hooks (docs/AMM_TRADING_DESIGN.md Phase D). Same routing
// discipline as the TradingAccount hooks: the pool/position live on the ER
// while delegated, so reads resolve the POOL's own delegation status (not
// the market's — they're delegated together in the happy path, but the
// pool's status is what governs where swap state actually is).
// =====================================================================

/** Does this market have an AMM pool at all? Cheap existence probe (base PDA read, delegation-agnostic) — MarketDetail routes panels on this. ~10s poll. */
export function useAmmPoolExists(marketPda: string) {
  const marketPk = useMemo(() => (marketPda ? new PublicKey(marketPda) : null), [marketPda]);
  return useQuery({
    queryKey: ["ammPoolExists", marketPda],
    queryFn: () => ammPoolExists(marketPk!),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
    enabled: !!marketPk,
  });
}

/**
 * A market's AMM pool, read from whichever ledger currently holds it —
 * live reserves on the ER while delegated (2.5s poll: prices move fast
 * there, the UI must too), base otherwise.
 */
export function useRoutedAmmPool(marketPda: string) {
  const marketPk = useMemo(() => (marketPda ? new PublicKey(marketPda) : null), [marketPda]);
  const poolPk = useMemo(() => (marketPk ? ammPoolPda(marketPk) : null), [marketPk]);
  const delegation = useDelegationStatus(poolPk);

  const connection = useMemo(() => {
    if (delegation.data?.isDelegated && delegation.data.fqdn) return getErConnection(delegation.data.fqdn);
    return getConnection();
  }, [delegation.data?.isDelegated, delegation.data?.fqdn]);

  const poolQuery = useQuery<OnChainAmmPool | null>({
    queryKey: ["ammPool", marketPda, delegation.data?.isDelegated ?? false, delegation.data?.fqdn ?? null],
    queryFn: () => getAmmPool(connection, marketPk!),
    refetchInterval: 2_500,
    placeholderData: keepPreviousData,
    enabled: !!marketPk && delegation.isFetched,
  });

  return {
    ...poolQuery,
    isDelegated: delegation.data?.isDelegated ?? false,
    fqdn: delegation.data?.fqdn ?? null,
    connection,
  };
}

/** One wallet's AmmPosition for a market, read from the pool's currently-resolved connection. */
export function useAmmPosition(marketPda: string, owner: PublicKey | null, connection: ReturnType<typeof getConnection>) {
  const marketPk = useMemo(() => (marketPda ? new PublicKey(marketPda) : null), [marketPda]);
  return useQuery<OnChainAmmPosition | null>({
    queryKey: ["ammPosition", marketPda, owner?.toBase58(), connection.rpcEndpoint],
    queryFn: () => getAmmPosition(connection, marketPk!, owner!),
    refetchInterval: 2_000,
    placeholderData: keepPreviousData,
    enabled: !!marketPk && !!owner,
  });
}

/**
 * AMM pools for the lobby's market list — delegation-agnostic PDA probe, so
 * ER-delegated pools (all v2 seeded markets) are found too, with reserves
 * for the ¢ price buttons. Map.has(marketPda) drives the AMM badge.
 */
export function useAmmPoolMarkets(marketPdas: string[] | undefined) {
  const key = marketPdas?.join(",") ?? "";
  return useQuery<Map<string, AmmPoolSummary>>({
    queryKey: ["ammPools", key],
    queryFn: () => getAmmPoolsForMarkets(marketPdas!),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    enabled: !!marketPdas && marketPdas.length > 0,
  });
}

/** Every AmmPosition a wallet owns. Base owner-scan, so a position currently
 * delegated to the ER is temporarily absent here (owned by the Delegation
 * Program while delegated) and reappears after undelegation — the live view
 * of a delegated position is on its market page, which routes reads to the
 * ER. Honest limitation, documented in the portfolio section's footer. */
export function useAmmPositionsForOwner(owner: PublicKey | null) {
  return useQuery<OnChainAmmPosition[]>({
    queryKey: ["ammPositions", owner?.toBase58()],
    queryFn: () => listAmmPositionsForOwner(owner!),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    enabled: !!owner,
  });
}

export interface FixtureScore {
  fixtureId: number;
  p1Goals: number;
  p2Goals: number;
  p1Yellows: number;
  p2Yellows: number;
  p1Reds: number;
  p2Reds: number;
  p1Corners: number;
  p2Corners: number;
  seq: number;
  fetchedAt: number;
  source: "txline" | "unavailable";
}

export interface LiveFixture {
  fixtureId: number;
  participant1: string;
  participant2: string;
  competition: string;
  startTimeMs: number | null;
  source: "live" | "static";
}

/**
 * Live fixture window from TxLINE /fixtures/snapshot (via /api/fixtures,
 * 5-min server cache) merged over the verified static fallback — real team
 * names and kickoff times without hand-refreshing a table.
 */
export function useLiveFixtures() {
  return useQuery<LiveFixture[]>({
    queryKey: ["fixtures"],
    queryFn: async () => {
      const res = await fetch("/api/fixtures", { cache: "no-store" });
      if (!res.ok) throw new Error(`fixtures ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/** Index a fixture list by id for O(1) name lookups in card grids. */
export function fixtureIndex(fixtures: LiveFixture[] | undefined): Map<number, LiveFixture> {
  return new Map((fixtures ?? []).map((f) => [f.fixtureId, f]));
}

/**
 * Live TxLINE score via our server-side proxy (/api/scores/[fixtureId] —
 * credentials never reach the browser). TxLINE free tier updates on a ~60s
 * SL1 cadence; poll at 20s so the UI reflects new data within a cadence tick.
 */
export function useScore(fixtureId: number | null | undefined) {
  return useQuery<FixtureScore>({
    queryKey: ["score", fixtureId],
    queryFn: async () => {
      const res = await fetch(`/api/scores/${fixtureId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`scores ${res.status}`);
      return res.json();
    },
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
    enabled: fixtureId !== null && fixtureId !== undefined,
  });
}

export interface ReferenceOdds {
  fixtureId: number;
  homePct: number | null;
  drawPct: number | null;
  awayPct: number | null;
  bookmaker: string | null;
  ts: number | null;
  fetchedAt: number;
  source: "txline" | "unavailable";
}

/**
 * Real TxLINE reference odds (full-game 1X2 implied probabilities) via the
 * server-side proxy. `source:"unavailable"` when TxLINE hasn't published
 * odds for the fixture yet (only fixtures near kickoff have them) — show
 * nothing in that case rather than a fabricated number. These are an
 * external reference only, never our market's price and never settlement.
 */
export function useReferenceOdds(fixtureId: number | null | undefined) {
  return useQuery<ReferenceOdds>({
    queryKey: ["odds", fixtureId],
    queryFn: async () => {
      const res = await fetch(`/api/odds/${fixtureId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`odds ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    enabled: fixtureId !== null && fixtureId !== undefined,
  });
}
