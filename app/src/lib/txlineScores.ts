// Server-only TxLINE live-score client. NEVER imported from a "use client"
// file: it reads TXLINE_JWT / TXLINE_API_TOKEN from server env (app/.env.local,
// not NEXT_PUBLIC_-prefixed) and calls TxLINE directly. The market page talks
// to this only through app/src/app/api/scores/[fixtureId]/route.ts, so
// credentials never reach the browser.
//
// TxLINE's /scores/stat-validation is keyed by (fixtureId, seq) — there's no
// "give me the latest" call, so getting the current score means finding the
// highest seq that still resolves. This sandbox bundle's fixtures don't
// appear to advance in real time (a fixture whose kickoff was over a week in
// the past still tops out at the same seq every time this was checked), so
// caching the discovered max seq per fixture for TXLINE_POLL_TTL_MS and
// re-validating occasionally is enough to honestly reflect "latest data
// TxLINE will give us" without a network round trip on every request.

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = process.env.TXLINE_API_BASE_URL ?? `${API_ORIGIN}/api`;
const JWT = process.env.TXLINE_JWT;
const API_TOKEN = process.env.TXLINE_API_TOKEN;

// Matches the TxLINE SL1 (free tier) update cadence the UI discloses to users.
const POLL_TTL_MS = 60_000;

export interface FixtureScore {
  fixtureId: number;
  p1Goals: number;
  p2Goals: number;
  /** Full match-stat set (statKeys 3-8): cards + corners, both sides. */
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

const EMPTY_STATS = { p1Goals: 0, p2Goals: 0, p1Yellows: 0, p2Yellows: 0, p1Reds: 0, p2Reds: 0, p1Corners: 0, p2Corners: 0 };

interface StatValidationResponse {
  statsToProve: Array<{ key: number; value: number; period: number }>;
}

async function statValidation(fixtureId: number, seq: number, statKeys: string): Promise<StatValidationResponse | null> {
  if (!JWT || !API_TOKEN) return null;
  const url = `${API_BASE_URL}/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${JWT}`,
      "X-Api-Token": API_TOKEN,
      "Accept-Encoding": "deflate",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as StatValidationResponse;
}

async function findMaxSeq(fixtureId: number): Promise<number> {
  let lo = 1;
  let hi = 1;
  while (hi <= 8192 && (await statValidation(fixtureId, hi, "1"))) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await statValidation(fixtureId, mid, "1")) lo = mid;
    else hi = mid;
  }
  return lo;
}

const cache = new Map<number, FixtureScore>();

/** Drop a fixture's cached score — called by the live stream bridge the
 * moment TxLINE pushes an event for it, so the next snapshot fetch returns
 * genuinely fresh data instead of waiting out the poll TTL. */
export function invalidateScoreCache(fixtureId: number): void {
  cache.delete(fixtureId);
}

/** Current score for a fixture, straight from TxLINE (not on-chain, not our proof capture). */
export async function getFixtureScore(fixtureId: number): Promise<FixtureScore> {
  const cached = cache.get(fixtureId);
  if (cached && Date.now() - cached.fetchedAt < POLL_TTL_MS) return cached;

  if (!JWT || !API_TOKEN) {
    const result: FixtureScore = { fixtureId, ...EMPTY_STATS, seq: 0, fetchedAt: Date.now(), source: "unavailable" };
    cache.set(fixtureId, result);
    return result;
  }

  try {
    const seq = await findMaxSeq(fixtureId);
    // Full match-stat set in one call: goals(1,2) yellows(3,4) reds(5,6) corners(7,8).
    // Some fixtures haven't recorded every stat — fall back to goals-only
    // rather than losing the score because a corners key didn't resolve.
    const stats = (await statValidation(fixtureId, seq, "1,2,3,4,5,6,7,8")) ?? (await statValidation(fixtureId, seq, "1,2"));
    const v = (key: number) => stats?.statsToProve.find((s) => s.key === key)?.value ?? 0;
    const result: FixtureScore = {
      fixtureId,
      p1Goals: v(1), p2Goals: v(2),
      p1Yellows: v(3), p2Yellows: v(4),
      p1Reds: v(5), p2Reds: v(6),
      p1Corners: v(7), p2Corners: v(8),
      seq, fetchedAt: Date.now(), source: "txline",
    };
    cache.set(fixtureId, result);
    return result;
  } catch {
    const result: FixtureScore = { fixtureId, ...EMPTY_STATS, seq: 0, fetchedAt: Date.now(), source: "unavailable" };
    cache.set(fixtureId, result);
    return result;
  }
}
