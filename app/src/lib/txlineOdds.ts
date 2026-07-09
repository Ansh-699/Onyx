// Server-only TxLINE reference-odds client. Same auth/caching pattern as
// txlineScores.ts (credentials from server env, never bundled to the
// browser; browser talks to /api/odds/[fixtureId]).
//
// Purpose: display REAL market odds from TxLINE next to our on-chain
// pool-implied probabilities, clearly labeled as an external reference —
// they are NOT our market's price and are never used in settlement.
// Live-probed 2026-07-09: /odds/snapshot/{fixtureId} returns entries like
//   { SuperOddsType: "1X2_PARTICIPANT_RESULT", MarketPeriod: null,
//     PriceNames: ["part1","draw","part2"], Prices: [...],
//     Pct: ["60.716","24.649","14.620"], Bookmaker: "TXLineStablePriceDemargined" }
// Only fixtures near kickoff have odds published (upcoming-but-distant
// fixtures return an empty array — that's honest "no odds yet", not an error).

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = process.env.TXLINE_API_BASE_URL ?? `${API_ORIGIN}/api`;
const JWT = process.env.TXLINE_JWT;
const API_TOKEN = process.env.TXLINE_API_TOKEN;

const POLL_TTL_MS = 60_000; // free-tier SL1 cadence, same as scores

interface RawOddsEntry {
  FixtureId: number;
  Ts: number;
  Bookmaker: string;
  SuperOddsType: string;
  MarketPeriod: string | null;
  MarketParameters: string | null;
  PriceNames: string[];
  Prices: number[];
  Pct: string[];
}

export interface ReferenceOdds {
  fixtureId: number;
  /** Full-game 1X2 implied probabilities (percent), when published. */
  homePct: number | null;
  drawPct: number | null;
  awayPct: number | null;
  bookmaker: string | null;
  ts: number | null;
  fetchedAt: number;
  source: "txline" | "unavailable";
}

const cache = new Map<number, ReferenceOdds>();

export async function getReferenceOdds(fixtureId: number): Promise<ReferenceOdds> {
  const cached = cache.get(fixtureId);
  if (cached && Date.now() - cached.fetchedAt < POLL_TTL_MS) return cached;

  const empty: ReferenceOdds = {
    fixtureId,
    homePct: null,
    drawPct: null,
    awayPct: null,
    bookmaker: null,
    ts: null,
    fetchedAt: Date.now(),
    source: "unavailable",
  };

  if (!JWT || !API_TOKEN) {
    cache.set(fixtureId, empty);
    return empty;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/odds/snapshot/${fixtureId}`, {
      headers: {
        Authorization: `Bearer ${JWT}`,
        "X-Api-Token": API_TOKEN,
        "Accept-Encoding": "deflate",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(String(res.status));
    const entries = (await res.json()) as RawOddsEntry[];

    // Full-game 1X2 only (MarketPeriod null/absent = full match).
    const fullGame = entries.find(
      (e) => e.SuperOddsType === "1X2_PARTICIPANT_RESULT" && !e.MarketPeriod,
    );
    if (!fullGame || fullGame.PriceNames.length !== 3) {
      cache.set(fixtureId, empty);
      return empty;
    }
    const pct = (name: string): number | null => {
      const i = fullGame.PriceNames.indexOf(name);
      const v = i >= 0 ? Number(fullGame.Pct[i]) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const result: ReferenceOdds = {
      fixtureId,
      homePct: pct("part1"),
      drawPct: pct("draw"),
      awayPct: pct("part2"),
      bookmaker: fullGame.Bookmaker,
      ts: fullGame.Ts,
      fetchedAt: Date.now(),
      source: "txline",
    };
    cache.set(fixtureId, result);
    return result;
  } catch {
    cache.set(fixtureId, empty);
    return empty;
  }
}
