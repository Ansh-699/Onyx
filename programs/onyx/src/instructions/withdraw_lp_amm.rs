//! withdraw_lp_amm (disc 36): base-layer, settled-only payout of the
//! seeded-liquidity leg to `lp_owner`. Unlike redeem_amm's `usdc_available`
//! leg, LPs have no pre-settlement park-and-leave: their capital is fully
//! at risk in the pool's reserves until the market resolves (real risk,
//! disclosed — docs/AMM_TRADING_DESIGN.md §2's "no bluff" LP treatment).
//!
//! Payout = reserve_winning + fees_accrued (the losing side's reserve was
//! already fully allocated to winning-side redeemers via redeem_amm, so it
//! is not the LP's to claim — this is the same "losing side dies worthless"
//! rule applied at the pool level instead of the position level). Zeroes
//! both reserves and fees_accrued, sets `lp_withdrawn` to guard a repeat
//! call.
//!
//! Accounts: [0] lp_owner (S) · [1] market (read) · [2] pool (W)
//!           · [3] vault (W) · [4] lp_owner_usdc_ata (W) · [5] token program
//!
//! Requires `pool` to be back on base (owned by this program), same
//! discipline as withdraw_trading / redeem_amm: can't pay out capital the
//! ER might still be actively trading with.

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
use crate::state::amm_pool::AmmPool;
use crate::state::market::Market;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [lp_owner, market_ai, pool_ai, vault_ai, lp_owner_ata, _token_program, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !lp_owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !pool_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let (market_status, outcome, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        (market.status(), market.outcome(), market.vault_bump())
    };
    let settled = market_status == STATUS_SETTLED || market_status == STATUS_CLAIMED;
    if !settled {
        return Err(OnyxError::NotSettled.into());
    }

    let mut pdata = pool_ai.try_borrow_mut_data()?;
    let mut pool = AmmPool::load(&mut pdata)?;
    if &pool.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }
    if &pool.lp_owner() != lp_owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if pool.lp_withdrawn() {
        return Err(OnyxError::LpAlreadyWithdrawn.into());
    }

    let winning_side = if outcome == OUTCOME_SIDE_A { SIDE_A } else { SIDE_B };
    let reserve_winning = if winning_side == SIDE_A { pool.reserve_a() } else { pool.reserve_b() };
    let payout = reserve_winning.checked_add(pool.fees_accrued()).ok_or(OnyxError::ArithmeticOverflow)?;

    if payout == 0 {
        return Err(OnyxError::NothingToRefund.into());
    }

    {
        let vault = TokenAccount::from_account_info(vault_ai).map_err(|_| OnyxError::InvalidAccountSize)?;
        if vault.amount() < payout {
            return Err(OnyxError::VaultUnderfunded.into());
        }
    }

    pool.set_reserve_a(0);
    pool.set_reserve_b(0);
    pool.set_fees_accrued(0);
    pool.set_lp_withdrawn(true);
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
        to: lp_owner_ata,
        authority: vault_ai,
        amount: payout,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    //! Real mollusk-svm SBF execution, same token-account fixture shape as
    //! redeem_amm.rs / withdraw_trading.rs. The property worth the most
    //! scrutiny: the LP is paid the WINNING side's reserve only — the losing
    //! side's leftover reserve must never leak to the LP (it's already
    //! spoken for by the solvency identity's Σtokens_winning obligation,
    //! see docs/AMM_TRADING_DESIGN.md §1) and fee accrual must be settled-
    //! outcome-agnostic (paid regardless of which side won).

    use mollusk_svm::{result::Check, Mollusk};
    use solana_account::Account;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_program_error::ProgramError as SvmProgramError;
    use solana_program_pack::Pack;
    use solana_pubkey::Pubkey;
    use solana_rent::Rent;
    use spl_token_interface::state::{Account as TokenAccountState, AccountState};

    use crate::constants::{DISC_MARKET, IX_WITHDRAW_LP_AMM, OUTCOME_SIDE_A, OUTCOME_SIDE_B, STATUS_OPEN, STATUS_SETTLED};
    use crate::error::OnyxError;
    use crate::state::amm_pool::AMM_POOL_LEN;
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
    fn pool_bytes(
        market: &Pubkey,
        lp_owner: &Pubkey,
        reserve_a: u64,
        reserve_b: u64,
        fees_accrued: u64,
        lp_withdrawn: bool,
    ) -> Vec<u8> {
        let mut b = vec![0u8; AMM_POOL_LEN];
        b[0] = crate::constants::DISC_AMM_POOL;
        b[8..40].copy_from_slice(market.as_ref());
        b[40..72].copy_from_slice(lp_owner.as_ref());
        b[72..80].copy_from_slice(&reserve_a.to_le_bytes());
        b[80..88].copy_from_slice(&reserve_b.to_le_bytes());
        b[96..104].copy_from_slice(&fees_accrued.to_le_bytes());
        b[114] = lp_withdrawn as u8;
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
        lp_owner: Pubkey,
        market_key: Pubkey,
        pool_key: Pubkey,
        vault_key: Pubkey,
        lp_owner_ata: Pubkey,
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

        let lp_owner = Pubkey::new_unique();
        let market_key = Pubkey::new_unique();
        let pool_key = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (vault_key, vault_bump) = Pubkey::find_program_address(&[b"vault", market_key.as_ref()], &PROGRAM_ID);
        let lp_owner_ata = Pubkey::new_unique();

        Fixture {
            mollusk, lp_owner, market_key, pool_key, vault_key, lp_owner_ata, mint, vault_bump,
            vault_funding: 10_000_000,
        }
    }

    #[allow(clippy::too_many_arguments)]
    impl Fixture {
        fn run(
            &mut self,
            pool_market_field: &Pubkey,
            pool_lp_owner_field: &Pubkey,
            pool_account_owner: Pubkey,
            market_status: u8,
            outcome: u8,
            reserve_a: u64,
            reserve_b: u64,
            fees_accrued: u64,
            lp_withdrawn: bool,
            extra_checks: &[Check],
        ) -> Vec<(Pubkey, Account)> {
            let rent = Rent::default();
            let pool_data = pool_bytes(pool_market_field, pool_lp_owner_field, reserve_a, reserve_b, fees_accrued, lp_withdrawn);

            let accounts = vec![
                (self.lp_owner, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID)),
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
                    self.pool_key,
                    Account {
                        lamports: rent.minimum_balance(AMM_POOL_LEN),
                        data: pool_data,
                        owner: pool_account_owner,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (self.vault_key, token_account(self.mint, self.vault_key, self.vault_funding)),
                (self.lp_owner_ata, token_account(self.mint, self.lp_owner, 0)),
                mollusk_svm_programs_token::token::keyed_account(),
            ];

            let instruction = Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(self.lp_owner, true),
                    AccountMeta::new_readonly(self.market_key, false),
                    AccountMeta::new(self.pool_key, false),
                    AccountMeta::new(self.vault_key, false),
                    AccountMeta::new(self.lp_owner_ata, false),
                    AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
                ],
                data: vec![IX_WITHDRAW_LP_AMM],
            };

            let result = self.mollusk.process_and_validate_instruction(&instruction, &accounts, extra_checks);
            result.resulting_accounts
        }
    }

    #[test]
    fn withdraw_lp_pays_reserve_winning_plus_fees() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &market, &lp, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_A, /* reserve_a */ 1_500_000, /* reserve_b */ 700_000, /* fees */ 20_000,
            false,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.lp_owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 1_520_000, "reserve_a (winning) + fees, NOT reserve_b");
        let pool_after = resulting.iter().find(|(k, _)| *k == fx.pool_key).unwrap();
        assert_eq!(&pool_after.1.data[72..80], &0u64.to_le_bytes(), "reserve_a zeroed");
        assert_eq!(&pool_after.1.data[80..88], &0u64.to_le_bytes(), "reserve_b zeroed");
        assert_eq!(&pool_after.1.data[96..104], &0u64.to_le_bytes(), "fees zeroed");
        assert_eq!(pool_after.1.data[114], 1, "lp_withdrawn set");
    }

    #[test]
    fn withdraw_lp_outcome_b_pays_reserve_b_not_a() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &market, &lp, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_B, 1_500_000, 700_000, 20_000,
            false,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.lp_owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 720_000, "reserve_b (winning) + fees");
    }

    #[test]
    fn withdraw_lp_rejects_not_settled() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        let market = fx.market_key;
        fx.run(
            &market, &lp, PROGRAM_ID,
            STATUS_OPEN, 0, 1_500_000, 700_000, 20_000, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::NotSettled as u32))],
        );
    }

    #[test]
    fn withdraw_lp_rejects_wrong_lp_owner() {
        let mut fx = setup();
        let market = fx.market_key;
        fx.run(
            &market, &Pubkey::new_unique() /* recorded lp_owner != signer */, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_A, 1_500_000, 700_000, 20_000, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::Unauthorized as u32))],
        );
    }

    #[test]
    fn withdraw_lp_rejects_double_withdraw() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        let market = fx.market_key;
        fx.run(
            &market, &lp, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_A, 1_500_000, 700_000, 20_000, /* lp_withdrawn */ true,
            &[Check::err(SvmProgramError::Custom(OnyxError::LpAlreadyWithdrawn as u32))],
        );
    }

    #[test]
    fn withdraw_lp_rejects_wrong_market() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        fx.run(
            &Pubkey::new_unique(), &lp, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_A, 1_500_000, 700_000, 20_000, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::BadParams as u32))],
        );
    }

    #[test]
    fn withdraw_lp_rejects_while_still_delegated() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        let market = fx.market_key;
        fx.run(
            &market, &lp, FAKE_DELEGATION_PROGRAM,
            STATUS_SETTLED, OUTCOME_SIDE_A, 1_500_000, 700_000, 20_000, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::InvalidOwner as u32))],
        );
    }

    #[test]
    fn withdraw_lp_rejects_vault_underfunded() {
        let mut fx = setup();
        fx.vault_funding = 100;
        let lp = fx.lp_owner;
        let market = fx.market_key;
        fx.run(
            &market, &lp, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_A, 1_500_000, 700_000, 20_000, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::VaultUnderfunded as u32))],
        );
    }

    #[test]
    fn withdraw_lp_rejects_zero_payout() {
        let mut fx = setup();
        let lp = fx.lp_owner;
        let market = fx.market_key;
        fx.run(
            &market, &lp, PROGRAM_ID,
            STATUS_SETTLED, OUTCOME_SIDE_A, /* reserve_a */ 0, /* reserve_b */ 700_000, /* fees */ 0, false,
            &[Check::err(SvmProgramError::Custom(OnyxError::NothingToRefund as u32))],
        );
    }
}
