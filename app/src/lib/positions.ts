// Live devnet reads for a wallet's ONYX Position + SealedOrder accounts.
// Same no-mocks discipline as onchain.ts (which this imports from — never
// duplicates): every value comes from a real getProgramAccounts call.
//
// Position account layout mirrors programs/onyx/src/state/position.rs exactly
// (96 bytes):
//   off  size  field
//     0     1  disc = 3 (DISC_POSITION)
//     1     7  _pad
//     8    32  owner
//    40    32  market
//    72     8  amount (u64 LE)
//    80     1  side (1=A, 2=B)
//    81     1  claimed (0/1)
//    82     1  bump
//    83    13  _reserved

import { Buffer } from "buffer";
import { type Connection, PublicKey } from "@solana/web3.js";
import {
  ONYX_PROGRAM_ID,
  DISC_SEALED_ORDER,
  getConnection,
  decodeSealedOrder,
  decodeTradingAccount,
  listMarkets,
  tradingAccountPda,
  type OnChainSealedOrder,
  type OnChainTradingAccount,
} from "./onchain";
import { resolveConnection } from "./erRouting";

/** Mirrors DISC_POSITION in programs/onyx/src/constants.rs. */
export const DISC_POSITION = 3;

const POSITION_LEN = 96;

/** Decoded on-chain Position account (see state/position.rs for the byte layout). */
export interface OnChainPosition {
  pda: string;
  owner: string;
  market: string;
  amount: bigint;
  side: number; // 1 = Side A, 2 = Side B
  claimed: boolean;
}

export function decodePosition(pubkey: PublicKey, data: Buffer): OnChainPosition | null {
  if (data.length < POSITION_LEN || data[0] !== DISC_POSITION) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    pda: pubkey.toBase58(),
    owner: new PublicKey(data.subarray(8, 40)).toBase58(),
    market: new PublicKey(data.subarray(40, 72)).toBase58(),
    amount: dv.getBigUint64(72, true),
    side: data[80]!,
    claimed: data[81] !== 0,
  };
}

/** All Position accounts owned by a wallet (disc byte 3 at offset 0, owner at offset 8). */
export async function listPositionsByOwner(owner: PublicKey): Promise<OnChainPosition[]> {
  const connection = getConnection();
  const accounts = await connection.getProgramAccounts(ONYX_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from([DISC_POSITION]).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 8, bytes: owner.toBase58(), encoding: "base58" } },
    ],
  });
  return accounts
    .map(({ pubkey, account }) => decodePosition(pubkey, account.data))
    .filter((p): p is OnChainPosition => p !== null);
}

/** All SealedOrder accounts owned by a wallet (disc byte 4 at offset 0, owner at offset 8). */
export async function listSealedOrdersByOwner(owner: PublicKey): Promise<OnChainSealedOrder[]> {
  const connection = getConnection();
  const accounts = await connection.getProgramAccounts(ONYX_PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from([DISC_SEALED_ORDER]).toString("base64"), encoding: "base64" } },
      { memcmp: { offset: 8, bytes: owner.toBase58(), encoding: "base58" } },
    ],
  });
  return accounts
    .map(({ pubkey, account }) => decodeSealedOrder(pubkey, account.data))
    .filter((o): o is OnChainSealedOrder => o !== null);
}

export interface OwnedTradingAccount extends OnChainTradingAccount {
  marketPda: string;
}

/**
 * Every TradingAccount a wallet owns, across every market — deliberately
 * NOT a single base-only getProgramAccounts scan like the two listers
 * above, because TradingAccount (unlike Position/SealedOrder, which never
 * move) can be delegated to an Ephemeral Rollup. A market currently
 * delegated has its base-layer copy owned by the Delegation Program, not
 * ONYX, so a base-only program-owner filter would silently skip every
 * TradingAccount that's mid-flight on an ER right now — the exact same
 * blind spot PricePanel's "Locked" stat had (see MarketDetail.tsx history)
 * before it was found and fixed, just at the portfolio-wide scale instead
 * of one market.
 *
 * First version of this function resolved each market's connection then
 * issued one getAccountInfo PER market in parallel — correct, but it
 * reliably 429s public devnet RPC once the market count gets past a couple
 * dozen (confirmed live: real Portfolio page load, real repeated 429s,
 * ~30s+ of retry backoff). Fixed by grouping markets by their RESOLVED
 * connection endpoint (almost always just "base", since only markets
 * currently mid-ER-lifecycle differ) and issuing ONE batched
 * getMultipleAccountsInfo per distinct ledger instead of one call per
 * market — O(distinct ledgers in use) RPC calls, not O(markets). A real
 * cross-ledger index (services/ingestion) is still the honest long-term
 * answer if a single ledger's own market count ever gets large enough to
 * need batching the batch.
 */
export async function listTradingAccountsByOwner(owner: PublicKey): Promise<OwnedTradingAccount[]> {
  const base = getConnection();
  const markets = await listMarkets();

  const resolved = await Promise.all(
    markets.map(async (m) => {
      const marketPk = new PublicKey(m.pda);
      const { connection } = await resolveConnection(marketPk, base);
      return { marketPda: m.pda, connection, pda: tradingAccountPda(marketPk, owner) };
    }),
  );

  const groups = new Map<string, { connection: Connection; items: { marketPda: string; pda: PublicKey }[] }>();
  for (const r of resolved) {
    const key = r.connection.rpcEndpoint;
    if (!groups.has(key)) groups.set(key, { connection: r.connection, items: [] });
    groups.get(key)!.items.push({ marketPda: r.marketPda, pda: r.pda });
  }

  const found: OwnedTradingAccount[] = [];
  await Promise.all(
    [...groups.values()].map(async ({ connection, items }) => {
      const infos = await connection.getMultipleAccountsInfo(items.map((i) => i.pda));
      infos.forEach((info, i) => {
        if (!info) return;
        const decoded = decodeTradingAccount(items[i]!.pda, info.data);
        if (decoded) found.push({ ...decoded, marketPda: items[i]!.marketPda });
      });
    }),
  );
  return found;
}
