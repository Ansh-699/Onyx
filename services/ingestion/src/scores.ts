// TxLINE scores + proof fetching, grounded on txodds/tx-on-chain example scripts.
//
// Endpoints (verified against the reference repo + OpenAPI):
//   GET /fixtures/snapshot?competitionId=&startEpochDay=
//   GET /scores/snapshot/{fixtureId}
//   GET /scores/stat-validation?fixtureId=&seq=&statKeys=   <- proof payload for validate_stat
//   GET /scores/stream  (SSE)  <- live score events
//
// NOTE ON UNITS: TxLINE timestamps are in MILLISECONDS.
//   epochDay = floor(ts_ms / 86_400_000)
// The daily-roots PDA uses seed ["daily_scores_roots", epochDay as u16 LE]
// even though the validate_stat IDL account arg is named `daily_scores_merkle_roots`.

import type { AuthState } from "./auth";
import { apiGet } from "./auth";

export const MS_PER_DAY = 86_400_000;

export function epochDayFromMs(tsMs: number): number {
  return Math.floor(tsMs / MS_PER_DAY);
}

/** A ProofNode as returned by the API (camelCase) — matches txoracle IDL ProofNode. */
export interface ApiProofNode {
  hash: number[] | Uint8Array;
  isRightSibling: boolean;
}

/** The stat-validation payload the API returns; shape mirrors the reference scripts. */
export interface StatValidationResponse {
  ts?: number;
  summary: {
    fixtureId: number;
    updateStats: {
      updateCount: number;
      minTimestamp: number;
      maxTimestamp: number;
    };
    eventStatsSubTreeRoot: number[];
  };
  subTreeProof: ApiProofNode[];
  mainTreeProof: ApiProofNode[];
  eventStatRoot: number[];
  statsToProve: Array<{ key: number; value: number; period: number }>;
  statProofs: ApiProofNode[][];
}

export interface FixtureSnapshot {
  fixtureId: number;
  competition?: string;
  competitionId?: number;
  participant1?: string;
  participant2?: string;
  startTime?: number;
  [k: string]: unknown;
}

/** GET fixtures for a competition/day (World Cup competitionId + epoch day). */
export function getFixtures(
  state: AuthState,
  competitionId: number,
  startEpochDay: number,
): Promise<FixtureSnapshot[]> {
  return apiGet<FixtureSnapshot[]>(
    `/fixtures/snapshot?competitionId=${competitionId}&startEpochDay=${startEpochDay}`,
    state,
  );
}

/** GET a scores snapshot for a fixture. */
export function getScoresSnapshot(
  state: AuthState,
  fixtureId: number,
): Promise<unknown> {
  return apiGet(`/scores/snapshot/${fixtureId}`, state);
}

/** GET the proof payload needed to run validate_stat for a given fixture/seq/stat. */
export function getStatValidation(
  state: AuthState,
  fixtureId: number,
  seq: number,
  statKeys: string | number,
): Promise<StatValidationResponse> {
  return apiGet<StatValidationResponse>(
    `/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys}`,
    state,
  );
}
