// Centralized, env-driven config for the TxLINE ingestion service.
// Values are read from process.env (Bun loads .env automatically).

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const NETWORK = (process.env.ONYX_NETWORK ?? "devnet") as
  | "devnet"
  | "mainnet";

// TxLINE API host must match the network. Devnet -> txline-dev, mainnet -> txline.
export const API_ORIGIN = req(
  "TXLINE_API_ORIGIN",
  NETWORK === "mainnet"
    ? "https://txline.txodds.com"
    : "https://txline-dev.txodds.com",
);
export const API_BASE_URL = req("TXLINE_API_BASE_URL", `${API_ORIGIN}/api`);
export const JWT_URL = req("TXLINE_JWT_URL", `${API_ORIGIN}/auth/guest/start`);

export const SERVICE_LEVEL_ID = Number(
  process.env.TXLINE_SERVICE_LEVEL_ID ?? "1",
);
export const DURATION_WEEKS = Number(process.env.TXLINE_DURATION_WEEKS ?? "4");

export const SOLANA_RPC_URL = req(
  "SOLANA_RPC_URL",
  "https://api.devnet.solana.com",
);
export const ANCHOR_WALLET = process.env.ANCHOR_WALLET ?? "./_keys/devnet-wallet.json";

export const TXORACLE_PROGRAM_ID = req(
  "TXORACLE_PROGRAM_ID",
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
);
export const TXL_MINT = req(
  "TXL_MINT",
  "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
);

// Pre-supplied credentials (skip on-chain subscribe + activate when present).
export const PRESET_JWT = process.env.TXLINE_JWT || undefined;
export const PRESET_API_TOKEN = process.env.TXLINE_API_TOKEN || undefined;
