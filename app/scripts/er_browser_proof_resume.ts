// Continuation of er_browser_proof.ts's lifecycle, starting from "run batch
// match", for a market where steps 1-7 (delegate, deposit+enable, bet,
// resize, cancel, final bet, reveal) already landed on-chain (independently
// verified via direct ER-connection reads) but the browser session that
// drove them was interrupted by an environment network outage before it
// could continue. Same real injected-wallet-with-real-signing approach as
// the main script -- see that file's header for the full honesty note.
//
// Usage: bun run scripts/er_browser_proof_resume.ts <marketPda>

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const MARKET = process.argv[2];
if (!MARKET) throw new Error("usage: er_browser_proof_resume.ts <marketPda>");

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../_keys/test-bettor.json", "utf8"))));
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");

interface Captured { label: string; sig: string; ms: number; }
const captured: Captured[] = [];

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
    // Needed for SettleClaimPanel, which (correctly, deliberately left
    // unchanged) uses wallet-adapter's sendTransaction() convenience
    // wrapper -- that calls THIS method directly, not signTransaction. Real
    // Phantom submits via its own internal RPC when this path is used; this
    // action is always base-only anyway (settle_market never targets the
    // ER), so submitting straight to public base devnet RPC here is a
    // faithful match for what a real wallet would actually do for this
    // specific instruction, not a shortcut.
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

  await page.exposeFunction("__onyxSignMessage", async (base64Msg: string) => {
    const msgBytes = Uint8Array.from(Buffer.from(base64Msg, "base64"));
    const nacl = await import("tweetnacl");
    const sig = nacl.default.sign.detached(msgBytes, bettor.secretKey);
    return Buffer.from(sig).toString("base64");
  });
  await page.addInitScript(MOCK_PROVIDER_INIT);
  page.on("console", (msg) => { if (msg.type() === "error") console.log("[browser console.error]", msg.text()); });
  page.on("pageerror", (err) => console.log("[browser pageerror]", err.message));

  const url = `http://localhost:3000/market/${MARKET}`;
  console.log("[resume] navigating to", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Each chromium.launch() is a fresh, isolated browser profile -- there's
  // no persisted wallet-adapter localStorage from the earlier (separate)
  // script run for autoConnect to find, so the connect flow has to run
  // again here explicitly (confirmed by screenshot: the panel showed
  // fully-correct live ER data with the wallet still reading "Select
  // Wallet").
  console.log("[resume] connecting wallet...");
  await page.click("text=Select Wallet", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 10000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/resume-00-loaded.png", fullPage: true });

  const panel = page.locator("div.card").filter({ hasText: "Fast trade (Ephemeral Rollup)" }).first();

  async function clickAndCapture(label: string, buttonText: string, opts?: { timeout?: number; root?: ReturnType<typeof page.locator> }) {
    const t0 = Date.now();
    const root = opts?.root ?? panel;
    const locator = root.locator(`button:has-text("${buttonText}")`).first();
    // Capture whatever sig is showing BEFORE the click, so we can positively
    // confirm the post-click sig is NEW -- a real gap in the first version
    // of this proof, which once mis-attributed a stale "last tx" href to a
    // later step because it never checked for a change.
    const before = await root.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
    await locator.click({ timeout: opts?.timeout ?? 15000 });
    let sig = "";
    for (let i = 0; i < 40; i++) {
      const href = await root.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
      if (href && href !== before) {
        const m = href.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]+)\?/);
        if (m) { sig = m[1]!; break; }
      }
      await page.waitForTimeout(500);
    }
    const ms = Date.now() - t0;
    console.log(`[resume] ${label} -> ${sig || "(no NEW sig captured — check screenshot)"} (${ms}ms wall)`);
    captured.push({ label, sig, ms });
    return sig;
  }

  // ---- Steps 8-9 (run batch match, undelegate) already landed on-chain in
  // the previous invocation of this script -- independently verified via
  // direct RPC read (market owner=ONYX, phase=Matched, clearingPrice=10%)
  // before writing this continuation. Only settle (which failed because
  // the mock provider didn't yet implement signAndSendTransaction) and a
  // second withdraw (for the now-claimable matched-winnings leg) remain.
  console.log("\n[resume] steps 8-9 (match, undelegate) already confirmed on-chain from the prior run -- skipping straight to settle");
  const settlePanel = page.locator("div.card").filter({ hasText: "Settle via validate_stat" }).first();
  await settlePanel.waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/resume-02-undelegated.png", fullPage: true });

  // ---- Step 10: settle ----
  console.log("\n[resume] === STEP 10: settle ===");
  await clickAndCapture("settle_market", "Settle via validate_stat", { timeout: 30000, root: settlePanel });
  await page.reload({ waitUntil: "domcontentloaded" });
  await panel.locator('button:has-text("Withdraw")').waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/resume-03-settled.png", fullPage: true });

  // ---- Step 11: withdraw ----
  console.log("\n[resume] === STEP 11: withdraw ===");
  const usdcMint = new PublicKey((await base.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX)[0]))!.data.subarray(40, 72));
  const bettorAta = getAssociatedTokenAddressSync(usdcMint, bettor.publicKey);
  const ataBefore = await base.getAccountInfo(bettorAta);
  const balBefore = ataBefore ? ataBefore.data.readBigUInt64LE(64) : 0n;
  await clickAndCapture("withdraw_trading", "Withdraw", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/resume-04-withdrawn.png", fullPage: true });

  const ataAfter = await base.getAccountInfo(bettorAta);
  const balAfter = ataAfter ? ataAfter.data.readBigUInt64LE(64) : 0n;

  console.log("\n===== RESUME PROOF: SUMMARY =====");
  console.log("wallet:", bettor.publicKey.toBase58());
  console.log("market:", MARKET);
  console.log(`bettor ATA: ${balBefore} -> ${balAfter} (delta ${balAfter - balBefore})`);
  for (const c of captured) console.log(`${c.sig ? "OK  " : "MISS"} ${c.label}: ${c.sig || "(not captured)"}  [${c.ms}ms wall]`);
  console.log("===================================");

  await browser.close();
}

main().catch((e) => {
  console.error("[resume] FAILED:", e);
  console.log("\n===== PARTIAL RESULTS =====");
  for (const c of captured) console.log(`${c.label}: ${c.sig || "(not captured)"}`);
  process.exit(1);
});
