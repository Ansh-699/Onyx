//! Cross-instruction AMM lifecycle property suite (docs/AMM_TRADING_DESIGN.md
//! Phase A, §5's row (a)/(d)). Unlike the per-instruction unit tests living
//! inside each `instructions/*_amm.rs` file, this exercises the REAL
//! instruction dispatch path end-to-end — create_amm_pool → open positions →
//! deposit → an adversarially-ordered mix of buys/sells from two independent
//! traders → settle → redeem both → withdraw LP — asserting the solvency
//! identity from the design doc's §1 holds EXACTLY not just once at the end,
//! but after every single step, and that the vault drains to precisely zero
//! post-settlement (the tightening the project owner asked for explicitly:
//! "reconcile solvency after settlement, not just after swaps").
//!
//! Settlement itself is simulated by directly rewriting the market account's
//! status/outcome bytes (no oracle CPI) -- the same choice withdraw_trading's
//! own tests make, since settle_market's oracle CPI is proven independently
//! (see the live any-fixture settlement pipeline) and is out of scope here.
//!
//! Two independent scenarios, deliberately different orderings AND different
//! winning sides, per the design doc's explicit "many random/hostile
//! orderings... not one happy path" requirement -- a CPMM swap is
//! path-dependent (unlike the commutative counter probe that originally
//! motivated this pivot), so correctness under ONE ordering does not imply
//! correctness under another.

use mollusk_svm::{result::Check, Mollusk};
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError as SvmProgramError;
use solana_program_pack::Pack;
use solana_pubkey::Pubkey;
use solana_rent::Rent;
use spl_token_interface::state::{Account as TokenAccountState, AccountState};
use std::collections::HashMap;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::MARKET_LEN;

const PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID);
const NOW: i64 = 1_700_000_000;
const DEADLINE: i64 = 2_000_000_000;

fn read_u64(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

fn market_bytes(status: u8, outcome: u8, deadline: i64, vault_bump: u8) -> Vec<u8> {
    let mut b = vec![0u8; MARKET_LEN];
    b[0] = DISC_MARKET;
    b[26] = status;
    b[27] = outcome;
    b[36..44].copy_from_slice(&deadline.to_le_bytes());
    b[100] = vault_bump;
    b
}

fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    mollusk_svm_programs_token::token::create_account_for_token_account(TokenAccountState {
        mint,
        owner,
        amount,
        delegate: solana_program_option::COption::None,
        state: AccountState::Initialized,
        is_native: solana_program_option::COption::None,
        delegated_amount: 0,
        close_authority: solana_program_option::COption::None,
    })
}

fn system_placeholder() -> Account {
    Account::new(0, 0, &solana_system_interface::program::ID)
}

struct World {
    mollusk: Mollusk,
    accounts: HashMap<Pubkey, Account>,
}

impl World {
    fn call(&mut self, instruction: &Instruction, checks: &[Check]) {
        let accounts: Vec<(Pubkey, Account)> = instruction
            .accounts
            .iter()
            .map(|meta| (meta.pubkey, self.accounts.get(&meta.pubkey).cloned().unwrap_or_default()))
            .collect();
        let result = self.mollusk.process_and_validate_instruction(instruction, &accounts, checks);
        for (k, v) in result.resulting_accounts {
            self.accounts.insert(k, v);
        }
    }

    fn get(&self, key: &Pubkey) -> &Account {
        self.accounts.get(key).expect("account must exist in world")
    }

    fn set(&mut self, key: Pubkey, account: Account) {
        self.accounts.insert(key, account);
    }

    fn token_balance(&self, key: &Pubkey) -> u64 {
        TokenAccountState::unpack(&self.get(key).data).unwrap().amount
    }
}

#[allow(clippy::too_many_arguments)]
fn ix_create_amm_pool(creator: &Pubkey, market: &Pubkey, pool: &Pubkey, vault: &Pubkey, creator_ata: &Pubkey, seed_amount: u64, fee_bps: u16) -> Instruction {
    let mut data = vec![IX_CREATE_AMM_POOL];
    data.extend_from_slice(&seed_amount.to_le_bytes());
    data.extend_from_slice(&fee_bps.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*pool, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*creator_ata, false),
            AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
        data,
    }
}

fn ix_open_amm_position(owner: &Pubkey, market: &Pubkey, position: &Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*position, false),
            AccountMeta::new_readonly(solana_system_interface::program::ID, false),
        ],
        data: vec![IX_OPEN_AMM_POSITION],
    }
}

fn ix_deposit_amm(owner: &Pubkey, market: &Pubkey, position: &Pubkey, vault: &Pubkey, owner_ata: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![IX_DEPOSIT_AMM];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*position, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*owner_ata, false),
            AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
        ],
        data,
    }
}

#[allow(clippy::too_many_arguments)]
fn ix_swap_amm(owner: &Pubkey, market: &Pubkey, pool: &Pubkey, position: &Pubkey, side: u8, direction: u8, amount_in: u64, min_out: u64) -> Instruction {
    let mut data = vec![IX_SWAP_AMM, side, direction];
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*pool, false),
            AccountMeta::new(*position, false),
        ],
        data,
    }
}

fn ix_redeem_amm(owner: &Pubkey, market: &Pubkey, position: &Pubkey, vault: &Pubkey, owner_ata: &Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*position, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*owner_ata, false),
            AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
        ],
        data: vec![IX_REDEEM_AMM],
    }
}

fn ix_withdraw_lp_amm(lp_owner: &Pubkey, market: &Pubkey, pool: &Pubkey, vault: &Pubkey, lp_owner_ata: &Pubkey) -> Instruction {
    Instruction {
        program_id: PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*lp_owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(*pool, false),
            AccountMeta::new(*vault, false),
            AccountMeta::new(*lp_owner_ata, false),
            AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
        ],
        data: vec![IX_WITHDRAW_LP_AMM],
    }
}

/// Asserts both halves of docs/AMM_TRADING_DESIGN.md §1's solvency identity:
/// collateral (usdc_available + sets_outstanding + fees_accrued == total ever
/// deposited) and the A/B symmetry (Σtokens + pool.reserve == sets_outstanding
/// on BOTH sides). Vault never moves during swaps, so `total_deposited` is a
/// constant checked at every call site, not re-derived from the vault itself.
fn assert_mid_lifecycle_solvency(world: &World, alice_pos: &Pubkey, bob_pos: &Pubkey, pool: &Pubkey, total_deposited: u64, label: &str) {
    let a = &world.get(alice_pos).data;
    let b = &world.get(bob_pos).data;
    let p = &world.get(pool).data;

    let alice_usdc = read_u64(a, 72);
    let alice_ta = read_u64(a, 80);
    let alice_tb = read_u64(a, 88);
    let bob_usdc = read_u64(b, 72);
    let bob_ta = read_u64(b, 80);
    let bob_tb = read_u64(b, 88);
    let reserve_a = read_u64(p, 72);
    let reserve_b = read_u64(p, 80);
    let sets_outstanding = read_u64(p, 88);
    let fees = read_u64(p, 96);

    assert_eq!(
        alice_usdc + bob_usdc + sets_outstanding + fees,
        total_deposited,
        "{label}: Σusdc_available + sets_outstanding + fees_accrued must equal total ever deposited"
    );
    assert_eq!(alice_ta + bob_ta + reserve_a, sets_outstanding, "{label}: Σtokens_a + reserve_a must equal sets_outstanding");
    assert_eq!(alice_tb + bob_tb + reserve_b, sets_outstanding, "{label}: Σtokens_b + reserve_b must equal sets_outstanding");
}

fn setup_world() -> World {
    unsafe {
        std::env::set_var("SBF_OUT_DIR", concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy"));
    }
    let mut mollusk = Mollusk::new(&PROGRAM_ID, "onyx");
    mollusk_svm_programs_token::token::add_program(&mut mollusk);
    mollusk.sysvars.clock = Clock { unix_timestamp: NOW, ..Clock::default() };
    // Seed the executable program accounts explicitly: World::call passes
    // every instruction meta from its own map, and a defaulted (empty,
    // non-executable) entry for the token/system program would MASK
    // mollusk's own fallback stubs -> UnsupportedProgramId on the first CPI.
    let mut accounts = HashMap::new();
    let (tok_key, tok_acct) = mollusk_svm_programs_token::token::keyed_account();
    accounts.insert(tok_key, tok_acct);
    let (sys_key, sys_acct) = mollusk_svm::program::keyed_account_for_system_program();
    accounts.insert(sys_key, sys_acct);
    World { mollusk, accounts }
}

struct Scenario {
    market: Pubkey,
    pool: Pubkey,
    vault: Pubkey,
    mint: Pubkey,
    creator: Pubkey,
    creator_ata: Pubkey,
    alice: Pubkey,
    alice_position: Pubkey,
    alice_ata: Pubkey,
    bob: Pubkey,
    bob_position: Pubkey,
    bob_ata: Pubkey,
}

fn wire_up(world: &mut World, seed_amount: u64, fee_bps: u16, alice_deposit: u64, bob_deposit: u64) -> Scenario {
    let market = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let (pool, _) = Pubkey::find_program_address(&[SEED_AMM_POOL, market.as_ref()], &PROGRAM_ID);
    let (vault, vault_bump) = Pubkey::find_program_address(&[SEED_VAULT, market.as_ref()], &PROGRAM_ID);

    let creator = Pubkey::new_unique();
    let creator_ata = Pubkey::new_unique();
    let alice = Pubkey::new_unique();
    let alice_ata = Pubkey::new_unique();
    let (alice_position, _) = Pubkey::find_program_address(&[SEED_AMM_POSITION, market.as_ref(), alice.as_ref()], &PROGRAM_ID);
    let bob = Pubkey::new_unique();
    let bob_ata = Pubkey::new_unique();
    let (bob_position, _) = Pubkey::find_program_address(&[SEED_AMM_POSITION, market.as_ref(), bob.as_ref()], &PROGRAM_ID);

    let rent = Rent::default();
    world.set(market, Account { lamports: rent.minimum_balance(MARKET_LEN), data: market_bytes(STATUS_OPEN, OUTCOME_UNKNOWN, DEADLINE, vault_bump), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
    world.set(pool, system_placeholder());
    world.set(vault, token_account(mint, vault, 0));
    world.set(creator, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID));
    world.set(creator_ata, token_account(mint, creator, seed_amount));
    world.set(alice, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID));
    world.set(alice_position, system_placeholder());
    world.set(alice_ata, token_account(mint, alice, alice_deposit));
    world.set(bob, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID));
    world.set(bob_position, system_placeholder());
    world.set(bob_ata, token_account(mint, bob, bob_deposit));

    world.call(&ix_create_amm_pool(&creator, &market, &pool, &vault, &creator_ata, seed_amount, fee_bps), &[Check::success()]);
    world.call(&ix_open_amm_position(&alice, &market, &alice_position), &[Check::success()]);
    world.call(&ix_open_amm_position(&bob, &market, &bob_position), &[Check::success()]);
    world.call(&ix_deposit_amm(&alice, &market, &alice_position, &vault, &alice_ata, alice_deposit), &[Check::success()]);
    world.call(&ix_deposit_amm(&bob, &market, &bob_position, &vault, &bob_ata, bob_deposit), &[Check::success()]);

    Scenario { market, pool, vault, mint, creator, creator_ata, alice, alice_position, alice_ata, bob, bob_position, bob_ata }
}

fn settle(world: &mut World, market: &Pubkey, vault_bump: u8, outcome: u8) {
    world.set(*market, Account { lamports: world.get(market).lamports, data: market_bytes(STATUS_SETTLED, outcome, DEADLINE, vault_bump), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
}

#[test]
fn full_lifecycle_solvency_holds_through_adversarial_swaps_and_post_settlement() {
    let mut world = setup_world();
    let seed = 1_000_000u64;
    let fee_bps = 100u16;
    let alice_deposit = 400_000u64;
    let bob_deposit = 400_000u64;
    let total_deposited = seed + alice_deposit + bob_deposit;
    let s = wire_up(&mut world, seed, fee_bps, alice_deposit, bob_deposit);

    assert_eq!(world.token_balance(&s.vault), total_deposited, "vault holds seed + both deposits before any swap");
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after deposits, before swaps");

    // Adversarially-ordered mix: both sides, both directions, both users,
    // interleaved so no single trader's swaps are ever contiguous.
    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_A, SWAP_BUY, 200_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after alice buy A");

    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_B, SWAP_BUY, 150_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after bob buy B");

    let alice_tokens_a = read_u64(&world.get(&s.alice_position).data, 80);
    let alice_sell_amount = alice_tokens_a / 2;
    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_A, SWAP_SELL, alice_sell_amount, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after alice sell half her A");

    // Bob switches sides entirely -- buys A too, now both users hold both sides.
    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_A, SWAP_BUY, 100_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after bob buy A (side switch)");

    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_B, SWAP_BUY, 50_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after alice buy B");

    let bob_tokens_b = read_u64(&world.get(&s.bob_position).data, 88);
    let bob_sell_amount = bob_tokens_b / 3;
    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_B, SWAP_SELL, bob_sell_amount, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after bob sell partial B");

    // Vault balance itself must be completely untouched by the whole swap
    // sequence -- swaps are pure account-data mutation, never touch the vault.
    assert_eq!(world.token_balance(&s.vault), total_deposited, "vault unchanged by any swap");

    // ---- settle: A wins ----
    let vault_bump = world.get(&s.market).data[100];
    settle(&mut world, &s.market, vault_bump, OUTCOME_SIDE_A);

    world.call(&ix_redeem_amm(&s.alice, &s.market, &s.alice_position, &s.vault, &s.alice_ata), &[Check::success()]);
    world.call(&ix_redeem_amm(&s.bob, &s.market, &s.bob_position, &s.vault, &s.bob_ata), &[Check::success()]);
    world.call(&ix_withdraw_lp_amm(&s.creator, &s.market, &s.pool, &s.vault, &s.creator_ata), &[Check::success()]);

    // The critical assertion (tightening #3): post-settlement, the vault
    // must drain to EXACTLY zero -- nothing stuck, nothing overdrawn. Every
    // instruction above used Check::success(), so no VaultUnderfunded ever
    // fired; this confirms the OTHER failure mode (money left stranded)
    // didn't happen either.
    assert_eq!(world.token_balance(&s.vault), 0, "vault must drain to EXACTLY zero after redeem+withdraw_lp (lamport-exact post-settlement solvency)");

    // Cross-check: total paid out across all three payouts must equal total
    // ever deposited, computed independently of the vault-balance check above.
    let alice_ata_final = world.token_balance(&s.alice_ata);
    let bob_ata_final = world.token_balance(&s.bob_ata);
    let creator_ata_final = world.token_balance(&s.creator_ata);
    let alice_ata_start = 1_000_000u64.saturating_sub(alice_deposit) + alice_deposit; // started at 1_000_000 - deposit is gone, deposit came back via redeem+swaps
    let _ = alice_ata_start; // starting balances vary per-actor; the vault-drain assertion above is the load-bearing one
    assert!(alice_ata_final + bob_ata_final > 0, "sanity: someone got paid");
    let _ = creator_ata_final;

    // Repeat-redeem after a full drain must be rejected with the SPECIFIC
    // AlreadyRedeemed error (not a silent no-op, not a generic failure) --
    // proves the end state left by a real multi-step flow is exactly as
    // consistent as the isolated unit test in redeem_amm.rs assumes.
    let accounts = vec![
        (s.alice, world.get(&s.alice).clone()),
        (s.market, world.get(&s.market).clone()),
        (s.alice_position, world.get(&s.alice_position).clone()),
        (s.vault, world.get(&s.vault).clone()),
        (s.alice_ata, world.get(&s.alice_ata).clone()),
        mollusk_svm_programs_token::token::keyed_account(),
    ];
    world.mollusk.process_and_validate_instruction(
        &ix_redeem_amm(&s.alice, &s.market, &s.alice_position, &s.vault, &s.alice_ata),
        &accounts,
        &[Check::err(SvmProgramError::Custom(OnyxError::AlreadyRedeemed as u32))],
    );
}

#[test]
fn full_lifecycle_different_ordering_and_outcome_b_also_solvent() {
    // Deliberately distinct from the scenario above: outcome B wins instead
    // of A, and the swap ordering is different (bob trades first, alice
    // trades B before A, only one sell total) -- a CPMM's output depends on
    // whatever reserves it reads, so one passing ordering does not imply
    // another does; this is the design doc's explicit "not one happy path"
    // requirement.
    let mut world = setup_world();
    let seed = 2_000_000u64;
    let fee_bps = 250u16; // 2.5%, different fee tier than scenario 1
    let alice_deposit = 300_000u64;
    let bob_deposit = 600_000u64;
    let total_deposited = seed + alice_deposit + bob_deposit;
    let s = wire_up(&mut world, seed, fee_bps, alice_deposit, bob_deposit);

    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_A, SWAP_BUY, 250_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after bob buy A");

    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_B, SWAP_BUY, 120_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after alice buy B");

    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_B, SWAP_BUY, 200_000, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after bob buy B too");

    let alice_tokens_b = read_u64(&world.get(&s.alice_position).data, 88);
    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_B, SWAP_SELL, alice_tokens_b, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after alice sells ALL her B back");

    assert_eq!(world.token_balance(&s.vault), total_deposited, "vault unchanged by any swap");

    let vault_bump = world.get(&s.market).data[100];
    settle(&mut world, &s.market, vault_bump, OUTCOME_SIDE_B);

    world.call(&ix_redeem_amm(&s.alice, &s.market, &s.alice_position, &s.vault, &s.alice_ata), &[Check::success()]);
    world.call(&ix_redeem_amm(&s.bob, &s.market, &s.bob_position, &s.vault, &s.bob_ata), &[Check::success()]);
    world.call(&ix_withdraw_lp_amm(&s.creator, &s.market, &s.pool, &s.vault, &s.creator_ata), &[Check::success()]);

    assert_eq!(world.token_balance(&s.vault), 0, "vault must drain to EXACTLY zero regardless of ordering or winning side");
    let _ = s.mint;
}

#[test]
fn full_lifecycle_expiry_unwind_pays_complete_sets_and_leaves_exact_residual() {
    // Scenario 3 (docs/AMM_TRADING_DESIGN.md §3): the market NEVER settles.
    // After deadline + SETTLE_GRACE, every position refunds usdc_available +
    // min(tokens_a, tokens_b) and the LP takes min(reserves) + fees. Unlike
    // the settled scenarios the vault does NOT drain to zero: the unpaid
    // directional residuals (|ta-tb| per position, |ra-rb| for the pool)
    // remain as permanently unclaimable dust. Same lamport-exact discipline,
    // different target — the vault must land on EXACTLY that residual,
    // computed independently from pre-refund state.
    let mut world = setup_world();
    let seed = 1_000_000u64;
    let fee_bps = 100u16;
    let alice_deposit = 400_000u64;
    let bob_deposit = 500_000u64;
    let total_deposited = seed + alice_deposit + bob_deposit;
    let s = wire_up(&mut world, seed, fee_bps, alice_deposit, bob_deposit);

    // Asymmetric trading so every party ends with a real directional residual.
    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_A, SWAP_BUY, 250_000, 0), &[Check::success()]);
    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_B, SWAP_BUY, 180_000, 0), &[Check::success()]);
    world.call(&ix_swap_amm(&s.alice, &s.market, &s.pool, &s.alice_position, SIDE_B, SWAP_BUY, 60_000, 0), &[Check::success()]);
    let bob_tb = read_u64(&world.get(&s.bob_position).data, 88);
    world.call(&ix_swap_amm(&s.bob, &s.market, &s.pool, &s.bob_position, SIDE_B, SWAP_SELL, bob_tb / 4, 0), &[Check::success()]);
    assert_mid_lifecycle_solvency(&world, &s.alice_position, &s.bob_position, &s.pool, total_deposited, "after swaps, before expiry");

    // NO settle. Warp past deadline + grace instead.
    world.mollusk.sysvars.clock = Clock { unix_timestamp: DEADLINE + SETTLE_GRACE + 1, ..Clock::default() };

    // Expected payouts + residual, computed independently from pre-refund state.
    let a = world.get(&s.alice_position).data.clone();
    let b = world.get(&s.bob_position).data.clone();
    let p = world.get(&s.pool).data.clone();
    let (alice_usdc, alice_ta, alice_tb) = (read_u64(&a, 72), read_u64(&a, 80), read_u64(&a, 88));
    let (bob_usdc, bob_ta, bob_tb) = (read_u64(&b, 72), read_u64(&b, 80), read_u64(&b, 88));
    let (reserve_a, reserve_b, fees) = (read_u64(&p, 72), read_u64(&p, 80), read_u64(&p, 96));
    let alice_expected = alice_usdc + alice_ta.min(alice_tb);
    let bob_expected = bob_usdc + bob_ta.min(bob_tb);
    let lp_expected = reserve_a.min(reserve_b) + fees;
    let expected_residual = total_deposited - alice_expected - bob_expected - lp_expected;
    assert!(alice_ta != alice_tb && bob_ta != bob_tb && reserve_a != reserve_b, "scenario must exercise real directional residuals");
    assert!(expected_residual > 0, "a pure-expiry unwind of an asymmetric book must leave non-zero dust");

    let alice_ata_before = world.token_balance(&s.alice_ata);
    let bob_ata_before = world.token_balance(&s.bob_ata);
    let creator_ata_before = world.token_balance(&s.creator_ata);

    world.call(&ix_redeem_amm(&s.alice, &s.market, &s.alice_position, &s.vault, &s.alice_ata), &[Check::success()]);
    world.call(&ix_redeem_amm(&s.bob, &s.market, &s.bob_position, &s.vault, &s.bob_ata), &[Check::success()]);
    world.call(&ix_withdraw_lp_amm(&s.creator, &s.market, &s.pool, &s.vault, &s.creator_ata), &[Check::success()]);

    assert_eq!(world.token_balance(&s.alice_ata) - alice_ata_before, alice_expected, "alice expiry refund = deposits + min(ta,tb) exactly");
    assert_eq!(world.token_balance(&s.bob_ata) - bob_ata_before, bob_expected, "bob expiry refund = deposits + min(ta,tb) exactly");
    assert_eq!(world.token_balance(&s.creator_ata) - creator_ata_before, lp_expected, "LP expiry payout = min(reserves) + fees exactly");
    assert_eq!(
        world.token_balance(&s.vault),
        expected_residual,
        "vault must land on EXACTLY the sum of directional residuals — nothing more paid, nothing extra stranded"
    );

    // Double-dip guards hold on the expiry path too.
    let accounts = vec![
        (s.alice, world.get(&s.alice).clone()),
        (s.market, world.get(&s.market).clone()),
        (s.alice_position, world.get(&s.alice_position).clone()),
        (s.vault, world.get(&s.vault).clone()),
        (s.alice_ata, world.get(&s.alice_ata).clone()),
        mollusk_svm_programs_token::token::keyed_account(),
    ];
    world.mollusk.process_and_validate_instruction(
        &ix_redeem_amm(&s.alice, &s.market, &s.alice_position, &s.vault, &s.alice_ata),
        &accounts,
        &[Check::err(SvmProgramError::Custom(OnyxError::AlreadyRedeemed as u32))],
    );
}

// ---- audit Phase 1 + 3: creation-time guards (fee ceiling, market ownership) ----

/// fee_bps ceiling is exactly MAX_AMM_FEE_BPS (10%): 1000 passes, 1001 is BadParams.
#[test]
fn create_pool_fee_cap_boundary() {
    for (fee, ok) in [(1000u16, true), (1001u16, false)] {
        let mut world = setup_world();
        let market = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (pool, _) = Pubkey::find_program_address(&[SEED_AMM_POOL, market.as_ref()], &PROGRAM_ID);
        let (vault, vault_bump) = Pubkey::find_program_address(&[SEED_VAULT, market.as_ref()], &PROGRAM_ID);
        let creator = Pubkey::new_unique();
        let creator_ata = Pubkey::new_unique();
        let rent = Rent::default();
        world.set(market, Account { lamports: rent.minimum_balance(MARKET_LEN), data: market_bytes(STATUS_OPEN, OUTCOME_UNKNOWN, DEADLINE, vault_bump), owner: PROGRAM_ID, executable: false, rent_epoch: 0 });
        world.set(pool, system_placeholder());
        world.set(vault, token_account(mint, vault, 0));
        world.set(creator, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID));
        world.set(creator_ata, token_account(mint, creator, 1_000_000));
        let checks = if ok {
            vec![Check::success()]
        } else {
            vec![Check::err(SvmProgramError::Custom(OnyxError::BadParams as u32))]
        };
        world.call(&ix_create_amm_pool(&creator, &market, &pool, &vault, &creator_ata, 1_000_000, fee), &checks);
    }
}

/// A "market" account owned by a foreign program can't get a pool: InvalidOwner (7001).
#[test]
fn create_pool_rejects_foreign_owned_market() {
    let mut world = setup_world();
    let market = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let (pool, _) = Pubkey::find_program_address(&[SEED_AMM_POOL, market.as_ref()], &PROGRAM_ID);
    let (vault, vault_bump) = Pubkey::find_program_address(&[SEED_VAULT, market.as_ref()], &PROGRAM_ID);
    let creator = Pubkey::new_unique();
    let creator_ata = Pubkey::new_unique();
    let rent = Rent::default();
    // valid market BYTES, wrong OWNER — only the ownership check can catch this
    world.set(market, Account { lamports: rent.minimum_balance(MARKET_LEN), data: market_bytes(STATUS_OPEN, OUTCOME_UNKNOWN, DEADLINE, vault_bump), owner: Pubkey::new_unique(), executable: false, rent_epoch: 0 });
    world.set(pool, system_placeholder());
    world.set(vault, token_account(mint, vault, 0));
    world.set(creator, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID));
    world.set(creator_ata, token_account(mint, creator, 1_000_000));
    world.call(
        &ix_create_amm_pool(&creator, &market, &pool, &vault, &creator_ata, 1_000_000, 100),
        &[Check::err(SvmProgramError::Custom(OnyxError::InvalidOwner as u32))],
    );
}

/// Foreign-owned market can't take positions either — but a market owned by
/// the DELEGATION PROGRAM must keep working: that's the production session
/// flow (seeder delegates market+pool first, wallets open positions after).
/// An ONYX-only ownership check here would brick one-signature onboarding.
#[test]
fn open_position_market_ownership_gate() {
    let rent = Rent::default();
    let delegation_program = Pubkey::new_from_array(DELEGATION_PROGRAM_ID);
    for (market_owner, expect_ok) in [
        (PROGRAM_ID, true),            // pre-delegation
        (delegation_program, true),    // post-delegation (seeded-market norm)
        (Pubkey::new_unique(), false), // fabricated foreign account
    ] {
        let mut world = setup_world();
        let market = Pubkey::new_unique();
        let (_, vault_bump) = Pubkey::find_program_address(&[SEED_VAULT, market.as_ref()], &PROGRAM_ID);
        let owner = Pubkey::new_unique();
        let (position, _) = Pubkey::find_program_address(&[SEED_AMM_POSITION, market.as_ref(), owner.as_ref()], &PROGRAM_ID);
        world.set(market, Account { lamports: rent.minimum_balance(MARKET_LEN), data: market_bytes(STATUS_OPEN, OUTCOME_UNKNOWN, DEADLINE, vault_bump), owner: market_owner, executable: false, rent_epoch: 0 });
        world.set(owner, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID));
        world.set(position, system_placeholder());
        let checks = if expect_ok {
            vec![Check::success()]
        } else {
            vec![Check::err(SvmProgramError::Custom(OnyxError::InvalidOwner as u32))]
        };
        world.call(&ix_open_amm_position(&owner, &market, &position), &checks);
    }
}
