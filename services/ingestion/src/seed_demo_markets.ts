// Seeds a varied, real set of on-chain ONYX markets for the demo lobby.
//
// Frontend/presentation task, not a program change: every market here is
// opened via the existing, unmodified `open_market_sealed` instruction
// (app/src/lib/instructions.ts). Two fixture groups:
//
//   1. fixtureId 18179550 -- the one fixture with a real captured
//      validate_stat proof already in this repo (fixtures/scores-validation
//      .sample.json). A fresh live pull (2026-07-09) of that fixture's full
//      stat line at its final simulated seq (1316) gives us real, richer
//      values beyond the single P1-goals=3 this repo already settles
//      against: P1 goals=3, P2 goals=2, P1 corners=4, P2 corners=2, P1
//      yellow=1, P2 yellow=1. That lets us open several genuinely distinct,
//      correctly-labeled predicates on the SAME real, settleable fixture
//      without touching the existing settled/claimed markets or
//      buildSettleMarketIx.
//   2. Two more real, currently-upcoming World Cup fixtures pulled live from
//      TxLINE's /fixtures/snapshot (competitionId=72) -- real team names,
//      kickoff still in the future, all stats at 0. These open as ordinary
//      pre-match markets; nothing to settle yet, which is the correct,
//      honest state for a fixture that hasn't kicked off.
//
// NOTE: "both teams to score" was requested but is deliberately NOT
// included -- ONYX's predicate schema is a single linear comparison
// (statA [ADD|SUBTRACT] statB) [GT|LT|EQ] threshold. BTTS needs a logical
// AND of two independent conditions (P1>0 AND P2>0), which has no
// representation in that schema (no MIN/AND op exists on-chain). Faking it
// off-chain would misrepresent what settle_market actually verifies, which
// is exactly what this project's whole pitch argues against.
//
// Usage: cd onyx && bun run services/ingestion/src/seed_demo_markets.ts

import { readFileSync } from "node:fs";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as cfg from "./config";
import {
  buildOpenMarketSealedIx,
  computeParamsHash,
  OP_NONE,
  CMP_GREATER_THAN,
  type MarketTerms,
} from "../../../app/src/lib/instructions";
import { getConfigUsdcMint } from "../../../app/src/lib/onchain";

const OP_ADD = 0;

interface Seed {
  label: string;
  fixtureId: number;
  statAKey: number;
  statBKey: number;
  op: number;
  threshold: bigint;
}

// fixtureId 18179550 real stat line, captured live 2026-07-09 at maxSeq=1316
// (P1 goals=3, P2 goals=2, P1 corners=4, P2 corners=2) -- used only to
// choose thresholds that read naturally; settlement of these still requires
// its own captured proof + buildSettleMarketIx support for combined stats,
// which is unchanged/out of scope here. These open as real Open markets.
const SEEDS: Seed[] = [
  { label: "Total goals over 1.5 (18179550)", fixtureId: 18179550, statAKey: 1, statBKey: 2, op: OP_ADD, threshold: 1n },
  { label: "Total goals over 2.5 (18179550, combined)", fixtureId: 18179550, statAKey: 1, statBKey: 2, op: OP_ADD, threshold: 2n },
  { label: "Total goals over 3.5 (18179550)", fixtureId: 18179550, statAKey: 1, statBKey: 2, op: OP_ADD, threshold: 3n },
  { label: "P1 goals over 1.5 (18179550)", fixtureId: 18179550, statAKey: 1, statBKey: 0, op: OP_NONE, threshold: 1n },
  { label: "P2 goals over 1.5 (18179550)", fixtureId: 18179550, statAKey: 2, statBKey: 0, op: OP_NONE, threshold: 1n },
  { label: "Total corners over 8.5 (18179550)", fixtureId: 18179550, statAKey: 7, statBKey: 8, op: OP_ADD, threshold: 8n },
  // Real, currently-upcoming fixtures (verified live via /fixtures/snapshot,
  // competitionId=72) -- pre-match markets, all stats 0 until kickoff.
  { label: "Total goals over 2.5 (France vs Morocco, 18209181)", fixtureId: 18209181, statAKey: 1, statBKey: 2, op: OP_ADD, threshold: 2n },
  { label: "Total goals over 2.5 (Spain vs Belgium, 18218149)", fixtureId: 18218149, statAKey: 1, statBKey: 2, op: OP_ADD, threshold: 2n },
];

async function main() {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));
  const connection = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
  const usdcMint = await getConfigUsdcMint();
  if (!usdcMint) throw new Error("ONYX config not initialized on devnet (run l0_loop_test.ts first)");
  console.log(`[seed] admin=${admin.publicKey.toBase58()} usdcMint=${usdcMint.toBase58()}`);

  for (const seed of SEEDS) {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const commitEndTs = nowSec + 180n;
    const revealEndTs = commitEndTs + 180n;
    const deadline = revealEndTs + 900n;

    const terms: MarketTerms = {
      fixtureId: BigInt(seed.fixtureId),
      statAKey: seed.statAKey,
      statBKey: seed.statBKey,
      op: seed.op,
      predicate: CMP_GREATER_THAN,
      threshold: seed.threshold,
      deadline,
    };
    const paramsHash = computeParamsHash(terms);
    const { ix, market } = buildOpenMarketSealedIx({
      creator: admin.publicKey,
      usdcMint,
      terms,
      paramsHash,
      commitEndTs,
      revealEndTs,
    });

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction();
      tx.add(ix);
      tx.recentBlockhash = blockhash;
      tx.feePayer = admin.publicKey;
      const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
      console.log(`[seed] OK  ${seed.label}\n       market=${market.toBase58()} sig=${sig}`);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes("already in use") || msg.includes("0x0")) {
        console.log(`[seed] SKIP ${seed.label} -- market ${market.toBase58()} already exists`);
      } else {
        console.log(`[seed] FAIL ${seed.label}: ${msg}`);
      }
    }
  }
}

main().catch((e) => {
  console.error("[seed] FATAL", e);
  process.exit(1);
});
