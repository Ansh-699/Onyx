// Replay fixture: a captured TxLINE stat-validation proof + derived settlement inputs,
// persisted to disk so the demo (and tests) can run deterministically with no live match.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { epochDayFromMs, type StatValidationResponse } from "./scores";

export interface ReplayFixture {
  capturedAt: string;
  network: string;
  fixtureId: number;
  seq: number;
  statKeys: string;
  /** Derived from summary.updateStats.minTimestamp (ms). */
  targetTsMs: number;
  epochDay: number;
  /** Raw API payload, used to rebuild the validate_stat args byte-for-byte. */
  payload: StatValidationResponse;
}

export function buildFixture(
  network: string,
  fixtureId: number,
  seq: number,
  statKeys: string,
  payload: StatValidationResponse,
): ReplayFixture {
  const targetTsMs = payload.summary.updateStats.minTimestamp;
  return {
    capturedAt: new Date().toISOString(),
    network,
    fixtureId,
    seq,
    statKeys,
    targetTsMs,
    epochDay: epochDayFromMs(targetTsMs),
    payload,
  };
}

export function saveFixture(path: string, fixture: ReplayFixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 2));
}

export function loadFixture(path: string): ReplayFixture {
  if (!existsSync(path)) throw new Error(`fixture not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as ReplayFixture;
}
