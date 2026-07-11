//! refund_expired (disc 7): return a position's stake if the market never
//! resolved. Guarantees I-NoTrap — funds can't be stranded by an unposted root.
//!
//! Guard: now > deadline + SETTLE_GRACE AND market not Settled/Claimed.
//! Permissionless: anyone may trigger it; funds only ever go back to the
//! position owner's token account.
//!
//! Accounts: [0] caller (S,W) · [1] market (W) · [2] position (W) · [3] vault (W)
//!           · [4] owner_usdc_ata (W) · [5] token program
//! (deadline is read from the market; SETTLE_GRACE is a constant.)

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::market::Market;
use crate::state::position::Position;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [caller, market_ai, position_ai, vault_ai, owner_ata, _token_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };

    if !caller.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !position_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    // Market must be past deadline+grace and NOT settled/claimed.
    let (deadline, status, market_key, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        (
            market.deadline(),
            market.status(),
            *market_ai.key(),
            market.vault_bump(),
        )
    };
    if status == STATUS_SETTLED || status == STATUS_CLAIMED || status == STATUS_REFUNDED {
        return Err(OnyxError::WrongStatus.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if now <= deadline.saturating_add(SETTLE_GRACE) {
        return Err(OnyxError::NotExpired.into());
    }

    // Verify vault PDA.
    let (vault_pda, _vb) = find_program_address(&[SEED_VAULT, market_key.as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }

    // Position must belong to this market + the owner_ata's owner, unclaimed.
    let (stake, pos_owner) = {
        let mut pdata = position_ai.try_borrow_mut_data()?;
        let pos = Position::load(&mut pdata)?;
        if &pos.market() != market_ai.key() {
            return Err(OnyxError::BadParams.into());
        }
        if pos.claimed() {
            return Err(OnyxError::AlreadyClaimed.into());
        }
        (pos.amount(), pos.owner())
    };
    let _ = pos_owner;

    // I-Solvency guard.
    {
        let vault = TokenAccount::from_account_info(vault_ai)
            .map_err(|_| OnyxError::InvalidAccountSize)?;
        if vault.amount() < stake {
            return Err(OnyxError::VaultUnderfunded.into());
        }
    }

    // Effects before interaction.
    {
        let mut pdata = position_ai.try_borrow_mut_data()?;
        let mut pos = Position::load(&mut pdata)?;
        pos.set_claimed(true);
    }
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let mut market = Market::load(&mut mdata)?;
        market.set_status(STATUS_REFUNDED);
    }

    // PDA-signed refund vault -> owner ATA.
    let vault_bump_arr = [vault_bump];
    let seeds = [
        Seed::from(SEED_VAULT),
        Seed::from(market_key.as_ref()),
        Seed::from(&vault_bump_arr),
    ];
    let signer = Signer::from(&seeds);
    Transfer {
        from: vault_ai,
        to: owner_ata,
        authority: vault_ai,
        amount: stake,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    //! Custody-critical I-NoTrap coverage for refund_expired via a real
    //! mollusk-svm SBF execution (loads target/deploy/onyx.so and the real
    //! SPL Token program, so this exercises the actual on-chain bytecode --
    //! not a Rust-level unit test of the handler function). The Clock sysvar
    //! is simulated directly (`mollusk.sysvars.clock = ...`) so this needs no
    //! real 2-hour wait.

    use mollusk_svm::{result::Check, Mollusk};
    use solana_account::Account;
    use solana_clock::Clock;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_program_error::ProgramError as SvmProgramError;
    use solana_pubkey::Pubkey;
    use solana_program_pack::Pack;
    use solana_rent::Rent;
    use spl_token_interface::state::{Account as TokenAccountState, AccountState};

    use crate::constants::{SETTLE_GRACE, STATUS_CLAIMED, STATUS_OPEN, STATUS_REFUNDED, STATUS_SETTLED};
    use crate::error::OnyxError;
    use crate::state::market::MARKET_LEN;
    use crate::state::position::POSITION_LEN;

    const PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID);

    fn market_bytes(status: u8, deadline: i64, vault_bump: u8) -> Vec<u8> {
        let mut b = vec![0u8; MARKET_LEN];
        b[0] = crate::constants::DISC_MARKET; // disc
        b[26] = status;
        b[36..44].copy_from_slice(&deadline.to_le_bytes());
        b[100] = vault_bump;
        b
    }

    fn position_bytes(owner: &Pubkey, market: &Pubkey, amount: u64, side: u8, claimed: bool) -> Vec<u8> {
        let mut b = vec![0u8; POSITION_LEN];
        b[0] = crate::constants::DISC_POSITION;
        b[8..40].copy_from_slice(owner.as_ref());
        b[40..72].copy_from_slice(market.as_ref());
        b[72..80].copy_from_slice(&amount.to_le_bytes());
        b[80] = side;
        b[81] = claimed as u8;
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

    struct Fixture {
        mollusk: Mollusk,
        caller: Pubkey,
        market_key: Pubkey,
        position_key: Pubkey,
        vault_key: Pubkey,
        owner_ata: Pubkey,
        owner: Pubkey,
        mint: Pubkey,
        stake: u64,
        vault_bump: u8,
    }

    fn setup() -> Fixture {
        // Mollusk resolves the compiled program by `SBF_OUT_DIR` (default:
        // CWD-relative `target/deploy`), which is wrong whenever `cargo test`
        // isn't invoked with CWD == this crate's own directory (e.g. `cargo
        // test --manifest-path programs/onyx/Cargo.toml` from the repo root,
        // which every other command in this session uses). Pin it explicitly
        // so this test is robust to how/where it's invoked from.
        unsafe {
            std::env::set_var(
                "SBF_OUT_DIR",
                concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy"),
            );
        }
        let mut mollusk = Mollusk::new(&PROGRAM_ID, "onyx");
        mollusk_svm_programs_token::token::add_program(&mut mollusk);

        let caller = Pubkey::new_unique();
        let market_key = Pubkey::new_unique();
        let position_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (vault_key, vault_bump) =
            Pubkey::find_program_address(&[b"vault", market_key.as_ref()], &PROGRAM_ID);
        let owner_ata = Pubkey::new_unique();
        let stake = 500_000u64;

        Fixture {
            mollusk,
            caller,
            market_key,
            position_key,
            vault_key,
            owner_ata,
            owner,
            mint,
            stake,
            vault_bump,
        }
    }

    impl Fixture {
        fn run(&mut self, status: u8, deadline: i64, claimed: bool, extra_checks: &[Check]) -> Vec<(Pubkey, Account)> {
            let market_data = market_bytes(status, deadline, self.vault_bump);
            let position_data = position_bytes(&self.owner, &self.market_key, self.stake, crate::constants::SIDE_A, claimed);
            let rent = Rent::default();

            let accounts = vec![
                (self.caller, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID)),
                (
                    self.market_key,
                    Account {
                        lamports: rent.minimum_balance(MARKET_LEN),
                        data: market_data,
                        owner: PROGRAM_ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (
                    self.position_key,
                    Account {
                        lamports: rent.minimum_balance(POSITION_LEN),
                        data: position_data,
                        owner: PROGRAM_ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (self.vault_key, token_account(self.mint, self.vault_key, self.stake)),
                (self.owner_ata, token_account(self.mint, self.owner, 0)),
                mollusk_svm_programs_token::token::keyed_account(),
            ];

            let instruction = Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(self.caller, true),
                    AccountMeta::new(self.market_key, false),
                    AccountMeta::new(self.position_key, false),
                    AccountMeta::new(self.vault_key, false),
                    AccountMeta::new(self.owner_ata, false),
                    AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
                ],
                data: vec![crate::constants::IX_REFUND_EXPIRED],
            };

            let result = self.mollusk.process_and_validate_instruction(&instruction, &accounts, extra_checks);
            result.resulting_accounts
        }
    }

    #[test]
    fn refund_succeeds_after_deadline_plus_grace() {
        let mut fx = setup();
        let now = 1_000_000i64;
        let deadline = now - SETTLE_GRACE - 10; // safely past grace
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };

        let resulting = fx.run(STATUS_OPEN, deadline, false, &[Check::success()]);

        let owner_ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        let decoded = TokenAccountState::unpack(&owner_ata_after.1.data).unwrap();
        assert_eq!(decoded.amount, fx.stake, "full stake refunded to owner ATA");

        let market_after = resulting.iter().find(|(k, _)| *k == fx.market_key).unwrap();
        assert_eq!(market_after.1.data[26], STATUS_REFUNDED, "market flipped to Refunded");

        let position_after = resulting.iter().find(|(k, _)| *k == fx.position_key).unwrap();
        assert_eq!(position_after.1.data[81], 1, "position marked claimed (I-Once, no double refund)");
    }

    #[test]
    fn refund_rejected_before_grace_elapses() {
        let mut fx = setup();
        let now = 1_000_000i64;
        let deadline = now - SETTLE_GRACE + 10; // still inside the grace window
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };

        fx.run(STATUS_OPEN, deadline, false, &[Check::err(SvmProgramError::Custom(OnyxError::NotExpired as u32))]);
    }

    #[test]
    fn refund_rejected_if_already_settled() {
        // I-NoTrap only opens the expired-refund path for UNRESOLVED markets;
        // a Settled market must go through claim, never refund_expired --
        // otherwise a winner's payout could be double-spent as a "refund".
        let mut fx = setup();
        let now = 1_000_000i64;
        let deadline = now - SETTLE_GRACE - 10;
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };

        fx.run(STATUS_SETTLED, deadline, false, &[Check::err(SvmProgramError::Custom(OnyxError::WrongStatus as u32))]);
    }

    #[test]
    fn refund_rejected_if_already_claimed() {
        // I-Once: a position that already claimed (via a prior refund_expired
        // or claim) can never be paid twice.
        let mut fx = setup();
        let now = 1_000_000i64;
        let deadline = now - SETTLE_GRACE - 10;
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };

        fx.run(STATUS_OPEN, deadline, true, &[Check::err(SvmProgramError::Custom(OnyxError::AlreadyClaimed as u32))]);
    }

    #[test]
    fn refund_rejected_if_already_refunded() {
        // Idempotency: calling refund_expired a second time on an already-
        // Refunded market must not transfer again.
        let mut fx = setup();
        let now = 1_000_000i64;
        let deadline = now - SETTLE_GRACE - 10;
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };

        fx.run(STATUS_REFUNDED, deadline, false, &[Check::err(SvmProgramError::Custom(OnyxError::WrongStatus as u32))]);
    }

    #[test]
    fn refund_rejected_if_already_claimed_status() {
        let mut fx = setup();
        let now = 1_000_000i64;
        let deadline = now - SETTLE_GRACE - 10;
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };

        fx.run(STATUS_CLAIMED, deadline, false, &[Check::err(SvmProgramError::Custom(OnyxError::WrongStatus as u32))]);
    }
}
