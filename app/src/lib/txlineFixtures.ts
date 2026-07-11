// Server-only TxLINE fixtures client — the live replacement for the old
// hand-refreshed KNOWN_FIXTURES table. NEVER imported from a "use client"
// file (reads TXLINE_JWT / TXLINE_API_TOKEN); the browser goes through
// app/src/app/api/fixtures/route.ts.
//
// /fixtures/snapshot serves a ROLLING window of current/upcoming fixtures —
// older fixtures age out (that's why the static table existed). We merge the
// live window over the static fallback in fixtureMeta.ts, so aged-out
// fixtures keep their real names and fresh ones need no hand refresh.

import { KNOWN_FIXTURES_STATIC, KNOWN_START_TIMES_STATIC } from "./fixtureMeta";

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = process.env.TXLINE_API_BASE_URL ?? `${API_ORIGIN}/api`;
const JWT = process.env.TXLINE_JWT;
const API_TOKEN = process.env.TXLINE_API_TOKEN;

const CACHE_TTL_MS = 5 * 60_000;

interface RawFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome?: boolean;
  Competition?: string;
  CompetitionId?: number;
  StartTime?: number; // ms since epoch (TxLINE timestamps are milliseconds)
}

export interface LiveFixture {
  fixtureId: number;
  participant1: string;
  participant2: string;
  competition: string;
  startTimeMs: number | null;
  /** "live" = in the current TxLINE window; "static" = our verified fallback table. */
  source: "live" | "static";
}

let cached: { at: number; fixtures: LiveFixture[] } | null = null;

export async function getLiveFixtures(): Promise<LiveFixture[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.fixtures;

  const byId = new Map<number, LiveFixture>();
  // Static fallback first — live entries overwrite it below.
  for (const [id, info] of Object.entries(KNOWN_FIXTURES_STATIC)) {
    byId.set(Number(id), {
      fixtureId: Number(id),
      participant1: info.participant1,
      participant2: info.participant2,
      competition: info.competition,
      startTimeMs: KNOWN_START_TIMES_STATIC[Number(id)] ?? null,
      source: "static",
    });
  }

  if (JWT && API_TOKEN) {
    try {
      const res = await fetch(`${API_BASE_URL}/fixtures/snapshot`, {
        headers: { Authorization: `Bearer ${JWT}`, "X-Api-Token": API_TOKEN, "Accept-Encoding": "deflate" },
        cache: "no-store",
      });
      if (res.ok) {
        const raw = (await res.json()) as RawFixture[];
        for (const f of raw) {
          byId.set(f.FixtureId, {
            fixtureId: f.FixtureId,
            participant1: f.Participant1,
            participant2: f.Participant2,
            competition: f.Competition ?? "World Cup",
            startTimeMs: f.StartTime ?? byId.get(f.FixtureId)?.startTimeMs ?? null,
            source: "live",
          });
        }
      }
    } catch {
      // network failure -> serve the static fallback silently; the route
      // exposes `source` per fixture so the UI can stay honest about it.
    }
  }

  const fixtures = [...byId.values()].sort((a, b) => (a.startTimeMs ?? Infinity) - (b.startTimeMs ?? Infinity));
  cached = { at: Date.now(), fixtures };
  return fixtures;
}
