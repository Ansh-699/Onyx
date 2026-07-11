// AMM Phase C devnet+ER proof (docs/AMM_TRADING_DESIGN.md §5 row C): the
// concurrency phase. Delegates market+pool+4 positions to the MagicBlock ER
// (first-ever on-chain use of delegate_amm_pool disc 32 / delegate_amm_
// position disc 33), fires GENUINELY CONCURRENT real swaps (Promise.all,
// two rounds: all-buys, then mixed buys+sells) against ONE live pool, and
// audits the result with the three assertions the design doc demands:
//
//  (1) no lost updates -- every swap Finalized-on-ER or fails visibly;
//  (2) the §1 solvency identity holds EXACTLY on the ER-read state after
//      each concurrent round (total-deposited is the invariant constant --
//      the real vault sits untouched on base);
//  (3) NO TWO SWAPS PRICED OFF THE SAME STALE RESERVES -- proven by
//      replaying the on-chain-observed landing order (slot order; intra-
//      slot order via getBlock, with a permutation-search fallback if the
//      ER RPC lacks getBlock) through the SAME mirrored CPMM math and
//      requiring it to reproduce the final on-chain reserves EXACTLY.
//      A stale-priced swap would break the replay: its on-chain output
//      would match some earlier reserve state, not its landing position.
//
// Then: undelegate-many (market+pool+4 positions in ONE call) -> verify the
// committed base state equals the final ER state field-for-field -> settle
// via the LIVE TxLINE pipeline -> redeem x4 + withdraw_lp -> vault must
// drain to EXACTLY zero. Standing evidence bar: sample swap sig shown
// Finalized-on-ER AND not-found-on-base.
//
// Usage: cd app && bun scripts/amm_er_lifecycle.ts

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildSettleMarketIx, buildDelegateMarketIx, buildUndelegateManyIx, delegateBufferPda, delegationRecordPda, delegationMetadataPda, DELEGATION_PROGRAM_ID } from "../src/lib/instructions";
import { getLiveSettlementProof } from "../src/lib/txlineSettlementProof";

const N = 4;
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));

const FIXTURE_ID = 18179550n;
const STAT_A = 1;
const THRESHOLD = 2n;
const PREDICATE = 0; // GT -> Side A wins on this fixture (stat value 3 > 2)

const LP_SEED = 1_000_000n;
const FEE_BPS = 100;
const DEPOSIT_EACH = 400_000n;
const TOTAL_DEPOSITED = LP_SEED + BigInt(N) * DEPOSIT_EACH;

const SIDE_A = 1, SIDE_B = 2, SWAP_BUY = 0, SWAP_SELL = 1;
const IX = { OPEN_MARKET: 1, CREATE_POOL: 29, OPEN_POSITION: 30, DEPOSIT: 31, DELEGATE_POOL: 32, DELEGATE_POSITION: 33, SWAP: 34, REDEEM: 35, WITHDRAW_LP: 36 };

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };
const fmt = (n: bigint) => `${(Number(n) / 1e6).toFixed(6)} tUSDC (${n})`;

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
  console.log(`[${label}] OK ${sig}`);
  sigs.push({ label, sig });
  return sig;
}

/** Concurrent ER send: measures latency, never throws -- returns err for the audit. */
async function sendErTimed(er: Connection, signer: Keypair, ixs: TransactionInstruction[], label: string): Promise<{ label: string; ms: number; sig: string; err: string | null }> {
  const t0 = performance.now();
  const tx = new Transaction().add(...ixs);
  const bh = await er.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await er.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  const ms = Math.round(performance.now() - t0);
  const err = conf.value.err ? JSON.stringify(conf.value.err) : null;
  console.log(`  [${label}] ${err ? "FAILED " + err : "OK"} ${ms}ms ${sig}`);
  if (!err) sigs.push({ label: `${label} (ER)`, sig });
  return { label, ms, sig, err };
}

// ---- mirrored CPMM math (identical to fpmm.rs; BigInt) ----
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

interface PoolState { reserveA: bigint; reserveB: bigint; sets: bigint; fees: bigint }
interface Swap { wallet: number; side: number; dir: number; amountIn: bigint }

/** Apply one swap to a pool state (returns tokens/collateral out). Mirrors swap_amm.rs exactly. */
function applySwap(s: PoolState, sw: Swap): bigint {
  if (sw.dir === SWAP_BUY) {
    const fee = calcFee(sw.amountIn, BigInt(FEE_BPS));
    const net = sw.amountIn - fee;
    const [rb, ro] = sw.side === SIDE_A ? [s.reserveA, s.reserveB] : [s.reserveB, s.reserveA];
    const ending = ceilDiv(rb * ro, ro + net);
    const out = rb + net - ending;
    if (sw.side === SIDE_A) { s.reserveA = ending; s.reserveB = ro + net; } else { s.reserveB = ending; s.reserveA = ro + net; }
    s.sets += net; s.fees += fee;
    return out;
  } else {
    const [rs, ro] = sw.side === SIDE_A ? [s.reserveA, s.reserveB] : [s.reserveB, s.reserveA];
    const d = sw.amountIn;
    const sum = rs + ro + d;
    const m = (sum - isqrt(sum * sum - 4n * ro * d)) / 2n;
    const fee = calcFee(m, BigInt(FEE_BPS));
    if (sw.side === SIDE_A) { s.reserveA = rs + d - m; s.reserveB = ro - m; } else { s.reserveB = rs + d - m; s.reserveA = ro - m; }
    s.sets -= m; s.fees += fee;
    return m - fee;
  }
}

// ---- on-chain readers ----
const readU64 = (data: Buffer, off: number) => data.readBigUInt64LE(off);
async function readPool(conn: Connection, pool: PublicKey): Promise<PoolState> {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error("pool account missing");
  return { reserveA: readU64(info.data, 72), reserveB: readU64(info.data, 80), sets: readU64(info.data, 88), fees: readU64(info.data, 96) };
}
async function readPosition(conn: Connection, position: PublicKey) {
  const info = await conn.getAccountInfo(position);
  if (!info) throw new Error("position account missing");
  return { usdc: readU64(info.data, 72), ta: readU64(info.data, 80), tb: readU64(info.data, 88) };
}
const poolEq = (a: PoolState, b: PoolState) => a.reserveA === b.reserveA && a.reserveB === b.reserveB && a.sets === b.sets && a.fees === b.fees;
const poolStr = (s: PoolState) => `A=${s.reserveA} B=${s.reserveB} sets=${s.sets} fees=${s.fees}`;

function assertEq(actual: bigint, expected: bigint, what: string) {
  if (actual !== expected) throw new Error(`ASSERTION FAILED: ${what}: actual=${actual} expected=${expected} (diff ${actual - expected})`);
  console.log(`  ASSERT OK  ${what}: ${actual}`);
}

interface PositionState { usdc: bigint; ta: bigint; tb: bigint }

/**
 * The stale-read audit. Determines the on-chain landing order of the round's
 * swaps (slot order gives a partial order; intra-slot ties resolved by
 * exhaustive search), replays it through the mirrored math from `before`,
 * and requires an EXACT match with `after` -- pool state AND every wallet's
 * position delta. Then enumerates ALL slot-order-consistent serializations
 * and reports how many are consistent: 1/N means the landing order is
 * UNIQUELY determined by the on-chain end state (path-dependence of the
 * CPMM makes coincidental matches vanishingly unlikely, and per-wallet
 * output deltas discriminate even pool-state collisions -- observed live:
 * a pool-only-matching decoy permutation existed in round 1 and was
 * eliminated exactly by the per-wallet check).
 */
async function replayAudit(
  er: Connection,
  round: string,
  results: { label: string; sig: string }[],
  swaps: Swap[],
  before: PoolState,
  after: PoolState,
  posBefore: PositionState[],
  posAfter: PositionState[],
): Promise<string> {
  // 1. landing slots
  const metas: { i: number; sig: string; slot: number }[] = [];
  for (let i = 0; i < results.length; i++) {
    const tx = await er.getTransaction(results[i]!.sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) throw new Error(`replay audit: tx not found on ER: ${results[i]!.sig}`);
    metas.push({ i, sig: results[i]!.sig, slot: tx.slot });
  }
  metas.sort((a, b) => a.slot - b.slot);
  console.log(`  [${round}] landing slots: ${metas.map((m) => `#${m.i}@${m.slot}`).join(" ")}`);

  // 2. per-wallet observed deltas (what each swap ACTUALLY paid/received)
  const observedOut = (sw: Swap): bigint => {
    const b = posBefore[sw.wallet]!, a = posAfter[sw.wallet]!;
    if (sw.dir === SWAP_BUY) return sw.side === SIDE_A ? a.ta - b.ta : a.tb - b.tb;
    return a.usdc - b.usdc; // SELL: net collateral credited
  };

  // 3. enumerate every serialization consistent with the slot partial order
  const slotGroups: (typeof metas)[] = [];
  for (const m of metas) {
    const last = slotGroups[slotGroups.length - 1];
    if (last && last[0]!.slot === m.slot) last.push(m);
    else slotGroups.push([m]);
  }
  const allOrders: (typeof metas)[] = slotGroups.reduce(
    (acc, group) => acc.flatMap((prefix) => permutations(group).map((p) => [...prefix, ...p])),
    [[]] as (typeof metas)[],
  );
  const consistent: (typeof metas)[] = [];
  for (const order of allOrders) {
    const st: PoolState = { ...before };
    let ok = true;
    for (const m of order) {
      const out = applySwap(st, swaps[m.i]!);
      if (out !== observedOut(swaps[m.i]!)) { ok = false; break; }
    }
    if (ok && poolEq(st, after)) consistent.push(order);
  }
  if (consistent.length === 0) {
    throw new Error(`replay audit ${round} FAILED: NO slot-consistent serialization reproduces the on-chain end state (pool + per-wallet deltas) -- lost update or stale-priced swap detected`);
  }

  // 4. print the (first) consistent order's replay trace
  const st: PoolState = { ...before };
  for (const m of consistent[0]!) {
    const out = applySwap(st, swaps[m.i]!);
    console.log(`  [${round}] replay #${m.i} (${swaps[m.i]!.dir === SWAP_BUY ? "BUY" : "SELL"} side ${swaps[m.i]!.side} ${swaps[m.i]!.amountIn}) -> out=${out} -> ${poolStr(st)}`);
  }
  const uniqueness = `${consistent.length}/${allOrders.length} slot-consistent serializations match (pool + all per-wallet deltas)`;
  console.log(`  [${round}] REPLAY AUDIT PASS: ${uniqueness}${consistent.length === 1 ? " -- landing order UNIQUELY determined" : " -- WARNING: order ambiguous (safety still holds: all swaps composed sequentially)"}`);
  return uniqueness;
}
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  // ---- wallets ----
  const lp = Keypair.generate();
  const traders = Array.from({ length: N }, () => Keypair.generate());
  const lpAta = getAssociatedTokenAddressSync(usdcMint, lp.publicKey);
  const traderAtas = traders.map((t) => getAssociatedTokenAddressSync(usdcMint, t.publicKey));
  {
    const fund = [lp, ...traders].map((w) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.publicKey, lamports: 40_000_000 }));
    await send(base, [admin], fund, `fund lp + ${N} traders with SOL`);
    const ataIxs = [
      createAssociatedTokenAccountInstruction(admin.publicKey, lpAta, lp.publicKey, usdcMint),
      createMintToInstruction(usdcMint, lpAta, admin.publicKey, LP_SEED),
      ...traders.flatMap((t, i) => [
        createAssociatedTokenAccountInstruction(admin.publicKey, traderAtas[i]!, t.publicKey, usdcMint),
        createMintToInstruction(usdcMint, traderAtas[i]!, admin.publicKey, DEPOSIT_EACH),
      ]),
    ];
    await send(base, [admin], ataIxs, "create ATAs + mint tUSDC (lp 1.0, traders 0.4 each)");
  }

  // ---- base: open plain market + pool + positions + deposits ----
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const paramsHash = sha256(u64le(FIXTURE_ID), u32le(STAT_A), u32le(0), Buffer.from([0xff]), Buffer.from([PREDICATE]), i64le(THRESHOLD), i64le(deadline));
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), u64le(FIXTURE_ID), paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm"), market.toBuffer()], ONYX);
  const positions = traders.map((t) => PublicKey.findProgramAddressSync([Buffer.from("ammpos"), market.toBuffer(), t.publicKey.toBuffer()], ONYX)[0]);
  console.log("market:", market.toBase58(), "\npool:  ", pool.toBase58());

  await send(base, [lp], [new TransactionInstruction({
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

  await send(base, [lp], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: lp.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: lpAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX.CREATE_POOL]), u64le(LP_SEED), u16le(FEE_BPS)]),
  })], "create_amm_pool");

  for (let i = 0; i < N; i++) {
    const t = traders[i]!;
    await send(base, [t], [
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: t.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: positions[i]!, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([IX.OPEN_POSITION]),
      }),
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: t.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: positions[i]!, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: traderAtas[i]!, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([IX.DEPOSIT]), u64le(DEPOSIT_EACH)]),
      }),
    ], `trader ${i}: open_amm_position + deposit 0.4`);
  }

  // ---- delegate market + pool + positions (base). First-ever live use of
  // discs 32/33. Same 8-account shape as delegate_trading_account. ----
  const delegateIx = (disc: number, delegated: PublicKey) =>
    new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: delegated, isSigner: false, isWritable: true },
        { pubkey: ONYX, isSigner: false, isWritable: false },
        { pubkey: delegateBufferPda(delegated), isSigner: false, isWritable: true },
        { pubkey: delegationRecordPda(delegated), isSigner: false, isWritable: true },
        { pubkey: delegationMetadataPda(delegated), isSigner: false, isWritable: true },
        { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([disc]), u32le(0xffffffff)]),
    });
  await send(base, [admin], [buildDelegateMarketIx({ payer: admin.publicKey, market })], "delegate_market");
  await send(base, [admin], [delegateIx(IX.DELEGATE_POOL, pool)], "delegate_amm_pool (disc 32, FIRST LIVE USE)");
  for (let i = 0; i < N; i++) {
    await send(base, [admin], [delegateIx(IX.DELEGATE_POSITION, positions[i]!)], `delegate_amm_position ${i} (disc 33)`);
  }

  // ---- discover ER endpoint via router; all six accounts must agree ----
  await new Promise((r) => setTimeout(r, 3000));
  async function delegationFqdn(account: PublicKey): Promise<string | undefined> {
    const res = await fetch("https://devnet-router.magicblock.app/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
    });
    return ((await res.json()) as any)?.result?.fqdn;
  }
  const fqdns = await Promise.all([market, pool, ...positions].map(delegationFqdn));
  if (fqdns.some((f) => !f)) throw new Error(`not all accounts delegated per router: ${fqdns.join(", ")}`);
  if (new Set(fqdns).size !== 1) throw new Error(`accounts landed on DIFFERENT ER nodes: ${fqdns.join(", ")}`);
  const er = new Connection(fqdns[0]!.startsWith("http") ? fqdns[0]! : `https://${fqdns[0]!}`, "confirmed");
  console.log("ER endpoint (all 6 accounts co-located):", fqdns[0]);

  const swapIx = (t: Keypair, position: PublicKey, side: number, dir: number, amountIn: bigint, minOut: bigint) =>
    new TransactionInstruction({
      programId: ONYX,
      keys: [
        // owner READ-ONLY: the ER rejects any writable non-delegated account
        // in the instruction metas; the tx-level fee payer is sponsored.
        { pubkey: t.publicKey, isSigner: true, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([Buffer.from([IX.SWAP, side, dir]), u64le(amountIn), u64le(minOut)]),
    });

  // ================= ROUND 1: 4 CONCURRENT BUYS =================
  // min_out=0 for the concurrent rounds ON PURPOSE: each swap's output
  // depends on the landing order, which is unknowable in advance -- that is
  // the entire phenomenon under test. Slippage enforcement itself was proven
  // on-chain in Phase B (Custom(6026) revert, sig in BUILD_STATE).
  const round1: Swap[] = [
    { wallet: 0, side: SIDE_A, dir: SWAP_BUY, amountIn: 150_000n },
    { wallet: 1, side: SIDE_B, dir: SWAP_BUY, amountIn: 110_000n },
    { wallet: 2, side: SIDE_A, dir: SWAP_BUY, amountIn: 70_000n },
    { wallet: 3, side: SIDE_B, dir: SWAP_BUY, amountIn: 50_000n },
  ];
  const poolBefore1 = await readPool(er, pool);
  console.log(`\n===== ROUND 1: ${N} CONCURRENT BUYS (Promise.all) ===== pool before: ${poolStr(poolBefore1)}`);
  const t1 = performance.now();
  const res1 = await Promise.all(round1.map((sw) => sendErTimed(er, traders[sw.wallet]!, [swapIx(traders[sw.wallet]!, positions[sw.wallet]!, sw.side, sw.dir, sw.amountIn, 0n)], `r1 w${sw.wallet} ${sw.dir === SWAP_BUY ? "BUY" : "SELL"} ${sw.side === SIDE_A ? "A" : "B"} ${sw.amountIn}`)));
  const wall1 = Math.round(performance.now() - t1);
  if (res1.some((r) => r.err)) throw new Error("round 1: a concurrent swap failed -- see above");
  console.log(`  all ${N} landed; wall-clock for the whole concurrent batch: ${wall1}ms; per-tx: [${res1.map((r) => r.ms).join(", ")}]ms`);

  const poolAfter1 = await readPool(er, pool);
  const pos1 = await Promise.all(positions.map((p) => readPosition(er, p)));
  console.log(`  pool after: ${poolStr(poolAfter1)}`);
  // solvency on ER state (assertion 2): total deposited is the constant
  assertEq(pos1.reduce((s, p) => s + p.usdc, 0n) + poolAfter1.sets + poolAfter1.fees, TOTAL_DEPOSITED, "R1: Σ usdc_available + sets + fees == total deposited");
  assertEq(pos1.reduce((s, p) => s + p.ta, 0n) + poolAfter1.reserveA, poolAfter1.sets, "R1: Σ tokens_A + reserve_a == sets");
  assertEq(pos1.reduce((s, p) => s + p.tb, 0n) + poolAfter1.reserveB, poolAfter1.sets, "R1: Σ tokens_B + reserve_b == sets");
  // stale-read audit (assertion 3)
  const posBefore1 = traders.map(() => ({ usdc: DEPOSIT_EACH, ta: 0n, tb: 0n }));
  const orderSource1 = await replayAudit(er, "R1", res1, round1, poolBefore1, poolAfter1, posBefore1, pos1);

  // ================= ROUND 2: CONCURRENT MIXED BUYS + SELLS =================
  const round2: Swap[] = [
    { wallet: 0, side: SIDE_A, dir: SWAP_SELL, amountIn: pos1[0]!.ta / 2n },
    { wallet: 1, side: SIDE_B, dir: SWAP_SELL, amountIn: pos1[1]!.tb / 2n },
    { wallet: 2, side: SIDE_B, dir: SWAP_BUY, amountIn: 50_000n },
    { wallet: 3, side: SIDE_A, dir: SWAP_BUY, amountIn: 40_000n },
  ];
  console.log(`\n===== ROUND 2: ${N} CONCURRENT MIXED (2 sells + 2 buys, Promise.all) ===== pool before: ${poolStr(poolAfter1)}`);
  const t2 = performance.now();
  const res2 = await Promise.all(round2.map((sw) => sendErTimed(er, traders[sw.wallet]!, [swapIx(traders[sw.wallet]!, positions[sw.wallet]!, sw.side, sw.dir, sw.amountIn, 0n)], `r2 w${sw.wallet} ${sw.dir === SWAP_BUY ? "BUY" : "SELL"} ${sw.side === SIDE_A ? "A" : "B"} ${sw.amountIn}`)));
  const wall2 = Math.round(performance.now() - t2);
  if (res2.some((r) => r.err)) throw new Error("round 2: a concurrent swap failed -- see above");
  console.log(`  all ${N} landed; wall-clock: ${wall2}ms; per-tx: [${res2.map((r) => r.ms).join(", ")}]ms`);

  const poolAfter2 = await readPool(er, pool);
  const pos2 = await Promise.all(positions.map((p) => readPosition(er, p)));
  console.log(`  pool after: ${poolStr(poolAfter2)}`);
  assertEq(pos2.reduce((s, p) => s + p.usdc, 0n) + poolAfter2.sets + poolAfter2.fees, TOTAL_DEPOSITED, "R2: Σ usdc_available + sets + fees == total deposited");
  assertEq(pos2.reduce((s, p) => s + p.ta, 0n) + poolAfter2.reserveA, poolAfter2.sets, "R2: Σ tokens_A + reserve_a == sets");
  assertEq(pos2.reduce((s, p) => s + p.tb, 0n) + poolAfter2.reserveB, poolAfter2.sets, "R2: Σ tokens_B + reserve_b == sets");
  const orderSource2 = await replayAudit(er, "R2", res2, round2, poolAfter1, poolAfter2, pos1, pos2);

  // ---- standing evidence bar: Finalized-on-ER + not-found-on-base ----
  const sampleSig = res1[0]!.sig;
  const onEr = await er.getTransaction(sampleSig, { maxSupportedTransactionVersion: 0 });
  const onBase = await base.getTransaction(sampleSig, { maxSupportedTransactionVersion: 0 });
  console.log(`\nsample swap sig ${sampleSig}:`);
  console.log(`  on ER:   ${onEr ? `FOUND (slot ${onEr.slot})` : "NOT FOUND"}   on base: ${onBase ? "FOUND (unexpected!)" : "not found (correct -- ER-only)"}`);
  if (!onEr || onBase) throw new Error("ER-only evidence check failed");

  // ---- undelegate market + pool + all positions in ONE call ----
  await send(er, [admin], [buildUndelegateManyIx({ payer: admin.publicKey, delegated: [market, pool, ...positions] })], "undelegate-many (market+pool+4 positions, ER)");
  console.log("waiting for undelegation to commit back to base...");
  const deadline2 = Date.now() + 90_000;
  for (;;) {
    const info = await base.getAccountInfo(pool);
    if (info && info.owner.equals(ONYX)) break;
    if (Date.now() > deadline2) throw new Error("undelegation did not land on base within 90s");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("pool re-owned by ONYX on base ✓");

  // ---- committed base state must equal the final ER state exactly ----
  console.log("\n===== DELEGATION ROUND-TRIP INTEGRITY =====");
  const poolBase = await readPool(base, pool);
  const posBase = await Promise.all(positions.map((p) => readPosition(base, p)));
  assertEq(poolBase.reserveA, poolAfter2.reserveA, "base reserveA == final ER reserveA");
  assertEq(poolBase.reserveB, poolAfter2.reserveB, "base reserveB == final ER reserveB");
  assertEq(poolBase.sets, poolAfter2.sets, "base sets == final ER sets");
  assertEq(poolBase.fees, poolAfter2.fees, "base fees == final ER fees");
  for (let i = 0; i < N; i++) {
    assertEq(posBase[i]!.usdc, pos2[i]!.usdc, `base pos${i}.usdc == ER`);
    assertEq(posBase[i]!.ta, pos2[i]!.ta, `base pos${i}.tokens_a == ER`);
    assertEq(posBase[i]!.tb, pos2[i]!.tb, `base pos${i}.tokens_b == ER`);
  }
  const vaultBal = BigInt((await base.getTokenAccountBalance(vault)).value.amount);
  assertEq(vaultBal, TOTAL_DEPOSITED, "vault (base, never delegated) untouched through the whole ER session");

  // ---- settle via LIVE pipeline + redeem all + withdraw LP ----
  console.log("\nfetching LIVE settlement proof from TxLINE...");
  const proof = await getLiveSettlementProof({ fixtureId: Number(FIXTURE_ID), statAKey: STAT_A, statBKey: 0 });
  if (!proof.ok) throw new Error(`live proof unavailable: ${proof.reason}`);
  const { ix: settleIx, computeIx } = buildSettleMarketIx({ submitter: admin.publicKey, market, fixture: proof.fixture, threshold: THRESHOLD, predicate: PREDICATE });
  let settled = false;
  for (let attempt = 1; attempt <= 5 && !settled; attempt++) {
    try { await send(base, [admin], [computeIx, settleIx], "settle_market (LIVE proof)"); settled = true; }
    catch (e) { console.log(`  settle attempt ${attempt} failed, retrying in 5s...`); await new Promise((r) => setTimeout(r, 5000)); }
  }
  if (!settled) throw new Error("settle failed after 5 attempts");
  const marketInfo = await base.getAccountInfo(market);
  const outcome = marketInfo!.data[27];
  console.log(`settled: outcome=${outcome} (1=SideA)`);

  const ataBefore = await Promise.all([...traderAtas, lpAta].map(async (a) => BigInt((await base.getTokenAccountBalance(a)).value.amount)));
  for (let i = 0; i < N; i++) {
    await send(base, [traders[i]!], [new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: traders[i]!.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: positions[i]!, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: traderAtas[i]!, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([IX.REDEEM]),
    })], `trader ${i} redeem_amm`);
  }
  await send(base, [lp], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: lp.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: lpAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX.WITHDRAW_LP]),
  })], "withdraw_lp_amm");

  // ---- final post-settlement reconciliation ----
  console.log("\n===== POST-SETTLEMENT RECONCILIATION =====");
  const vaultFinal = BigInt((await base.getTokenAccountBalance(vault)).value.amount);
  const ataAfter = await Promise.all([...traderAtas, lpAta].map(async (a) => BigInt((await base.getTokenAccountBalance(a)).value.amount)));
  const paid = ataAfter.map((b, i) => b - ataBefore[i]!);
  const winnerIsA = outcome === 1;
  for (let i = 0; i < N; i++) {
    const expected = posBase[i]!.usdc + (winnerIsA ? posBase[i]!.ta : posBase[i]!.tb);
    assertEq(paid[i]!, expected, `trader ${i} payout == usdc_available + winning tokens`);
  }
  assertEq(paid[N]!, (winnerIsA ? poolBase.reserveA : poolBase.reserveB) + poolBase.fees, "LP payout == winning reserve + fees");
  assertEq(vaultFinal, 0n, "vault drains to EXACTLY zero post-settlement");
  assertEq(paid.reduce((s, p) => s + p, 0n), TOTAL_DEPOSITED, "Σ payouts == total ever deposited");

  // ---- summary ----
  console.log("\n===== PHASE C PROOF SUMMARY =====");
  console.log(`concurrent rounds: 2 × ${N} real swaps (Promise.all), all landed, zero lost updates`);
  console.log(`round 1 (4 buys):        batch wall ${wall1}ms, replay audit: ${orderSource1}`);
  console.log(`round 2 (2 sells+2 buys): batch wall ${wall2}ms, replay audit: ${orderSource2}`);
  console.log(`solvency: exact on ER after each round, exact across the undelegation round-trip, vault ${fmt(vaultFinal)} after full unwind`);
  console.log(`payouts: ${paid.slice(0, N).map((p, i) => `t${i}=${p}`).join(" ")} lp=${paid[N]} (Σ=${paid.reduce((s, p) => s + p, 0n)})`);
  console.log(`LP P&L: ${fmt(paid[N]! - LP_SEED)}`);
  console.log("\n===== SIGNATURES =====");
  for (const { label, sig } of sigs) console.log(`  ${label}: ${sig}`);
  console.log("\nVERDICT: PASS — concurrent real swaps serialize correctly on the ER; no lost updates; no stale-priced swaps; solvent to the lamport end-to-end");
  console.log("market:", market.toBase58());
}

main().catch((e) => { console.error("\nPHASE C PROOF FAILED:", e); process.exit(1); });
