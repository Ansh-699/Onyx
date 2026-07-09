// TxLINE 3-step auth, verified against txodds/tx-on-chain examples/devnet.
//
//   Step 1: POST /auth/guest/start            -> { token }  (guest JWT, 30d)
//   Step 2: on-chain `subscribe(serviceLevelId, weeks)` via txoracle (free tier = 0 cost,
//           but still a real Token-2022 subscription tx that registers the wallet)
//   Step 3: POST /api/token/activate { txSig, walletSignature, leagues } -> X-Api-Token
//
// Data calls then send BOTH headers:
//   Authorization: Bearer <jwt>
//   X-Api-Token:   <apiToken>
//
// If TXLINE_JWT + TXLINE_API_TOKEN are provided in env, steps 2-3 are skipped.

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";
import * as cfg from "./config";
import txoracleIdl from "../../../idl/txoracle.json" with { type: "json" };

export interface AuthState {
  jwt: string;
  apiToken: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Step 1: acquire a guest JWT. */
export async function getGuestJwt(): Promise<string> {
  const res = await fetch(cfg.JWT_URL, { method: "POST" });
  if (!res.ok) throw new Error(`guest/start failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  if (!body.token) throw new Error("guest/start returned no token");
  return body.token;
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Full 3-step activation. Returns { jwt, apiToken }.
 * Requires a funded devnet keypair at cfg.ANCHOR_WALLET for the on-chain subscribe.
 */
export async function activate(opts?: {
  serviceLevelId?: number;
  weeks?: number;
  selectedLeagues?: number[];
}): Promise<AuthState> {
  // Fast path: caller provided credentials.
  if (cfg.PRESET_JWT && cfg.PRESET_API_TOKEN) {
    return { jwt: cfg.PRESET_JWT, apiToken: cfg.PRESET_API_TOKEN };
  }

  const serviceLevelId = opts?.serviceLevelId ?? cfg.SERVICE_LEVEL_ID;
  const weeks = opts?.weeks ?? cfg.DURATION_WEEKS;
  const selectedLeagues = opts?.selectedLeagues ?? [];

  if (weeks < 4 || weeks % 4 !== 0) {
    throw new Error(`weeks must be a multiple of 4 (got ${weeks})`);
  }

  const jwt = cfg.PRESET_JWT ?? (await getGuestJwt());

  const connection = new Connection(cfg.SOLANA_RPC_URL, "confirmed");
  const user = loadKeypair(cfg.ANCHOR_WALLET);
  const wallet = new anchor.Wallet(user);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // The vendored IDL's embedded `address` is the MAINNET txoracle program id;
  // override it with the network-correct id from config before constructing
  // the Program, or devnet calls silently target the wrong (undeployed) id.
  const idlForNetwork = { ...txoracleIdl, address: cfg.TXORACLE_PROGRAM_ID } as anchor.Idl;
  const program = new anchor.Program(idlForNetwork, provider);
  const tokenMint = new PublicKey(cfg.TXL_MINT);

  // Ensure the user's Token-2022 ATA exists (holds the free subscription mint).
  const userAta = getAssociatedTokenAddressSync(
    tokenMint,
    user.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const ataInfo = await connection.getAccountInfo(userAta);
  if (!ataInfo) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey,
        userAta,
        user.publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [user], {
      commitment: "confirmed",
    });
    await delay(3000);
  }

  // Derive shared PDAs.
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId,
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId,
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    tokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  // Step 2: on-chain subscribe.
  const tx = await program.methods
    .subscribe(serviceLevelId, weeks)
    .accounts({
      user: user.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint,
      userTokenAccount: userAta,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();

  const bh = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = user.publicKey;
  tx.sign(user);
  const txSig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(
    { signature: txSig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );

  // Step 3: activate — sign `${txSig}:${leagues.join(",")}:${jwt}` with the wallet key.
  const messageString = `${txSig}:${selectedLeagues.join(",")}:${jwt}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(messageString), user.secretKey);
  const walletSignature = Buffer.from(sig).toString("base64");

  // Force identity encoding: Bun's fetch has a broken zstd decoder and the
  // CDN in front of this endpoint will happily serve zstd if negotiated.
  const res = await fetch(`${cfg.API_BASE_URL}/token/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "Accept-Encoding": "identity",
    },
    body: JSON.stringify({ txSig, walletSignature, leagues: selectedLeagues }),
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`token/activate failed: ${res.status} ${rawText}`);
  // The endpoint returns the token as a bare plain-text string (not JSON),
  // e.g. `txoracle_api_...` — fall back to the raw body when it isn't JSON.
  let apiToken: string;
  try {
    const body = JSON.parse(rawText) as { token?: string } | string;
    apiToken = typeof body === "string" ? body : (body.token ?? "");
  } catch {
    apiToken = rawText.trim();
  }
  if (!apiToken) throw new Error("token/activate returned no apiToken");

  return { jwt, apiToken };
}

/** Authenticated GET against the TxLINE data API, with one JWT-renew retry on 401. */
export async function apiGet<T = unknown>(
  path: string,
  state: AuthState,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${cfg.API_BASE_URL}${path}`;
  const doFetch = (jwt: string) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": state.apiToken,
        "Accept-Encoding": "deflate",
      },
    });

  let res = await doFetch(state.jwt);
  if (res.status === 401 || res.status === 403) {
    state.jwt = await getGuestJwt();
    res = await doFetch(state.jwt);
  }
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// Allow running this file directly to smoke-test step 1.
if (import.meta.main) {
  getGuestJwt()
    .then((jwt) => {
      console.log("guest JWT acquired (len):", jwt.length);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
