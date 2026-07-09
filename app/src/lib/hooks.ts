"use client";

// Client-side live-data hooks. Every hook polls real devnet / TxLINE state
// through the existing read functions in onchain.ts — no mocks — and uses
// keepPreviousData so a poll tick can never blank or flash the UI.

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  listMarkets,
  getMarket,
  listSealedOrders,
  type OnChainMarket,
  type OnChainSealedOrder,
} from "./onchain";

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

export interface FixtureScore {
  fixtureId: number;
  p1Goals: number;
  p2Goals: number;
  seq: number;
  fetchedAt: number;
  source: "txline" | "unavailable";
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
