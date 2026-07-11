// Live devnet proof of MagicBlock session-key trading (docs/SESSION_TRADING.md):
//
//   1. ONE user-signed transaction = the UI's "Start session": gpl_session
//      create_session + open_amm_position + deposit_amm + delegate
//      market/pool/position — exactly what one wallet popup covers.
//   2. The SESSION KEY (zero SOL, ever — checked) signs swaps on the ER as
//      fee payer: popup-free AND gas-free, validator-sponsored.
//   3. Scope negatives, live: a keyless stranger is Unauthorized (6012);
//      the session key CANNOT redeem funds (6012); after revoke_session the
//      session key's swap is SessionInvalid (6032).
//   4. Undelegate, settle via the LIVE TxLINE proof pipeline, drain the
//      vault to exactly zero — the standing solvency bar.
//
// Run: cd app && bun scripts/session_er_proof.ts

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildSettleMarketIx,
  buildDelegateMarketIx,
  buildUndelegateManyIx,
  delegateBufferPda,
  delegationRecordPda,
  delegationMetadataPda,
  DELEGATION_PROGRAM_ID,
} from "../src/lib/instructions";
import { buildCreateSessionIx, buildRevokeSessionIx, sessionTokenPda } from "../src/lib/session";
import { getLiveSettlementProof } from "../src/lib/txlineSettlementProof";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));

const FIXTURE_ID = 18179550n;
const STAT_A = 1;
const THRESHOLD = 2n;
const PREDICATE = 0; // GT -> Side A wins on this fixture (stat value 3 > 2)
const LP_SEED = 1_000_000n;
const FEE_BPS = 100;
const DEPOSIT = 400_000n;

const SIDE_A = 1, SIDE_B = 2, SWAP_BUY = 0, SWAP_SELL = 1;
const IX = { OPEN_MARKET: 1, CREATE_POOL: 29, OPEN_POSITION: 30, DEPOSIT: 31, DELEGATE_POOL: 32, DELEGATE_POSITION: 33, SWAP: 34, REDEEM: 35, WITHDRAW_LP: 36 };
const ERR_UNAUTHORIZED = 6012, ERR_SESSION_INVALID = 6032;

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };

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

/** Send expecting a specific Custom(code) revert; throws if it succeeds or fails differently. */
async function sendExpectCustom(conn: Connection, signers: Keypair[], ixs: TransactionInstruction[], code: number, label: string) {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  const err = JSON.stringify(conf.value.err ?? null);
  if (!err.includes(`"Custom":${code}`)) throw new Error(`${label}: expected Custom(${code}), got ${err} sig=${sig}`);
  console.log(`[${label}] correctly REVERTED with Custom(${code}) ${sig}`);
  sigs.push({ label: `${label} (expected revert)`, sig });
}

const readU64 = (data: Buffer, off: number) => data.readBigUInt64LE(off);
async function readPosition(conn: Connection, position: PublicKey) {
  const info = await conn.getAccountInfo(position);
  if (!info) throw new Error("position account missing");
  return { usdc: readU64(info.data, 72), ta: readU64(info.data, 80), tb: readU64(info.data, 88) };
}

function assertEq(actual: bigint, expected: bigint, what: string) {
  if (actual !== expected) throw new Error(`ASSERTION FAILED: ${what}: actual=${actual} expected=${expected}`);
  console.log(`  ASSERT OK  ${what}: ${actual}`);
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  // ---- wallets: LP (market creator) + one user + the SESSION KEY ----
  const lp = Keypair.generate();
  const user = Keypair.generate();
  const sessionKey = Keypair.generate(); // NEVER funded — the whole point
  const stranger = Keypair.generate(); // negative-test signer, no token
  const lpAta = getAssociatedTokenAddressSync(usdcMint, lp.publicKey);
  const userAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey);

  await send(base, [admin], [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: lp.publicKey, lamports: 40_000_000 }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 60_000_000 }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: stranger.publicKey, lamports: 10_000_000 }),
  ], "fund lp + user + stranger with SOL (session key gets NOTHING)");
  await send(base, [admin], [
    createAssociatedTokenAccountInstruction(admin.publicKey, lpAta, lp.publicKey, usdcMint),
    createMintToInstruction(usdcMint, lpAta, admin.publicKey, LP_SEED),
    createAssociatedTokenAccountInstruction(admin.publicKey, userAta, user.publicKey, usdcMint),
    createMintToInstruction(usdcMint, userAta, admin.publicKey, DEPOSIT),
  ], "create ATAs + mint tUSDC");

  // ---- market + pool (base) ----
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const paramsHash = sha256(u64le(FIXTURE_ID), u32le(STAT_A), u32le(0), Buffer.from([0xff]), Buffer.from([PREDICATE]), i64le(THRESHOLD), i64le(deadline));
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), u64le(FIXTURE_ID), paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm"), market.toBuffer()], ONYX);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("ammpos"), market.toBuffer(), user.publicKey.toBuffer()], ONYX);
  console.log("market:", market.toBase58());

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
  }), new TransactionInstruction({
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
  })], "open_market + create_amm_pool");

  // ---- THE ONE-SIGNATURE ONBOARDING TX (what the UI's single popup sends) ----
  const validUntil = Number(now) + 4 * 60 * 60;
  const sessionToken = sessionTokenPda(sessionKey.publicKey, user.publicKey);
  const delegateIx = (disc: number, delegated: PublicKey) => new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
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
  await send(base, [user, sessionKey], [
    buildCreateSessionIx({ authority: user.publicKey, sessionSigner: sessionKey.publicKey, validUntil }),
    new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([IX.OPEN_POSITION]),
    }),
    new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([IX.DEPOSIT]), u64le(DEPOSIT)]),
    }),
    buildDelegateMarketIx({ payer: user.publicKey, market }),
    delegateIx(IX.DELEGATE_POOL, pool),
    delegateIx(IX.DELEGATE_POSITION, position),
  ], "ONE-SIGNATURE START SESSION: create_session + open + deposit + delegate market/pool/position");

  // ---- router discovery ----
  await new Promise((r) => setTimeout(r, 3000));
  const routerRes = await fetch("https://devnet-router.magicblock.app/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [pool.toBase58()] }),
  });
  const fqdn = ((await routerRes.json()) as any)?.result?.fqdn as string | undefined;
  if (!fqdn) throw new Error("pool not delegated per router");
  const er = new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");
  console.log("ER endpoint:", fqdn);

  // ---- SESSION-SIGNED SWAPS on the ER: fee payer = session key (0 SOL) ----
  const sessionSwapIx = (side: number, dir: number, amountIn: bigint) => new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: sessionKey.publicKey, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: sessionToken, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([IX.SWAP, side, dir]), u64le(amountIn), u64le(0n)]),
  });

  console.log("\n===== SESSION SWAPS (signed ONLY by the never-funded session key) =====");
  const balBefore = await base.getBalance(sessionKey.publicKey);
  assertEq(BigInt(balBefore), 0n, "session key SOL balance before swaps (base)");
  const swapTimes: number[] = [];
  for (const [i, sw] of ([
    { side: SIDE_A, dir: SWAP_BUY, amountIn: 150_000n },
    { side: SIDE_B, dir: SWAP_BUY, amountIn: 100_000n },
    { side: SIDE_A, dir: SWAP_SELL, amountIn: 60_000n },
  ] as const).entries()) {
    const t0 = performance.now();
    await send(er, [sessionKey], [sessionSwapIx(sw.side, sw.dir, sw.amountIn)], `session swap ${i + 1} (${sw.dir === SWAP_BUY ? "BUY" : "SELL"} ${sw.side === SIDE_A ? "A" : "B"})`);
    swapTimes.push(Math.round(performance.now() - t0));
  }
  console.log(`  per-swap latency: [${swapTimes.join(", ")}]ms — zero wallet popups, zero SOL spent`);
  const posAfterSwaps = await readPosition(er, position);
  console.log(`  position after: usdc=${posAfterSwaps.usdc} A=${posAfterSwaps.ta} B=${posAfterSwaps.tb}`);
  if (posAfterSwaps.ta === 0n || posAfterSwaps.tb === 0n) throw new Error("session swaps did not move the position");

  // ---- negative 1: a stranger with NO token is Unauthorized ----
  console.log("\n===== SCOPE NEGATIVES (live) =====");
  await sendExpectCustom(er, [stranger], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: stranger.publicKey, isSigner: true, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from([IX.SWAP, SIDE_A, SWAP_BUY]), u64le(10_000n), u64le(0n)]),
  })], ERR_UNAUTHORIZED, "stranger (no session token) swap");

  // ---- undelegate everything back to base ----
  await send(er, [user], [buildUndelegateManyIx({ payer: user.publicKey, delegated: [market, pool, position] })], "undelegate-many (ER)");
  console.log("waiting for undelegation to commit back to base...");
  const undelegateDeadline = Date.now() + 90_000;
  for (;;) {
    const info = await base.getAccountInfo(pool);
    if (info && info.owner.equals(ONYX)) break;
    if (Date.now() > undelegateDeadline) throw new Error("undelegation did not land on base within 90s");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("pool re-owned by ONYX on base ✓");

  // ---- negative 2: session key can NEVER redeem funds (funds-exit pin, live).
  // Fund it 0.01 SOL ONLY for this base-layer negative's fee. ----
  await send(base, [admin], [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sessionKey.publicKey, lamports: 10_000_000 })], "fund session key 0.01 SOL for base-fee negatives only");
  await sendExpectCustom(base, [sessionKey], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: sessionKey.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX.REDEEM]),
  })], ERR_UNAUTHORIZED, "session key attempts redeem_amm");

  // ---- negative 3: revoke the session, then a session swap fails ----
  await send(base, [user], [buildRevokeSessionIx({ authority: user.publicKey, sessionSigner: sessionKey.publicKey })], "revoke_session (token closed, rent back)");
  await sendExpectCustom(base, [sessionKey], [sessionSwapIx(SIDE_A, SWAP_BUY, 10_000n)], ERR_SESSION_INVALID, "session swap AFTER revocation");

  // ---- settle via LIVE pipeline, drain, solvency ----
  console.log("\nfetching LIVE settlement proof from TxLINE...");
  const proof = await getLiveSettlementProof({ fixtureId: Number(FIXTURE_ID), statAKey: STAT_A, statBKey: 0 });
  if (!proof.ok) throw new Error(`live proof unavailable: ${proof.reason}`);
  const { ix: settleIx, computeIx } = buildSettleMarketIx({ submitter: admin.publicKey, market, fixture: proof.fixture, threshold: THRESHOLD, predicate: PREDICATE });
  let settled = false;
  for (let attempt = 1; attempt <= 5 && !settled; attempt++) {
    try { await send(base, [admin], [computeIx, settleIx], "settle_market (LIVE proof)"); settled = true; }
    catch { console.log(`  settle attempt ${attempt} failed, retrying in 5s...`); await new Promise((r) => setTimeout(r, 5000)); }
  }
  if (!settled) throw new Error("settle failed after 5 attempts");

  await send(base, [user], [new TransactionInstruction({
    programId: ONYX,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX.REDEEM]),
  })], "user redeem_amm (owner wallet — the only key that can)");
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

  const vaultBal = BigInt((await base.getTokenAccountBalance(vault)).value.amount);
  assertEq(vaultBal, 0n, "vault drains to EXACTLY zero post-settlement");

  console.log("\n===== SIGNATURES =====");
  for (const s of sigs) console.log(`  ${s.label}: ${s.sig}`);
  console.log("\nVERDICT: PASS — one popup to start, popup-free gas-free session swaps on the ER,");
  console.log("scope + revocation enforced on-chain, funds-exit owner-only, vault zero.");
  console.log("market:", market.toBase58());
}

main().catch((e) => { console.error(e); process.exit(1); });
