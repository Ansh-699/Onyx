//! Deterministic keccak-256 Merkle re-derivation.
//!
//! ONYX mirrors the txoracle proof model so a client can locally re-derive the
//! same root the on-chain oracle anchored. A `ProofNode` carries a sibling hash
//! and a flag telling us whether that sibling sits on the *right*. The folding
//! rule must match the oracle exactly:
//!
//! * `is_right_sibling == true`  -> parent = H(current || sibling)
//! * `is_right_sibling == false` -> parent = H(sibling || current)
//!
//! Hashing uses keccak-256 (`solana-nostd-keccak`, ~100 CU/hash on-chain), the
//! same primitive the oracle uses. This module is pure and runs on the host so
//! the determinism property can be unit-tested without a validator.

use solana_nostd_keccak::hashv;

/// A single Merkle authentication-path node, byte-compatible with the txoracle
/// `ProofNode { hash: [u8;32], is_right_sibling: bool }` type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

impl ProofNode {
    pub fn new(hash: [u8; 32], is_right_sibling: bool) -> Self {
        Self {
            hash,
            is_right_sibling,
        }
    }
}

/// keccak-256 of a single 32-byte leaf pre-image already computed by the caller.
#[inline]
pub fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[left, right])
}

/// Fold a `leaf` up an authentication path and return the derived root.
///
/// Deterministic: identical `(leaf, proof)` inputs always yield the same root,
/// and the fold direction is fully determined by each node's `is_right_sibling`
/// flag. This is the core of the settlement-determinism argument.
pub fn compute_root(leaf: [u8; 32], proof: &[ProofNode]) -> [u8; 32] {
    let mut acc = leaf;
    for node in proof {
        acc = if node.is_right_sibling {
            // sibling is on the right: current stays left
            hash_pair(&acc, &node.hash)
        } else {
            // sibling is on the left: current moves right
            hash_pair(&node.hash, &acc)
        };
    }
    acc
}

/// Re-derive the root from `leaf` + `proof` and compare against `expected_root`.
#[inline]
pub fn verify(leaf: [u8; 32], proof: &[ProofNode], expected_root: &[u8; 32]) -> bool {
    &compute_root(leaf, proof) == expected_root
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    use super::*;

    fn leaf(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[test]
    fn single_node_right_sibling() {
        let l = leaf(1);
        let s = leaf(2);
        let root = compute_root(l, &[ProofNode::new(s, true)]);
        assert_eq!(root, hash_pair(&l, &s));
    }

    #[test]
    fn single_node_left_sibling() {
        let l = leaf(1);
        let s = leaf(2);
        let root = compute_root(l, &[ProofNode::new(s, false)]);
        assert_eq!(root, hash_pair(&s, &l));
    }

    #[test]
    fn deterministic_repeat() {
        let l = leaf(9);
        let proof = [
            ProofNode::new(leaf(3), true),
            ProofNode::new(leaf(7), false),
            ProofNode::new(leaf(5), true),
        ];
        let r1 = compute_root(l, &proof);
        let r2 = compute_root(l, &proof);
        assert_eq!(r1, r2, "root must be deterministic for identical inputs");
    }

    #[test]
    fn direction_matters() {
        // A right sibling and a left sibling with the same hash must generally
        // produce different parents, proving the flag actually steers folding.
        let l = leaf(1);
        let s = leaf(2);
        let right = compute_root(l, &[ProofNode::new(s, true)]);
        let left = compute_root(l, &[ProofNode::new(s, false)]);
        assert_ne!(right, left);
    }

    #[test]
    fn verify_roundtrip() {
        let l = leaf(42);
        let proof = [ProofNode::new(leaf(11), false), ProofNode::new(leaf(22), true)];
        let root = compute_root(l, &proof);
        assert!(verify(l, &proof, &root));
        let mut bad = root;
        bad[0] ^= 0xFF;
        assert!(!verify(l, &proof, &bad));
    }

    #[test]
    fn tamper_leaf_breaks_root() {
        let proof = [ProofNode::new(leaf(11), true)];
        let good = compute_root(leaf(1), &proof);
        let tampered = compute_root(leaf(2), &proof);
        assert_ne!(good, tampered);
    }
}
