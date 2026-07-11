// Real TxLINE fixture metadata (competition, team names) — fetched live from
// TxLINE's /fixtures/snapshot on devnet (services/ingestion/src/
// fetch_fixture_meta.ts), not fabricated. TxLINE's fixtures/snapshot only
// serves a rolling window of current/upcoming fixtures, so older fixtures
// (like the one this build's captured settlement proof is pinned to) can
// age out of it — when that happens we honestly fall back to the fixture
// id instead of inventing a team name.
//
// This is a small static cache, not a live API integration, deliberately:
// adding a live TxLINE-authenticated call into the Next.js frontend is a
// new auth/failure-mode surface not worth taking on right before a demo
// recording, for data that (for the one fixture that matters, the real
// settleable one) isn't even currently retrievable anyway. Refresh this
// list with `bun run services/ingestion/src/fetch_fixture_meta.ts` any
// time you want to pull the current bundle.

export interface FixtureInfo {
  competition: string;
  participant1: string;
  participant2: string;
}

// [VERIFIED live 2026-07-09, re-verified live 2026-07-10 via TxLINE
//  /fixtures/snapshot — bundle window unchanged (6 fixtures, same set minus
//  18209181 which has since kicked off and rolled out of the window; kept
//  below since real team names don't stop being true just because the
//  endpoint stopped listing the fixture as "current"). Also checked: no
//  participant-ID -> name lookup endpoint exists anywhere in TxLINE's
//  documented surface, so fixture 18179550 (Participant1Id/Participant2Id
//  1575/1289 per /scores/snapshot) has no path to a real name right now —
//  not unresolved from lack of trying.]
export const KNOWN_FIXTURES_STATIC: Record<number, FixtureInfo> = {
  18209181: { competition: "World Cup", participant1: "France", participant2: "Morocco" },
  18213979: { competition: "World Cup", participant1: "Norway", participant2: "England" },
  18218149: { competition: "World Cup", participant1: "Spain", participant2: "Belgium" },
  18222446: { competition: "World Cup", participant1: "Argentina", participant2: "Switzerland" },
  18143850: { competition: "Friendlies", participant1: "Vietnam", participant2: "Myanmar" },
  18182808: { competition: "Friendlies", participant1: "Australia", participant2: "Brazil" },
  18182864: { competition: "Friendlies", participant1: "Australia", participant2: "Brazil" },
};

// Live overlay from TxLINE /fixtures/snapshot (via useLiveFixtures →
// primeLiveFixtures). The sync getters below prefer it, so every existing
// call site gets real, current team names the moment the live window loads —
// static table stays as the fallback for aged-out fixtures.
const LIVE_OVERLAY = new Map<number, { info: FixtureInfo; startTimeMs: number | null }>();

export function primeLiveFixtures(
  fixtures: { fixtureId: number; participant1: string; participant2: string; competition: string; startTimeMs: number | null }[] | undefined,
): void {
  for (const f of fixtures ?? []) {
    LIVE_OVERLAY.set(f.fixtureId, {
      info: { competition: f.competition, participant1: f.participant1, participant2: f.participant2 },
      startTimeMs: f.startTimeMs,
    });
  }
}

export function getFixtureInfo(fixtureId: number): FixtureInfo | null {
  return LIVE_OVERLAY.get(fixtureId)?.info ?? KNOWN_FIXTURES_STATIC[fixtureId] ?? null;
}

/** Display label for a fixture card heading — real match name when known, an honest fallback otherwise. */
export function fixtureDisplayName(fixtureId: number): string {
  const info = getFixtureInfo(fixtureId);
  if (info) return `${info.participant1} vs ${info.participant2}`;
  return `World Cup fixture #${fixtureId}`;
}

// Kickoff time (ms since epoch), verified live 2026-07-09 via TxLINE
// /scores/snapshot/{fixtureId} (StartTime field). Kept separate from
// KNOWN_FIXTURES because we know kickoff time for 18179550 even though its
// team names aged out of the /fixtures/snapshot window (see header comment)
// -- used by the live-scores API route to tell "upcoming" from
// "kicked off" without guessing.
export const KNOWN_START_TIMES_STATIC: Record<number, number> = {
  18179550: 1_782_936_000_000,
  18209181: 1_783_627_200_000,
  18213979: 1_783_803_600_000,
  18218149: 1_783_710_000_000,
  18222446: 1_783_818_000_000,
};

export function getFixtureStartTimeMs(fixtureId: number): number | null {
  return LIVE_OVERLAY.get(fixtureId)?.startTimeMs ?? KNOWN_START_TIMES_STATIC[fixtureId] ?? null;
}

/** Real, currently-upcoming World Cup fixtures with known team names — for the Create page's fixture picker. */
export function listUpcomingRealFixtures(): { fixtureId: number; info: FixtureInfo; startTimeMs: number | null }[] {
  return Object.entries(KNOWN_FIXTURES_STATIC)
    .filter(([, info]) => info.competition === "World Cup")
    .map(([id, info]) => ({ fixtureId: Number(id), info, startTimeMs: getFixtureStartTimeMs(Number(id)) }));
}
