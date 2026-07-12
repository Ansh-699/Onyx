// Final step of the lifecycle: settle already landed
// (5HvwFuPej1CDNkP29QbvcWM2cxXaSifRJfbXWapoWRxxL6GQLmEJP4BwitvZEyc4HtiKyu5rBJgk7vdcD9EcS2WY,
// disc=5 settle_market, err:none, independently confirmed via
// getSignaturesForAddress). This claims the now-unlocked matched-winnings
// leg via a second withdraw_trading call, same real-signing injected
// wallet as the rest of this proof.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const MARKET = process.argv[2];
if (!MARKET) throw new Error("usage: er_browser_final_withdraw.ts <marketPda>");
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const bettor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("../_keys/test-bettor.json", "utf8"))));
const ONYX = new PublicKey("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");

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
  window.phantom = { solana: {
    isPhantom: true, publicKey: fakePublicKey, isConnected: true,
    connect: async () => ({ publicKey: fakePublicKey }),
    disconnect: async () => {}, on: () => {}, off: () => {}, removeAllListeners: () => {},
    signTransaction: async (tx) => signOneTransaction(tx),
    signAllTransactions: async (txs) => Promise.all(txs.map(signOneTransaction)),
  }};
  window.solana = window.phantom.solana;
  window.isPhantomInstalled = true;
})();
`;

async function main() {
  const usdcMint = new PublicKey((await base.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], ONYX)[0]))!.data.subarray(40, 72));
  const bettorAta = getAssociatedTokenAddressSync(usdcMint, bettor.publicKey);
  const balBefore = (await base.getAccountInfo(bettorAta))!.data.readBigUInt64LE(64);
  console.log("[final] bettor ATA before:", balBefore);

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

  await page.goto(`http://localhost:3000/market/${MARKET}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.click("text=Select Wallet", { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.click("text=Phantom", { timeout: 10000 });
  await page.waitForTimeout(2000);

  const panel = page.locator("div.card").filter({ hasText: "Fast trade (Ephemeral Rollup)" }).first();
  await panel.locator('button:has-text("Withdraw")').waitFor({ state: "visible", timeout: 20000 });
  const before = await panel.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
  await panel.locator('button:has-text("Withdraw")').first().click({ timeout: 15000 });

  let sig = "";
  for (let i = 0; i < 40; i++) {
    const href = await panel.locator('a:has-text("last tx")').first().getAttribute("href").catch(() => null);
    if (href && href !== before) {
      const m = href.match(/\/tx\/([1-9A-HJ-NP-Za-km-z]+)\?/);
      if (m) { sig = m[1]!; break; }
    }
    await page.waitForTimeout(500);
  }
  console.log("[final] withdraw_trading (winnings leg) ->", sig || "(not captured)");
  await page.screenshot({ path: "/tmp/claude-1000/-home-anshtyagi-Documents-worldcup/a3bee9fc-78fa-4362-b7ff-85bf4d3f06aa/scratchpad/final-withdraw.png", fullPage: true });
  await browser.close();

  await new Promise((r) => setTimeout(r, 2000));
  const balAfter = (await base.getAccountInfo(bettorAta))!.data.readBigUInt64LE(64);
  console.log("[final] bettor ATA after:", balAfter, "delta:", balAfter - balBefore);
}
main().catch((e) => { console.error("[final] FAILED:", e); process.exit(1); });
