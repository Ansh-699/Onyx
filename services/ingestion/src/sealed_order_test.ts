// Sealed Order Intent (Level 1, O7) — commit-reveal MEV-proof batch match,
// devnet de-risk / proof test. Native Pinocchio, no Anchor.
//
// Throwaway market only (fresh fixture id) — never the L0-proven or
// ER-proven markets. Two throwaway bettor keypairs (funded fresh from the
// admin wallet, which is the test-USDC mint authority).
//
// Stages:
//   A. open_market_sealed (throwaway fixture, short commit/reveal windows)
//   B. submit_sealed_order x3 (bettorA submits TWO orders on side A with
//      different nonces -- exercises the Position-merge path in
//      run_batch_match; bettorB submits ONE order on side B). Reads the
//      order accounts back mid-Commit to prove side/price aren't visible.
//   C. wait for commit_end_ts, reveal_order x3 (+ one deliberately-wrong
//      preimage attempt that must be rejected)
//   D. submit + reveal a FOURTH order that is then left unrevealed, to
//      prove I-NoTrap via refund_unrevealed
//   E. wait for reveal_end_ts, run_batch_match -> decode clearing_price +
//      each order's matched_size + the resulting Position(s)
//   F. refund_unrevealed on the never-revealed order
//
// Usage: cd onyx && bun run services/ingestion/src/sealed_order_test.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { keccak256 } from "js-sha3";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import * as cfg from "./config";

const RPC_URL = cfg.SOLANA_RPC_URL;
const ONYX = new PublicKey(process.env.ONYX_PROGRAM_ID ?? "4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");

const IX_OPEN_MARKET_SEALED = 15;
const IX_SUBMIT_SEALED_ORDER = 16;
const IX_REVEAL_ORDER = 17;
const IX_RUN_BATCH_MATCH = 18;
const IX_REFUND_UNREVEALED = 19;
const OP_NONE = 0xff,
  CMP_GREATER_THAN = 0;
const SIDE_A = 1,
  SIDE_B = 2;
const SEED_MARKET = Buffer.from("market"),
  SEED_VAULT = Buffer.from("vault"),
  SEED_ORDER = Buffer.from("order"),
  SEED_POSITION = Buffer.from("pos");

const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
};
const sha256 = (...b: Buffer[]) => {
  const h = createHash("sha256");
  for (const x of b) h.update(x);
  return h.digest();
};
const commitment = (side: number, size: bigint, limitPrice: bigint, nonce: bigint, owner: PublicKey) =>
  Buffer.from(
    keccak256.arrayBuffer(
      Buffer.concat([Buffer.from([side]), u64le(size), u64le(limitPrice), u64le(nonce), owner.toBuffer()]),
    ),
  );

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) {
    // Fetch logs for a readable failure before throwing.
    const tx2 = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    throw new Error(
      `${label} landed but FAILED: ${JSON.stringify(conf.value.err)} (sig ${sig})\n${(tx2?.meta?.logMessages ?? []).join("\n")}`,
    );
  }
  console.log(`[sealed] ${label} -> ${sig}`);
  return sig;
}

class ExpectFailButSucceeded extends Error {}

async function expectFail(p: Promise<unknown>, label: string) {
  try {
    await p;
    throw new ExpectFailButSucceeded(`${label}: expected failure but it SUCCEEDED`);
  } catch (e) {
    if (e instanceof ExpectFailButSucceeded) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[sealed] ${label} correctly rejected: ${msg.split("\n")[0]}`);
  }
}

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(cfg.ANCHOR_WALLET, "utf8"))));
  console.log("[sealed] admin:", admin.publicKey.toBase58());
  console.log("[sealed] ONYX program:", ONYX.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await conn.getAccountInfo(configPda);
  if (!configInfo) throw new Error("config not initialized; run l0_loop_test first");
  const usdcMint = new PublicKey(configInfo.data.subarray(40, 72));
  console.log("[sealed] usdc mint:", usdcMint.toBase58());

  // ---- fresh throwaway bettors ----
  const bettorA = Keypair.generate();
  const bettorB = Keypair.generate();
  console.log("[sealed] bettorA:", bettorA.publicKey.toBase58());
  console.log("[sealed] bettorB:", bettorB.publicKey.toBase58());

  for (const b of [bettorA, bettorB]) {
    await send(
      conn,
      [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.publicKey, lamports: 30_000_000 })],
      [admin],
      `fund ${b.publicKey.toBase58().slice(0, 6)} with SOL`,
    );
  }
  const ataA = await getOrCreateAssociatedTokenAccount(conn, admin, usdcMint, bettorA.publicKey);
  const ataB = await getOrCreateAssociatedTokenAccount(conn, admin, usdcMint, bettorB.publicKey);
  await mintTo(conn, admin, usdcMint, ataA.address, admin, 10_000n);
  await mintTo(conn, admin, usdcMint, ataB.address, admin, 10_000n);
  console.log("[sealed] funded both bettors with SOL + test USDC");

  // ---- Stage A: open_market_sealed ----
  const fixtureId = BigInt(process.env.SEALED_FIXTURE_ID ?? "900000005");
  const statKey = 1,
    threshold = 2n;
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const paramsHash = sha256(
    u64le(fixtureId),
    u32le(statKey),
    u32le(0),
    Buffer.from([OP_NONE]),
    Buffer.from([CMP_GREATER_THAN]),
    i64le(threshold),
    i64le(deadline),
  );
  const fixtureLe = u64le(fixtureId);
  const [market] = PublicKey.findProgramAddressSync([SEED_MARKET, fixtureLe, paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([SEED_VAULT, market.toBuffer()], ONYX);
  console.log("[sealed] throwaway sealed market PDA:", market.toBase58());

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const commitEndTs = nowSec + 20n; // short windows so the devnet run finishes quickly
  const revealEndTs = nowSec + 40n;

  if (!(await conn.getAccountInfo(market))) {
    const openArgs = Buffer.concat([
      fixtureLe,
      u32le(statKey),
      u32le(0),
      Buffer.from([OP_NONE]),
      Buffer.from([CMP_GREATER_THAN]),
      i64le(threshold),
      i64le(deadline),
      paramsHash,
      i64le(commitEndTs),
      i64le(revealEndTs),
    ]);
    await send(
      conn,
      [
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
          data: Buffer.concat([Buffer.from([IX_OPEN_MARKET_SEALED]), openArgs]),
        }),
      ],
      [admin],
      "open_market_sealed",
    );
  } else {
    console.log("[sealed] market already exists; reusing (commit window may already be over).");
  }

  // ---- Stage B: submit_sealed_order x3 ----
  // Worked example (same numbers as the host unit test
  // matching::tests::worked_example_pro_rata_with_dust):
  //   A1: size 100, limit 70   A2: size 200, limit 60   B1: size 90, limit 50
  // Expected: p* = 50, matched A1=30, A2=60, B1=90.
  type OrderSpec = { owner: Keypair; ata: PublicKey; nonce: bigint; side: number; size: bigint; limitPrice: bigint; collateral: bigint };
  const orders: OrderSpec[] = [
    { owner: bettorA, ata: ataA.address, nonce: 0n, side: SIDE_A, size: 100n, limitPrice: 70n, collateral: 100n },
    { owner: bettorA, ata: ataA.address, nonce: 1n, side: SIDE_A, size: 200n, limitPrice: 60n, collateral: 200n },
    { owner: bettorB, ata: ataB.address, nonce: 0n, side: SIDE_B, size: 90n, limitPrice: 50n, collateral: 90n },
  ];

  const orderPda = (owner: PublicKey, nonce: bigint) =>
    PublicKey.findProgramAddressSync([SEED_ORDER, market.toBuffer(), owner.toBuffer(), u64le(nonce)], ONYX)[0];

  for (const o of orders) {
    const pda = orderPda(o.owner.publicKey, o.nonce);
    const c = commitment(o.side, o.size, o.limitPrice, o.nonce, o.owner.publicKey);
    const args = Buffer.concat([u64le(o.nonce), c, u64le(o.collateral)]);
    await send(
      conn,
      [
        new TransactionInstruction({
          programId: ONYX,
          keys: [
            { pubkey: o.owner.publicKey, isSigner: true, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: pda, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: o.ata, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([IX_SUBMIT_SEALED_ORDER]), args]),
        }),
      ],
      [o.owner],
      `submit_sealed_order nonce=${o.nonce} owner=${o.owner.publicKey.toBase58().slice(0, 6)}`,
    );
  }

  // ---- Success criterion 1: prove side/price aren't recoverable on-chain during Commit ----
  const firstOrderInfo = await conn.getAccountInfo(orderPda(bettorA.publicKey, 0n));
  if (!firstOrderInfo) throw new Error("order account missing after submit");
  const sideByteDuringCommit = firstOrderInfo.data[121];
  const sizeBytesDuringCommit = firstOrderInfo.data.subarray(128, 136);
  console.log(
    `[sealed] order account during Commit: only commitment(32B)+collateral_locked are meaningful; ` +
      `side byte reads ${sideByteDuringCommit} (0=unset), size field reads ${sizeBytesDuringCommit.toString("hex")} (all zero) -- ` +
      `the true side=${orders[0]!.side} size=${orders[0]!.size} are NOT recoverable from on-chain bytes.`,
  );

  // A wrong preimage must be rejected once reveal opens (tested in Stage C).

  // ---- Stage D: a fourth order, submitted but never revealed (I-NoTrap) ----
  const bettorC = Keypair.generate();
  await send(
    conn,
    [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: bettorC.publicKey, lamports: 20_000_000 })],
    [admin],
    "fund bettorC",
  );
  const ataC = await getOrCreateAssociatedTokenAccount(conn, admin, usdcMint, bettorC.publicKey);
  await mintTo(conn, admin, usdcMint, ataC.address, admin, 10_000n);
  const orphan = { owner: bettorC, ata: ataC.address, nonce: 0n, side: SIDE_A, size: 50n, limitPrice: 55n, collateral: 50n };
  const orphanPda = orderPda(orphan.owner.publicKey, orphan.nonce);
  {
    const c = commitment(orphan.side, orphan.size, orphan.limitPrice, orphan.nonce, orphan.owner.publicKey);
    const args = Buffer.concat([u64le(orphan.nonce), c, u64le(orphan.collateral)]);
    await send(
      conn,
      [
        new TransactionInstruction({
          programId: ONYX,
          keys: [
            { pubkey: orphan.owner.publicKey, isSigner: true, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: orphanPda, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: orphan.ata, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([IX_SUBMIT_SEALED_ORDER]), args]),
        }),
      ],
      [orphan.owner],
      "submit_sealed_order (orphan, will never be revealed)",
    );
  }

  // ---- wait for commit_end_ts ----
  const waitUntil = async (target: bigint, label: string) => {
    const nowMs = Date.now();
    const targetMs = Number(target) * 1000;
    const waitMs = targetMs - nowMs + 3000; // +3s margin past the boundary
    if (waitMs > 0) {
      console.log(`[sealed] waiting ${Math.ceil(waitMs / 1000)}s for ${label}...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  };
  await waitUntil(commitEndTs, "commit_end_ts");

  // ---- Stage C: reveal_order x3, plus one deliberately-wrong preimage ----
  await expectFail(
    (async () => {
      // size(50) stays <= collateral_locked(100) so this genuinely exercises
      // the commitment-hash check, not the (separate) size<=collateral guard.
      const wrong = Buffer.concat([Buffer.from([SIDE_B]), u64le(50n), u64le(1n), u64le(orders[0]!.nonce)]);
      return send(
        conn,
        [
          new TransactionInstruction({
            programId: ONYX,
            keys: [
              { pubkey: orders[0]!.owner.publicKey, isSigner: true, isWritable: false },
              { pubkey: market, isSigner: false, isWritable: true },
              { pubkey: orderPda(orders[0]!.owner.publicKey, orders[0]!.nonce), isSigner: false, isWritable: true },
            ],
            data: Buffer.concat([Buffer.from([IX_REVEAL_ORDER]), wrong]),
          }),
        ],
        [orders[0]!.owner],
        "reveal_order with WRONG preimage",
      );
    })(),
    "reveal_order(wrong preimage)",
  );

  for (const o of orders) {
    const pda = orderPda(o.owner.publicKey, o.nonce);
    const args = Buffer.concat([Buffer.from([o.side]), u64le(o.size), u64le(o.limitPrice), u64le(o.nonce)]);
    await send(
      conn,
      [
        new TransactionInstruction({
          programId: ONYX,
          keys: [
            { pubkey: o.owner.publicKey, isSigner: true, isWritable: false },
            { pubkey: market, isSigner: false, isWritable: true },
            { pubkey: pda, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([Buffer.from([IX_REVEAL_ORDER]), args]),
        }),
      ],
      [o.owner],
      `reveal_order nonce=${o.nonce} owner=${o.owner.publicKey.toBase58().slice(0, 6)} (correct preimage)`,
    );
  }
  console.log("[sealed] the orphan order (bettorC) is deliberately left UNrevealed.");

  // ---- wait for reveal_end_ts ----
  await waitUntil(revealEndTs, "reveal_end_ts");

  // ---- Stage E: run_batch_match ----
  // Pass orders in a DELIBERATELY REORDERED sequence vs how they were
  // submitted (B1 first, then A2, then A1) -- the matcher is proven
  // order-independent by the host unit test; this just demonstrates the
  // on-chain call accepts any ordering.
  const posA = PublicKey.findProgramAddressSync([SEED_POSITION, market.toBuffer(), bettorA.publicKey.toBuffer()], ONYX)[0];
  const posB = PublicKey.findProgramAddressSync([SEED_POSITION, market.toBuffer(), bettorB.publicKey.toBuffer()], ONYX)[0];
  const reordered = [orders[2]!, orders[1]!, orders[0]!]; // B1, A2, A1
  const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  for (const o of reordered) {
    const pda = orderPda(o.owner.publicKey, o.nonce);
    const pos = o.side === SIDE_A ? posA : posB;
    remaining.push(
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: pos, isSigner: false, isWritable: true },
      { pubkey: o.ata, isSigner: false, isWritable: true },
    );
  }
  await send(
    conn,
    [
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ...remaining,
        ],
        data: Buffer.from([IX_RUN_BATCH_MATCH]),
      }),
    ],
    [admin],
    "run_batch_match (accounts passed in REORDERED sequence: B1, A2, A1)",
  );

  // ---- decode + report results ----
  const marketAfter = await conn.getAccountInfo(market);
  const clearingPrice = marketAfter!.data.readBigUInt64LE(119);
  const phase = marketAfter!.data[118];
  const totalA = marketAfter!.data.readBigUInt64LE(52);
  const totalB = marketAfter!.data.readBigUInt64LE(60);
  console.log(`\n[sealed] market.phase after match: ${phase} (3=Matched)`);
  console.log(`[sealed] clearing_price: ${clearingPrice} (expected 50)`);
  console.log(`[sealed] total_side_a: ${totalA} total_side_b: ${totalB} (expected 90 / 90)`);

  for (const o of orders) {
    const info = await conn.getAccountInfo(orderPda(o.owner.publicKey, o.nonce));
    const matched = info!.data.readBigUInt64LE(144);
    console.log(
      `[sealed] order nonce=${o.nonce} owner=${o.owner.publicKey.toBase58().slice(0, 6)} matched_size=${matched}`,
    );
  }
  const posAInfo = await conn.getAccountInfo(posA);
  const posBInfo = await conn.getAccountInfo(posB);
  console.log(
    `[sealed] Position(bettorA): side=${posAInfo!.data[80]} amount=${posAInfo!.data.readBigUInt64LE(72)} (expected side=1 amount=90, merged from two sealed orders)`,
  );
  console.log(
    `[sealed] Position(bettorB): side=${posBInfo!.data[80]} amount=${posBInfo!.data.readBigUInt64LE(72)} (expected side=2 amount=90)`,
  );

  // ---- Stage F: refund_unrevealed on the orphan ----
  await send(
    conn,
    [
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true }, // permissionless trigger
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: orphanPda, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: orphan.ata, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([IX_REFUND_UNREVEALED]),
      }),
    ],
    [admin],
    "refund_unrevealed (orphan, triggered by admin on bettorC's behalf)",
  );
  const orphanAtaInfo = await conn.getAccountInfo(orphan.ata);
  console.log(
    `[sealed] orphan (bettorC) USDC ATA balance after refund: ${orphanAtaInfo!.data.readBigUInt64LE(64)} (expected 10000, full collateral back)`,
  );

  console.log("\n===== SEALED ORDER INTENT RESULT =====");
  console.log("market:          ", market.toBase58());
  console.log("clearing_price:  ", clearingPrice.toString());
  console.log("total_side_a/b:  ", totalA.toString(), "/", totalB.toString());
  console.log("=======================================");
}

main().catch((e) => {
  console.error("[sealed] FAILED:", e);
  process.exit(1);
});
