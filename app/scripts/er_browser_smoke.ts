// Quick validation of the injected-wallet signing bridge before running the
// full multi-minute lifecycle proof: connect, click ONLY "delegate market",
// confirm a real signature comes back. Bails immediately on failure.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Keypair } from "@solana/web3.js";

const MARKET = process.argv[2];
if (!MARKET) throw new Error("usage: er_browser_smoke.ts <marketPda>");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../_keys/test-bettor.json", "utf8"))));

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
    // serializeMessage() triggers Transaction._compile(), which is what
    // actually POPULATES tx.signatures from the instructions' account metas
    // -- must run before inspecting tx.signatures, not after (that ordering
    // bug is exactly what made this throw "not a required signer" on every
    // real transaction during initial testing: tx.signatures was still [].)
    const messageBytes = tx.serializeMessage();
    console.log("[page] signTransaction called, signatures required:", tx.signatures.length);
    const idx = tx.signatures.findIndex((s) => s.publicKey && s.publicKey.toBase58 && s.publicKey.toBase58() === pubkeyB58);
    console.log("[page] my signer index:", idx);
    if (idx === -1) throw new Error("wallet is not a required signer for this transaction");
    const myPubkeyObj = tx.signatures[idx].publicKey;
    const sigB64 = await window.__onyxSignMessage(bytesToBase64(messageBytes));
    const sigBytes = base64ToBytes(sigB64);
    console.log("[page] got sig back, len:", sigBytes.length);
    tx.addSignature(myPubkeyObj, sigBytes);
    console.log("[page] addSignature succeeded");
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
    console.log("[node] signed message, sig len:", sig.length);
    return Buffer.from(sig).toString("base64");
  });
  await page.addInitScript(MOCK_PROVIDER_INIT);
  page.on("console", (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.log("[browser pageerror]", err.message));

  await page.goto(`http://localhost:3000/market/${MARKET}`, { waitUntil: "networkidle", timeout: 30000 });
  console.log("[smoke] page loaded");

  await page.click("text=Select Wallet", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 10000 });
  // Selecting a wallet whose readyState is Installed auto-connects (this
  // WalletProvider has autoConnect set) -- no separate "Connect" click needed.
  await page.waitForTimeout(2000);
  console.log("[smoke] wallet connect flow done");

  const overlayText = await page.locator("text=Issue").first().isVisible().catch(() => false);
  if (overlayText) {
    console.log("[smoke] *** Next.js dev error overlay is showing an issue ***");
    const detail = await page.evaluate(() => {
      const el = document.querySelector('[data-nextjs-dialog-body], [id*="nextjs__container_errors"]');
      return el?.textContent ?? "(overlay present but couldn't extract text via that selector)";
    });
    console.log("[smoke] overlay content:", detail);
  }

  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/smoke-connected.png", fullPage: true });

  const connectedText = await page.locator("body").textContent();
  console.log("[smoke] wallet button area shows connected:", connectedText?.includes(bettor.publicKey.toBase58().slice(0, 4)) ?? "unknown");

  const btn = page.locator('button:has-text("Delegate market to Ephemeral Rollup")').first();
  const btnCount = await btn.count();
  console.log("[smoke] delegate button found:", btnCount);
  if (btnCount === 0) {
    console.log("[smoke] delegate button not present -- market may already be delegated, or step gating differs. Dumping panel text:");
    const panelText = await page.locator("text=Fast trade").locator("..").locator("..").textContent().catch(() => "(could not extract)");
    console.log(panelText);
    await browser.close();
    return;
  }

  await btn.click({ timeout: 15000 });
  console.log("[smoke] clicked delegate button, waiting for tx...");
  await page.waitForTimeout(3000);

  const href = await page.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
  console.log("[smoke] last tx href:", href);
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/smoke-after-delegate.png", fullPage: true });

  await browser.close();
}
main().catch((e) => { console.error("[smoke] FAILED:", e); process.exit(1); });
