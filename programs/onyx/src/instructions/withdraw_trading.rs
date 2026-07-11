//! withdraw_trading (disc 28): base-layer payout from a TradingAccount —
//! the other real SPL transfer in this design (deposit_trading is the
//! first), and the only place ER-fast trading's economics touch real money
//! again after the one deposit. Pays out two things in one call:
//!   1. `available` (unlocked funds — never committed, or restored by a
//!      cancel) — always withdrawable, no settlement required.
//!   2. Matched-winnings, if the market has settled and this account's
//!      matched order was on the winning side — same parimutuel formula as
//!      the base flow's `claim.rs` (stake + stake*losingPool/winningPool -
//!      fee), reading the SAME Market.total_side_a/b pools `claim.rs` does:
//!      run_batch_match_fast writes into those same fields, so ER-fast and
//!      base-flow matched volume share one combined pool and one payout
//!      formula — deliberately, not by accident (see design doc).
//! `claimed_winnings` guards leg 2 against double payout; leg 1 just zeroes
//! `available`, no separate guard needed.
//!
//! Accounts: [0] owner (S,W) · [1] config · [2] market (read) · [3] trading (W)
//!           · [4] vault (W) · [5] owner_usdc_ata (W) · [6] token program
//!
//! Requires `trading` to be back on base (owned by this program) -- while
//! delegated it's owned by the Delegation Program and this fails the same
//! way deposit_trading does, which is the correct behavior: you can't
//! withdraw funds the ER might still be actively trading with.

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
use crate::state::config::Config;
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [owner, config_ai, market_ai, trading_ai, vault_ai, owner_ata, _token_program, ..] =
        accounts
    else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }
    if !trading_ai.is_owned_by(program_id) {
        return Err(OnyxError::InvalidOwner.into());
    }

    let fee_bps = {
        let mut cdata = config_ai.try_borrow_mut_data()?;
        let config = Config::load_checked(&mut cdata, config_ai.key(), program_id)?;
        config.fee_bps() as u64
    };

    let (market_status, outcome, total_a, total_b, vault_bump) = {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        (
            market.status(),
            market.outcome(),
            market.total_side_a(),
            market.total_side_b(),
            market.vault_bump(),
        )
    };

    let mut tdata = trading_ai.try_borrow_mut_data()?;
    let mut trading = TradingAccount::load(&mut tdata)?;
    if &trading.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &trading.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }

    let mut payout = trading.available();

    let settled = market_status == STATUS_SETTLED || market_status == STATUS_CLAIMED;
    if settled && !trading.claimed_winnings() && trading.status() == TRADING_STATUS_MATCHED {
        let winning_side = if outcome == OUTCOME_SIDE_A { SIDE_A } else { SIDE_B };
        if trading.side() == winning_side && trading.matched_size() > 0 {
            let (winning_pool, losing_pool) = if winning_side == SIDE_A {
                (total_a, total_b)
            } else {
                (total_b, total_a)
            };
            if winning_pool > 0 {
                let stake = trading.matched_size();
                let winnings = (losing_pool as u128)
                    .checked_mul(stake as u128)
                    .ok_or(OnyxError::ArithmeticOverflow)?
                    .checked_div(winning_pool as u128)
                    .ok_or(OnyxError::ArithmeticOverflow)? as u64;
                let fee = winnings.checked_mul(fee_bps).ok_or(OnyxError::ArithmeticOverflow)? / BPS_DENOM;
                let win_payout = stake
                    .checked_add(winnings)
                    .ok_or(OnyxError::ArithmeticOverflow)?
                    .checked_sub(fee)
                    .ok_or(OnyxError::ArithmeticOverflow)?;
                payout = payout.checked_add(win_payout).ok_or(OnyxError::ArithmeticOverflow)?;
            }
        }
        trading.set_claimed_winnings(true);
    }

    if payout == 0 {
        return Err(OnyxError::NothingToRefund.into());
    }

    {
        let vault = TokenAccount::from_account_info(vault_ai).map_err(|_| OnyxError::InvalidAccountSize)?;
        if vault.amount() < payout {
            return Err(OnyxError::VaultUnderfunded.into());
        }
    }

    trading.set_available(0);
    trading.set_withdrawn(trading.withdrawn().checked_add(payout).ok_or(OnyxError::ArithmeticOverflow)?);
    drop(tdata);

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
    //! Real mollusk-svm SBF execution (same pattern as refund_expired.rs's
    //! custody-critical coverage) for the other instruction in this program
    //! that sends real money out: withdraw_trading is the only place ER-fast
    //! trading's economics touch a real transfer after the initial deposit,
    //! and it has two independent payout legs (unlocked `available`, and
    //! settled matched-winnings reusing claim.rs's exact parimutuel formula)
    //! plus a double-payout guard on the winnings leg specifically -- exactly
    //! the kind of logic that's easy to get subtly wrong and expensive to
    //! find out about live. Was previously exercised only by end-to-end
    //! devnet proof scripts, never in isolation.

    use mollusk_svm::{result::Check, Mollusk};
    use solana_account::Account;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_program_error::ProgramError as SvmProgramError;
    use solana_pubkey::Pubkey;
    use solana_program_pack::Pack;
    use solana_rent::Rent;
    use spl_token_interface::state::{Account as TokenAccountState, AccountState};

    use crate::constants::{
        BPS_DENOM, DISC_CONFIG, DISC_MARKET, OUTCOME_SIDE_A, OUTCOME_SIDE_B, SIDE_A, SIDE_B,
        STATUS_CLAIMED, STATUS_OPEN, STATUS_SETTLED, TRADING_STATUS_MATCHED,
    };
    use crate::error::OnyxError;
    use crate::state::config::CONFIG_LEN;
    use crate::state::market::MARKET_LEN;
    use crate::state::trading_account::TRADING_ACCOUNT_LEN;

    const PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID);
    const FAKE_DELEGATION_PROGRAM: Pubkey = Pubkey::new_from_array([9u8; 32]);

    fn config_bytes(fee_bps: u16) -> Vec<u8> {
        let mut b = vec![0u8; CONFIG_LEN];
        b[0] = DISC_CONFIG;
        b[104..106].copy_from_slice(&fee_bps.to_le_bytes());
        b
    }

    fn market_bytes(status: u8, outcome: u8, total_a: u64, total_b: u64, vault_bump: u8) -> Vec<u8> {
        let mut b = vec![0u8; MARKET_LEN];
        b[0] = DISC_MARKET;
        b[26] = status;
        b[27] = outcome;
        b[52..60].copy_from_slice(&total_a.to_le_bytes());
        b[60..68].copy_from_slice(&total_b.to_le_bytes());
        b[100] = vault_bump;
        b
    }

    #[allow(clippy::too_many_arguments)]
    fn trading_bytes(
        owner: &Pubkey,
        market: &Pubkey,
        available: u64,
        status: u8,
        side: u8,
        matched_size: u64,
        claimed_winnings: bool,
    ) -> Vec<u8> {
        let mut b = vec![0u8; TRADING_ACCOUNT_LEN];
        b[0] = crate::constants::DISC_TRADING_ACCOUNT;
        b[8..40].copy_from_slice(owner.as_ref());
        b[40..72].copy_from_slice(market.as_ref());
        b[80..88].copy_from_slice(&available.to_le_bytes());
        b[128] = side;
        b[129] = status;
        b[152..160].copy_from_slice(&matched_size.to_le_bytes());
        b[169] = claimed_winnings as u8;
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
        config_key: Pubkey,
        market_key: Pubkey,
        trading_key: Pubkey,
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
        let (config_key, _) = Pubkey::find_program_address(&[b"config"], &PROGRAM_ID);
        let market_key = Pubkey::new_unique();
        let trading_key = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let (vault_key, vault_bump) = Pubkey::find_program_address(&[b"vault", market_key.as_ref()], &PROGRAM_ID);
        let owner_ata = Pubkey::new_unique();

        Fixture {
            mollusk,
            owner,
            config_key,
            market_key,
            trading_key,
            vault_key,
            owner_ata,
            mint,
            vault_bump,
            vault_funding: 10_000_000, // generously funded unless a test overrides it
        }
    }

    #[allow(clippy::too_many_arguments)]
    impl Fixture {
        fn run(
            &mut self,
            trading_owner_field: &Pubkey,
            trading_market_field: &Pubkey,
            trading_account_owner: Pubkey, // the account's actual on-chain owner (program vs "still delegated")
            available: u64,
            market_status: u8,
            outcome: u8,
            total_a: u64,
            total_b: u64,
            trading_status: u8,
            side: u8,
            matched_size: u64,
            claimed_winnings: bool,
            fee_bps: u16,
            extra_checks: &[Check],
        ) -> Vec<(Pubkey, Account)> {
            let rent = Rent::default();
            let trading_data = trading_bytes(
                trading_owner_field,
                trading_market_field,
                available,
                trading_status,
                side,
                matched_size,
                claimed_winnings,
            );

            let accounts = vec![
                (self.owner, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID)),
                (
                    self.config_key,
                    Account {
                        lamports: rent.minimum_balance(CONFIG_LEN),
                        data: config_bytes(fee_bps),
                        owner: PROGRAM_ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (
                    self.market_key,
                    Account {
                        lamports: rent.minimum_balance(MARKET_LEN),
                        data: market_bytes(market_status, outcome, total_a, total_b, self.vault_bump),
                        owner: PROGRAM_ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (
                    self.trading_key,
                    Account {
                        lamports: rent.minimum_balance(TRADING_ACCOUNT_LEN),
                        data: trading_data,
                        owner: trading_account_owner,
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
                    AccountMeta::new_readonly(self.config_key, false),
                    AccountMeta::new_readonly(self.market_key, false),
                    AccountMeta::new(self.trading_key, false),
                    AccountMeta::new(self.vault_key, false),
                    AccountMeta::new(self.owner_ata, false),
                    AccountMeta::new_readonly(mollusk_svm_programs_token::token::ID, false),
                ],
                data: vec![crate::constants::IX_WITHDRAW_TRADING],
            };

            let result = self.mollusk.process_and_validate_instruction(&instruction, &accounts, extra_checks);
            result.resulting_accounts
        }
    }

    #[test]
    fn withdraw_available_only_when_not_settled() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* available */ 500_000, STATUS_OPEN, 0, 0, 0,
            TRADING_STATUS_MATCHED, SIDE_A, /* matched_size */ 0, false, 100,
            &[Check::success()],
        );

        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 500_000);

        let trading_after = resulting.iter().find(|(k, _)| *k == fx.trading_key).unwrap();
        assert_eq!(&trading_after.1.data[80..88], &0u64.to_le_bytes(), "available zeroed");
        assert_eq!(&trading_after.1.data[160..168], &500_000u64.to_le_bytes(), "withdrawn recorded");
        // Not settled -> claimed_winnings must stay untouched (false).
        assert_eq!(trading_after.1.data[169], 0);
    }

    #[test]
    fn withdraw_winnings_matches_claim_formula_exactly() {
        // Same numbers as the classic flow's README-documented claim example
        // (1,000,000 stake, matching pools, 1% fee -> 1,990,000 payout) --
        // deliberately, to cross-check run_batch_match_fast/withdraw_trading
        // reuse claim.rs's formula byte-for-byte, not just "close enough".
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* available */ 0, STATUS_SETTLED, OUTCOME_SIDE_A, /* total_a */ 1_000_000, /* total_b */ 1_000_000,
            TRADING_STATUS_MATCHED, SIDE_A, /* matched_size */ 1_000_000, false, /* fee_bps */ 100,
            &[Check::success()],
        );

        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 1_990_000);

        let trading_after = resulting.iter().find(|(k, _)| *k == fx.trading_key).unwrap();
        assert_eq!(trading_after.1.data[169], 1, "claimed_winnings set, guards double payout");
    }

    #[test]
    fn withdraw_combines_available_and_winnings_in_one_payout() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* available */ 200_000, STATUS_SETTLED, OUTCOME_SIDE_A, 1_000_000, 1_000_000,
            TRADING_STATUS_MATCHED, SIDE_A, 1_000_000, false, 100,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 200_000 + 1_990_000);
    }

    #[test]
    fn withdraw_losing_side_settled_pays_available_only_and_still_marks_claimed() {
        // Side B matched, but outcome is Side A -- no winnings, but
        // claimed_winnings still flips to true so this branch is never
        // re-evaluated on a later withdraw call.
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        let resulting = fx.run(
            &owner, &market, PROGRAM_ID,
            /* available */ 50_000, STATUS_SETTLED, OUTCOME_SIDE_A, 1_000_000, 1_000_000,
            TRADING_STATUS_MATCHED, SIDE_B, 1_000_000, false, 100,
            &[Check::success()],
        );
        let ata_after = resulting.iter().find(|(k, _)| *k == fx.owner_ata).unwrap();
        assert_eq!(TokenAccountState::unpack(&ata_after.1.data).unwrap().amount, 50_000, "no winnings, losing side");
        let trading_after = resulting.iter().find(|(k, _)| *k == fx.trading_key).unwrap();
        assert_eq!(trading_after.1.data[169], 1, "still marked claimed to short-circuit future checks");
    }

    #[test]
    fn withdraw_rejected_when_nothing_to_withdraw() {
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, PROGRAM_ID,
            /* available */ 0, STATUS_OPEN, 0, 0, 0,
            TRADING_STATUS_MATCHED, SIDE_A, 0, false, 100,
            &[Check::err(SvmProgramError::Custom(OnyxError::NothingToRefund as u32))],
        );
    }

    #[test]
    fn withdraw_rejected_double_withdraw_after_already_claimed() {
        // available already 0 (drained by a prior call) AND claimed_winnings
        // already true -> the winnings branch must not re-fire (it's gated
        // on !claimed_winnings), so this must fail NothingToRefund, not pay
        // out a second time.
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, PROGRAM_ID,
            /* available */ 0, STATUS_SETTLED, OUTCOME_SIDE_A, 1_000_000, 1_000_000,
            TRADING_STATUS_MATCHED, SIDE_A, 1_000_000, /* claimed_winnings */ true, 100,
            &[Check::err(SvmProgramError::Custom(OnyxError::NothingToRefund as u32))],
        );
    }

    #[test]
    fn withdraw_rejected_wrong_owner() {
        // Trading account's recorded `.owner()` field is some other wallet,
        // not the signer -- must reject before any payout math runs.
        let mut fx = setup();
        let market = fx.market_key;
        fx.run(
            &Pubkey::new_unique(), &market, PROGRAM_ID,
            500_000, STATUS_OPEN, 0, 0, 0,
            TRADING_STATUS_MATCHED, SIDE_A, 0, false, 100,
            &[Check::err(SvmProgramError::Custom(OnyxError::Unauthorized as u32))],
        );
    }

    #[test]
    fn withdraw_rejected_wrong_market() {
        let mut fx = setup();
        let owner = fx.owner;
        fx.run(
            &owner, &Pubkey::new_unique() /* recorded market != market_ai actually passed */, PROGRAM_ID,
            500_000, STATUS_OPEN, 0, 0, 0,
            TRADING_STATUS_MATCHED, SIDE_A, 0, false, 100,
            &[Check::err(SvmProgramError::Custom(OnyxError::BadParams as u32))],
        );
    }

    #[test]
    fn withdraw_rejected_while_still_delegated() {
        // trading account's actual on-chain owner is NOT this program (as if
        // still owned by the Delegation Program while mid-ER-lifecycle) --
        // must fail InvalidOwner before any of the payout logic runs.
        let mut fx = setup();
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, FAKE_DELEGATION_PROGRAM,
            500_000, STATUS_OPEN, 0, 0, 0,
            TRADING_STATUS_MATCHED, SIDE_A, 0, false, 100,
            &[Check::err(SvmProgramError::Custom(OnyxError::InvalidOwner as u32))],
        );
    }

    #[test]
    fn withdraw_rejected_when_vault_underfunded() {
        let mut fx = setup();
        fx.vault_funding = 100; // less than the 500_000 available being withdrawn
        let owner = fx.owner;
        let market = fx.market_key;
        fx.run(
            &owner, &market, PROGRAM_ID,
            500_000, STATUS_OPEN, 0, 0, 0,
            TRADING_STATUS_MATCHED, SIDE_A, 0, false, 100,
            &[Check::err(SvmProgramError::Custom(OnyxError::VaultUnderfunded as u32))],
        );
    }
}
