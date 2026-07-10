// Phase-based RPC routing for MagicBlock ER trading (docs/ER_TRADING_DESIGN.md
// §3). Every account this program owns is either base-resident or
// ER-delegated at any moment; the router's getDelegationStatus is the single
// source of truth for which. Reads and ER-only writes must go to whichever
// endpoint currently HOLDS the authoritative state for that specific
// account — base-only writes (deposit/delegate/settle/withdraw) always go to
// base regardless, since those instructions are only valid pre-delegation or
// post-undelegation by the program's own account-ownership checks.

import { Connection, PublicKey } from "@solana/web3.js";

const ROUTER_URL = process.env.NEXT_PUBLIC_MAGICBLOCK_ROUTER_URL ?? "https://devnet-router.magicblock.app/";

export interface DelegationStatus {
  isDelegated: boolean;
  fqdn: string | null;
  checkedAt: number;
}

const NOT_DELEGATED: Omit<DelegationStatus, "checkedAt"> = { isDelegated: false, fqdn: null };

// Short TTL: this cache backs both live UI polling AND the just-before-send
// check on every ER-bound transaction, so staleness directly costs correctness
// (a stale "not delegated" would misroute a write to base and fail loudly;
// a stale "delegated" against an already-undelegated account fails against
// the ER instead, equally loudly — see errors.ts's wrong-ledger detection for
// the graceful recovery path either way). 3s keeps polling cheap without
// living long enough to matter for a window that's open for tens of seconds.
const TTL_MS = 3_000;
const cache = new Map<string, DelegationStatus>();
const erConnections = new Map<string, Connection>();

async function fetchDelegationStatus(key: string): Promise<Omit<DelegationStatus, "checkedAt">> {
  try {
    const res = await fetch(ROUTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [key] }),
    });
    if (!res.ok) return NOT_DELEGATED;
    const json = await res.json();
    const result = json?.result;
    if (!result?.isDelegated) return NOT_DELEGATED;
    const rawFqdn = result.fqdn as string | undefined;
    if (!rawFqdn) return NOT_DELEGATED;
    return { isDelegated: true, fqdn: rawFqdn.startsWith("http") ? rawFqdn : `https://${rawFqdn}` };
  } catch {
    return NOT_DELEGATED;
  }
}

/** Delegation status for one account, cached ~3s. Pass `force` to bypass the cache right before sending a transaction. */
export async function getDelegationStatus(pubkey: PublicKey, force = false): Promise<DelegationStatus> {
  const key = pubkey.toBase58();
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.checkedAt < TTL_MS) return cached;
  const fresh = await fetchDelegationStatus(key);
  const status: DelegationStatus = { ...fresh, checkedAt: Date.now() };
  cache.set(key, status);
  return status;
}

export function getErConnection(fqdn: string): Connection {
  let c = erConnections.get(fqdn);
  if (!c) {
    c = new Connection(fqdn, "confirmed");
    erConnections.set(fqdn, c);
  }
  return c;
}

/** Resolve the connection that currently holds authoritative state for `pubkey`: ER if delegated, base otherwise. */
export async function resolveConnection(
  pubkey: PublicKey,
  baseConnection: Connection,
  force = false,
): Promise<{ connection: Connection; isDelegated: boolean; fqdn: string | null }> {
  const status = await getDelegationStatus(pubkey, force);
  if (status.isDelegated && status.fqdn) {
    return { connection: getErConnection(status.fqdn), isDelegated: true, fqdn: status.fqdn };
  }
  return { connection: baseConnection, isDelegated: false, fqdn: null };
}

/** Invalidate the cached status for an account — call right after a delegate/undelegate tx confirms, so the next read doesn't wait out the TTL. */
export function invalidateDelegationStatus(pubkey: PublicKey): void {
  cache.delete(pubkey.toBase58());
}
