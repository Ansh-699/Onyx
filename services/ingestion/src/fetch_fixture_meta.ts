// Fetch real TxLINE fixture metadata (team names, competition) for the
// World Cup free-tier bundle, and print it in the exact shape
// app/src/lib/fixtureMeta.ts expects -- so that file's KNOWN_FIXTURES table
// can be refreshed by hand whenever the bundle's current fixture window
// moves. Read-only against TxLINE; does not touch the ONYX program.
//
// TxLINE's /fixtures/snapshot serves a rolling window of current/upcoming
// fixtures (per the reference docs: "Get all fixtures for a specific
// competition or all competitions"), no fixture-id lookup endpoint exists,
// so an older fixture (like the one this build's captured settlement proof
// is pinned to) can age out of it entirely -- this script will simply not
// find it if so, and that's the honest, correct behavior.
//
// Usage: cd onyx && bun run services/ingestion/src/fetch_fixture_meta.ts
//        TARGET_FIXTURE_ID=18179550 bun run services/ingestion/src/fetch_fixture_meta.ts

import { activate, apiGet, type AuthState } from "./auth";

const TARGET_FIXTURE_ID = process.env.TARGET_FIXTURE_ID ? Number(process.env.TARGET_FIXTURE_ID) : undefined;

interface RawFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  Participant1IsHome?: boolean;
  Competition?: string;
  CompetitionId?: number;
  StartTime?: number;
}

async function main() {
  const state: AuthState = await activate();
  console.log("[meta] authenticated");

  // No params = every fixture currently visible in this bundle (World Cup +
  // International Friendlies, per the free-tier docs).
  const fixtures = await apiGet<RawFixture[]>("/fixtures/snapshot", state);
  console.log(`[meta] ${fixtures.length} fixtures currently in the bundle window`);

  if (TARGET_FIXTURE_ID) {
    const target = fixtures.find((f) => f.FixtureId === TARGET_FIXTURE_ID);
    if (target) {
      console.log(`[meta] FOUND fixture ${TARGET_FIXTURE_ID}:`, JSON.stringify(target, null, 2));
    } else {
      console.log(`[meta] fixture ${TARGET_FIXTURE_ID} is NOT in the current bundle window (likely aged out).`);
    }
    return;
  }

  console.log("\n// Paste into app/src/lib/fixtureMeta.ts KNOWN_FIXTURES:");
  for (const f of fixtures) {
    console.log(
      `  ${f.FixtureId}: { competition: ${JSON.stringify(f.Competition ?? "World Cup")}, participant1: ${JSON.stringify(f.Participant1)}, participant2: ${JSON.stringify(f.Participant2)} },`,
    );
  }
}

main().catch((e) => {
  console.error("[meta] FAILED:", e);
  process.exit(1);
});
