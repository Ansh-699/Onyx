// Seed REAL trading activity across the live AMM markets — the "feels dead"
// fix, with the same honesty bar as everything else in this repo:
//
//   - Every price move is a REAL swap_amm from a REAL funded wallet, quoted
//     with the same lib/ammMath.ts math users get, min_out enforced on-chain.
//     No price is ever written directly; pools land wherever the flow puts
//     them (randomized two-sided order flow with a mild per-market lean).
//   - The demo wallet ends up with real positions (some winning, some not)
//     plus one settled WIN (real validate_stat proof, real redeem receipt)
//     and one settled LOSS (position honestly worth zero).
//   - Every swap/price sample is recorded to app/.data/price-history.json
//     with its transaction signature — the UI's history chart and trades
//     feed serve those real, explorer-verifiable records.
//   - Disclosed in-product: this is seeded market-making on devnet, same
//     disclosure treatment as the house counterparty.
//
// Keys: trader/demo keypairs persist under _keys/ (gitignored — verified
// never committed). The demo-wallet secret prints to the TERMINAL ONLY.
// No devnet SOL airdrops anywhere: SOL comes from the admin wallet by
// transfer; tUSDC from the mint authority we hold.
//
// Idempotent: wallets/markets are create-or-load; re-running adds more real
// trades on top. Run: cd app && bun scripts/seed_activity.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";

// Minimal base58 encoder (Phantom's import format) — avoids adding a dep.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  computeParamsHash,
  buildOpenMarketIx,
  buildCreateAmmPoolIx,
  buildOpenAmmPositionIx,
  buildDepositAmmIx,
  buildSwapAmmIx,
  buildRedeemAmmIx,
  buildSettleMarketIx,
  buildDelegateMarketIx,
  buildDelegateAmmPoolIx,
  buildDelegateAmmPositionIx,
  ammPoolPda,
  ammPositionPda,
  vaultPda,
  DELEGATION_PROGRAM_ID,
  SIDE_A,
  SIDE_B,
  SWAP_BUY,
  SWAP_SELL,
  type MarketTerms,
} from "../src/lib/instructions";
import { AMM_POOL, AMM_POSITION } from "../src/lib/layouts";
import { quoteBuy, quoteSell, minOutForTolerance, spotPriceScaled } from "../src/lib/ammMath";
import { OP_NONE, OP_ADD } from "../src/lib/statKeys";
import { getLiveFixtures } from "../src/lib/txlineFixtures";
import { getLiveSettlementProof } from "../src/lib/txlineSettlementProof";
import { KNOWN_FIXTURES_STATIC } from "../src/lib/fixtureMeta";
import { recordBatch, type PricePoint, type TradeRecord } from "../src/lib/priceHistory";

const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const base = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

const KEYS_DIR = join(process.cwd(), "..", "_keys");
const STATE_PATH = join(KEYS_DIR, "seed-state.json");
const CMP_GT = 0;
const FEE_BPS = 100;
const USD = 1_000_000n; // 6dp base units per tUSDC
const TOL_BPS = 300; // 3% slippage tolerance for seeded swaps (sequential, generous)

// deterministic-ish RNG so re-runs vary but stay reproducible per day
let rngState = Math.floor(Date.now() / 86_400_000);
const rng = () => {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
};
const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

const sigs: { label: string; sig: string }[] = [];
async function send(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  sigs.push({ label, sig });
  return sig;
}

// ---------- persisted wallets ----------
function loadOrCreateKeypairs(): { traders: Keypair[]; demo: Keypair } {
  mkdirSync(KEYS_DIR, { recursive: true });
  const tradersPath = join(KEYS_DIR, "traders.json");
  const demoPath = join(KEYS_DIR, "demo-wallet.json");
  let traders: Keypair[];
  if (existsSync(tradersPath)) {
    traders = (JSON.parse(readFileSync(tradersPath, "utf8")) as number[][]).map((s) => Keypair.fromSecretKey(Uint8Array.from(s)));
  } else {
    traders = Array.from({ length: 6 }, () => Keypair.generate());
    writeFileSync(tradersPath, JSON.stringify(traders.map((k) => Array.from(k.secretKey))), { mode: 0o600 });
  }
  let demo: Keypair;
  if (existsSync(demoPath)) {
    demo = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(demoPath, "utf8")) as number[]));
  } else {
    demo = Keypair.generate();
    writeFileSync(demoPath, JSON.stringify(Array.from(demo.secretKey)), { mode: 0o600 });
  }
  return { traders, demo };
}

interface SeedState {
  settledWin?: { market: string; fixtureId: number };
  settledLoss?: { market: string; fixtureId: number };
  deepMarkets?: string[];
}
const loadState = (): SeedState => (existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as SeedState) : {});
const saveState = (s: SeedState) => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

// ---------- on-chain reads ----------
const u64 = (d: Buffer, off: number) => d.readBigUInt64LE(off);
async function readPool(conn: Connection, pool: PublicKey) {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error(`pool ${pool.toBase58()} missing`);
  return {
    reserveA: u64(info.data, AMM_POOL.RESERVE_A),
    reserveB: u64(info.data, AMM_POOL.RESERVE_B),
    fees: u64(info.data, AMM_POOL.FEES_ACCRUED),
    feeBps: info.data.readUInt16LE(AMM_POOL.FEE_BPS),
  };
}
async function readPositionMaybe(conn: Connection, position: PublicKey) {
  const info = await conn.getAccountInfo(position);
  if (!info) return null;
  return {
    usdc: u64(info.data, AMM_POSITION.USDC_AVAILABLE),
    tokensA: u64(info.data, AMM_POSITION.TOKENS_A),
    tokensB: u64(info.data, AMM_POSITION.TOKENS_B),
    delegated: info.owner.equals(DELEGATION_PROGRAM_ID),
  };
}

async function erConnectionFor(account: PublicKey): Promise<Connection> {
  const res = await fetch("https://devnet-router.magicblock.app/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
  });
  const fqdn = ((await res.json()) as { result?: { fqdn?: string } })?.result?.fqdn;
  if (!fqdn) throw new Error(`${account.toBase58()} not delegated per router`);
  return new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");
}

// ---------- funding (idempotent; NO airdrops — admin transfer + owned mint only) ----------
async function ensureFunding(wallets: Keypair[], usdcMint: PublicKey, targetSol: number, targetUsdc: bigint) {
  const adminBal = await base.getBalance(admin.publicKey);
  console.log(`admin SOL balance: ${(adminBal / 1e9).toFixed(3)}`);
  for (const w of wallets) {
    const ixs: TransactionInstruction[] = [];
    const sol = await base.getBalance(w.publicKey);
    if (sol < targetSol * 0.6e9) {
      ixs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.publicKey, lamports: Math.floor(targetSol * 1e9) - sol }));
    }
    const ata = getAssociatedTokenAddressSync(usdcMint, w.publicKey);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, w.publicKey, usdcMint));
    const bal = await base.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
    if (bal < targetUsdc / 2n) ixs.push(createMintToInstruction(usdcMint, ata, admin.publicKey, targetUsdc - bal));
    if (ixs.length > 0) await send(base, [admin], ixs, `fund ${w.publicKey.toBase58().slice(0, 6)}`);
  }
}

// ---------- position lifecycle ----------
async function ensureDelegatedPosition(trader: Keypair, market: PublicKey, usdcMint: PublicKey, deposit: bigint): Promise<boolean> {
  const position = ammPositionPda(market, trader.publicKey);
  const existing = await readPositionMaybe(base, position);
  if (existing?.delegated) return true; // already trading on the ER
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
  if (!existing) ixs.push(buildOpenAmmPositionIx({ owner: trader.publicKey, market }).ix);
  if (!existing || existing.usdc < deposit / 2n) ixs.push(buildDepositAmmIx({ owner: trader.publicKey, market, amount: deposit, usdcMint }));
  ixs.push(buildDelegateAmmPositionIx({ payer: trader.publicKey, market, owner: trader.publicKey }));
  await send(base, [trader], ixs, `open+deposit+delegate position ${trader.publicKey.toBase58().slice(0, 6)} on ${market.toBase58().slice(0, 6)}`);
  return true;
}

async function ensureBasePosition(trader: Keypair, market: PublicKey, usdcMint: PublicKey, deposit: bigint) {
  const position = ammPositionPda(market, trader.publicKey);
  const existing = await readPositionMaybe(base, position);
  if (existing && existing.usdc >= deposit / 2n) return;
  const ixs: TransactionInstruction[] = [];
  if (!existing) ixs.push(buildOpenAmmPositionIx({ owner: trader.publicKey, market }).ix);
  ixs.push(buildDepositAmmIx({ owner: trader.publicKey, market, amount: deposit, usdcMint }));
  await send(base, [trader], ixs, `open+deposit (base) ${trader.publicKey.toBase58().slice(0, 6)} on ${market.toBase58().slice(0, 6)}`);
}

/** One real swap, quoted with the user-facing math, min_out enforced on-chain. Returns sig or null if quote impossible. */
async function realSwap(
  conn: Connection,
  trader: Keypair,
  market: PublicKey,
  pool: PublicKey,
  side: number,
  dir: number,
  amountIn: bigint,
): Promise<string | null> {
  const p = await readPool(conn, pool);
  const [rIn, rOut] = side === SIDE_A ? [p.reserveA, p.reserveB] : [p.reserveB, p.reserveA];
  let minOut: bigint;
  if (dir === SWAP_BUY) {
    const q = quoteBuy(rIn, rOut, amountIn, p.feeBps);
    if (!q) return null;
    minOut = minOutForTolerance(q.tokensOut, TOL_BPS);
  } else {
    const q = quoteSell(rIn, rOut, amountIn, p.feeBps);
    if (!q) return null;
    minOut = minOutForTolerance(q.netOut, TOL_BPS);
  }
  const ix = buildSwapAmmIx({ owner: trader.publicKey, market, side, direction: dir, amountIn, minOut });
  return send(conn, [trader], [ix], `swap ${dir === SWAP_BUY ? "buy" : "sell"} ${side === SIDE_A ? "A" : "B"} ${Number(amountIn) / 1e6}`);
}

// ---------- settled-receipt markets ----------
interface FinishedPick {
  fixtureId: number;
  name: string;
  stats: { key: number; value: number }[];
}
/** Find a finished, NAMED fixture TxLINE still has provable stats for. */
async function findFinishedFixture(): Promise<FinishedPick | null> {
  const live = await getLiveFixtures();
  const candidates: { fixtureId: number; name: string }[] = [];
  for (const f of live) {
    if (f.startTimeMs !== null && f.startTimeMs < Date.now() - 3 * 3600_000) {
      candidates.push({ fixtureId: f.fixtureId, name: `${f.participant1} vs ${f.participant2}` });
    }
  }
  for (const [id, info] of Object.entries(KNOWN_FIXTURES_STATIC)) {
    candidates.push({ fixtureId: Number(id), name: `${info.participant1} vs ${info.participant2}` });
  }
  for (const c of candidates) {
    // goals for both sides in one proof probe; corners as fallback stats
    const probe = await getLiveSettlementProof({ fixtureId: c.fixtureId, statAKey: 1, statBKey: 2 });
    if (probe.ok) {
      const stats = probe.fixture.payload.statsToProve.map((s) => ({ key: s.key, value: s.value }));
      return { fixtureId: c.fixtureId, name: c.name, stats };
    }
  }
  return null;
}

async function createTradeAndSettleReceiptMarket(opts: {
  label: "WIN" | "LOSS";
  fixtureId: number;
  statKey: number;
  finalValue: number;
  usdcMint: PublicKey;
  demo: Keypair;
  traders: Keypair[];
}): Promise<{ market: PublicKey; settleSig: string }> {
  const { label, fixtureId, statKey, finalValue, usdcMint, demo, traders } = opts;
  // WIN: threshold = final-1 → "stat > threshold" is TRUE → outcome SIDE_A.
  // LOSS: threshold = final → strict > is FALSE → outcome SIDE_B.
  const threshold = BigInt(label === "WIN" ? finalValue - 1 : finalValue);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const terms: MarketTerms = { fixtureId: BigInt(fixtureId), statAKey: statKey, statBKey: 0, op: OP_NONE, predicate: CMP_GT, threshold, deadline };
  const paramsHash = computeParamsHash(terms);
  const { ix: openIx, market } = buildOpenMarketIx({ creator: admin.publicKey, usdcMint, terms, paramsHash });
  const { ix: poolIx } = buildCreateAmmPoolIx({ creator: admin.publicKey, market, usdcMint, seedAmount: 300n * USD, feeBps: FEE_BPS });
  await send(base, [admin], [openIx, poolIx], `open ${label}-receipt market + 300 tUSDC pool`);
  console.log(`  ${label} market: ${market.toBase58()} (stat[${statKey}] > ${threshold}, final value ${finalValue})`);

  const pool = ammPoolPda(market);
  // Demo buys SIDE_A on both — TRUE market pays it, FALSE market zeroes it.
  await ensureBasePosition(demo, market, usdcMint, 25n * USD);
  await realSwap(base, demo, market, pool, SIDE_A, SWAP_BUY, 20n * USD);
  for (const t of traders.slice(0, 2)) {
    await ensureBasePosition(t, market, usdcMint, 20n * USD);
    await realSwap(base, t, market, pool, SIDE_B, SWAP_BUY, BigInt(randInt(8, 15)) * USD);
  }

  // Settle via the LIVE proof — same pipeline the UI's settle button uses.
  const proof = await getLiveSettlementProof({ fixtureId, statAKey: statKey, statBKey: 0 });
  if (!proof.ok) throw new Error(`live proof unavailable at settle time: ${proof.reason}`);
  const { ix: settleIx, computeIx } = buildSettleMarketIx({ submitter: admin.publicKey, market, fixture: proof.fixture, threshold, predicate: CMP_GT });
  let settleSig = "";
  for (let attempt = 1; attempt <= 5 && !settleSig; attempt++) {
    try {
      settleSig = await send(base, [admin], [computeIx, settleIx], `settle_market ${label} (LIVE validate_stat proof)`);
    } catch (e) {
      console.log(`  settle attempt ${attempt} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!settleSig) throw new Error(`settle ${label} failed after 5 attempts`);
  return { market, settleSig };
}

// ---------- main ----------
async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));
  const { traders, demo } = loadOrCreateKeypairs();
  const state = loadState();
  console.log(`traders: ${traders.map((t) => t.publicKey.toBase58().slice(0, 6)).join(", ")}`);
  console.log(`demo wallet: ${demo.publicKey.toBase58()}`);

  await ensureFunding([...traders, demo], usdcMint, 0.05, 300n * USD);
  // admin LP capital for the deep pools + receipt pools
  const adminAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
  await send(base, [admin], [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminAta, admin.publicKey, usdcMint),
    createMintToInstruction(usdcMint, adminAta, admin.publicKey, 2_000n * USD),
  ], "mint admin LP capital");

  // ---- discover active AMM markets (dual scan incl. delegated) ----
  const { listMarkets, getAmmPoolsForMarkets } = await import("../src/lib/onchain");
  const allMarkets = await listMarkets();
  const now = Math.floor(Date.now() / 1000);

  // ---- 2 extra DEEP markets on upcoming fixtures (distinct predicates) ----
  if (!state.deepMarkets || state.deepMarkets.length === 0) {
    const upcoming = (await getLiveFixtures()).filter((f) => f.competition === "World Cup" && f.startTimeMs !== null && f.startTimeMs > Date.now() + 30 * 60_000);
    const deepPlans = [
      { statAKey: 7, statBKey: 8, op: OP_ADD, threshold: 8n, blurb: "9+ total corners" },
      { statAKey: 3, statBKey: 4, op: OP_ADD, threshold: 3n, blurb: "4+ total yellow cards" },
    ];
    const created: string[] = [];
    for (const [i, plan] of deepPlans.entries()) {
      const f = upcoming[i % upcoming.length];
      if (!f) break;
      const terms: MarketTerms = {
        fixtureId: BigInt(f.fixtureId), statAKey: plan.statAKey, statBKey: plan.statBKey,
        op: plan.op, predicate: CMP_GT, threshold: plan.threshold, deadline: BigInt(Math.floor(f.startTimeMs! / 1000)),
      };
      const paramsHash = computeParamsHash(terms);
      const { ix: openIx, market } = buildOpenMarketIx({ creator: admin.publicKey, usdcMint, terms, paramsHash });
      if (await base.getAccountInfo(market)) { created.push(market.toBase58()); continue; }
      const { ix: poolIx } = buildCreateAmmPoolIx({ creator: admin.publicKey, market, usdcMint, seedAmount: 400n * USD, feeBps: FEE_BPS });
      await send(base, [admin], [openIx, poolIx], `DEEP market: ${f.participant1} vs ${f.participant2} — ${plan.blurb} (400 tUSDC pool)`);
      await send(base, [admin], [
        buildDelegateMarketIx({ payer: admin.publicKey, market }),
        buildDelegateAmmPoolIx({ payer: admin.publicKey, market }),
      ], "delegate deep market + pool to ER");
      created.push(market.toBase58());
      console.log(`DEEP: ${f.participant1} vs ${f.participant2} — ${plan.blurb} → ${market.toBase58()}`);
    }
    state.deepMarkets = created;
    saveState(state);
  }

  // refresh market list to include the deep markets
  const markets = (await listMarkets())
    .filter((m) => Number(m.deadline) > now && (m.status === 0 || m.status === 1))
    // dual-scan can briefly return a just-delegated market from both scans
    .filter((m, i, arr) => arr.findIndex((x) => x.pda === m.pda) === i);
  const pools = await getAmmPoolsForMarkets(markets.map((m) => m.pda));
  const active = markets.filter((m) => pools.get(m.pda)?.delegated);
  if (active.length === 0) throw new Error("no active delegated AMM markets to trade on");
  console.log(`\nactive ER markets: ${active.length}`);

  const er = await erConnectionFor(ammPoolPda(new PublicKey(active[0]!.pda)));

  // ---- organic two-sided trading on every active market ----
  const leans = [0.62, 0.4, 0.55, 0.68, 0.35, 0.5];
  for (const [mi, m] of active.entries()) {
    const market = new PublicKey(m.pda);
    const pool = ammPoolPda(market);
    const lean = leans[mi % leans.length]!;
    const participants = [...traders].sort(() => rng() - 0.5).slice(0, 4);
    console.log(`\n--- market ${m.pda.slice(0, 8)} (lean YES ${Math.round(lean * 100)}%) ---`);
    for (const t of participants) await ensureDelegatedPosition(t, market, usdcMint, BigInt(randInt(30, 70)) * USD);

    const points: PricePoint[] = [];
    const tradeRecs: TradeRecord[] = [];
    const rounds = randInt(12, 18);
    for (let r = 0; r < rounds; r++) {
      const t = pick(participants);
      const position = ammPositionPda(market, t.publicKey);
      const pos = await readPositionMaybe(er, position);
      if (!pos) continue;
      const side = rng() < lean ? SIDE_A : SIDE_B;
      const held = side === SIDE_A ? pos.tokensA : pos.tokensB;
      const wantSell = rng() < 0.22 && held > 3n * USD;
      const dir = wantSell ? SWAP_SELL : SWAP_BUY;
      const amountIn = dir === SWAP_BUY
        ? BigInt(randInt(2, 12)) * USD
        : held / BigInt(randInt(2, 4));
      if (dir === SWAP_BUY && pos.usdc < amountIn) continue;
      try {
        const sig = await realSwap(er, t, market, pool, side, dir, amountIn);
        if (!sig) continue;
        const p = await readPool(er, pool);
        points.push({ t: Date.now(), priceA: Number(spotPriceScaled(p.reserveA, p.reserveB)), fees: p.fees.toString() });
        tradeRecs.push({ t: Date.now(), side, dir, amountIn: amountIn.toString(), sig });
      } catch (e) {
        console.log(`  swap skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }
    }
    recordBatch(pool.toBase58(), points, tradeRecs);
    const p = await readPool(er, pool);
    console.log(`  final: YES ${(Number(spotPriceScaled(p.reserveA, p.reserveB)) / 10_000).toFixed(1)}¢ · reserves ${Number(p.reserveA) / 1e6}/${Number(p.reserveB) / 1e6} · fees ${Number(p.fees) / 1e6}`);
  }

  // ---- demo wallet takes real positions on 3 active markets ----
  console.log("\n--- demo wallet positions ---");
  for (const [i, m] of active.slice(0, 3).entries()) {
    const market = new PublicKey(m.pda);
    const pool = ammPoolPda(market);
    await ensureDelegatedPosition(demo, market, usdcMint, 40n * USD);
    // one with the lean (should sit in profit), one against (honest loss), one mixed
    const side = i === 1 ? SIDE_B : SIDE_A;
    try {
      const demoPos = await readPositionMaybe(er, ammPositionPda(market, demo.publicKey));
      const budget = demoPos ? demoPos.usdc / USD : 0n;
      if (budget < 3n) continue;
      const spend = BigInt(Math.min(randInt(10, 25), Number(budget) - 1));
      const sig = await realSwap(er, demo, market, pool, side, SWAP_BUY, spend * USD);
      if (sig) {
        const p = await readPool(er, pool);
        recordBatch(pool.toBase58(), [{ t: Date.now(), priceA: Number(spotPriceScaled(p.reserveA, p.reserveB)), fees: p.fees.toString() }], [{ t: Date.now(), side, dir: SWAP_BUY, amountIn: "0", sig }]);
      }
    } catch (e) {
      console.log(`  demo swap skipped: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
    }
  }

  // ---- settled WIN + LOSS receipt markets ----
  if (!state.settledWin || !state.settledLoss) {
    console.log("\n--- settled receipt markets (real validate_stat settlement) ---");
    const finished = await findFinishedFixture();
    if (!finished) {
      console.log("!! no finished fixture with provable stats found — skipping settled receipts (honest: nothing faked)");
    } else {
      console.log(`finished fixture: ${finished.name} (#${finished.fixtureId}) — stats ${JSON.stringify(finished.stats)}`);
      const winStat = finished.stats.find((s) => s.value >= 1) ?? finished.stats[0]!;
      const lossStat = finished.stats[0]!;
      if (!state.settledWin) {
        const { market, settleSig } = await createTradeAndSettleReceiptMarket({
          label: "WIN", fixtureId: finished.fixtureId, statKey: winStat.key, finalValue: winStat.value, usdcMint, demo, traders,
        });
        // demo redeems: real settlement receipt + P&L
        await send(base, [demo], [buildRedeemAmmIx({ owner: demo.publicKey, market, usdcMint })], "demo redeem_amm (WIN receipt)");
        state.settledWin = { market: market.toBase58(), fixtureId: finished.fixtureId };
        saveState(state);
        console.log(`  WIN settled ${settleSig}`);
      }
      if (!state.settledLoss) {
        const { market, settleSig } = await createTradeAndSettleReceiptMarket({
          label: "LOSS", fixtureId: finished.fixtureId, statKey: lossStat.key, finalValue: lossStat.value, usdcMint, demo, traders,
        });
        // winners (the traders on side B) redeem — proves payouts flow; demo's side-A position is honestly worthless
        for (const t of traders.slice(0, 2)) {
          try { await send(base, [t], [buildRedeemAmmIx({ owner: t.publicKey, market, usdcMint })], "trader redeem (LOSS market winner)"); } catch { /* nothing to redeem */ }
        }
        state.settledLoss = { market: market.toBase58(), fixtureId: finished.fixtureId };
        saveState(state);
        console.log(`  LOSS settled ${settleSig}`);
      }
    }
  }

  // ---- final report ----
  console.log("\n===================== ON-CHAIN RESULTS =====================");
  const finalMarkets = (await listMarkets()).filter((m) => (Number(m.deadline) > now && (m.status === 0 || m.status === 1)) || [state.settledWin?.market, state.settledLoss?.market].includes(m.pda));
  for (const m of finalMarkets) {
    const market = new PublicKey(m.pda);
    const pool = ammPoolPda(market);
    const poolInfo = await base.getAccountInfo(pool);
    if (!poolInfo) continue;
    const conn = poolInfo.owner.equals(DELEGATION_PROGRAM_ID) ? er : base;
    const p = await readPool(conn, pool);
    const custody = await base.getTokenAccountBalance(vaultPda(market)).then((r) => Number(r.value.amount) / 1e6).catch(() => 0);
    const priceA = Number(spotPriceScaled(p.reserveA, p.reserveB)) / 10_000;
    const vol = (Number(p.fees) / 1e6) * (10_000 / p.feeBps);
    console.log(`${m.pda}  YES ${priceA.toFixed(1)}¢ | reserves ${(Number(p.reserveA) / 1e6).toFixed(1)}/${(Number(p.reserveB) / 1e6).toFixed(1)} | custody ${custody.toFixed(1)} tUSDC | volume≈${vol.toFixed(1)} tUSDC | status ${m.status}`);
  }
  console.log("\ndemo wallet positions:");
  for (const m of finalMarkets) {
    const market = new PublicKey(m.pda);
    const position = ammPositionPda(market, demo.publicKey);
    const info = await base.getAccountInfo(position);
    if (!info) continue;
    const conn = info.owner.equals(DELEGATION_PROGRAM_ID) ? er : base;
    const pos = await readPositionMaybe(conn, position);
    if (pos) console.log(`  ${m.pda.slice(0, 8)}: usdc ${Number(pos.usdc) / 1e6} | A ${Number(pos.tokensA) / 1e6} | B ${Number(pos.tokensB) / 1e6}${pos.delegated ? " (on ER)" : ""}`);
  }

  console.log("\nkey signatures (explorer: https://explorer.solana.com/tx/<sig>?cluster=devnet):");
  for (const s of sigs.filter((x) => x.label.includes("settle") || x.label.includes("redeem") || x.label.includes("DEEP"))) {
    console.log(`  ${s.label}: ${s.sig}`);
  }
  const sampleSwaps = sigs.filter((x) => x.label.startsWith("swap")).slice(-3);
  for (const s of sampleSwaps) console.log(`  ${s.label}: ${s.sig}`);

  console.log("\n===================== DEMO WALLET IMPORT (terminal only — never committed) =====================");
  console.log(`address: ${demo.publicKey.toBase58()}`);
  console.log(`secret (base58, Phantom → Settings → Manage Accounts → Import Private Key):`);
  console.log(bs58encode(demo.secretKey));
}

main().catch((e) => { console.error(e); process.exit(1); });
