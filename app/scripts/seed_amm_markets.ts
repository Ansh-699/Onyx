// Seed the v2 lobby: fresh AMM markets on the LIVE TxLINE fixture window,
// each pre-delegated (market + pool) to the Ephemeral Rollup so a user's
// "Start session" is one signature and every swap lands on the ER
// immediately. Re-runnable: existing markets are skipped.
//
// Deadline = fixture kickoff (trading closes when the match starts); the
// admin wallet is the LP for every seeded pool (LP risk is real, disclosed).
//
// Run: cd app && bun scripts/seed_amm_markets.ts

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildDelegateMarketIx, delegateBufferPda, delegationRecordPda, delegationMetadataPda, DELEGATION_PROGRAM_ID } from "../src/lib/instructions";
import { getLiveFixtures } from "../src/lib/txlineFixtures";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

// 25 tUSDC per pool: deep enough that a judge's ~0.5 tUSDC trade moves the
// price ~1¢ (feels like a market), shallow enough the LP-risk story stays
// visible. We control the devnet mint, so depth is free.
const LP_SEED = 25_000_000n;
const FEE_BPS = 100;
const OP_NONE = 0xff, OP_ADD = 0;
const CMP_GT = 0;
const IX = { OPEN_MARKET: 1, CREATE_POOL: 29, DELEGATE_POOL: 32 };

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };

// Market templates per fixture: [statA, statB, op, predicate, threshold, blurb]
// statKeys: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (P1/P2).
const TEMPLATES: Array<{ statA: number; statB: number; op: number; predicate: number; threshold: bigint; blurb: (p1: string, p2: string) => string }> = [
  { statA: 1, statB: 0, op: OP_NONE, predicate: CMP_GT, threshold: 1n, blurb: (p1) => `${p1} scores 2+ goals` },
  { statA: 2, statB: 0, op: OP_NONE, predicate: CMP_GT, threshold: 0n, blurb: (_1, p2) => `${p2} scores at least once` },
  { statA: 7, statB: 8, op: OP_ADD, predicate: CMP_GT, threshold: 8n, blurb: () => `9+ total corners` },
  { statA: 3, statB: 4, op: OP_ADD, predicate: CMP_GT, threshold: 3n, blurb: () => `4+ total yellow cards` },
];

async function send(signers: Keypair[], ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const bh = await base.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  console.log(`  [${label}] ${sig}`);
  return sig;
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));
  const adminAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);

  const fixtures = (await getLiveFixtures()).filter(
    (f) => f.competition === "World Cup" && f.startTimeMs !== null && f.startTimeMs > Date.now() + 30 * 60_000,
  );
  if (fixtures.length === 0) throw new Error("no upcoming World Cup fixtures in the live window");
  console.log(`upcoming fixtures: ${fixtures.map((f) => `${f.participant1} vs ${f.participant2} (#${f.fixtureId})`).join(", ")}`);

  // 2 templates per fixture, round-robin, capped at 8 markets total.
  const plans: Array<{ fixtureId: number; p1: string; p2: string; startMs: number; t: (typeof TEMPLATES)[number] }> = [];
  for (const [fi, f] of fixtures.entries()) {
    for (let ti = 0; ti < 2; ti++) {
      const t = TEMPLATES[(fi + ti) % TEMPLATES.length]!;
      plans.push({ fixtureId: f.fixtureId, p1: f.participant1, p2: f.participant2, startMs: f.startTimeMs!, t });
    }
  }
  const capped = plans.slice(0, 8);

  // Fund the admin LP ATA once for all pools.
  await send([admin], [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, usdcMint),
    createMintToInstruction(usdcMint, adminAta, admin.publicKey, LP_SEED * BigInt(capped.length)),
  ], `mint ${(LP_SEED * BigInt(capped.length)) / 1_000_000n} tUSDC LP capital to admin`);

  const created: string[] = [];
  for (const plan of capped) {
    const deadline = BigInt(Math.floor(plan.startMs / 1000)); // trading closes at kickoff
    const { statA, statB, op, predicate, threshold } = plan.t;
    const paramsHash = sha256(u64le(BigInt(plan.fixtureId)), u32le(statA), u32le(statB), Buffer.from([op]), Buffer.from([predicate]), i64le(threshold), i64le(deadline));
    const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), u64le(BigInt(plan.fixtureId)), paramsHash], ONYX);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);
    const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm"), market.toBuffer()], ONYX);

    const label = `${plan.p1} vs ${plan.p2}: ${plan.t.blurb(plan.p1, plan.p2)}`;
    if (await base.getAccountInfo(market)) {
      console.log(`SKIP (exists): ${label} — ${market.toBase58()}`);
      continue;
    }
    console.log(`CREATE: ${label}`);

    await send([admin], [
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPda, isSigner: false, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([IX.OPEN_MARKET]), u64le(BigInt(plan.fixtureId)), u32le(statA), u32le(statB), Buffer.from([op]), Buffer.from([predicate]), i64le(threshold), i64le(deadline), paramsHash]),
      }),
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: pool, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: adminAta, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([IX.CREATE_POOL]), u64le(LP_SEED), u16le(FEE_BPS)]),
      }),
    ], "open_market + create_amm_pool");

    // Pre-delegate market + pool: users' Start-session tx then only needs to
    // delegate their own position — every seeded market is ER-ready.
    await send([admin], [
      buildDelegateMarketIx({ payer: admin.publicKey, market }),
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: pool, isSigner: false, isWritable: true },
          { pubkey: ONYX, isSigner: false, isWritable: false },
          { pubkey: delegateBufferPda(pool), isSigner: false, isWritable: true },
          { pubkey: delegationRecordPda(pool), isSigner: false, isWritable: true },
          { pubkey: delegationMetadataPda(pool), isSigner: false, isWritable: true },
          { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([IX.DELEGATE_POOL]), u32le(0xffffffff)]),
      }),
    ], "delegate market + pool to ER");

    created.push(`${label} — ${market.toBase58()}`);
  }

  console.log(`\n===== SEEDED ${created.length} ER-READY AMM MARKETS =====`);
  for (const c of created) console.log(`  ${c}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
