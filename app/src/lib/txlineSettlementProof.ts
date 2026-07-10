// Server-only live TxLINE settlement-proof fetcher. NEVER imported from a
// "use client" file: reads TXLINE_JWT/TXLINE_API_TOKEN from server env, same
// discipline as txlineScores.ts (which already proves this exact pattern
// works, for the live score ticker). This is the missing piece that makes
// settle_market genuinely general instead of working for only the one
// bundled demo fixture: getStatValidation-equivalent logic already existed
// in services/ingestion (server-side CLI tooling); this is the same idea,
// callable from a Next.js API route for an arbitrary market at settlement
// time.
//
// TxLINE's /scores/stat-validation is keyed by (fixtureId, seq) with no
// "give me the final state" call, so finding the right seq means locating
// the highest one that still resolves for the stat(s) this market's
// predicate actually needs -- same binary-search approach txlineScores.ts
// already uses for the live score ticker, just keyed on the REAL stat(s)
// being settled rather than hardcoded to key "1".
//
// Live-verified before writing this: requesting multiple stat keys in one
// call (statKeys="1,2") returns ONE shared `eventStatRoot` covering both,
// with per-stat proof paths in `statProofs[0]`/`statProofs[1]` -- not two
// separate roots. That's exactly the shape CapturedProofFixture already
// expects (built for this before this module existed).

import type { CapturedProofFixture } from "./instructions";

const API_ORIGIN = process.env.TXLINE_API_ORIGIN ?? "https://txline-dev.txodds.com";
const API_BASE_URL = process.env.TXLINE_API_BASE_URL ?? `${API_ORIGIN}/api`;
const JWT = process.env.TXLINE_JWT;
const API_TOKEN = process.env.TXLINE_API_TOKEN;

const MS_PER_DAY = 86_400_000;

interface RawStatValidationResponse {
  ts: number;
  statsToProve: { key: number; value: number; period: number }[];
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  statProofs: { hash: number[]; isRightSibling: boolean }[][];
  subTreeProof: { hash: number[]; isRightSibling: boolean }[];
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[];
}

async function statValidation(fixtureId: number, seq: number, statKeys: string): Promise<RawStatValidationResponse | null> {
  if (!JWT || !API_TOKEN) return null;
  const url = `${API_BASE_URL}/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${JWT}`, "X-Api-Token": API_TOKEN, "Accept-Encoding": "deflate" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as RawStatValidationResponse;
}

/** Highest seq for which `statKeys` still resolves — the latest/final known state TxLINE has for this fixture. */
async function findMaxSeq(fixtureId: number, statKeys: string): Promise<number | null> {
  if (!(await statValidation(fixtureId, 1, statKeys))) return null;
  let lo = 1;
  let hi = 1;
  while (hi <= 8192 && (await statValidation(fixtureId, hi, statKeys))) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await statValidation(fixtureId, mid, statKeys)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface SettlementProofRequest {
  fixtureId: number;
  statAKey: number;
  /** 0 (OP_NONE's stat_b sentinel) for a single-stat market. */
  statBKey: number;
}

export type SettlementProofResult =
  | { ok: true; fixture: CapturedProofFixture }
  | { ok: false; reason: string };

/**
 * Fetch a live, general settlement proof for ANY fixture/stat combination
 * TxLINE's sandbox actually has data for -- not just the one bundled demo
 * fixture. Returns `ok:false` with an honest reason (never throws, never
 * fabricates) when TxLINE has no data for this fixture, or credentials
 * aren't configured.
 */
export async function getLiveSettlementProof(req: SettlementProofRequest): Promise<SettlementProofResult> {
  if (!JWT || !API_TOKEN) {
    return { ok: false, reason: "TXLINE_JWT/TXLINE_API_TOKEN not configured on this server" };
  }
  const combined = req.statBKey !== 0;
  const statKeys = combined ? `${req.statAKey},${req.statBKey}` : String(req.statAKey);

  const seq = await findMaxSeq(req.fixtureId, statKeys);
  if (seq === null) {
    return {
      ok: false,
      reason: combined
        ? `TxLINE has no data for fixture ${req.fixtureId} covering both stat keys ${req.statAKey} and ${req.statBKey} together`
        : `TxLINE has no data for fixture ${req.fixtureId}, stat key ${req.statAKey}`,
    };
  }

  const resp = await statValidation(req.fixtureId, seq, statKeys);
  if (!resp) return { ok: false, reason: "proof fetch failed at the located seq (transient — retry)" };

  const statA = resp.statsToProve.find((s) => s.key === req.statAKey);
  if (!statA) return { ok: false, reason: `response didn't include stat key ${req.statAKey}` };
  if (combined && !resp.statsToProve.find((s) => s.key === req.statBKey)) {
    return { ok: false, reason: `response didn't include stat key ${req.statBKey}` };
  }
  // Reorder statsToProve/statProofs so index 0 is always statA and (if
  // combined) index 1 is always statB, regardless of the order TxLINE
  // returned them in -- buildSettleMarketIx indexes positionally.
  const aIdx = resp.statsToProve.findIndex((s) => s.key === req.statAKey);
  const bIdx = combined ? resp.statsToProve.findIndex((s) => s.key === req.statBKey) : -1;
  const orderedStats = combined ? [resp.statsToProve[aIdx]!, resp.statsToProve[bIdx]!] : [resp.statsToProve[aIdx]!];
  const orderedProofs = combined ? [resp.statProofs[aIdx]!, resp.statProofs[bIdx]!] : [resp.statProofs[aIdx]!];

  // targetTsMs (ValidateStatArgs.ts, used by txoracle for seed generation)
  // MUST be summary.updateStats.minTimestamp, NOT the top-level `ts` /
  // maxTimestamp -- confirmed live the hard way: the bundled demo capture
  // has updateCount:1 with min===max===ts, which trivially satisfied either
  // interpretation and hid this distinction. A live fixture with multiple
  // batched updates (updateCount>1, min!==max) exposed it: using `ts`
  // (===maxTimestamp there) failed with txoracle's own
  // Custom(6010)/TimestampMismatch ("the timestamp provided for seed
  // generation does not match the timestamp in the snapshot payload");
  // switching to minTimestamp settled successfully.
  const targetTsMs = resp.summary.updateStats.minTimestamp;
  const fixture: CapturedProofFixture = {
    fixtureId: req.fixtureId,
    seq,
    targetTsMs,
    epochDay: Math.floor(targetTsMs / MS_PER_DAY),
    payload: {
      ts: resp.ts,
      statsToProve: orderedStats,
      eventStatRoot: resp.eventStatRoot,
      summary: resp.summary,
      statProofs: orderedProofs,
      subTreeProof: resp.subTreeProof,
      mainTreeProof: resp.mainTreeProof,
    },
  };
  return { ok: true, fixture };
}
