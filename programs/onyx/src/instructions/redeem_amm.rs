//! redeem_amm (disc 35): base-layer AMM position payout. Pays out two
//! independent legs in one call, same two-leg shape as withdraw_trading.rs:
//!   1. `usdc_available` (deposited, never swapped — riskless, always
//!      withdrawable, no settlement required; I-NoTrap discipline: a
//!      park-and-leave depositor is never stuck waiting on settlement).
//!   2. Post-settlement token redemption: winning-side tokens redeem 1:1
//!      for collateral from the vault; losing-side tokens die worthless.
//!      Both token balances zero on this leg — the position's directional
//!      exposure is fully resolved either way, matching the solvency
//!      identity in docs/AMM_TRADING_DESIGN.md §1 (Σ user.tokens_winning
//!      must land at exactly what the vault can pay). `redeemed` guards
//!      leg 2 against a second payout; a repeat call with nothing left
//!      returns the specific `AlreadyRedeemed` rather than the generic
//!      `NothingToRefund`, so the two "nothing to withdraw" cases are
//!      distinguishable by the caller.
//!
//! Accounts: [0] owner (S) · [1] market (read) · [2] position (W)
//!           · [3] vault (W) · [4] owner_usdc_ata (W) · [5] token program
//!
//! Requires `position` to be back on base (owned by this program) -- while
//! delegated it's owned by the Delegation Program and this fails the same
//! way withdraw_trading does: you can't withdraw funds the ER might still
//! be actively trading with.

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    pubkey::{find_program_address, Pubkey},
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;
use pinocchio_token::state::TokenAccount;

use crate::constants::*;
use crate::error::OnyxError;
use crate::state::amm_position::AmmPosition;
use crate::state::market::Market;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, market_ai, position_ai, vault_ai, owner_ata, _token_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !position_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let (market_status, outcome, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        (market.status(), market.outcome(), market.vault_bump())
    };

    let mut pdata = position_ai.try_borrow_mut_data()?;
    let mut position = AmmPosition::load(&mut pdata)?;
    if &position.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &position.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }

    let already_redeemed = position.redeemed();
    let mut payout = position.usdc_available();

    let settled = market_status == STATUS_SETTLED || market_status == STATUS_CLAIMED;
    if settled && !already_redeemed {
        let winning_side = if outcome == OUTCOME_SIDE_A { SIDE_A } else { SIDE_B };
        let tokens_winning = if winning_side == SIDE_A { position.tokens_a() } else { position.tokens_b() };
        payout = payout.checked_add(tokens_winning).ok_or(OnyxError::ArithmeticOverflow)?;
        position.set_tokens_a(0);
        position.set_tokens_b(0);
        position.set_redeemed(true);
    }

    if payout == 0 {
        if settled && already_redeemed {
            return Err(OnyxError::AlreadyRedeemed.into());
        }
        return Err(OnyxError::NothingToRefund.into());
    }

    {
        let vault = TokenAccount::from_account_info(vault_ai).map_err(|_| OnyxError::InvalidAccountSize)?;
        if vault.amount() < payout {
            return Err(OnyxError::VaultUnderfunded.into());
        }
    }

    position.set_usdc_available(0);
    position.set_withdrawn(position.withdrawn().checked_add(payout).ok_or(OnyxError::ArithmeticOverflow)?);
    drop(pdata);

    let (vault_pda, _) = find_program_address(&[SEED_VAULT, market_ai.key().as_ref()], program_id);
    if vault_ai.key() != &vault_pda {
        return Err(OnyxError::InvalidPda.into());
    }
    let vault_bump_arr = [vault_bump];
    let seeds = [Seed::from(SEED_VAULT), Seed::from(market_ai.key().as_ref()), Seed::from(&vault_bump_arr)];
    let signer = Signer::from(&seeds);
    Transfer {
        from: vault_ai,
        to: owner_ata,
        authority: vault_ai,
        amount: payout,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    //! Real mollusk-svm SBF execution, same token-account fixture shape as
    //! withdraw_trading.rs's tests (the closest analog: base-layer, two-leg
    //! payout, real SPL transfer). The case worth the most scrutiny here is
    //! the AlreadyRedeemed-vs-NothingToRefund distinction, since it's new
    //! (withdraw_trading only ever returns NothingToRefund for its double-
    //! payout guard) and easy to get backwards.

    use mollusk_svm::{result::Check, Mollusk};
    use solana_account::Account;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_program_error::ProgramError as SvmProgramError;
    use solana_program_pack::Pack;
    use solana_pubkey::Pubkey;
    use solana_rent::Rent;
    use spl_token_interface::state::{Account as TokenAccountState, AccountState};

    use crate::constants::{
        DISC_MARKET, IX_REDEEM_AMM, OUTCOME_SIDE_A, OUTCOME_SIDE_B, STATUS_OPEN, STATUS_SETTLED,
    };
    use crate::error::OnyxError;
    use crate::state::amm_position::AMM_POSITION_LEN;
    use crate::state::market::MARKET_LEN;

    const PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID);
    const FAKE_DELEGATION_PROGRAM: Pubkey = Pubkey::new_from_array([9u8; 32]);

    fn market_bytes(status: u8, outcome: u8, vault_bump: u8) -> Vec<u8> {
        let mut b = vec![0u8; MARKET_LEN];
        b[0] = DISC_MARKET;
        b[26] = status;
        b[27] = outcome;
        b[100] = vault_bump;
        b
    }

    #[allow(clippy::too_many_arguments)]
    fn position_bytes(
        owner: &Pubkey,
        market: &Pubkey,
        usdc_available: u64,
        tokens_a: u64,
        tokens_b: u64,
        redeemed: bool,
    ) -> Vec<u8> {
        let mut b = vec![0u8; AMM_POSITION_LEN];
        b[0] = crate::constants::DISC_AMM_POSITION;
        b[8..40].copy_from_slice(owner.as_ref());
        b[40..72].copy_from_slice(market.as_ref());
        b[72..80].copy_from_slice(&usdc_available.to_le_bytes());
        b[80..88].copy_from_slice(&tokens_a.to_le_bytes());
        b[88..96].copy_from_slice(&tokens_b.to_le_bytes());
        b[104] = redeemed as u8;
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
        owner: Pubkey,
        market_key: Pubkey,
        position_key: Pubkey,
        vault_key: Pubkey,
        owner_ata: Pubkey,
        mint: Pubkey,
        vault_bump: u8,
        vault_funding: u64,
    }

    fn setup() -> Fixture {
        unsafe {
            std::env::set_var("SBF_OUT_DIR", concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy"));
        }
        let mut mollusk = Mollusk::new(&PROGRAM_ID, "onyx");
        mollusk_svm_programs_token::token::add_program(&mut mollusk);

        let owner = Pubkey::new_unique();
        let market_key = Pubkey::new_unique();
        let position_key = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (vault_key, vault_bump) = Pubkey::find_program_address(&[b"vault", market_key.as_ref()], &PROGRAM_ID);
        let owner_ata = Pubkey::new_unique();

        Fixture {
            mollusk, owner, market_key, position_key, vault_key, owner_ata, mint, vault_bump,
            vault_funding: 10_000_000,
        }
    }

    #[allow(clippy::too_many_arguments)]
    impl Fixture {
        fn run(
            &mut self,
            position_owner_field: &Pubkey,
            position_market_field: &Pubkey,
            position_account_owner: Pubkey,
            usdc_available: u64,
            market_status: u8,
            outcome: u8,
            tokens_a: u64,
            tokens_b: u64,
            redeemed: bool,
            extra_checks: &[Check],
        ) -> Vec<(Pubkey, Account)> {
            let rent = Rent::default();
            let position_data =
                position_bytes(position_owner_field, position_market_field, usdc_available, tokens_a, tokens_b, redeemed);

            let accounts = vec![
                (self.owner, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID)),
                (
                    self.market_key,
                    Account {
                        lamports: rent.minimum_balance(MARKET_LEN),
                        data: market_bytes(market_status, outcome, self.vault_bump),
                        owner: PROGRAM_ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (
                    self.position_key,
                    Account {
                        lamports: rent.minimum_balance(AMM_POSITION_LEN),
                        data: position_data,
                        owner: position_account_owner,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (self.vault_key, token_account(self.mint, self.vault_key, self.vault_funding)),
                (self.owner_ata, token_account(self.mint, self.owner, 0)),
                mollusk_svm_programs_token::token::keyed_account(),
            ];

            let instruction = Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(self.owner, true),
                    AccountMeta::new_readonly(self.market_key, false),
                    AccountMeta::new(self.position_key, false),
                    AccountMeta::new(self.vault_key, false),
                    AccountMeta::new(self.owner_ata, false),
                    AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
                ],
                data: vec![IX_REDEEM_AMM],
            };

            let result = self.mollusk.process_and_validate_instruction(&instruction, &accounts, extra_checks);
            result.resulting_accounts
        }
    }

    #[test]
    fn redeem_pre_settlement_pays_available_leg_only() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* usdc_available */ 200_000, STATUS_OPEN, 0, /* tokens_a */ 300_000, /* tokens_b */ 0,
            false,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 200_000, "tokens leg untouched pre-settlement");
        let position_after = resulting.iter().find(|(k, _)| *k == fx.position_key).unwrap();
        assert_eq!(&position_after.1.data[72..80], &0u64.to_le_bytes(), "usdc_available zeroed");
        assert_eq!(&position_after.1.data[80..88], &300_000u64.to_le_bytes(), "tokens_a untouched, still tradeable");
        assert_eq!(position_after.1.data[104], 0, "redeemed stays false pre-settlement");
    }

    #[test]
    fn redeem_post_settlement_pays_available_plus_winning_tokens() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* usdc_available */ 100_000, STATUS_SETTLED, OUTCOME_SIDE_A, /* tokens_a */ 300_000, /* tokens_b */ 999_000,
            false,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 400_000, "available + winning tokens_a");
        let position_after = resulting.iter().find(|(k, _)| *k == fx.position_key).unwrap();
        assert_eq!(&position_after.1.data[80..88], &0u64.to_le_bytes(), "tokens_a zeroed");
        assert_eq!(&position_after.1.data[88..96], &0u64.to_le_bytes(), "tokens_b (losing) also zeroed, dies worthless");
        assert_eq!(position_after.1.data[104], 1, "redeemed set");
    }

    #[test]
    fn redeem_losing_side_pays_available_only_tokens_die() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* usdc_available */ 50_000, STATUS_SETTLED, OUTCOME_SIDE_A, /* tokens_a */ 0, /* tokens_b */ 500_000,
            false,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 50_000, "no payout for losing-side tokens");
    }

    #[test]
    fn redeem_rejects_double_redeem_with_specific_error() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, PROGRAM_ID,
            /* usdc_available */ 0, STATUS_SETTLED, OUTCOME_SIDE_A, 300_000, 0,
            /* redeemed */ true,
            &[Check::err(SvmProgramError::Custom(OnyxError::AlreadyRedeemed as u32))],
        );
    }

    #[test]
    fn redeem_rejects_nothing_to_redeem_pre_settlement() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, PROGRAM_ID,
            0, STATUS_OPEN, 0, 0, 0, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::NothingToRefund as u32))],
        );
    }

    #[test]
    fn redeem_rejects_wrong_owner() {
        let mut fx = setup();
        let market = fx.market_key;
        fx.run(
            &Pubkey::new_unique(), &market, PROGRAM_ID,
            200_000, STATUS_OPEN, 0, 0, 0, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::Unauthorized as u32))],
        );
    }

    #[test]
    fn redeem_rejects_wrong_market() {
        let mut fx = setup();
        let owner = fx.owner;
        fx.run(
            &owner, &Pubkey::new_unique(), PROGRAM_ID,
            200_000, STATUS_OPEN, 0, 0, 0, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::BadParams as u32))],
        );
    }

    #[test]
    fn redeem_rejects_while_still_delegated() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, FAKE_DELEGATION_PROGRAM,
            200_000, STATUS_OPEN, 0, 0, 0, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::InvalidOwner as u32))],
        );
    }

    #[test]
    fn redeem_rejects_vault_underfunded() {
        let mut fx = setup();
        fx.vault_funding = 100;
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, PROGRAM_ID,
            200_000, STATUS_OPEN, 0, 0, 0, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::VaultUnderfunded as u32))],
        );
    }

    #[test]
    fn redeem_settled_outcome_b_pays_tokens_b() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            0, STATUS_SETTLED, OUTCOME_SIDE_B, /* tokens_a (losing) */ 777_000, /* tokens_b (winning) */ 222_000,
            false,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 222_000);
    }
}
