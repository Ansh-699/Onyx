// AMM Phase B devnet proof (docs/AMM_TRADING_DESIGN.md §5 row B): the full
// base-layer AMM lifecycle against the freshly UPGRADED program, with the §1
// solvency identity reconciled to the lamport at TWO standalone checkpoints
// -- mid-lifecycle (after all swaps) and final post-redemption (vault must
// drain to EXACTLY zero). The checkpoints are explicit assertions that make
// the script exit non-zero on any mismatch; the script finishing is not the
// proof, the assertions are.
//
// Also proves, en route:
//  - every swap's min_out is set to the EXACT expected output computed
//    off-chain with mirrored CPMM math -- if the on-chain math diverged from
//    the client quote engine by even one unit, the swap would revert with
//    SlippageExceeded (this is the Phase D quote-engine pre-check);
//  - one DELIBERATE slippage revert (min_out = expected+1) landing on-chain
//    as Custom(6026) -- the guard is real, not advisory;
//  - settlement via the LIVE TxLINE proof pipeline (getLiveSettlementProof),
//    not the bundled demo capture.
//
// Usage: cd app && bun scripts/amm_base_lifecycle.ts
// (app/ cwd matters: bun auto-loads app/.env.local for TXLINE_JWT/API_TOKEN)

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildSettleMarketIx } from "../src/lib/instructions";
import { getLiveSettlementProof } from "../src/lib/txlineSettlementProof";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));

// ---- market terms: same live-settleable fixture/stat the settlement
// pipeline has already proven (fixture 18179550, stat 1 > 2 -> Side A wins,
// deterministic), but settled via the LIVE fetch below, never the bundled
// capture. Deadline differs every run => unique params_hash => fresh market.
const FIXTURE_ID = 18179550n;
const STAT_A = 1;
const THRESHOLD = 2n;
const PREDICATE = 0; // GT

// ---- amounts (6dp tUSDC) ----
const LP_SEED = 1_000_000n; // 1.0 tUSDC pool seed -> reserves (1e6, 1e6)
const FEE_BPS = 100; // 1%
const ALICE_DEPOSIT = 400_000n;
const BOB_DEPOSIT = 400_000n;
const TOTAL_DEPOSITED = LP_SEED + ALICE_DEPOSIT + BOB_DEPOSIT;

const SIDE_A = 1, SIDE_B = 2, SWAP_BUY = 0, SWAP_SELL = 1;
const IX = { OPEN_MARKET: 1, CREATE_POOL: 29, OPEN_POSITION: 30, DEPOSIT: 31, SWAP: 34, REDEEM: 35, WITHDRAW_LP: 36 };

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };
const fmt = (n: bigint) => `${(Number(n) / 1e6).toFixed(6)} tUSDC (${n})`;

const sigs: { label: string; sig: string }[] = [];

async function send(signers: Keypair[], ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const bh = await base.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  console.log(`[${label}] OK ${sig}`);
  sigs.push({ label, sig });
  return sig;
}

/** Send a tx we EXPECT to fail on-chain with the given custom error code. */
async function sendExpectCustomError(signers: Keypair[], ixs: TransactionInstruction[], code: number, label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const bh = await base.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  const err = conf.value.err as any;
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom !== code) {
    throw new Error(`${label}: expected on-chain Custom(${code}), got ${JSON.stringify(err)} sig=${sig}`);
  }
  console.log(`[${label}] REVERTED AS EXPECTED Custom(${code}) ${sig}`);
  sigs.push({ label: `${label} (expected revert)`, sig });
  return sig;
}

// ---- mirrored CPMM math (must match fpmm.rs exactly; all BigInt) ----
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length + 1) / 2n);
  for (;;) { const next = (x + n / x) / 2n; if (next >= x) break; x = next; }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}
const calcFee = (amount: bigint, feeBps: bigint) => (amount * feeBps) / 10_000n;
function calcBuy(reserveBuy: bigint, reserveOther: bigint, netIn: bigint) {
  const ending = ceilDiv(reserveBuy * reserveOther, reserveOther + netIn);
  return { tokensOut: reserveBuy + netIn - ending, newReserveBuy: ending, newReserveOther: reserveOther + netIn };
}
function calcSell(reserveSell: bigint, reserveOther: bigint, tokensIn: bigint) {
  const s = reserveSell + reserveOther + tokensIn;
  const m = (s - isqrt(s * s - 4n * reserveOther * tokensIn)) / 2n;
  return { gross: m, newReserveSell: reserveSell + tokensIn - m, newReserveOther: reserveOther - m };
}

// Off-chain simulated pool/position state, advanced in lockstep with every
// on-chain swap -- checkpoint 1 asserts the REAL on-chain state equals this
// simulation EXACTLY, which retroactively proves every individual swap's
// on-chain result matched the mirrored math.
const sim = {
  reserveA: LP_SEED, reserveB: LP_SEED, sets: LP_SEED, fees: 0n,
  pos: { alice: { usdc: 0n, ta: 0n, tb: 0n }, bob: { usdc: 0n, ta: 0n, tb: 0n } },
};
function simBuy(who: "alice" | "bob", side: number, amountIn: bigint): bigint {
  const fee = calcFee(amountIn, BigInt(FEE_BPS));
  const net = amountIn - fee;
  const r = side === SIDE_A ? calcBuy(sim.reserveA, sim.reserveB, net) : calcBuy(sim.reserveB, sim.reserveA, net);
  if (side === SIDE_A) { sim.reserveA = r.newReserveBuy; sim.reserveB = r.newReserveOther; sim.pos[who].ta += r.tokensOut; }
  else { sim.reserveB = r.newReserveBuy; sim.reserveA = r.newReserveOther; sim.pos[who].tb += r.tokensOut; }
  sim.pos[who].usdc -= amountIn;
  sim.sets += net;
  sim.fees += fee;
  return r.tokensOut;
}
function simSell(who: "alice" | "bob", side: number, tokensIn: bigint): bigint {
  const r = side === SIDE_A ? calcSell(sim.reserveA, sim.reserveB, tokensIn) : calcSell(sim.reserveB, sim.reserveA, tokensIn);
  const fee = calcFee(r.gross, BigInt(FEE_BPS));
  const netOut = r.gross - fee;
  if (side === SIDE_A) { sim.reserveA = r.newReserveSell; sim.reserveB = r.newReserveOther; sim.pos[who].ta -= tokensIn; }
  else { sim.reserveB = r.newReserveSell; sim.reserveA = r.newReserveOther; sim.pos[who].tb -= tokensIn; }
  sim.pos[who].usdc += netOut;
  sim.sets -= r.gross;
  sim.fees += fee;
  return netOut;
}

// ---- on-chain readers ----
const readU64 = (data: Buffer, off: number) => data.readBigUInt64LE(off);
async function readPool(pool: PublicKey) {
  const info = await base.getAccountInfo(pool);
  if (!info) throw new Error("pool account missing");
  return { reserveA: readU64(info.data, 72), reserveB: readU64(info.data, 80), sets: readU64(info.data, 88), fees: readU64(info.data, 96) };
}
async function readPosition(position: PublicKey) {
  const info = await base.getAccountInfo(position);
  if (!info) throw new Error("position account missing");
  return { usdc: readU64(info.data, 72), ta: readU64(info.data, 80), tb: readU64(info.data, 88), withdrawn: readU64(info.data, 96) };
}
async function vaultBalance(vault: PublicKey): Promise<bigint> {
  const r = await base.getTokenAccountBalance(vault);
  return BigInt(r.value.amount);
}
async function ataBalance(ata: PublicKey): Promise<bigint> {
  try { const r = await base.getTokenAccountBalance(ata); return BigInt(r.value.amount); } catch { return 0n; }
}

function assertEq(actual: bigint, expected: bigint, what: string) {
  if (actual !== expected) throw new Error(`SOLVENCY ASSERTION FAILED: ${what}: actual=${actual} expected=${expected} (diff ${actual - expected})`);
  console.log(`  ASSERT OK  ${what}: ${actual}`);
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  // ---- wallets: creator/LP + alice + bob, fresh every run ----
  const lp = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate();
  const wallets: [string, Keypair][] = [["lp", lp], ["alice", alice], ["bob", bob]];
  const atas = Object.fromEntries(wallets.map(([n, w]) => [n, getAssociatedTokenAddressSync(usdcMint, w.publicKey)])) as Record<string, PublicKey>;
  {
    const fund = wallets.map(([, w]) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.publicKey, lamports: 30_000_000 }));
    await send([admin], fund, "fund 3 wallets with SOL");
    const mintAmounts: Record<string, bigint> = { lp: LP_SEED, alice: ALICE_DEPOSIT, bob: BOB_DEPOSIT };
    const ataIxs = wallets.flatMap(([n, w]) => [
      createAssociatedTokenAccountInstruction(admin.publicKey, atas[n]!, w.publicKey, usdcMint),
      createMintToInstruction(usdcMint, atas[n]!, admin.publicKey, mintAmounts[n]!),
    ]);
    await send([admin], ataIxs, "create ATAs + mint tUSDC (lp 1.0, alice 0.4, bob 0.4)");
  }

  // ---- open_market (disc 1, plain PHASE_NONE market) ----
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const paramsHash = sha256(u64le(FIXTURE_ID), u32le(STAT_A), u32le(0), Buffer.from([0xff]), Buffer.from([PREDICATE]), i64le(THRESHOLD), i64le(deadline));
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), u64le(FIXTURE_ID), paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm"), market.toBuffer()], ONYX);
  const positions = {
    alice: PublicKey.findProgramAddressSync([Buffer.from("ammpos"), market.toBuffer(), alice.publicKey.toBuffer()], ONYX)[0],
    bob: PublicKey.findProgramAddressSync([Buffer.from("ammpos"), market.toBuffer(), bob.publicKey.toBuffer()], ONYX)[0],
  };
  console.log("market:", market.toBase58(), "\npool:  ", pool.toBase58());

  await send([lp], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: lp.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX.OPEN_MARKET]), u64le(FIXTURE_ID), u32le(STAT_A), u32le(0), Buffer.from([0xff]), Buffer.from([PREDICATE]), i64le(THRESHOLD), i64le(deadline), paramsHash]),
  })], "open_market (plain)");

  // ---- create_amm_pool (disc 29): real SPL seed into the market vault ----
  await send([lp], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: lp.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: atas.lp!, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX.CREATE_POOL]), u64le(LP_SEED), u16le(FEE_BPS)]),
  })], "create_amm_pool (seed 1.0 tUSDC, 1% fee)");

  // ---- open positions + deposits ----
  for (const [name, w] of [["alice", alice], ["bob", bob]] as const) {
    const deposit = name === "alice" ? ALICE_DEPOSIT : BOB_DEPOSIT;
    await send([w], [
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: positions[name]!, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([IX.OPEN_POSITION]),
      }),
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: w.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: positions[name]!, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: atas[name]!, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([IX.DEPOSIT]), u64le(deposit)]),
      }),
    ], `${name}: open_amm_position + deposit_amm`);
  }
  sim.pos.alice.usdc = ALICE_DEPOSIT;
  sim.pos.bob.usdc = BOB_DEPOSIT;

  const vaultAfterDeposits = await vaultBalance(vault);
  console.log(`vault after seed+deposits: ${fmt(vaultAfterDeposits)}`);
  assertEq(vaultAfterDeposits, TOTAL_DEPOSITED, "vault == seed + alice + bob deposits");

  // ---- swaps (all min_out = EXACT expected from mirrored math) ----
  const swapIx = (w: Keypair, position: PublicKey, side: number, dir: number, amountIn: bigint, minOut: bigint) =>
    new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: w.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: positions[w === alice ? "alice" : "bob"]!, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([Buffer.from([IX.SWAP, side, dir]), u64le(amountIn), u64le(minOut)]),
    });
  void positions; // (position arg resolved inside swapIx by wallet identity)

  // 1. alice buys A with 0.16
  let exp = simBuy("alice", SIDE_A, 160_000n);
  await send([alice], [swapIx(alice, positions.alice!, SIDE_A, SWAP_BUY, 160_000n, exp)], `alice BUY A 0.16 (min_out=${exp}, exact)`);
  // 2. bob buys B with 0.12
  exp = simBuy("bob", SIDE_B, 120_000n);
  await send([bob], [swapIx(bob, positions.bob!, SIDE_B, SWAP_BUY, 120_000n, exp)], `bob BUY B 0.12 (min_out=${exp}, exact)`);

  // --- deliberate slippage revert: min_out one unit above what's achievable ---
  {
    const fee = calcFee(80_000n, BigInt(FEE_BPS));
    const wouldGet = calcBuy(sim.reserveA, sim.reserveB, 80_000n - fee).tokensOut;
    await sendExpectCustomError([alice], [swapIx(alice, positions.alice!, SIDE_A, SWAP_BUY, 80_000n, wouldGet + 1n)], 6026, "alice BUY A with min_out=expected+1");
  }

  // 3. alice sells half her A tokens
  let sellAmt = sim.pos.alice.ta / 2n;
  exp = simSell("alice", SIDE_A, sellAmt);
  await send([alice], [swapIx(alice, positions.alice!, SIDE_A, SWAP_SELL, sellAmt, exp)], `alice SELL A ${sellAmt} tokens (min_out=${exp}, exact)`);
  // 4. bob buys A with 0.08 (side switch)
  exp = simBuy("bob", SIDE_A, 80_000n);
  await send([bob], [swapIx(bob, positions.bob!, SIDE_A, SWAP_BUY, 80_000n, exp)], `bob BUY A 0.08 (min_out=${exp}, exact)`);
  // 5. alice buys B with 0.04
  exp = simBuy("alice", SIDE_B, 40_000n);
  await send([alice], [swapIx(alice, positions.alice!, SIDE_B, SWAP_BUY, 40_000n, exp)], `alice BUY B 0.04 (min_out=${exp}, exact)`);
  // 6. bob sells a third of his B tokens
  sellAmt = sim.pos.bob.tb / 3n;
  exp = simSell("bob", SIDE_B, sellAmt);
  await send([bob], [swapIx(bob, positions.bob!, SIDE_B, SWAP_SELL, sellAmt, exp)], `bob SELL B ${sellAmt} tokens (min_out=${exp}, exact)`);

  // ================= CHECKPOINT 1: mid-lifecycle solvency =================
  console.log("\n===== CHECKPOINT 1 (after 6 swaps, before settlement) =====");
  const p1 = await readPool(pool);
  const a1 = await readPosition(positions.alice!);
  const b1 = await readPosition(positions.bob!);
  const v1 = await vaultBalance(vault);
  console.log(`  pool:  reserveA=${p1.reserveA} reserveB=${p1.reserveB} sets=${p1.sets} fees=${p1.fees}`);
  console.log(`  alice: usdc=${a1.usdc} tokensA=${a1.ta} tokensB=${a1.tb}`);
  console.log(`  bob:   usdc=${b1.usdc} tokensA=${b1.ta} tokensB=${b1.tb}`);
  console.log(`  vault: ${fmt(v1)}`);
  // on-chain state must equal the off-chain simulation EXACTLY (proves every
  // swap's on-chain math matched the mirrored quote engine, unit for unit)
  assertEq(p1.reserveA, sim.reserveA, "on-chain reserveA == simulated");
  assertEq(p1.reserveB, sim.reserveB, "on-chain reserveB == simulated");
  assertEq(p1.sets, sim.sets, "on-chain sets_outstanding == simulated");
  assertEq(p1.fees, sim.fees, "on-chain fees_accrued == simulated");
  assertEq(a1.usdc, sim.pos.alice.usdc, "alice usdc == simulated");
  assertEq(b1.usdc, sim.pos.bob.usdc, "bob usdc == simulated");
  // the §1 solvency identity, lamport-exact
  assertEq(a1.usdc + b1.usdc + p1.sets + p1.fees, v1, "Σ usdc_available + sets + fees == vault");
  assertEq(a1.ta + b1.ta + p1.reserveA, p1.sets, "Σ tokens_A + reserve_a == sets_outstanding");
  assertEq(a1.tb + b1.tb + p1.reserveB, p1.sets, "Σ tokens_B + reserve_b == sets_outstanding");
  assertEq(v1, TOTAL_DEPOSITED, "vault untouched by swaps (== total ever deposited)");
  console.log("  CHECKPOINT 1: SOLVENT, lamport-exact ✓");

  // ---- settle via the LIVE TxLINE proof pipeline ----
  console.log("\nfetching LIVE settlement proof from TxLINE...");
  const proof = await getLiveSettlementProof({ fixtureId: Number(FIXTURE_ID), statAKey: STAT_A, statBKey: 0 });
  if (!proof.ok) throw new Error(`live proof unavailable: ${proof.reason}`);
  console.log(`live proof: seq=${proof.fixture.seq} epochDay=${proof.fixture.epochDay} statValue=${proof.fixture.payload.statsToProve[0]!.value}`);
  const { ix: settleIx, computeIx } = buildSettleMarketIx({ submitter: admin.publicKey, market, fixture: proof.fixture, threshold: THRESHOLD, predicate: PREDICATE });
  let settled = false;
  for (let attempt = 1; attempt <= 5 && !settled; attempt++) {
    try {
      await send([admin], [computeIx, settleIx], "settle_market (LIVE proof)");
      settled = true;
    } catch (e) {
      console.log(`  settle attempt ${attempt} failed (${(e as Error).message.slice(0, 120)}), retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!settled) throw new Error("settle_market failed after 5 attempts");
  const marketInfo = await base.getAccountInfo(market);
  const status = marketInfo!.data[26], outcome = marketInfo!.data[27];
  console.log(`market status=${status} (4=Settled) outcome=${outcome} (1=SideA)`);
  if (status !== 4) throw new Error("market not settled");

  // ---- redeem both users + withdraw LP ----
  const ataBefore = { alice: await ataBalance(atas.alice!), bob: await ataBalance(atas.bob!), lp: await ataBalance(atas.lp!) };
  const redeemIx = (w: Keypair, name: "alice" | "bob") =>
    new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: w.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: positions[name]!, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: atas[name]!, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([IX.REDEEM]),
    });
  await send([alice], [redeemIx(alice, "alice")], "alice redeem_amm");
  await send([bob], [redeemIx(bob, "bob")], "bob redeem_amm");
  await send([lp], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: lp.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: atas.lp!, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX.WITHDRAW_LP]),
  })], "withdraw_lp_amm");

  // ================= CHECKPOINT 2: post-redemption, vault == 0 =================
  console.log("\n===== CHECKPOINT 2 (post settle + redeem×2 + withdraw_lp) =====");
  const v2 = await vaultBalance(vault);
  const ataAfter = { alice: await ataBalance(atas.alice!), bob: await ataBalance(atas.bob!), lp: await ataBalance(atas.lp!) };
  const paid = { alice: ataAfter.alice - ataBefore.alice, bob: ataAfter.bob - ataBefore.bob, lp: ataAfter.lp - ataBefore.lp };
  console.log(`  payouts: alice=${fmt(paid.alice)} bob=${fmt(paid.bob)} lp=${fmt(paid.lp)}`);
  console.log(`  vault final: ${fmt(v2)}`);
  assertEq(v2, 0n, "vault drains to EXACTLY zero post-settlement");
  assertEq(paid.alice + paid.bob + paid.lp, TOTAL_DEPOSITED, "Σ payouts == total ever deposited");
  // expected per-wallet from the simulation + outcome (A won):
  const winnerIsA = outcome === 1;
  const expAlice = sim.pos.alice.usdc + (winnerIsA ? sim.pos.alice.ta : sim.pos.alice.tb);
  const expBob = sim.pos.bob.usdc + (winnerIsA ? sim.pos.bob.ta : sim.pos.bob.tb);
  const expLp = (winnerIsA ? sim.reserveA : sim.reserveB) + sim.fees;
  assertEq(paid.alice, expAlice, "alice payout == usdc_available + winning tokens");
  assertEq(paid.bob, expBob, "bob payout == usdc_available + winning tokens");
  assertEq(paid.lp, expLp, "lp payout == winning reserve + fees");
  console.log("  CHECKPOINT 2: vault ZERO, every unit accounted ✓");

  // ---- balance table + sig list ----
  console.log("\n===== PHASE B PROOF: BALANCE TABLE =====");
  console.log(`deposited:  lp seed=${fmt(LP_SEED)}  alice=${fmt(ALICE_DEPOSIT)}  bob=${fmt(BOB_DEPOSIT)}  total=${fmt(TOTAL_DEPOSITED)}`);
  console.log(`checkpoint1: vault=${fmt(v1)}  (usdcA=${a1.usdc} usdcB=${b1.usdc} sets=${p1.sets} fees=${p1.fees})`);
  console.log(`checkpoint2: vault=${fmt(v2)}  payouts: alice=${fmt(paid.alice)} bob=${fmt(paid.bob)} lp=${fmt(paid.lp)}`);
  console.log(`outcome: ${winnerIsA ? "Side A" : "Side B"} won — LP P&L: ${fmt(paid.lp - LP_SEED)} (adverse selection is real, disclosed)`);
  console.log("\n===== SIGNATURES =====");
  for (const { label, sig } of sigs) console.log(`  ${label}: ${sig}`);
  console.log("\nVERDICT: PASS — solvency identity lamport-exact at BOTH checkpoints on live devnet");
  console.log("market:", market.toBase58());
}

main().catch((e) => { console.error("\nPHASE B PROOF FAILED:", e); process.exit(1); });
