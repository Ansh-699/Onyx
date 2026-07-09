// Mock data shaped like the ingestion FixtureSnapshot + on-chain market PDAs.
// Where on-chain data isn't wired yet, these give the UI realistic structure.

import type { FixtureSnapshot, MarketSummary, ReceiptInput } from "./types";
import { hashPair, leafFromScoreStat, toHex } from "./merkle";

// World Cup competitionId placeholder (structure matches TxLINE fixtures/snapshot).
export const WORLD_CUP_COMPETITION_ID = 4;

export const FIXTURES: FixtureSnapshot[] = [
  {
    fixtureId: 100234,
    competition: "FIFA World Cup",
    competitionId: WORLD_CUP_COMPETITION_ID,
    participant1: "Argentina",
    participant2: "France",
    startTime: 1_781_020_800_000, // ms
  },
  {
    fixtureId: 100235,
    competition: "FIFA World Cup",
    competitionId: WORLD_CUP_COMPETITION_ID,
    participant1: "Brazil",
    participant2: "England",
    startTime: 1_781_107_200_000,
  },
  {
    fixtureId: 100236,
    competition: "FIFA World Cup",
    competitionId: WORLD_CUP_COMPETITION_ID,
    participant1: "Spain",
    participant2: "Germany",
    startTime: 1_781_193_600_000,
  },
];

// Stat key catalogue (illustrative; real keys come from TxLINE stat dictionary).
export const STAT_KEYS = {
  totalGoals: 10,
  totalCorners: 21,
  totalCards: 33,
  totalShotsOnTarget: 42,
} as const;

export const MARKETS: MarketSummary[] = [
  {
    pda: "Mkt1AArgFra1Goa1sGT2xxxxxxxxxxxxxxxxxxxxxxxx",
    fixtureId: 100234,
    statLabel: "Total goals",
    statKey: STAT_KEYS.totalGoals,
    period: 0,
    predicate: { threshold: 2, comparison: "greaterThan" },
    deadlineMs: 1_781_020_800_000,
    poolYes: 1240,
    poolNo: 860,
  },
  {
    pda: "Mkt2AArgFra1Corners1LT9xxxxxxxxxxxxxxxxxxxxxx",
    fixtureId: 100234,
    statLabel: "Total corners",
    statKey: STAT_KEYS.totalCorners,
    period: 0,
    predicate: { threshold: 9, comparison: "lessThan" },
    deadlineMs: 1_781_020_800_000,
    poolYes: 540,
    poolNo: 980,
  },
  {
    pda: "Mkt3ABraEng1Goals1EQ3xxxxxxxxxxxxxxxxxxxxxxxx",
    fixtureId: 100235,
    statLabel: "Total goals",
    statKey: STAT_KEYS.totalGoals,
    period: 0,
    predicate: { threshold: 3, comparison: "equalTo" },
    deadlineMs: 1_781_107_200_000,
    poolYes: 300,
    poolNo: 300,
  },
  {
    pda: "Mkt4ASpaGer1Cards1GT4xxxxxxxxxxxxxxxxxxxxxxxx",
    fixtureId: 100236,
    statLabel: "Total cards",
    statKey: STAT_KEYS.totalCards,
    period: 0,
    predicate: { threshold: 4, comparison: "greaterThan" },
    deadlineMs: 1_781_193_600_000,
    poolYes: 720,
    poolNo: 410,
  },
];

export function fixtureById(id: number): FixtureSnapshot | undefined {
  return FIXTURES.find((f) => f.fixtureId === id);
}

export function marketByPda(pda: string): MarketSummary | undefined {
  return MARKETS.find((m) => m.pda === pda);
}

export function marketsForFixture(fixtureId: number): MarketSummary[] {
  return MARKETS.filter((m) => m.fixtureId === fixtureId);
}

/**
 * Build a *genuinely valid* receipt fixture: we compute a real leaf from the
 * final ScoreStat, then fold it up 3 mock siblings using the SAME logic the
 * receipt page verifies with, so `root` is authentic. This proves the
 * in-browser re-derivation end-to-end without needing a live captured proof.
 */
export function buildValidReceipt(market: string): ReceiptInput {
  const finalStat = { key: STAT_KEYS.totalGoals, value: 3, period: 0 };
  const leaf = leafFromScoreStat(finalStat);

  // Deterministic mock siblings (any 32-byte values work for the demo).
  const sib0 = leafFromScoreStat({ key: 10, value: 1, period: 0 });
  const sib1 = leafFromScoreStat({ key: 21, value: 5, period: 1 });
  const sib2 = leafFromScoreStat({ key: 33, value: 2, period: 2 });

  const proofPath = [
    { hash: Array.from(sib0), isRightSibling: true },
    { hash: Array.from(sib1), isRightSibling: false },
    { hash: Array.from(sib2), isRightSibling: true },
  ];

  // Fold to derive the authentic root (mirror of verifyMerkleProof).
  let acc = leaf;
  acc = hashPair(acc, sib0); // sib0 right
  acc = hashPair(sib1, acc); // sib1 left
  acc = hashPair(acc, sib2); // sib2 right
  const root = "0x" + toHex(acc);

  return {
    market,
    finalStat,
    root,
    leaf: "0x" + toHex(leaf),
    proofPath,
    predicate: { threshold: 2, comparison: "greaterThan" },
  };
}
