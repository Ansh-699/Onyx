// In-browser keccak256 Merkle re-derivation — the verifiable-receipt core.
//
// This MUST stay byte-consistent with the on-chain merkle verifier
// (programs/onyx merkle.rs / the txoracle validate_stat fold). The contract:
//
//   ProofNode { hash: [u8;32], is_right_sibling: bool }
//
//   fold step:
//     node = is_right_sibling
//         ? keccak256( concat(acc, sibling.hash) )   // sibling on the RIGHT
//         : keccak256( concat(sibling.hash, acc) )   // sibling on the LEFT
//
//   starting acc = leaf; after folding every ProofNode, acc must equal root.
//
// Hashing is raw keccak256 over the 64-byte concatenation of two 32-byte
// hashes (no domain-separation byte), matching the reference tx-on-chain trees.

import { keccak256 } from "js-sha3";
import type { ProofNode, ScoreStat, TraderPredicate } from "./types";

/** 32-byte hash as raw bytes. */
export type Bytes32 = Uint8Array;

/** Parse a hex string ("0x…" or bare) or number[] into a 32-byte Uint8Array. */
export function toBytes32(input: string | number[] | Uint8Array): Bytes32 {
  if (input instanceof Uint8Array) {
    return assertLen32(input);
  }
  if (Array.isArray(input)) {
    return assertLen32(Uint8Array.from(input));
  }
  let hex = input.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  if (hex.length !== 64) {
    throw new Error(`expected 32-byte (64 hex chars) value, got ${hex.length} chars`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function assertLen32(b: Uint8Array): Bytes32 {
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
}

/** Lowercase hex, no 0x prefix. */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** keccak256 of raw bytes -> 32-byte Uint8Array. */
export function keccak(bytes: Uint8Array): Bytes32 {
  // js-sha3 keccak256.arrayBuffer returns a 32-byte ArrayBuffer.
  return new Uint8Array(keccak256.arrayBuffer(bytes));
}

/** keccak256(concat(left, right)) over two 32-byte hashes. */
export function hashPair(left: Bytes32, right: Bytes32): Bytes32 {
  const buf = new Uint8Array(64);
  buf.set(left, 0);
  buf.set(right, 32);
  return keccak(buf);
}

/**
 * Compute the keccak leaf for a ScoreStat.
 *
 * Serialization matches the on-chain ScoreStat layout used to build the tree:
 *   key:   u32 little-endian (4 bytes)
 *   value: i32 little-endian (4 bytes)
 *   period:i32 little-endian (4 bytes)
 * then keccak256 over the 12-byte buffer.
 *
 * If the anchored leaf is provided directly, prefer verifying against that;
 * this helper lets the receipt page show that finalStat truly hashes to `leaf`.
 */
export function leafFromScoreStat(stat: ScoreStat): Bytes32 {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, stat.key >>> 0, true);
  dv.setInt32(4, stat.value | 0, true);
  dv.setInt32(8, stat.period | 0, true);
  return keccak(buf);
}

export interface FoldStep {
  index: number;
  isRightSibling: boolean;
  sibling: string; // hex
  accBefore: string; // hex
  accAfter: string; // hex
}

export interface MerkleResult {
  /** Final computed root (hex). */
  computedRoot: string;
  /** Expected anchored root (hex). */
  expectedRoot: string;
  /** True iff computedRoot === expectedRoot. */
  ok: boolean;
  /** Per-node fold trace, useful for the receipt UI. */
  steps: FoldStep[];
}

/**
 * Fold a leaf up a proof path and compare against the anchored root.
 *
 * @param leaf      32-byte leaf hash
 * @param proofPath ordered siblings from leaf -> root
 * @param root      anchored on-chain root
 */
export function verifyMerkleProof(
  leaf: string | number[] | Uint8Array,
  proofPath: ProofNode[],
  root: string | number[] | Uint8Array,
): MerkleResult {
  let acc = toBytes32(leaf);
  const expected = toBytes32(root);
  const steps: FoldStep[] = [];

  proofPath.forEach((node, index) => {
    const sibling = toBytes32(node.hash);
    const accBefore = acc;
    // is_right_sibling => sibling is on the RIGHT: keccak(acc || sibling)
    // otherwise         => sibling is on the LEFT:  keccak(sibling || acc)
    const next = node.isRightSibling
      ? hashPair(accBefore, sibling)
      : hashPair(sibling, accBefore);
    steps.push({
      index,
      isRightSibling: node.isRightSibling,
      sibling: toHex(sibling),
      accBefore: toHex(accBefore),
      accAfter: toHex(next),
    });
    acc = next;
  });

  const computedRoot = toHex(acc);
  const expectedRoot = toHex(expected);
  return {
    computedRoot,
    expectedRoot,
    ok: computedRoot === expectedRoot,
    steps,
  };
}

/** Evaluate a TraderPredicate against an observed value (GT/LT/EQ only). */
export function evaluatePredicate(value: number, predicate: TraderPredicate): boolean {
  switch (predicate.comparison) {
    case "greaterThan":
      return value > predicate.threshold;
    case "lessThan":
      return value < predicate.threshold;
    case "equalTo":
      return value === predicate.threshold;
    default:
      return false;
  }
}

export function comparisonSymbol(c: TraderPredicate["comparison"]): string {
  switch (c) {
    case "greaterThan":
      return ">";
    case "lessThan":
      return "<";
    case "equalTo":
      return "=";
  }
}
