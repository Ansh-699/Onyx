// Browser-driven acceptance proof for ER-fast trading (task from the user:
// "prove that specifically... give me wallet-signed tx sigs from the
// browser, not script-signed"). Launches the ACTUAL dev server pages in a
// real Chromium browser and clicks through the real UI — every transaction
// is built by the real ErTradingPanel.tsx code (React state, hooks, the
// erRouting connection resolution) and signed by an injected wallet-
// adapter-compatible provider.
//
// HONESTY NOTE on what this is and isn't: the injected provider is backed
// by a REAL devnet Keypair (test-bettor.json) that genuinely holds and
// spends real devnet SOL/tUSDC, and every signature below is produced by
// that real key signing the REAL transaction object the page's own
// wallet-adapter code constructed -- so this exercises the exact same
// production code path a real Phantom user would trigger (RPC routing
// logic, React handlers, buildXIx calls invoked via actual button clicks).
// It is NOT the user's own Phantom extension clicking -- there's no way to
// script that without the user's own session. Treat this as strong
// UI-code-path proof, with a clear "your turn" checklist to redo live at
// the end.
//
// Usage: cd onyx && bun run services/ingestion/src/er_browser_proof.ts <marketPda>

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const MARKET = process.argv[2];
if (!MARKET) throw new Error("usage: er_browser_proof.ts <marketPda>");

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../_keys/test-bettor.json", "utf8"))));
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");

interface Captured {
  label: string;
  sig: string;
  ms: number;
}
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
  function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const pkBytes = bs58decode(pubkeyB58);
  const fakePublicKey = {
    toBytes: () => pkBytes,
    toBuffer: () => pkBytes,
    toString: () => pubkeyB58,
    toBase58: () => pubkeyB58,
    equals: (o) => !!o && typeof o.toBase58 === "function" && o.toBase58() === pubkeyB58,
    _bn: {},
  };

  async function signOneTransaction(tx) {
    // tx is a REAL @solana/web3.js Transaction from the page's own bundle
    // (built by the real ErTradingPanel/instructions.ts code). We sign its
    // message bytes via a Node-side bridge (window.__onyxSignMessage,
    // exposed by Playwright) using the real secret key, then attach the
    // signature back onto the SAME object via its own real addSignature
    // method -- no reconstruction, no cross-bundle Buffer issues.
    //
    // serializeMessage() must run BEFORE inspecting tx.signatures -- it's
    // what triggers Transaction._compile(), which actually populates
    // tx.signatures from the instructions' account metas. Checking
    // signatures first (as an earlier draft of this script did) always saw
    // an empty array and threw "not a required signer" on every real tx.
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
    isPhantom: true,
    publicKey: fakePublicKey,
    isConnected: true,
    connect: async () => {
      provider.publicKey = fakePublicKey;
      return { publicKey: fakePublicKey };
    },
    disconnect: async () => {},
    on: () => {},
    off: () => {},
    removeAllListeners: () => {},
    signTransaction: async (tx) => signOneTransaction(tx),
    signAllTransactions: async (txs) => Promise.all(txs.map(signOneTransaction)),
    signMessage: async (msg) => {
      const sigB64 = await window.__onyxSignMessage(bytesToBase64(msg));
      return { signature: base64ToBytes(sigB64) };
    },
  };
  window.phantom = { solana: provider };
  window.solana = provider;
  window.isPhantomInstalled = true;
  window.__onyxCaptured = [];
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

  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("[browser console.error]", msg.text());
  });
  page.on("pageerror", (err) => console.log("[browser pageerror]", err.message));

  const url = `http://localhost:3000/market/${MARKET}`;
  console.log("[proof] navigating to", url);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

  console.log("[proof] connecting wallet...");
  await page.click("text=Select Wallet", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 10000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-01-connected.png", fullPage: true });

  // Scoped to the ER panel specifically -- the page ALSO has a collapsed
  // <details> disclosure wrapping the classic SealedOrderPanel, which uses
  // near-identical form markup (same placeholders). An unscoped locator can
  // resolve to that hidden, collapsed copy instead of the real (possibly
  // not-yet-rendered) ER one, and Playwright's "element is not visible"
  // retry loop times out silently on it -- exactly what happened on the
  // first attempt at this script.
  const panel = page.locator("div.card").filter({ hasText: "Fast trade (Ephemeral Rollup)" }).first();

  async function clickAndCapture(
    label: string,
    buttonTextOrLocator: string,
    opts?: { timeout?: number; exact?: boolean; root?: ReturnType<typeof page.locator> },
  ) {
    const t0 = Date.now();
    const root = opts?.root ?? panel;
    const locator = opts?.exact
      ? root.getByRole("button", { name: buttonTextOrLocator, exact: true })
      : root.locator(`button:has-text("${buttonTextOrLocator}")`).first();
    await locator.click({ timeout: opts?.timeout ?? 15000 });
    // Wait for THIS root's "last tx" link to update, then read the sig out
    // of the href. Scoped per-root because settle_market's button lives in
    // a DIFFERENT card (SettleClaimPanel) with its own independent "last
    // tx" line -- an unscoped page-wide search would grab whichever "last
    // tx" link appears first in DOM order (the ER panel's, always, since it
    // renders before SettleClaimPanel), returning a STALE signature from a
    // prior step instead of the new one.
    await page.waitForTimeout(500);
    let sig = "";
    for (let i = 0; i < 40; i++) {
      const href = await root.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
      if (href) {
        const m = href.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]+)\?/);
        if (m) { sig = m[1]!; break; }
      }
      await page.waitForTimeout(500);
    }
    const ms = Date.now() - t0;
    console.log(`[proof] ${label} -> ${sig || "(no sig captured — check screenshot)"} (${ms}ms wall)`);
    captured.push({ label, sig, ms });
    return sig;
  }

  // ---- Step 1: delegate market ----
  // Resumable: if a prior run of this script already got the market
  // delegated (e.g. an external interruption killed the process right
  // after this step landed, as actually happened once during development),
  // the "Delegate market" button simply won't be on the page -- skip
  // straight to step 2 instead of failing on a button that doesn't exist.
  console.log("\n[proof] === STEP 1: delegate market ===");
  const marketAlreadyDelegated = (await base.getAccountInfo(new PublicKey(MARKET)))?.owner.equals(
    new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"),
  );
  if (marketAlreadyDelegated) {
    console.log("[proof] market already delegated (resuming a prior run) -- skipping step 1");
  } else {
    await clickAndCapture("delegate_market", "Delegate market to Ephemeral Rollup");
    await page.waitForTimeout(3000); // let delegation status propagate through the router
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-02-delegated.png", fullPage: true });

  // ---- Step 2: deposit & enable ----
  console.log("\n[proof] === STEP 2: deposit & enable trading account ===");
  const depositInput = panel.locator('input[placeholder="5"]').first();
  await depositInput.fill("5");
  await clickAndCapture("deposit_trading + delegate_trading_account", "Deposit & enable fast trading", { timeout: 30000 });
  // Wait for the bet form to actually render (frontend poll needs a tick to
  // pick up the just-created TradingAccount) rather than a fixed sleep --
  // this exact race (form not yet visible) is what broke the first attempt.
  await panel.locator('button:has-text("Place bet (ER)")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-03-deposited.png", fullPage: true });

  // ---- Step 3: place bet #1 ----
  console.log("\n[proof] === STEP 3: place bet ===");
  const sizeInput = panel.locator('input[placeholder="1"]').first();
  const limitInput = panel.locator('input[placeholder="50"]').first();
  await sizeInput.fill("1");
  await limitInput.fill("50");
  await clickAndCapture("submit_order_fast (bet #1)", "Place bet (ER)", { timeout: 20000 });
  await panel.locator('button:has-text("Resize")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-04-bet-placed.png", fullPage: true });

  // ---- Step 4: resize ----
  console.log("\n[proof] === STEP 4: resize bet ===");
  const resizeSize = panel.locator('input[value="1"]').first();
  await resizeSize.fill("1.5").catch(() => console.log("[proof] resize size field not found by value selector, trying generic"));
  await clickAndCapture("cancel_order_fast + submit_order_fast (resize)", "Resize", { timeout: 20000 });
  await panel.locator('button:has-text("Resize")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-05-resized.png", fullPage: true });

  // ---- Step 5: cancel entirely ----
  console.log("\n[proof] === STEP 5: cancel ===");
  await clickAndCapture("cancel_order_fast (full cancel)", "Cancel", { timeout: 20000 });
  await panel.locator('button:has-text("Place bet (ER)")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-06-cancelled.png", fullPage: true });

  // ---- Step 6: place the FINAL bet that will actually go through ----
  console.log("\n[proof] === STEP 6: place final bet (will be matched) ===");
  await sizeInput.fill("1");
  await limitInput.fill("50");
  await clickAndCapture("submit_order_fast (final bet)", "Place bet (ER)", { timeout: 20000 });
  await panel.locator('button:has-text("Resize")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-07-final-bet.png", fullPage: true });

  console.log("\n[proof] waiting for commit window to close (checking market state directly)...");
  let commitEndTs = 0;
  {
    const info = await base.getAccountInfo(new PublicKey(MARKET));
    commitEndTs = Number(info!.data.readBigInt64LE(102));
  }
  while (Math.floor(Date.now() / 1000) < commitEndTs + 3) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("[proof] commit window closed, reloading page...");
  await page.reload({ waitUntil: "networkidle" });
  await panel.locator('button:has-text("Reveal now")').waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-08-reveal-window.png", fullPage: true });

  // ---- Step 7: reveal ----
  console.log("\n[proof] === STEP 7: reveal ===");
  await clickAndCapture("reveal_order_fast", "Reveal now", { timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-09-revealed.png", fullPage: true });

  console.log("\n[proof] waiting for reveal window to close...");
  let revealEndTs = 0;
  {
    const info = await base.getAccountInfo(new PublicKey(MARKET));
    revealEndTs = Number(info!.data.readBigInt64LE(110));
  }
  while (Math.floor(Date.now() / 1000) < revealEndTs + 3) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("[proof] reveal window closed, reloading...");
  await page.reload({ waitUntil: "networkidle" });
  await panel.locator('button:has-text("Run batch match now")').waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-10-match-ready.png", fullPage: true });

  // ---- Step 8: run batch match ----
  console.log("\n[proof] === STEP 8: run batch match ===");
  await clickAndCapture("run_batch_match_fast", "Run batch match now", { timeout: 20000 });
  await panel.locator('button:has-text("Move to base")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-11-matched.png", fullPage: true });

  // ---- Step 9: undelegate ----
  console.log("\n[proof] === STEP 9: undelegate ===");
  await clickAndCapture("undelegate (market + all trading accounts)", "Move to base (undelegate)", { timeout: 20000 });
  console.log("[proof] waiting for base to show ownership restored...");
  for (let i = 0; i < 30; i++) {
    const m = await base.getAccountInfo(new PublicKey(MARKET));
    if (m && m.owner.equals(ONYX)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await page.reload({ waitUntil: "networkidle" });
  // SettleClaimPanel is a DIFFERENT card from the ER panel -- wait for ITS
  // button specifically, page-wide (not scoped to `panel`).
  const settlePanel = page.locator("div.card").filter({ hasText: "Settle via validate_stat" }).first();
  await settlePanel.waitFor({ state: "visible", timeout: 20000 }).catch(() =>
    console.log("[proof] settle button not visible after undelegate -- market may not be provable-gated, check screenshot"),
  );
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-12-undelegated.png", fullPage: true });

  // ---- Step 10: settle (existing SettleClaimPanel, unchanged) ----
  console.log("\n[proof] === STEP 10: settle ===");
  await clickAndCapture("settle_market", "Settle via validate_stat", { timeout: 30000, root: settlePanel });
  await page.reload({ waitUntil: "networkidle" });
  await panel.locator('button:has-text("Withdraw")').waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-13-settled.png", fullPage: true });

  // ---- Step 11: withdraw ----
  console.log("\n[proof] === STEP 11: withdraw ===");
  const ataBefore = await base.getAccountInfo(getAssociatedTokenAddressSync(new PublicKey((await base.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX)[0]))!.data.subarray(40, 72)), bettor.publicKey));
  const balBefore = ataBefore ? ataBefore.data.readBigUInt64LE(64) : 0n;
  await clickAndCapture("withdraw_trading", "Withdraw", { timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/browser-14-withdrawn.png", fullPage: true });

  const ataAfter = await base.getAccountInfo(getAssociatedTokenAddressSync(new PublicKey((await base.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX)[0]))!.data.subarray(40, 72)), bettor.publicKey));
  const balAfter = ataAfter ? ataAfter.data.readBigUInt64LE(64) : 0n;

  console.log("\n===== BROWSER-DRIVEN PROOF: SUMMARY =====");
  console.log("wallet:", bettor.publicKey.toBase58());
  console.log("market:", MARKET);
  console.log(`bettor ATA: ${balBefore} -> ${balAfter} (delta ${balAfter - balBefore})`);
  for (const c of captured) {
    console.log(`${c.sig ? "OK  " : "MISS"} ${c.label}: ${c.sig || "(not captured)"}  [${c.ms}ms wall]`);
  }
  console.log("===========================================");

  await browser.close();
}

main().catch((e) => {
  console.error("[proof] FAILED:", e);
  console.log("\n===== PARTIAL RESULTS =====");
  for (const c of captured) console.log(`${c.label}: ${c.sig || "(not captured)"}`);
  process.exit(1);
});
