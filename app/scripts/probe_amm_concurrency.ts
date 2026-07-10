// AMM-pivot Phase-0 probe (NO new program code -- existing deployed
// instructions only): can MULTIPLE wallets do CONCURRENT read-modify-write
// mutations to ONE shared delegated account on the ER without lost updates,
// at swap-like cadence?
//
// This is the exact write pattern an AMM swap needs (every swap is a RMW on
// the shared pool's reserves + the swapper's own position). The existing
// instruction set already contains a perfect stand-in: reveal_order_fast
// INCREMENTS Market.revealed_count and cancel_order_fast DECREMENTS it --
// a real accumulating counter on a shared delegated account, callable by
// many wallets.
//
// Probe: N fresh wallets each commit an order (sequential, latency
// measured), then all N reveal CONCURRENTLY (Promise.all -- interleaved RMW
// increments on the same byte), verify revealed_count == N (no lost
// updates), then all N cancel concurrently, verify revealed_count == 0.
//
// Usage: bun run scripts/probe_amm_concurrency_tmp.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as ix from "../src/lib/instructions";

const N = 4;
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const sha256 = (...bufs: Buffer[]) => { const h = createHash("sha256"); for (const b of bufs) h.update(b); return h.digest(); };

async function sendBase(signers: Keypair[], ixs: TransactionInstruction[], label: string) {
  const tx = new Transaction().add(...ixs);
  const bh = await base.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  console.log(`[${label}] OK ${sig}`);
  return sig;
}

async function sendEr(er: Connection, signer: Keypair, ixs: TransactionInstruction[], label: string): Promise<{ ms: number; sig: string; err: string | null }> {
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
  console.log(`[${label}] ${err ? "FAILED " + err : "OK"} ${ms}ms ${sig}`);
  return { ms, sig, err };
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));

  // ---- fresh market: 100s commit, 120s reveal ----
  const fixtureId = 18179550n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deadline = now + 3600n;
  const commitEndTs = now + 100n;
  const revealEndTs = commitEndTs + 120n;
  const paramsHash = sha256(u64le(fixtureId), u32le(1), u32le(0), Buffer.from([0xff]), Buffer.from([0]), i64le(2n), i64le(deadline));
  const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), u64le(fixtureId), paramsHash], ONYX);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);
  const openArgs = Buffer.concat([u64le(fixtureId), u32le(1), u32le(0), Buffer.from([0xff]), Buffer.from([0]), i64le(2n), i64le(deadline), paramsHash, i64le(commitEndTs), i64le(revealEndTs)]);
  const openIx = new TransactionInstruction({
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
    data: Buffer.concat([Buffer.from([15]), openArgs]),
  });
  await sendBase([admin], [openIx], "open_market_sealed");
  console.log("market:", market.toBase58());

  await sendBase([admin], [ix.buildDelegateMarketIx({ payer: admin.publicKey, market })], "delegate_market");
  await new Promise((r) => setTimeout(r, 3000));

  const routerRes = await fetch("https://devnet-router.magicblock.app/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [market.toBase58()] }),
  });
  const routerJson: any = await routerRes.json();
  const fqdn: string | undefined = routerJson?.result?.fqdn;
  if (!fqdn) throw new Error("market not delegated per router");
  const er = new Connection(fqdn.startsWith("http") ? fqdn : `https://${fqdn}`, "confirmed");
  console.log("ER endpoint:", fqdn);

  // ---- N fresh wallets: fund SOL from admin (no flaky airdrop), ATA+mint, open+deposit+delegate ----
  const wallets: Keypair[] = Array.from({ length: N }, () => Keypair.generate());
  {
    const fundIxs = wallets.map((w) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: w.publicKey, lamports: 20_000_000 }));
    await sendBase([admin], fundIxs, `fund ${N} wallets with SOL`);
    const ataIxs = wallets.flatMap((w) => {
      const ata = getAssociatedTokenAddressSync(usdcMint, w.publicKey);
      return [
        createAssociatedTokenAccountInstruction(admin.publicKey, ata, w.publicKey, usdcMint),
        createMintToInstruction(usdcMint, ata, admin.publicKey, 2_000_000),
      ];
    });
    await sendBase([admin], ataIxs, `create ATAs + mint tUSDC for ${N} wallets`);
  }
  for (let i = 0; i < N; i++) {
    const w = wallets[i]!;
    const { ix: openTaIx } = ix.buildOpenTradingAccountIx({ owner: w.publicKey, market });
    const depositIx = ix.buildDepositTradingIx({ owner: w.publicKey, market, amount: 1_000_000n, usdcMint });
    const delegateTaIx = ix.buildDelegateTradingAccountIx({ payer: w.publicKey, market, owner: w.publicKey });
    await sendBase([w], [openTaIx, depositIx, delegateTaIx], `wallet ${i}: open+deposit+delegate TA`);
  }

  // ---- commit window: sequential submits on ER (per-tx latency) ----
  console.log("\n--- SUBMITS (sequential, ER) ---");
  const nonces = wallets.map((_, i) => BigInt(1000 + i));
  const submitResults: { ms: number; err: string | null }[] = [];
  for (let i = 0; i < N; i++) {
    const w = wallets[i]!;
    const commitment = ix.sealedCommitment(1, 500_000n, 500_000n, nonces[i]!, w.publicKey);
    const r = await sendEr(er, w, [ix.buildSubmitOrderFastIx({ owner: w.publicKey, market, commitment, collateral: 500_000n })], `submit wallet ${i}`);
    submitResults.push(r);
  }

  // ---- wait for commit close ----
  console.log("\nwaiting for commit window to close...");
  while (BigInt(Math.floor(Date.now() / 1000)) < commitEndTs + 2n) await new Promise((r) => setTimeout(r, 2000));

  // ---- CONCURRENT reveals: N interleaved RMW increments on the SAME shared account ----
  console.log(`\n--- ${N} CONCURRENT REVEALS (Promise.all, ER) -- the lost-update test ---`);
  const revealResults = await Promise.all(
    wallets.map((w, i) =>
      sendEr(er, w, [ix.buildRevealOrderFastIx({ owner: w.publicKey, market, side: 1, size: 500_000n, limitPrice: 500_000n, nonce: nonces[i]! })], `reveal wallet ${i}`),
    ),
  );

  const marketAfterReveals = await er.getAccountInfo(market);
  const countAfterReveals = marketAfterReveals!.data[127];
  console.log(`revealed_count after ${N} concurrent reveals: ${countAfterReveals} (expect ${N} -- lost updates iff <)`);

  // ---- CONCURRENT cancels: N interleaved RMW decrements ----
  console.log(`\n--- ${N} CONCURRENT CANCELS (Promise.all, ER) ---`);
  const cancelResults = await Promise.all(
    wallets.map((w, i) => sendEr(er, w, [ix.buildCancelOrderFastIx({ owner: w.publicKey, market })], `cancel wallet ${i}`)),
  );
  const marketAfterCancels = await er.getAccountInfo(market);
  const countAfterCancels = marketAfterCancels!.data[127];
  console.log(`revealed_count after ${N} concurrent cancels: ${countAfterCancels} (expect 0)`);

  // ---- cleanup: undelegate the scratch market ----
  const taPdas = wallets.map((w) => ix.tradingAccountPda(market, w.publicKey));
  await sendEr(er, admin, [ix.buildUndelegateManyIx({ payer: admin.publicKey, delegated: [market, ...taPdas] })], "undelegate market + TAs (cleanup)");

  // ---- summary ----
  const ok = (rs: { err: string | null }[]) => rs.filter((r) => !r.err).length;
  const avg = (rs: { ms: number; err: string | null }[]) => Math.round(rs.filter((r) => !r.err).reduce((s, r) => s + r.ms, 0) / Math.max(1, ok(rs)));
  console.log("\n===== PROBE SUMMARY =====");
  console.log(`submits   (sequential): ${ok(submitResults)}/${N} ok, avg ${avg(submitResults)}ms`);
  console.log(`reveals   (concurrent): ${ok(revealResults)}/${N} ok, avg ${avg(revealResults)}ms, latencies=[${revealResults.map((r) => r.ms).join(", ")}]`);
  console.log(`cancels   (concurrent): ${ok(cancelResults)}/${N} ok, avg ${avg(cancelResults)}ms, latencies=[${cancelResults.map((r) => r.ms).join(", ")}]`);
  console.log(`shared-counter integrity: after reveals=${countAfterReveals}/${N}, after cancels=${countAfterCancels}/0`);
  console.log(`VERDICT: ${countAfterReveals === N && countAfterCancels === 0 && ok(revealResults) === N && ok(cancelResults) === N ? "PASS -- no lost updates, all concurrent RMW writes landed" : "FAIL -- see above"}`);
  console.log("market:", market.toBase58());
}
main().catch((e) => { console.error("PROBE FAILED:", e); process.exit(1); });
