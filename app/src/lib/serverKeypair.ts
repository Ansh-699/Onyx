import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

/**
 * The server-side signing key (mint authority / house / treasury), from
 * ANCHOR_WALLET.
 *
 * ANCHOR_WALLET was path-only, which is unsettable on Vercel: there is no
 * filesystem to put a keypair on, so every route that signs (faucet,
 * house-counter, house-counter-fast, buy-usdc) 500s in a serverless deploy.
 * Accept the raw JSON array too, so the same variable works as a path locally
 * and as the key itself in a hosted env.
 */
export function loadServerKeypair(): Keypair {
  const v = process.env.ANCHOR_WALLET;
  if (!v) throw new Error("ANCHOR_WALLET not set (server env) — a keypair path, or the secret-key JSON array itself");
  const text = v.trim().startsWith("[") ? v : readFileSync(v, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
}
