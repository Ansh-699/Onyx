//! ONYX on-chain settlement program (Pinocchio, native, no_std).
//!
//! L0 core MVP: escrow markets settled by a CPI into the `txoracle` program's
//! `validate_stat` instruction. Settlement truth is the on-chain Merkle root
//! posted by the oracle; ONYX never settles from off-chain data.
//!
//! The crate is `#![no_std]` on the Solana SBF target and `std` on the host so
//! the pure helpers (Merkle re-derivation, terms hashing, payout math) can be
//! unit-tested directly with `cargo test` on the host.
#![cfg_attr(target_os = "solana", no_std)]

extern crate alloc;

pub mod constants;
pub mod error;
pub mod matching;
pub mod merkle;
pub mod state;
pub mod util;

pub mod cpi {
    pub mod delegation;
    pub mod permission;
    pub mod txoracle;
}

pub mod instructions;

pub mod entrypoint;

// Re-export the dispatcher so integration tests / clients can reference it.
pub use entrypoint::process_instruction;

/// ONYX program id placeholder. Overwritten at deploy time with the
/// `cargo build-sbf` keypair. Kept here so PDA derivations have a stable
/// compile-time id during tests.
pinocchio_pubkey::declare_id!("4LpMzq6wXYFMzxgbyMyN2ja4EQhPsYGHSCAvjwzA18MB");
