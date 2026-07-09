// Phase 0 runner — the de-risking milestone.
//
// Proves the full TxLINE data path end to end:
//   1. Authenticate (3-step, or preset JWT+API token via env)
//   2. Pull a real stat-validation proof payload
//   3. Derive settlement inputs (epochDay, target ts, daily-roots PDA seed)
//   4. Persist a deterministic replay fixture for the demo + tests
//
// Usage (Bun):
//   cd onyx && bun run phase0
// Env: see .env.example. To skip on-chain subscribe, set TXLINE_JWT + TXLINE_API_TOKEN.
// Override the sample target with: FIXTURE_ID=..., SEQ=..., STAT_KEYS=...

import { activate, getGuestJwt, type AuthState } from "./auth";
import { getStatValidation } from "./scores";
import { buildFixture, saveFixture } from "./fixture";
import * as cfg from "./config";

// Sample target from the reference script (subscription_scores_1stat.ts).
const FIXTURE_ID = Number(process.env.FIXTURE_ID ?? "18179550");
const SEQ = Number(process.env.SEQ ?? "1315");
const STAT_KEYS = process.env.STAT_KEYS ?? "1";
const FIXTURE_OUT =
  process.env.FIXTURE_OUT ?? "fixtures/scores-validation.sample.json";

async function main() {
  console.log(`[phase0] network=${cfg.NETWORK} api=${cfg.API_BASE_URL}`);

  // Step 1 — auth. Prefer full activation; fall back to JWT-only if no wallet
  // is configured (still lets us prove step 1 + endpoint reachability).
  let state: AuthState;
  try {
    state = await activate();
    console.log(`[phase0] authenticated. apiToken len=${state.apiToken.length}`);
  } catch (e) {
    console.warn(
      `[phase0] full activation unavailable (${(e as Error).message}). ` +
        `Falling back to guest-JWT only — set TXLINE_API_TOKEN to fetch proofs.`,
    );
    state = { jwt: await getGuestJwt(), apiToken: cfg.PRESET_API_TOKEN ?? "" };
  }

  if (!state.apiToken) {
    console.log(
      "[phase0] no API token; step-1 auth reachability confirmed. Stopping before proof fetch.",
    );
    return;
  }

  // Step 2 — fetch a real proof payload.
  console.log(`[phase0] fetching stat-validation fixture=${FIXTURE_ID} seq=${SEQ} statKeys=${STAT_KEYS}`);
  const payload = await getStatValidation(state, FIXTURE_ID, SEQ, STAT_KEYS);

  // Step 3 — derive + report settlement inputs.
  const fixture = buildFixture(cfg.NETWORK, FIXTURE_ID, SEQ, STAT_KEYS, payload);
  console.log(
    `[phase0] derived targetTsMs=${fixture.targetTsMs} epochDay=${fixture.epochDay} ` +
      `stats=${payload.statsToProve?.length ?? 0}`,
  );

  // Step 4 — persist replay fixture.
  saveFixture(FIXTURE_OUT, fixture);
  console.log(`[phase0] wrote replay fixture -> ${FIXTURE_OUT}`);
  console.log("[phase0] OK");
}

main().catch((e) => {
  console.error("[phase0] FAILED:", e);
  process.exit(1);
});
