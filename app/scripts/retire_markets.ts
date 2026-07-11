// Retire the pre-v2 devnet markets: drain every vault the protocol allows,
// keeper-style, and report exactly what remains. Solana has no "delete
// account" for these (no close instruction; vaults have no close authority)
// — retirement means (a) empty the vault via legitimate refund/redeem paths
// and (b) the v2 lobby's default filter hides non-active markets.
//
// What this script can drain, honestly:
//   - Unsettled L0/sealed markets past deadline + 2h grace: refund_expired /
//     refund_unrevealed are PERMISSIONLESS keepers — anyone can trigger
//     them; funds always go to the position/order OWNER's token account.
//     (First LIVE use of the expiry path shipped earlier today.)
//   - AMM positions/pools owned by keys this repo holds (admin, test-bettor):
//     redeem_amm / withdraw_lp_amm (owner-signed), which since today also
//     open after deadline+grace on never-settled markets.
//   - What it can NOT drain: settled-market Positions belonging to throwaway
//     demo wallets whose keys are gone (claim requires the winner's
//     signature). Reported as "unclaimed by owner" — that's their money,
//     not ours to move.
//
// Run: cd app && bun scripts/retire_markets.ts

import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf8"))));
const ownedKeys: Keypair[] = [admin];
try {
  ownedKeys.push(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL("../../_keys/test-bettor.json", import.meta.url).pathname, "utf8")))));
} catch { /* optional */ }
const ownedByBase58 = new Map(ownedKeys.map((k) => [k.publicKey.toBase58(), k]));

const IX = { REFUND_EXPIRED: 7, REFUND_UNREVEALED: 19, REDEEM_AMM: 35, WITHDRAW_LP_AMM: 36 };
const SETTLE_GRACE = 7200;
const STATUS_SETTLED = 4, STATUS_CLAIMED = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(signer: Keypair, ixs: TransactionInstruction[], label: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const tx = new Transaction().add(...ixs);
    const bh = await base.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = signer.publicKey;
    tx.sign(signer);
    const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
    if (conf.value.err) return { ok: false, detail: `${label}: ${JSON.stringify(conf.value.err)}` };
    console.log(`  [${label}] ${sig}`);
    return { ok: true, detail: sig };
  } catch (e) {
    return { ok: false, detail: `${label}: ${e}` };
  }
}

async function vaultBalance(vault: PublicKey): Promise<bigint> {
  try { return BigInt((await base.getTokenAccountBalance(vault)).value.amount); } catch { return 0n; }
}

async function main() {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX);
  const configInfo = await base.getAccountInfo(configPda);
  const usdcMint = new PublicKey(configInfo!.data.subarray(40, 72));
  const now = Math.floor(Date.now() / 1000);

  // Enumerate everything once. memcmp bytes are BASE58: "1"=0x00, so disc N
  // encodes as the base58 char for byte N — market(2)="3", position(3)="4",
  // sealed_order(4)="5", amm_pool(6)="7", amm_position(7)="8".
  const [markets, positions, sealedOrders, ammPools, ammPositions] = await Promise.all(
    ["3", "4", "5", "7", "8"].map((d) => base.getProgramAccounts(ONYX, { filters: [{ memcmp: { offset: 0, bytes: d } }] })),
  );
  console.log(`inventory: ${markets.length} markets, ${positions.length} positions, ${sealedOrders.length} sealed orders, ${ammPools.length} amm pools, ${ammPositions.length} amm positions\n`);

  const byMarket = <T extends { account: { data: Buffer } }>(list: T[], off: number) => {
    const m = new Map<string, T[]>();
    for (const item of list) {
      const key = new PublicKey(item.account.data.subarray(off, off + 32)).toBase58();
      (m.get(key) ?? m.set(key, []).get(key)!).push(item);
    }
    return m;
  };
  const positionsByMarket = byMarket(positions, 40);
  const ordersByMarket = byMarket(sealedOrders, 40);
  const poolsByMarket = byMarket(ammPools, 8);
  const ammPositionsByMarket = byMarket(ammPositions, 40);

  const report: string[] = [];

  for (const { pubkey: market, account } of markets) {
    const status = account.data[26];
    const deadline = Number(account.data.readBigInt64LE(36));
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], ONYX);
    const before = await vaultBalance(vault);
    if (before === 0n) continue;
    const settled = status === STATUS_SETTLED || status === STATUS_CLAIMED;
    const expired = now > deadline + SETTLE_GRACE;
    const mk = market.toBase58();
    console.log(`--- ${mk} status=${status} expired=${expired} vault=${Number(before) / 1e6} tUSDC`);

    if (!settled && !expired) {
      report.push(`${mk}: SKIPPED — still active (deadline not past grace); vault ${Number(before) / 1e6}`);
      continue;
    }

    // 1. Permissionless: refund_expired for every L0 Position (unsettled+expired).
    if (!settled && expired) {
      for (const p of positionsByMarket.get(mk) ?? []) {
        const owner = new PublicKey(p.account.data.subarray(8, 8 + 32));
        const ownerAta = getAssociatedTokenAddressSync(usdcMint, owner);
        await send(admin, [
          createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ownerAta, owner, usdcMint),
          new TransactionInstruction({
            programId: ONYX,
            keys: [
              { pubkey: admin.publicKey, isSigner: true, isWritable: true },
              { pubkey: market, isSigner: false, isWritable: true },
              { pubkey: p.pubkey, isSigner: false, isWritable: true },
              { pubkey: vault, isSigner: false, isWritable: true },
              { pubkey: ownerAta, isSigner: false, isWritable: true },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([IX.REFUND_EXPIRED]),
          }),
        ], `refund_expired -> ${owner.toBase58().slice(0, 8)}`);
        await sleep(400);
      }
    }

    // 2. Permissionless: refund_unrevealed for unrevealed sealed orders.
    for (const o of ordersByMarket.get(mk) ?? []) {
      const revealed = o.account.data[120] === 1;
      const collateral = o.account.data.readBigUInt64LE(104);
      if (revealed || collateral === 0n) continue;
      const owner = new PublicKey(o.account.data.subarray(8, 8 + 32));
      const ownerAta = getAssociatedTokenAddressSync(usdcMint, owner);
      await send(admin, [
        createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ownerAta, owner, usdcMint),
        new TransactionInstruction({
          programId: ONYX,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: o.pubkey, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: ownerAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([IX.REFUND_UNREVEALED]),
        }),
      ], `refund_unrevealed -> ${owner.toBase58().slice(0, 8)}`);
      await sleep(400);
    }

    // 3. Owner-signed: AMM positions/pool for keys we hold (settled OR expired).
    for (const p of ammPositionsByMarket.get(mk) ?? []) {
      if (p.account.owner.toBase58() !== ONYX.toBase58()) continue; // delegated — skip
      const owner58 = new PublicKey(p.account.data.subarray(8, 8 + 32)).toBase58();
      const signer = ownedByBase58.get(owner58);
      if (!signer) continue;
      const ownerAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);
      await send(signer, [
        createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, ownerAta, signer.publicKey, usdcMint),
        new TransactionInstruction({
          programId: ONYX,
          keys: [
            { pubkey: signer.publicKey, isSigner: true, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: p.pubkey, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: ownerAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([IX.REDEEM_AMM]),
        }),
      ], `redeem_amm (owned) ${owner58.slice(0, 8)}`);
      await sleep(400);
    }
    for (const pl of poolsByMarket.get(mk) ?? []) {
      if (pl.account.owner.toBase58() !== ONYX.toBase58()) continue;
      const lp58 = new PublicKey(pl.account.data.subarray(40, 40 + 32)).toBase58();
      const signer = ownedByBase58.get(lp58);
      if (!signer) continue;
      const lpAta = getAssociatedTokenAddressSync(usdcMint, signer.publicKey);
      await send(signer, [
        createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, lpAta, signer.publicKey, usdcMint),
        new TransactionInstruction({
          programId: ONYX,
          keys: [
            { pubkey: signer.publicKey, isSigner: true, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: pl.pubkey, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: lpAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([IX.WITHDRAW_LP_AMM]),
        }),
      ], `withdraw_lp_amm (owned) ${lp58.slice(0, 8)}`);
      await sleep(400);
    }

    const after = await vaultBalance(vault);
    const drained = before - after;
    report.push(
      `${mk}: drained ${Number(drained) / 1e6} of ${Number(before) / 1e6} tUSDC${after > 0n ? ` — residual ${Number(after) / 1e6} (${settled ? "unclaimed by settled-market owners whose keys are gone" : "directional dust / third-party AMM balances"})` : " — EMPTY"}`,
    );
  }

  console.log("\n===== RETIREMENT REPORT =====");
  for (const r of report) console.log("  " + r);
}

main().catch((e) => { console.error(e); process.exit(1); });
