//! swap_amm (disc 34): buy or sell outcome tokens against an AmmPool's
//! reserves. ER-routed once the pool+position are delegated — pure
//! account-data mutation, no token CPI, no lamports movement (the operation
//! class the Phase-0 probe proved the ER allows). `owner` is kept
//! **read-only**, same discipline as submit_order_fast: any writable
//! non-delegated account (including the fee payer) makes the ER reject the
//! whole transaction.
//!
//! **The property that makes concurrent swaps safe** (docs/AMM_TRADING_
//! DESIGN.md §0.1's tightening): `amount_out` is computed HERE, entirely
//! from `pool`'s CURRENT on-chain reserves at execution time via
//! `fpmm::calc_buy`/`calc_sell`. The client sends only `amount_in` and
//! `min_out` — never a pre-computed output. Combined with Solana's
//! writable-account serialization (independently confirmed live via
//! `scripts/probe_amm_concurrency.ts`: two concurrent writers to one
//! account never tear or lose an update), this means two concurrent swaps
//! against the same pool cannot both price off the same stale reserves —
//! whichever lands second in the runtime's actual execution order
//! necessarily reads the first swap's already-applied effect.
//!
//! Accounts: [0] owner (S, readonly) · [1] market (read; delegated
//!           alongside the pool so it exists on the ER, used only for the
//!           status/deadline gate) · [2] pool (W) · [3] position (W)
//! Args: side(u8: SIDE_A|SIDE_B) direction(u8: SWAP_BUY|SWAP_SELL)
//!       amount_in(u64 LE) min_out(u64 LE) = 18 bytes

use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};

use crate::constants::*;
use crate::error::OnyxError;
use crate::fpmm::{calc_buy, calc_fee, calc_sell};
use crate::state::amm_pool::AmmPool;
use crate::state::amm_position::AmmPosition;
use crate::state::market::Market;
use crate::util::read_u64_le;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [owner, market_ai, pool_ai, position_ai, ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !owner.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let side = *args.first().ok_or(OnyxError::InvalidInstructionData)?;
    let direction = *args.get(1).ok_or(OnyxError::InvalidInstructionData)?;
    let amount_in = read_u64_le(args, 2)?;
    let min_out = read_u64_le(args, 10)?;
    if side != SIDE_A && side != SIDE_B {
        return Err(OnyxError::BadParams.into());
    }
    if direction != SWAP_BUY && direction != SWAP_SELL {
        return Err(OnyxError::BadParams.into());
    }
    if amount_in == 0 {
        return Err(OnyxError::InsufficientStake.into());
    }

    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        let status = market.status();
        if status != STATUS_OPEN && status != STATUS_LIVE {
            return Err(OnyxError::WrongStatus.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if now >= market.deadline() {
            return Err(OnyxError::WrongPhase.into());
        }
    }

    let mut pdata = pool_ai.try_borrow_mut_data()?;
    let mut pool = AmmPool::load(&mut pdata)?;
    if &pool.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }

    let mut posdata = position_ai.try_borrow_mut_data()?;
    let mut position = AmmPosition::load(&mut posdata)?;
    if &position.owner() != owner.key() {
        return Err(OnyxError::Unauthorized.into());
    }
    if &position.market() != market_ai.key() {
        return Err(OnyxError::BadParams.into());
    }

    let fee_bps = pool.fee_bps();

    if direction == SWAP_BUY {
        if amount_in > position.usdc_available() {
            return Err(OnyxError::InsufficientStake.into());
        }
        let fee = calc_fee(amount_in, fee_bps)?;
        let net_in = amount_in.checked_sub(fee).ok_or(OnyxError::ArithmeticOverflow)?;
        if net_in == 0 {
            return Err(OnyxError::InsufficientStake.into());
        }

        let (reserve_buy, reserve_other) = if side == SIDE_A {
            (pool.reserve_a(), pool.reserve_b())
        } else {
            (pool.reserve_b(), pool.reserve_a())
        };
        let result = calc_buy(reserve_buy, reserve_other, net_in)?;
        if result.tokens_out < min_out {
            return Err(OnyxError::SlippageExceeded.into());
        }

        if side == SIDE_A {
            pool.set_reserve_a(result.new_reserve_buy);
            pool.set_reserve_b(result.new_reserve_other);
            position.set_tokens_a(
                position.tokens_a().checked_add(result.tokens_out).ok_or(OnyxError::ArithmeticOverflow)?,
            );
        } else {
            pool.set_reserve_b(result.new_reserve_buy);
            pool.set_reserve_a(result.new_reserve_other);
            position.set_tokens_b(
                position.tokens_b().checked_add(result.tokens_out).ok_or(OnyxError::ArithmeticOverflow)?,
            );
        }
        position.set_usdc_available(
            position.usdc_available().checked_sub(amount_in).ok_or(OnyxError::ArithmeticOverflow)?,
        );
        pool.set_sets_outstanding(
            pool.sets_outstanding().checked_add(net_in).ok_or(OnyxError::ArithmeticOverflow)?,
        );
        pool.set_fees_accrued(pool.fees_accrued().checked_add(fee).ok_or(OnyxError::ArithmeticOverflow)?);
    } else {
        let held = if side == SIDE_A { position.tokens_a() } else { position.tokens_b() };
        if amount_in > held {
            return Err(OnyxError::InsufficientStake.into());
        }

        let (reserve_sell, reserve_other) = if side == SIDE_A {
            (pool.reserve_a(), pool.reserve_b())
        } else {
            (pool.reserve_b(), pool.reserve_a())
        };
        let result = calc_sell(reserve_sell, reserve_other, amount_in)?;
        let gross = result.gross_collateral_out;
        let fee = calc_fee(gross, fee_bps)?;
        let net_out = gross.checked_sub(fee).ok_or(OnyxError::ArithmeticOverflow)?;
        if net_out < min_out {
            return Err(OnyxError::SlippageExceeded.into());
        }

        if side == SIDE_A {
            pool.set_reserve_a(result.new_reserve_sell);
            pool.set_reserve_b(result.new_reserve_other);
            position.set_tokens_a(position.tokens_a().checked_sub(amount_in).ok_or(OnyxError::ArithmeticOverflow)?);
        } else {
            pool.set_reserve_b(result.new_reserve_sell);
            pool.set_reserve_a(result.new_reserve_other);
            position.set_tokens_b(position.tokens_b().checked_sub(amount_in).ok_or(OnyxError::ArithmeticOverflow)?);
        }
        position.set_usdc_available(
            position.usdc_available().checked_add(net_out).ok_or(OnyxError::ArithmeticOverflow)?,
        );
        pool.set_sets_outstanding(
            pool.sets_outstanding().checked_sub(gross).ok_or(OnyxError::ArithmeticOverflow)?,
        );
        pool.set_fees_accrued(pool.fees_accrued().checked_add(fee).ok_or(OnyxError::ArithmeticOverflow)?);
    }

    Ok(())
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    //! Real mollusk-svm SBF execution. swap_amm has NO token CPI at all (pure
    //! account-data mutation on pool+position, the same ER-compatible
    //! operation class as run_batch_match_fast) so this fixture needs no SPL
    //! token program, unlike deposit_amm/redeem_amm/withdraw_lp_amm. Every
    //! happy-path result is cross-checked against fpmm::calc_buy/calc_sell
    //! called directly, so a wiring bug (wrong offset, side swapped, fee
    //! applied twice) would still be caught even though fpmm.rs's own suite
    //! already covers the math in isolation.

    use mollusk_svm::{result::Check, Mollusk};
    use solana_account::Account;
    use solana_clock::Clock;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_program_error::ProgramError as SvmProgramError;
    use solana_pubkey::Pubkey;
    use solana_rent::Rent;

    use crate::constants::{DISC_MARKET, IX_SWAP_AMM, SIDE_A, SIDE_B, STATUS_OPEN, SWAP_BUY, SWAP_SELL};
    use crate::error::OnyxError;
    use crate::fpmm::calc_buy;
    use crate::state::amm_pool::AMM_POOL_LEN;
    use crate::state::amm_position::AMM_POSITION_LEN;
    use crate::state::market::MARKET_LEN;

    const PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID);

    fn market_bytes(status: u8, deadline: i64) -> Vec<u8> {
        let mut b = vec![0u8; MARKET_LEN];
        b[0] = DISC_MARKET;
        b[26] = status;
        b[36..44].copy_from_slice(&deadline.to_le_bytes());
        b
    }

    #[allow(clippy::too_many_arguments)]
    fn pool_bytes(
        market: &Pubkey,
        lp_owner: &Pubkey,
        reserve_a: u64,
        reserve_b: u64,
        sets_outstanding: u64,
        fees_accrued: u64,
        fee_bps: u16,
    ) -> Vec<u8> {
        let mut b = vec![0u8; AMM_POOL_LEN];
        b[0] = crate::constants::DISC_AMM_POOL;
        b[8..40].copy_from_slice(market.as_ref());
        b[40..72].copy_from_slice(lp_owner.as_ref());
        b[72..80].copy_from_slice(&reserve_a.to_le_bytes());
        b[80..88].copy_from_slice(&reserve_b.to_le_bytes());
        b[88..96].copy_from_slice(&sets_outstanding.to_le_bytes());
        b[96..104].copy_from_slice(&fees_accrued.to_le_bytes());
        b[112..114].copy_from_slice(&fee_bps.to_le_bytes());
        b
    }

    fn position_bytes(owner: &Pubkey, market: &Pubkey, usdc_available: u64, tokens_a: u64, tokens_b: u64) -> Vec<u8> {
        let mut b = vec![0u8; AMM_POSITION_LEN];
        b[0] = crate::constants::DISC_AMM_POSITION;
        b[8..40].copy_from_slice(owner.as_ref());
        b[40..72].copy_from_slice(market.as_ref());
        b[72..80].copy_from_slice(&usdc_available.to_le_bytes());
        b[80..88].copy_from_slice(&tokens_a.to_le_bytes());
        b[88..96].copy_from_slice(&tokens_b.to_le_bytes());
        b
    }

    fn onyx_account(data: Vec<u8>, len: usize) -> Account {
        let rent = Rent::default();
        Account { lamports: rent.minimum_balance(len), data, owner: PROGRAM_ID, executable: false, rent_epoch: 0 }
    }

    fn read_u64(data: &[u8], off: usize) -> u64 {
        u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
    }

    struct Fixture {
        mollusk: Mollusk,
        owner: Pubkey,
        market_key: Pubkey,
        pool_key: Pubkey,
        position_key: Pubkey,
    }

    fn setup() -> Fixture {
        unsafe {
            std::env::set_var("SBF_OUT_DIR", concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy"));
        }
        let mollusk = Mollusk::new(&PROGRAM_ID, "onyx");
        Fixture {
            mollusk,
            owner: Pubkey::new_unique(),
            market_key: Pubkey::new_unique(),
            pool_key: Pubkey::new_unique(),
            position_key: Pubkey::new_unique(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    impl Fixture {
        fn instruction(&self, owner: &Pubkey, side: u8, direction: u8, amount_in: u64, min_out: u64) -> Instruction {
            let mut data = vec![IX_SWAP_AMM, side, direction];
            data.extend_from_slice(&amount_in.to_le_bytes());
            data.extend_from_slice(&min_out.to_le_bytes());
            Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new_readonly(*owner, true),
                    AccountMeta::new_readonly(self.market_key, false),
                    AccountMeta::new(self.pool_key, false),
                    AccountMeta::new(self.position_key, false),
                ],
                data,
            }
        }

        fn world(
            &self,
            market_status: u8,
            deadline: i64,
            lp_owner: &Pubkey,
            reserve_a: u64,
            reserve_b: u64,
            sets_outstanding: u64,
            fees_accrued: u64,
            fee_bps: u16,
            position_owner: &Pubkey,
            usdc_available: u64,
            tokens_a: u64,
            tokens_b: u64,
        ) -> Vec<(Pubkey, Account)> {
            vec![
                (self.owner, Account::new(1_000_000_000, 0, &solana_system_interface::program::ID)),
                (self.market_key, onyx_account(market_bytes(market_status, deadline), MARKET_LEN)),
                (
                    self.pool_key,
                    onyx_account(
                        pool_bytes(&self.market_key, lp_owner, reserve_a, reserve_b, sets_outstanding, fees_accrued, fee_bps),
                        AMM_POOL_LEN,
                    ),
                ),
                (
                    self.position_key,
                    onyx_account(
                        position_bytes(position_owner, &self.market_key, usdc_available, tokens_a, tokens_b),
                        AMM_POSITION_LEN,
                    ),
                ),
            ]
        }

        #[allow(clippy::too_many_arguments)]
        fn run(
            &mut self,
            market_status: u8,
            deadline: i64,
            now: i64,
            lp_owner: Pubkey,
            reserve_a: u64,
            reserve_b: u64,
            sets_outstanding: u64,
            fees_accrued: u64,
            fee_bps: u16,
            position_owner: Pubkey,
            usdc_available: u64,
            tokens_a: u64,
            tokens_b: u64,
            side: u8,
            direction: u8,
            amount_in: u64,
            min_out: u64,
            extra_checks: &[Check],
        ) -> Vec<(Pubkey, Account)> {
            self.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };
            let owner = self.owner;
            let accounts = self.world(
                market_status, deadline, &lp_owner, reserve_a, reserve_b, sets_outstanding, fees_accrued, fee_bps,
                &position_owner, usdc_available, tokens_a, tokens_b,
            );
            let instruction = self.instruction(&owner, side, direction, amount_in, min_out);
            let result = self.mollusk.process_and_validate_instruction(&instruction, &accounts, extra_checks);
            result.resulting_accounts
        }
    }

    #[test]
    fn buy_matches_fpmm_directly() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        // fee_bps=100 (1%) of 100_000 = 1_000 -> net_in = 99_000.
        let expected = calc_buy(1_000_000, 1_000_000, 99_000).unwrap();
        let resulting = fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 100,
            owner, 500_000, 0, 0,
            SIDE_A, SWAP_BUY, 100_000, 0,
            &[Check::success()],
        );
        let pool_after = &resulting.iter().find(|(k, _)| *k == fx.pool_key).unwrap().1.data;
        let position_after = &resulting.iter().find(|(k, _)| *k == fx.position_key).unwrap().1.data;
        assert_eq!(read_u64(pool_after, 72), expected.new_reserve_buy, "reserve_a");
        assert_eq!(read_u64(pool_after, 80), expected.new_reserve_other, "reserve_b");
        assert_eq!(read_u64(pool_after, 88), 1_000_000 + 99_000, "sets_outstanding += net_in");
        assert_eq!(read_u64(pool_after, 96), 1_000, "fees_accrued = 1% of 100_000");
        assert_eq!(read_u64(position_after, 80), expected.tokens_out, "tokens_a credited");
        assert_eq!(read_u64(position_after, 72), 500_000 - 100_000, "usdc_available debited by full amount_in");
    }

    #[test]
    fn sell_matches_fpmm_directly() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        let sell = crate::fpmm::calc_sell(1_200_000, 833_334, 50_000).unwrap();
        let fee = crate::fpmm::calc_fee(sell.gross_collateral_out, 100).unwrap();
        let net_out = sell.gross_collateral_out - fee;
        let resulting = fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_200_000, 833_334, 1_000_000, 0, 100,
            owner, 10_000, 50_000, 0,
            SIDE_A, SWAP_SELL, 50_000, 0,
            &[Check::success()],
        );
        let pool_after = &resulting.iter().find(|(k, _)| *k == fx.pool_key).unwrap().1.data;
        let position_after = &resulting.iter().find(|(k, _)| *k == fx.position_key).unwrap().1.data;
        assert_eq!(read_u64(pool_after, 72), sell.new_reserve_sell);
        assert_eq!(read_u64(pool_after, 80), sell.new_reserve_other);
        assert_eq!(read_u64(position_after, 80), 0, "tokens_a fully sold");
        assert_eq!(read_u64(position_after, 72), 10_000 + net_out, "usdc_available credited net of fee");
        assert_eq!(read_u64(pool_after, 96), fee, "fee accrued");
    }

    #[test]
    fn buy_reverts_on_slippage() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        let expected = calc_buy(1_000_000, 1_000_000, 99_000).unwrap();
        fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 100,
            owner, 500_000, 0, 0,
            SIDE_A, SWAP_BUY, 100_000, expected.tokens_out + 1, // min_out one more than achievable
            &[Check::err(SvmProgramError::Custom(OnyxError::SlippageExceeded as u32))],
        );
    }

    #[test]
    fn sell_reverts_on_slippage() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_200_000, 833_334, 1_000_000, 0, 100,
            owner, 10_000, 50_000, 0,
            SIDE_A, SWAP_SELL, 50_000, u64::MAX, // impossible min_out
            &[Check::err(SvmProgramError::Custom(OnyxError::SlippageExceeded as u32))],
        );
    }

    #[test]
    fn buy_rejects_insufficient_usdc_available() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 100,
            owner, /* usdc_available */ 50_000, 0, 0,
            SIDE_A, SWAP_BUY, /* amount_in */ 100_000, 0,
            &[Check::err(SvmProgramError::Custom(OnyxError::InsufficientStake as u32))],
        );
    }

    #[test]
    fn sell_rejects_insufficient_tokens_held() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_200_000, 833_334, 1_000_000, 0, 100,
            owner, 0, /* tokens_a */ 1_000, 0,
            SIDE_A, SWAP_SELL, /* amount_in (tokens) */ 50_000, 0,
            &[Check::err(SvmProgramError::Custom(OnyxError::InsufficientStake as u32))],
        );
    }

    #[test]
    fn swap_rejects_wrong_owner() {
        let mut fx = setup();
        let lp = Pubkey::new_unique();
        // Position recorded owner != signer (fx.owner is the signer, but the
        // position's stored owner field is some other random wallet).
        fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 100,
            Pubkey::new_unique(), 500_000, 0, 0,
            SIDE_A, SWAP_BUY, 100_000, 0,
            &[Check::err(SvmProgramError::Custom(OnyxError::Unauthorized as u32))],
        );
    }

    #[test]
    fn swap_rejects_after_deadline() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        fx.run(
            STATUS_OPEN, /* deadline */ 1_000_000_000, /* now */ 1_000_000_001, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 100,
            owner, 500_000, 0, 0,
            SIDE_A, SWAP_BUY, 100_000, 0,
            &[Check::err(SvmProgramError::Custom(OnyxError::WrongPhase as u32))],
        );
    }

    #[test]
    fn swap_rejects_wrong_market_status() {
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        fx.run(
            crate::constants::STATUS_SETTLED, 2_000_000_000, 1_000_000_000, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 100,
            owner, 500_000, 0, 0,
            SIDE_A, SWAP_BUY, 100_000, 0,
            &[Check::err(SvmProgramError::Custom(OnyxError::WrongStatus as u32))],
        );
    }

    #[test]
    fn buy_side_b_credits_tokens_b_not_a() {
        // Regression guard for a copy-paste swap of the side branches: buying
        // B must never touch tokens_a.
        let mut fx = setup();
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        let resulting = fx.run(
            STATUS_OPEN, 2_000_000_000, 1_000_000_000, lp,
            1_000_000, 1_000_000, 1_000_000, 0, 0,
            owner, 500_000, 0, 0,
            SIDE_B, SWAP_BUY, 100_000, 0,
            &[Check::success()],
        );
        let position_after = &resulting.iter().find(|(k, _)| *k == fx.position_key).unwrap().1.data;
        assert_eq!(read_u64(position_after, 80), 0, "tokens_a untouched");
        assert!(read_u64(position_after, 88) > 0, "tokens_b credited");
    }

    #[test]
    fn swap_compute_units_under_50k() {
        let mut fx = setup();
        fx.mollusk.sysvars.clock = Clock { unix_timestamp: 1_000_000_000, ..Clock::default() };
        let owner = fx.owner;
        let lp = Pubkey::new_unique();
        let accounts = fx.world(
            STATUS_OPEN, 2_000_000_000, &lp, 1_000_000, 1_000_000, 1_000_000, 0, 100,
            &owner, 500_000, 0, 0,
        );
        let instruction = fx.instruction(&owner, SIDE_A, SWAP_BUY, 100_000, 0);
        let result = fx.mollusk.process_and_validate_instruction(&instruction, &accounts, &[Check::success()]);
        assert!(
            result.compute_units_consumed < 50_000,
            "swap consumed {} CU, expected < 50_000 (docs/AMM_TRADING_DESIGN.md §0.3 budget)",
            result.compute_units_consumed
        );
    }
}
