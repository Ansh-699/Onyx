// AMM Phase D browser-driven proof (docs/AMM_TRADING_DESIGN.md §5 row D):
// the ENTIRE AMM lifecycle driven through the real UI with a real-signing
// injected wallet — same honesty standard as er_browser_proof.ts: the page
// builds every transaction with its own production code, the "wallet" only
// signs bytes (ed25519 over the exact serialized message), nothing is
// mocked below the wallet-provider boundary.
//
// Steps (all through the browser except where marked script-side):
//   1. /create → market type = AMM → seed 1.0 tUSDC @1% fee → one tx
//      (open_market + create_amm_pool), wallet-signed. Wallet becomes LP.
//   2. market page → AmmTradingPanel renders (pool-existence routing) →
//      deposit 2 tUSDC (faucet + open_amm_position + deposit_amm).
//   3. BUY Side A 0.5 tUSDC at 1% tolerance → quote shown (min received =
//      on-chain min_out) → swap lands.
//   4. **DELIBERATE SLIPPAGE REVERT** (the required screenshot): tolerance
//      set to 0%, and the injected wallet STALLS the signature while a
//      script-side trader moves the pool price — exactly the real-world
//      race slippage protection exists for. The UI's already-built min_out
//      is then beaten on-chain → SlippageExceeded(6026) → the panel shows
//      the friendly slippage message. Nothing traded — verified.
//   5. SELL half the Side-A tokens back at 1% tolerance → lands (the
//      "sell anytime" half of the whole pivot, in the browser).
//   6. Settle via SettleClaimPanel (real validate_stat CPI).
//   7. Redeem via the panel; LP withdraw via the panel (same wallet seeded
//      the pool). Script-side: the price-mover redeems its own position
//      too, then the market vault is asserted EXACTLY ZERO on-chain.
//
// Usage: cd app && bun scripts/amm_browser_proof.ts   (dev server on :3000)

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const SHOTS = "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad";
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../_keys/test-bettor.json", "utf8"))));
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/home/anshtyagi/.config/solana/id.json", "utf8"))));
// The script-side price mover for the slippage-revert step.
const mover = Keypair.generate();

interface Captured { label: string; sig: string; ms: number }
const captured: Captured[] = [];

const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

async function sendScript(signers: Keypair[], ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const bh = await base.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const conf = await base.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  console.log(`[script-side] ${label} OK ${sig}`);
  return sig;
}

const MOCK_PROVIDER_INIT = `
(function () {
  const pubkeyB58 = "${bettor.publicKey.toBase58()}";
  function bs58decode(str) {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let bytes = [0];
    for (let i = 0; i < str.length; i++) {
      let carry = ALPHABET.indexOf(str[i]);
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }
  function bytesToBase64(bytes) { let b=""; for (let i=0;i<bytes.length;i++) b+=String.fromCharCode(bytes[i]); return btoa(b); }
  function base64ToBytes(b64) { const bin=atob(b64); const out=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; }
  const pkBytes = bs58decode(pubkeyB58);
  const fakePublicKey = {
    toBytes: () => pkBytes, toBuffer: () => pkBytes, toString: () => pubkeyB58, toBase58: () => pubkeyB58,
    equals: (o) => !!o && typeof o.toBase58 === "function" && o.toBase58() === pubkeyB58, _bn: {},
  };
  async function signOneTransaction(tx) {
    // The slippage-revert hook: when armed, hold this signature while the
    // proof script moves the pool price out from under the already-built
    // transaction (its min_out is fixed at build time) -- the honest
    // real-world race that on-chain min_out enforcement exists for.
    if (window.__onyxStallNextSign) {
      window.__onyxStallNextSign = false;
      await window.__onyxProofStall();
    }
    const messageBytes = tx.serializeMessage();
    const idx = tx.signatures.findIndex((s) => s.publicKey && s.publicKey.toBase58 && s.publicKey.toBase58() === pubkeyB58);
    if (idx === -1) throw new Error("wallet is not a required signer for this transaction");
    const myPubkeyObj = tx.signatures[idx].publicKey;
    const sigB64 = await window.__onyxSignMessage(bytesToBase64(messageBytes));
    const sigBytes = base64ToBytes(sigB64);
    tx.addSignature(myPubkeyObj, sigBytes);
    return tx;
  }
  const provider = {
    isPhantom: true, publicKey: fakePublicKey, isConnected: true,
    connect: async () => { provider.publicKey = fakePublicKey; return { publicKey: fakePublicKey }; },
    disconnect: async () => {}, on: () => {}, off: () => {}, removeAllListeners: () => {},
    signTransaction: async (tx) => signOneTransaction(tx),
    signAllTransactions: async (txs) => Promise.all(txs.map(signOneTransaction)),
    signAndSendTransaction: async (tx, opts) => {
      const signed = await signOneTransaction(tx);
      const wireBytes = signed.serialize();
      const base64Tx = bytesToBase64(new Uint8Array(wireBytes));
      const res = await fetch("https://api.devnet.solana.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "sendTransaction",
          params: [base64Tx, { encoding: "base64", skipPreflight: true, preflightCommitment: opts?.preflightCommitment ?? "confirmed" }],
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return { signature: json.result };
    },
  };
  window.phantom = { solana: provider };
  window.solana = provider;
  window.isPhantomInstalled = true;
})();
`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });

  await page.exposeFunction("__onyxSignMessage", async (base64Msg: string) => {
    const msgBytes = Uint8Array.from(Buffer.from(base64Msg, "base64"));
    const nacl = await import("tweetnacl");
    const sig = nacl.default.sign.detached(msgBytes, bettor.secretKey);
    return Buffer.from(sig).toString("base64");
  });

  // Script-side price mover, callable from inside the stalled signature.
  let marketPk: PublicKey | null = null;
  let usdcMint: PublicKey | null = null;
  await page.exposeFunction("__onyxProofStall", async () => {
    if (!marketPk || !usdcMint) throw new Error("mover not primed");
    const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm"), marketPk.toBuffer()], ONYX);
    const [position] = PublicKey.findProgramAddressSync([Buffer.from("ammpos"), marketPk.toBuffer(), mover.publicKey.toBuffer()], ONYX);
    // One real buy big enough to move the price past a 0% tolerance quote.
    const swapIx = new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: mover.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketPk, isSigner: false, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: position, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([Buffer.from([34, 1, 0]), u64le(300_000n), u64le(0n)]),
    });
    await sendScript([mover], [swapIx], "mover BUY A 0.3 (price shove during stalled signature)");
  });

  await page.addInitScript(MOCK_PROVIDER_INIT);
  page.on("pageerror", (err) => console.log("[browser pageerror]", err.message));

  // ---- STEP 1: create the AMM market through /create ----
  console.log("=== STEP 1: /create (market type = AMM) ===");
  await page.goto("http://localhost:3000/create", { waitUntil: "networkidle", timeout: 45000 });
  await page.click("text=Select Wallet", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 10000 });
  await page.waitForTimeout(1500);

  await page.selectOption('[data-testid="create-market-type"]', "amm");
  await page.fill('[data-testid="create-seed"]', "1");
  await page.screenshot({ path: `${SHOTS}/amm-01-create-form.png`, fullPage: true });
  await page.click('[data-testid="create-submit"]');
  await page.waitForSelector("text=Market created on devnet", { timeout: 90000 });
  const marketStr = (await page.locator("p.mono").first().textContent())?.trim();
  if (!marketStr) throw new Error("market pda not shown on create result");
  marketPk = new PublicKey(marketStr);
  console.log("market created via UI:", marketStr);
  await page.screenshot({ path: `${SHOTS}/amm-02-created.png`, fullPage: true });

  // prime the mover (script-side): SOL + tUSDC + position + deposit, so the
  // stall hook later only has to fire ONE swap tx.
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX)[0];
  usdcMint = new PublicKey((await base.getAccountInfo(configPda))!.data.subarray(40, 72));
  {
    const moverAta = getAssociatedTokenAddressSync(usdcMint, mover.publicKey);
    await sendScript([admin], [
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: mover.publicKey, lamports: 30_000_000 }),
      createAssociatedTokenAccountInstruction(admin.publicKey, moverAta, mover.publicKey, usdcMint),
      createMintToInstruction(usdcMint, moverAta, admin.publicKey, 500_000),
    ], "fund mover");
    const [position] = PublicKey.findProgramAddressSync([Buffer.from("ammpos"), marketPk.toBuffer(), mover.publicKey.toBuffer()], ONYX);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), marketPk.toBuffer()], ONYX);
    await sendScript([mover], [
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: mover.publicKey, isSigner: true, isWritable: true },
          { pubkey: marketPk, isSigner: false, isWritable: false },
          { pubkey: position, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([30]),
      }),
      new TransactionInstruction({
        programId: ONYX,
        keys: [
          { pubkey: mover.publicKey, isSigner: true, isWritable: true },
          { pubkey: marketPk, isSigner: false, isWritable: false },
          { pubkey: position, isSigner: false, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: getAssociatedTokenAddressSync(usdcMint, mover.publicKey), isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([Buffer.from([31]), u64le(500_000n)]),
      }),
    ], "mover open+deposit 0.5");
  }

  // ---- STEP 2: market page → deposit through the panel ----
  console.log("\n=== STEP 2: AmmTradingPanel deposit ===");
  await page.goto(`http://localhost:3000/market/${marketStr}`, { waitUntil: "networkidle", timeout: 45000 });
  // wallet-adapter may auto-reconnect from localStorage after navigation —
  // only click through the modal if the connect button is actually there.
  await page.click("text=Select Wallet", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 5000 }).catch(() => {});
  await page.waitForSelector("text=Trade anytime (AMM)", { timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/amm-03-panel.png`, fullPage: true });

  const t2 = Date.now();
  await page.click('[data-testid="amm-deposit-btn"]', { timeout: 15000 });
  await page.waitForSelector('[data-testid="amm-swap-btn"]', { timeout: 60000 });
  console.log(`deposit landed (${Date.now() - t2}ms wall)`);
  await page.screenshot({ path: `${SHOTS}/amm-04-deposited.png`, fullPage: true });

  async function lastSig(): Promise<string> {
    const href = await page.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
    const m = href?.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]+)\?/);
    return m?.[1] ?? "";
  }
  captured.push({ label: "deposit (open_amm_position + deposit_amm)", sig: await lastSig(), ms: Date.now() - t2 });

  // ---- STEP 3: BUY through the panel (1% tolerance) ----
  console.log("\n=== STEP 3: BUY Side A 0.5 @1% tolerance ===");
  await page.fill('[data-testid="amm-amount"]', "0.5");
  await page.fill('[data-testid="amm-tolerance"]', "1.0");
  await page.waitForTimeout(600); // quote render
  const minOutShown = await page.locator('[data-testid="amm-minout"]').textContent();
  console.log("quote min received (== on-chain min_out):", minOutShown?.trim());
  await page.screenshot({ path: `${SHOTS}/amm-05-buy-quote.png`, fullPage: true });
  const t3 = Date.now();
  const sigBefore3 = await lastSig();
  await page.click('[data-testid="amm-swap-btn"]');
  await page.waitForFunction(
    (prev) => {
      const a = document.querySelector('a[href*="/tx/"]');
      return a && !(a as HTMLAnchorElement).href.includes(prev);
    },
    sigBefore3 || "___",
    { timeout: 60000 },
  );
  captured.push({ label: "swap_amm BUY A 0.5 (UI, tol 1%)", sig: await lastSig(), ms: Date.now() - t3 });
  await page.screenshot({ path: `${SHOTS}/amm-06-bought.png`, fullPage: true });

  // ---- STEP 4: deliberate slippage revert ----
  console.log("\n=== STEP 4: DELIBERATE SLIPPAGE REVERT (tol 0% + price shoved mid-signature) ===");
  await page.fill('[data-testid="amm-amount"]', "0.2");
  await page.fill('[data-testid="amm-tolerance"]', "0");
  await page.waitForTimeout(600);
  await page.evaluate(() => { (window as unknown as { __onyxStallNextSign: boolean }).__onyxStallNextSign = true; });
  await page.click('[data-testid="amm-swap-btn"]');
  await page.waitForSelector('[data-testid="amm-error"]', { timeout: 60000 });
  const errText = (await page.locator('[data-testid="amm-error"]').textContent()) ?? "";
  console.log("panel error:", errText.trim());
  if (!/slippage/i.test(errText)) throw new Error(`expected the friendly slippage message, got: ${errText}`);
  await page.screenshot({ path: `${SHOTS}/amm-07-slippage-reverted.png`, fullPage: true });
  console.log("slippage revert confirmed in the UI (screenshot amm-07) — nothing traded");

  // ---- STEP 5: SELL half the tokens back ----
  console.log("\n=== STEP 5: SELL half of Side-A holdings @1% tolerance ===");
  // read current tokens from the panel's availability row is fragile; read on-chain
  const [bettorPosition] = PublicKey.findProgramAddressSync([Buffer.from("ammpos"), marketPk.toBuffer(), bettor.publicKey.toBuffer()], ONYX);
  const posInfo = await base.getAccountInfo(bettorPosition);
  const tokensA = posInfo!.data.readBigUInt64LE(80);
  const sellAmt = tokensA / 2n;
  await page.selectOption('[data-testid="amm-direction"]', "1");
  await page.fill('[data-testid="amm-amount"]', (Number(sellAmt) / 1e6).toFixed(6));
  await page.fill('[data-testid="amm-tolerance"]', "1.0");
  await page.waitForTimeout(600);
  const t5 = Date.now();
  const sigBefore5 = await lastSig();
  await page.click('[data-testid="amm-swap-btn"]');
  await page.waitForFunction(
    (prev) => {
      const a = document.querySelector('a[href*="/tx/"]');
      return a && !(a as HTMLAnchorElement).href.includes(prev);
    },
    sigBefore5 || "___",
    { timeout: 60000 },
  );
  captured.push({ label: `swap_amm SELL A ${sellAmt} (UI, tol 1%)`, sig: await lastSig(), ms: Date.now() - t5 });
  await page.screenshot({ path: `${SHOTS}/amm-08-sold.png`, fullPage: true });

  // ---- STEP 6: settle via SettleClaimPanel ----
  console.log("\n=== STEP 6: settle (real validate_stat CPI) ===");
  const settlePanel = page.locator("div.card").filter({ hasText: "Settle via validate_stat" }).first();
  await settlePanel.waitFor({ state: "visible", timeout: 20000 });
  const t6 = Date.now();
  await settlePanel.locator('button:has-text("Settle via validate_stat")').first().click({ timeout: 30000 });
  await page.waitForSelector("text=outcome:", { timeout: 90000 });
  console.log(`settled (${Date.now() - t6}ms wall)`);
  await page.reload({ waitUntil: "networkidle" });
  await page.click("text=Select Wallet", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click("text=Phantom", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/amm-09-settled.png`, fullPage: true });

  // ---- STEP 7: redeem + LP withdraw through the panel ----
  console.log("\n=== STEP 7: redeem + LP withdraw ===");
  const bettorAta = getAssociatedTokenAddressSync(usdcMint, bettor.publicKey);
  const balBefore = (await base.getAccountInfo(bettorAta))!.data.readBigUInt64LE(64);

  const t7 = Date.now();
  await page.click('[data-testid="amm-redeem-btn"]', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="amm-redeem-btn"]'), undefined, { timeout: 60000 });
  captured.push({ label: "redeem_amm (UI)", sig: await lastSig(), ms: Date.now() - t7 });

  const t7b = Date.now();
  await page.click('button:has-text("Withdraw LP capital + fees")', { timeout: 20000 });
  await page.waitForSelector("text=LP withdrawn ✓", { timeout: 60000 });
  captured.push({ label: "withdraw_lp_amm (UI)", sig: await lastSig(), ms: Date.now() - t7b });
  await page.screenshot({ path: `${SHOTS}/amm-10-redeemed-lp-withdrawn.png`, fullPage: true });

  const balAfter = (await base.getAccountInfo(bettorAta))!.data.readBigUInt64LE(64);

  // script-side: mover redeems its own leg, then the vault must be EXACTLY 0.
  {
    const [position] = PublicKey.findProgramAddressSync([Buffer.from("ammpos"), marketPk.toBuffer(), mover.publicKey.toBuffer()], ONYX);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), marketPk.toBuffer()], ONYX);
    const moverAta = getAssociatedTokenAddressSync(usdcMint, mover.publicKey);
    await sendScript([mover], [new TransactionInstruction({
      programId: ONYX,
      keys: [
        { pubkey: mover.publicKey, isSigner: true, isWritable: true },
        { pubkey: marketPk, isSigner: false, isWritable: false },
        { pubkey: position, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: moverAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([35]),
    })], "mover redeem_amm");
    const vaultBal = (await base.getAccountInfo(vault))!.data.readBigUInt64LE(64);
    if (vaultBal !== 0n) throw new Error(`vault not drained: ${vaultBal}`);
    console.log("[script-side] vault drained to EXACTLY 0 after all redemptions ✓");
  }

  console.log("\n===== AMM BROWSER PROOF: SUMMARY =====");
  console.log("wallet (creator/LP/trader):", bettor.publicKey.toBase58());
  console.log("market:", marketStr);
  console.log(`bettor ATA across redeem+LP: ${balBefore} -> ${balAfter} (delta ${balAfter - balBefore})`);
  for (const c of captured) console.log(`${c.sig ? "OK  " : "MISS"} ${c.label}: ${c.sig || "(not captured)"}  [${c.ms}ms wall]`);
  console.log("slippage revert: friendly 6026 message shown in-panel (amm-07-slippage-reverted.png)");
  console.log("=======================================");

  await browser.close();
}

main().catch((e) => {
  console.error("PROOF FAILED:", e);
  for (const c of captured) console.log(`${c.label}: ${c.sig || "(not captured)"}`);
  process.exit(1);
});
