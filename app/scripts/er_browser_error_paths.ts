// Self-audit test (never run before): does a REAL on-chain rejection
// actually render as a visible, styled error in ErTradingPanel? Built
// end-to-end (withGuard -> classifyWrongLedger ?? friendlyError -> setError
// -> the `{error && <p className={styles.error}>{error}</p>}` block) but
// never independently watched fire in a real browser.
//
// TEST A (deterministic): corrupt the saved reveal secret in localStorage,
// then click "Reveal now" -- reveal_order_fast checks the revealed values
// hash to the original commitment, so this is a REAL on-chain rejection
// (OnyxError::CommitmentMismatch, 6019), not a simulated one. Confirms the
// error-rendering wiring works at all with a guaranteed-reproducible case.
//
// TEST B (opportunistic, exact wrong-ledger repro): freeze the browser's
// belief that the market is still ER-delegated (intercept the MagicBlock
// router POST), then undelegate market+TA for real via a direct script-side
// call, then click "Cancel & reclaim" in the still-frozen browser. If the
// TA is still readable through the (now-stale) ER connection, this should
// trigger classifyWrongLedger's real ER-rejection branch. If the TA vanishes
// from the ER's view first (unknown until tested), that's reported as a
// finding, not forced further.
//
// Usage: bun run scripts/er_browser_error_paths.ts <marketPda>

import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";

const MARKET = process.argv[2];
if (!MARKET) throw new Error("usage: er_browser_error_paths.ts <marketPda>");

const base = new Connection("https://api.devnet.solana.com", "confirmed");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../_keys/test-bettor.json", "utf8"))));
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
const ROUTER_URL = "https://devnet-router.magicblock.app/";
const SCRATCH = "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad";

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
    tx.addSignature(myPubkeyObj, base64ToBytes(sigB64));
    return tx;
  }
  const provider = {
    isPhantom: true, publicKey: fakePublicKey, isConnected: true,
    connect: async () => { provider.publicKey = fakePublicKey; return { publicKey: fakePublicKey }; },
    disconnect: async () => {}, on: () => {}, off: () => {}, removeAllListeners: () => {},
    signTransaction: async (tx) => signOneTransaction(tx),
    signAllTransactions: async (txs) => Promise.all(txs.map(signOneTransaction)),
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
  page.on("pageerror", (err) => console.log("[browser pageerror]", err.message));

  const url = `http://localhost:3000/market/${MARKET}`;
  console.log("[test] navigating to", url);
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  console.log("[test] connecting wallet...");
  await page.click("text=Select Wallet", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 10000 });
  await page.waitForTimeout(2000);

  const panel = page.locator("div.card").filter({ hasText: "Fast trade (Ephemeral Rollup)" }).first();

  async function click(buttonText: string, timeout = 15000) {
    await panel.locator(`button:has-text("${buttonText}")`).first().click({ timeout });
  }

  // ---- Get to an open-order state: delegate market, deposit+enable, bet ----
  console.log("\n[test] === SETUP: delegate market ===");
  await click("Delegate market to Ephemeral Rollup", 20000);
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "networkidle" });

  console.log("[test] === SETUP: deposit & enable ===");
  await panel.locator('input[placeholder="5"]').first().fill("5");
  await click("Deposit & enable fast trading", 30000);
  await panel.locator('button:has-text("Place bet (ER)")').waitFor({ state: "visible", timeout: 15000 });

  console.log("[test] === SETUP: place bet ===");
  await panel.locator('input[placeholder="1"]').first().fill("1");
  await panel.locator('input[placeholder="50"]').first().fill("50");
  await click("Place bet (ER)", 20000);
  await panel.locator('button:has-text("Cancel")').waitFor({ state: "visible", timeout: 15000 });
  await page.screenshot({ path: `${SCRATCH}/errpath-00-bet-open.png`, fullPage: true });
  console.log("[test] setup complete: open order exists, market delegated");

  // ======================================================================
  // TEST A: corrupted reveal secret -> guaranteed real on-chain rejection
  // ======================================================================
  console.log("\n[test] === TEST A: corrupt localStorage secret, wait for reveal window, click Reveal ===");
  await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("onyx:fast:"));
    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      parsed.nonce = "999999999"; // corrupt -- won't hash to the real on-chain commitment
      localStorage.setItem(k, JSON.stringify(parsed));
      console.log("[page] corrupted secret for", k);
    }
  });

  console.log("[test] waiting for commit window to close...");
  let commitEndTs = 0;
  {
    const info = await base.getAccountInfo(new PublicKey(MARKET));
    commitEndTs = Number(info!.data.readBigInt64LE(102));
  }
  while (Math.floor(Date.now() / 1000) < commitEndTs + 3) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  await page.reload({ waitUntil: "networkidle" });
  await panel.locator('button:has-text("Reveal now")').waitFor({ state: "visible", timeout: 20000 });
  await page.screenshot({ path: `${SCRATCH}/errpath-01-reveal-window-corrupted.png`, fullPage: true });

  console.log("[test] clicking Reveal now with corrupted secret...");
  await click("Reveal now", 20000);
  // Give withGuard's catch a moment to run and setError to flush to the DOM.
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SCRATCH}/errpath-02-reveal-rejected.png`, fullPage: true });

  const errorText = await panel.locator("p").filter({ hasText: /./ }).allTextContents();
  console.log("[test] all <p> text in panel after failed reveal:", JSON.stringify(errorText));

  // Does the error paragraph actually exist and have visible content?
  const errParaCount = await page.locator("p").filter({ hasText: /commitment|reveal|error|report/i }).count();
  console.log(`[test] paragraphs matching error-ish text: ${errParaCount}`);

  // ======================================================================
  // TEST B: opportunistic exact wrong-ledger repro via frozen router state
  // ======================================================================
  console.log("\n[test] === TEST B: freeze router response, undelegate for real, click Cancel ===");

  // Capture the real current delegation status (fqdn) before freezing, so
  // the frozen response is realistic (a real fqdn, not a fabricated one).
  const realStatusRes = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [MARKET] }),
  });
  const realStatusJson = await realStatusRes.json();
  console.log("[test] real router response before freeze:", JSON.stringify(realStatusJson));
  const frozenFqdn = realStatusJson?.result?.fqdn;
  if (!frozenFqdn) {
    console.log("[test] TEST B SKIPPED: could not read a real fqdn to freeze (market may not actually be delegated per the router)");
  } else {
    await page.route(ROUTER_URL, async (route) => {
      const req = route.request();
      const body = req.postDataJSON();
      if (body?.method === "getDelegationStatus") {
        console.log("[test] intercepted getDelegationStatus for", body.params?.[0], "-> forcing frozen isDelegated:true");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { isDelegated: true, fqdn: frozenFqdn } }),
        });
        return;
      }
      await route.continue();
    });

    // Undelegate market + TA for REAL, script-side, direct to base -- same
    // instruction the UI's own "Move to base" button would send, just
    // triggered out-of-band so the browser's cached belief goes stale.
    const { buildUndelegateManyIx } = await import("../src/lib/instructions");
    const marketPk = new PublicKey(MARKET);
    const [tradingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("trading"), marketPk.toBuffer(), bettor.publicKey.toBuffer()],
      ONYX,
    );
    console.log("[test] undelegating market + TA out-of-band (script-side, real tx)...");
    const undelegateIx = buildUndelegateManyIx({ payer: bettor.publicKey, delegated: [marketPk, tradingPda] });
    const erConn = new Connection(frozenFqdn.startsWith("http") ? frozenFqdn : `https://${frozenFqdn}`, "confirmed");
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), undelegateIx);
    const { blockhash, lastValidBlockHeight } = await erConn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = bettor.publicKey;
    tx.sign(bettor);
    const undelegateSig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const conf = await erConn.confirmTransaction({ signature: undelegateSig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log("[test] out-of-band undelegate sig:", undelegateSig, "err:", JSON.stringify(conf.value.err));

    // Confirm on base that ownership actually flipped back before proceeding.
    for (let i = 0; i < 15; i++) {
      const m = await base.getAccountInfo(marketPk);
      if (m && m.owner.equals(ONYX)) { console.log("[test] base confirms market ownership restored to ONYX"); break; }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Try reading the TA back through the (now-stale) ER connection, to see
    // whether it's still visible there post-undelegate (determines whether
    // the browser's Cancel button will still be clickable).
    const taAfterViaEr = await erConn.getAccountInfo(tradingPda).catch((e) => { console.log("[test] ER read threw:", String(e)); return null; });
    console.log("[test] TA readable via ER post-undelegate?", taAfterViaEr ? `yes, ${taAfterViaEr.data.length} bytes, owner=${taAfterViaEr.owner.toBase58()}` : "no (null)");

    // Now click Cancel in the still-frozen browser -- it still believes
    // isDelegated:true (route intercepted), so ErTradingPanel's `connection`
    // prop is still the ER connection, and cancel_order_fast will be built
    // and sent there for an account that's no longer authoritative there.
    const cancelVisible = await panel.locator('button:has-text("Cancel")').first().isVisible().catch(() => false);
    console.log("[test] Cancel button still visible in frozen browser?", cancelVisible);
    if (cancelVisible) {
      await page.screenshot({ path: `${SCRATCH}/errpath-03-before-race-click.png`, fullPage: true });
      console.log("[test] clicking Cancel against the now-undelegated account...");
      await click("Cancel", 20000).catch((e) => console.log("[test] click threw/timed out:", String(e)));
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${SCRATCH}/errpath-04-after-race-click.png`, fullPage: true });
      const raceErrorText = await panel.locator("p").filter({ hasText: /./ }).allTextContents();
      console.log("[test] all <p> text in panel after race click:", JSON.stringify(raceErrorText));
    } else {
      console.log("[test] TEST B INCONCLUSIVE: Cancel button disappeared once the frontend's OWN poll (TA/market data, not just delegation status) caught up to the real undelegated state -- the exact race window is narrower than one poll tick, could not force it this way.");
      await page.screenshot({ path: `${SCRATCH}/errpath-03-cancel-gone.png`, fullPage: true });
    }
  }

  await browser.close();
}

main().catch((e) => {
  console.error("[test] FAILED:", e);
  process.exit(1);
});
