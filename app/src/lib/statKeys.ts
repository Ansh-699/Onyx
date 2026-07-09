// TxLINE soccer stat-key dictionary — verified against TxLINE's own docs
// (txline-docs.txodds.com/documentation/scores/soccer-feed), not guessed.
//
// Encoding: stat_key = period*1000 + base_key. Base keys are PER-PARTICIPANT
// (key 1 = Participant 1's goals, key 2 = Participant 2's goals, etc.) --
// there is no single "total goals" base key. A market combining both
// participants (e.g. "total corners" = P1 corners + P2 corners) needs
// ONYX's op field (ADD) over two keys (7 ADD 8); every market created by
// this build's /create form today is single-stat (op = NONE), so in
// practice each existing market's predicate is about ONE side's stat.
//
// If a stat key falls outside this confirmed set (or ONYX's op combines two
// keys we don't recognize as a matching pair), we fall back to the raw
// `stat[key]` form rather than guess — same "no bluff" discipline as
// everywhere else in this app.

export const OP_NONE = 0xff;
export const OP_ADD = 0;
export const OP_SUBTRACT = 1;

export const CMP_GREATER_THAN = 0;
export const CMP_LESS_THAN = 1;
export const CMP_EQUAL_TO = 2;

interface BaseStat {
  label: string; // lowercase, e.g. "goals"
  participant: 1 | 2;
}

// Confirmed base keys 1-8 (soccer, full match). [VERIFIED against TxLINE docs]
const BASE_STATS: Record<number, BaseStat> = {
  1: { label: "goals", participant: 1 },
  2: { label: "goals", participant: 2 },
  3: { label: "yellow cards", participant: 1 },
  4: { label: "yellow cards", participant: 2 },
  5: { label: "red cards", participant: 1 },
  6: { label: "red cards", participant: 2 },
  7: { label: "corners", participant: 1 },
  8: { label: "corners", participant: 2 },
};

const PERIOD_PREFIX: Record<number, string> = {
  0: "",
  1: "1st-half ",
  2: "2nd-half ",
  3: "ET1 ",
  4: "ET2 ",
  5: "penalties ",
};

/** Selectable single-stat options for the Create page — real verified TxLINE keys, full match (period 0) only. */
export const SELECTABLE_STAT_OPTIONS: { label: string; key: number }[] = [
  { label: "P1 goals", key: 1 },
  { label: "P2 goals", key: 2 },
  { label: "P1 yellow cards", key: 3 },
  { label: "P2 yellow cards", key: 4 },
  { label: "P1 corners", key: 7 },
  { label: "P2 corners", key: 8 },
];

export function decodeStatKey(key: number): { period: number; baseKey: number } {
  return { period: Math.floor(key / 1000), baseKey: key % 1000 };
}

/** Team-agnostic phrase for one side of a stat key, e.g. "2nd-half corners". Team name filled in by the caller when known. */
export function statBaseLabel(key: number): { periodPrefix: string; label: string; participant: 1 | 2 } | null {
  const { period, baseKey } = decodeStatKey(key);
  const base = BASE_STATS[baseKey];
  if (!base) return null;
  return { periodPrefix: PERIOD_PREFIX[period] ?? `period ${period} `, label: base.label, participant: base.participant };
}

/** Sportsbook-style over/under threshold display: integer GT/LT become a half-point line so there's no push. */
function lineText(op: number, predicate: number, threshold: bigint): string {
  const t = Number(threshold);
  if (predicate === CMP_GREATER_THAN) return `over ${t + 0.5}`;
  if (predicate === CMP_LESS_THAN) return `under ${t - 0.5}`;
  if (predicate === CMP_EQUAL_TO) return `exactly ${t}`;
  return `${op === OP_SUBTRACT ? "differs by" : ""} ${t}`;
}

export interface MarketPredicate {
  statAKey: number;
  statBKey: number;
  op: number;
  predicate: number;
  threshold: bigint;
}

export interface TeamNames {
  participant1?: string;
  participant2?: string;
}

/**
 * Human-readable market question, e.g. "Argentina corners — over 2.5" or,
 * for an unrecognized/combined key we can't confidently phrase, the raw
 * `stat[key] > threshold` form (never fabricated).
 */
export function describeMarketPredicate(p: MarketPredicate, teams?: TeamNames): string {
  const a = statBaseLabel(p.statAKey);

  // Combined two-participant market (op ADD/SUBTRACT over the SAME base
  // stat's two participant keys) -> "Total <stat>". Not producible by this
  // build's /create form today, but ONYX's on-chain op field supports it.
  if (p.statBKey !== 0 && p.op !== OP_NONE) {
    const b = statBaseLabel(p.statBKey);
    if (a && b && a.label === b.label && a.periodPrefix === b.periodPrefix && a.participant !== b.participant) {
      const verb = p.op === OP_ADD ? "Total" : "Difference in";
      return `${a.periodPrefix}${verb} ${a.label} — ${lineText(p.op, p.predicate, p.threshold)}`;
    }
    // Two-stat combo we don't recognize -> stay raw rather than guess.
    return `stat[${p.statAKey}] ${p.op === OP_ADD ? "+" : "−"} stat[${p.statBKey}] ${predicateSymbol(p.predicate)} ${p.threshold}`;
  }

  if (!a) return `stat[${p.statAKey}] ${predicateSymbol(p.predicate)} ${p.threshold}`;

  const who = a.participant === 1 ? (teams?.participant1 ?? "Team A") : (teams?.participant2 ?? "Team B");
  return `${who} ${a.periodPrefix}${a.label} — ${lineText(p.op, p.predicate, p.threshold)}`;
}

export function predicateSymbol(predicate: number): string {
  return predicate === CMP_GREATER_THAN ? ">" : predicate === CMP_LESS_THAN ? "<" : "=";
}

/** The exact raw predicate string, always shown alongside the friendly title for the verifiability-minded. */
export function rawPredicateText(p: MarketPredicate): string {
  if (p.statBKey !== 0 && p.op !== OP_NONE) {
    return `stat[${p.statAKey}] ${p.op === OP_ADD ? "+" : "−"} stat[${p.statBKey}] ${predicateSymbol(p.predicate)} ${p.threshold}`;
  }
  return `stat[${p.statAKey}] ${predicateSymbol(p.predicate)} ${p.threshold}`;
}
