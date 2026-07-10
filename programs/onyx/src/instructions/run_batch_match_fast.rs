//! run_batch_match_fast (disc 26): the ER-fast-path batch match. Permissionless
//! (anyone can call it, same pattern as settle_market/claim/the base
//! run_batch_match) — so the batch-inclusion completeness check below is
//! load-bearing, not optional: without it, a permissionless caller could
//! choose which revealed orders to include and skew the clearing price by
//! omission (the audit finding this fixes).
//!
//! THE CHECK (two parts, both required — see inline comments at each):
//!   1. `remaining.len() == Market.revealed_count` — the caller cannot pass
//!      fewer accounts than the number of orders that have genuinely
//!      revealed, so a straightforward omission (leave N accounts out) is
//!      rejected outright.
//!   2. Status is re-verified as `Revealed` immediately before EACH account
//!      is written in the second pass, not just at the initial read pass.
//!      This closes the remaining hole part 1 alone doesn't: padding the
//!      count by passing the SAME real revealed-order account twice instead
//!      of a genuinely different one. Solana aliases duplicate writable
//!      account entries to the same underlying memory, so by the time the
//!      second occurrence is reached its status already reads `Matched`
//!      (written when the first occurrence was processed) — the immediate
//!      re-check catches that and the WHOLE transaction fails atomically.
//!      A caller cannot satisfy "correct length" AND "every write succeeds"
//!      without every entry being a genuinely distinct, genuinely revealed
//!      order — i.e. the complete set.
//!
//! No token CPI at all — matched_size is pure TradingAccount bookkeeping;
//! real settlement happens at withdraw time on base, after undelegation.
//!
//! Accounts: [0] payer (S, readonly) · [1] market (W)
//!           · remaining: one TradingAccount (W) per revealed order, caller-
//!             selected but count- and status-enforced as above.

use alloc::vec::Vec;
use pinocchio::{account_info::AccountInfo, pubkey::Pubkey, sysvars::clock::Clock, sysvars::Sysvar, ProgramResult};

use crate::constants::*;
use crate::error::OnyxError;
use crate::matching::{run_uniform_price_match, OrderInput};
use crate::state::market::Market;
use crate::state::trading_account::TradingAccount;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _args: &[u8]) -> ProgramResult {
    let [payer, market_ai, remaining @ ..] = accounts else {
        return Err(OnyxError::InvalidInstructionData.into());
    };
    if !payer.is_signer() {
        return Err(OnyxError::MissingSignature.into());
    }

    let n = remaining.len();
    if n == 0 || n > MAX_BATCH_ORDERS {
        return Err(OnyxError::TooManyOrders.into());
    }

    let market_key = *market_ai.key();
    {
        let mut mdata = market_ai.try_borrow_mut_data()?;
        let market = Market::load(&mut mdata)?;
        if market.phase() == PHASE_MATCHED {
            return Err(OnyxError::WrongPhase.into());
        }
        let now = Clock::get()?.unix_timestamp;
        if now < market.reveal_end_ts() {
            return Err(OnyxError::WrongPhase.into());
        }
        // CHECK 1 of 2 — see file header. Rejects a straightforward
        // omission: the caller cannot pass fewer accounts than the number
        // of orders that genuinely revealed.
        if n != market.revealed_count() as usize {
            return Err(OnyxError::TooManyOrders.into());
        }
    }

    // Pass 1: read every account, verify it's a genuinely revealed order for
    // THIS market. (A duplicate passed here just reads the same real data
    // twice at this point -- still Revealed, since nothing's been mutated
    // yet. That's fine; the pass-2 re-check below is what actually closes
    // the duplicate-padding hole, not this pass.)
    let mut inputs: Vec<OrderInput> = Vec::with_capacity(n);
    for acc in remaining.iter() {
        let mut tdata = acc.try_borrow_mut_data()?;
        let trading = TradingAccount::load(&mut tdata)?;
        if trading.market() != market_key {
            return Err(OnyxError::BadParams.into());
        }
        if trading.status() != TRADING_STATUS_REVEALED {
            return Err(OnyxError::WrongPhase.into());
        }
        inputs.push(OrderInput {
            side: trading.side(),
            size: trading.size(),
            limit_price: trading.limit_price(),
            commitment: trading.commitment(),
        });
    }

    let (clearing_price, matched_sizes) = run_uniform_price_match(&inputs);

    let mut delta_a: u64 = 0;
    let mut delta_b: u64 = 0;

    // Pass 2: write back. CHECK 2 of 2 -- see file header. Re-verifying
    // `status == Revealed` HERE (not trusting pass 1) is what makes passing
    // the same account twice fail the whole transaction instead of quietly
    // padding the count while a different real order is omitted.
    for (i, acc) in remaining.iter().enumerate() {
        let mut tdata = acc.try_borrow_mut_data()?;
        let mut trading = TradingAccount::load(&mut tdata)?;
        if trading.status() != TRADING_STATUS_REVEALED {
            return Err(OnyxError::WrongPhase.into()); // duplicate/aliased account -> abort
        }
        let matched = matched_sizes[i];
        // Release any unmatched portion of `locked` back to `available` --
        // the TradingAccount equivalent of the base flow's run_batch_match.rs
        // refund transfer (SealedOrder has no "available" balance, so that
        // flow does a real SPL Transfer back to the user's ATA; here it's
        // pure internal bookkeeping, no token movement). This was a real bug
        // caught by inspection before any UI was built on top of it: without
        // it, any partial fill leaves the unmatched remainder permanently
        // stuck -- status becomes Matched, which cancel_order_fast no longer
        // accepts, so there'd be no recovery path at all.
        let unmatched = trading.locked().checked_sub(matched).ok_or(OnyxError::ArithmeticOverflow)?;
        if unmatched > 0 {
            trading.set_available(trading.available().checked_add(unmatched).ok_or(OnyxError::ArithmeticOverflow)?);
        }
        trading.set_locked(0);
        trading.set_matched_size(matched);
        if matched > 0 {
            if trading.side() == SIDE_A {
                delta_a = delta_a.checked_add(matched).ok_or(OnyxError::ArithmeticOverflow)?;
            } else {
                delta_b = delta_b.checked_add(matched).ok_or(OnyxError::ArithmeticOverflow)?;
            }
        }
    }

    let mut mdata = market_ai.try_borrow_mut_data()?;
    let mut market = Market::load(&mut mdata)?;
    let ta = market.total_side_a().checked_add(delta_a).ok_or(OnyxError::ArithmeticOverflow)?;
    market.set_total_side_a(ta);
    let tb = market.total_side_b().checked_add(delta_b).ok_or(OnyxError::ArithmeticOverflow)?;
    market.set_total_side_b(tb);
    market.set_clearing_price(clearing_price);
    market.set_phase(PHASE_MATCHED);

    Ok(())
}

#[cfg(all(test, not(target_os = "solana")))]
mod tests {
    //! Real mollusk-svm SBF execution (same pattern as refund_expired.rs /
    //! withdraw_trading.rs). No token CPI here at all (pure account-data
    //! mutation, per the file header), so this fixture is simpler than
    //! withdraw_trading's -- no SPL token program needed. The two things
    //! most worth locking down at the unit level: the batch-inclusion
    //! completeness check (already live-tested for both attack variants via
    //! er_omission_attack_test.ts, but never in isolation), and the
    //! partial-fill unmatched-locked-release logic (a real bug this exact
    //! file's comments document being caught by inspection before any UI was
    //! built on top of it).

    use alloc::vec;
    use alloc::vec::Vec;
    use mollusk_svm::{result::Check, Mollusk};
    use solana_account::Account;
    use solana_clock::Clock;
    use solana_instruction::{AccountMeta, Instruction};
    use solana_program_error::ProgramError as SvmProgramError;
    use solana_pubkey::Pubkey;
    use solana_rent::Rent;

    use crate::constants::{
        DISC_MARKET, IX_RUN_BATCH_MATCH_FAST, PHASE_MATCHED, PHASE_REVEAL, SIDE_A, SIDE_B,
        TRADING_STATUS_LOCKED, TRADING_STATUS_MATCHED, TRADING_STATUS_REVEALED,
    };
    use crate::error::OnyxError;
    use crate::state::market::MARKET_LEN;
    use crate::state::trading_account::TRADING_ACCOUNT_LEN;

    const PROGRAM_ID: Pubkey = Pubkey::new_from_array(crate::ID);

    fn market_bytes(phase: u8, revealed_count: u8, reveal_end_ts: i64, total_a: u64, total_b: u64) -> Vec<u8> {
        let mut b = vec![0u8; MARKET_LEN];
        b[0] = DISC_MARKET;
        b[52..60].copy_from_slice(&total_a.to_le_bytes());
        b[60..68].copy_from_slice(&total_b.to_le_bytes());
        b[110..118].copy_from_slice(&reveal_end_ts.to_le_bytes());
        b[118] = phase;
        b[127] = revealed_count;
        b
    }

    #[allow(clippy::too_many_arguments)]
    fn trading_bytes(owner: &Pubkey, market: &Pubkey, locked: u64, status: u8, side: u8, size: u64, limit_price: u64) -> Vec<u8> {
        let mut b = vec![0u8; TRADING_ACCOUNT_LEN];
        b[0] = crate::constants::DISC_TRADING_ACCOUNT;
        b[8..40].copy_from_slice(owner.as_ref());
        b[40..72].copy_from_slice(market.as_ref());
        b[88..96].copy_from_slice(&locked.to_le_bytes());
        b[128] = side;
        b[129] = status;
        b[136..144].copy_from_slice(&size.to_le_bytes());
        b[144..152].copy_from_slice(&limit_price.to_le_bytes());
        b
    }

    fn ta_account(data: Vec<u8>) -> Account {
        let rent = Rent::default();
        Account { lamports: rent.minimum_balance(TRADING_ACCOUNT_LEN), data, owner: PROGRAM_ID, executable: false, rent_epoch: 0 }
    }

    struct Fixture {
        mollusk: Mollusk,
        payer: Pubkey,
        market_key: Pubkey,
    }

    fn setup() -> Fixture {
        unsafe {
            std::env::set_var("SBF_OUT_DIR", concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy"));
        }
        let mollusk = Mollusk::new(&PROGRAM_ID, "onyx");
        Fixture { mollusk, payer: Pubkey::new_unique(), market_key: Pubkey::new_unique() }
    }

    impl Fixture {
        /// `metas` is the instruction's own account-index list (can repeat a
        /// pubkey to simulate the duplicate-account attack); `world` is the
        /// deduped set of accounts mollusk actually knows about -- exactly
        /// mirrors how a real transaction can reference one account twice in
        /// its account-keys table while there's only ever one real account.
        fn run_raw(
            &mut self,
            market_phase: u8,
            revealed_count: u8,
            reveal_end_ts: i64,
            now: i64,
            world: Vec<(Pubkey, Account)>,
            metas: Vec<Pubkey>,
            extra_checks: &[Check],
        ) -> Vec<(Pubkey, Account)> {
            self.mollusk.sysvars.clock = Clock { unix_timestamp: now, ..Clock::default() };
            let rent = Rent::default();

            let mut accounts = vec![
                (self.payer, Account::new(10_000_000_000, 0, &solana_system_interface::program::ID)),
                (
                    self.market_key,
                    Account {
                        lamports: rent.minimum_balance(MARKET_LEN),
                        data: market_bytes(market_phase, revealed_count, reveal_end_ts, 0, 0),
                        owner: PROGRAM_ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
            ];
            accounts.extend(world);

            let mut ix_accounts = vec![AccountMeta::new_readonly(self.payer, true), AccountMeta::new(self.market_key, false)];
            ix_accounts.extend(metas.iter().map(|k| AccountMeta::new(*k, false)));

            let instruction = Instruction { program_id: PROGRAM_ID, accounts: ix_accounts, data: vec![IX_RUN_BATCH_MATCH_FAST] };
            let result = self.mollusk.process_and_validate_instruction(&instruction, &accounts, extra_checks);
            result.resulting_accounts
        }
    }

    /// Two orders that fully match at a predictable price -- same numbers as
    /// the classic flow's documented example (500000/100000 limits, both
    /// tie at full volume, smallest price wins -> clearing_price=100000).
    fn two_full_match_tas(market: &Pubkey) -> (Pubkey, Pubkey, Vec<(Pubkey, Account)>, Vec<Pubkey>) {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let world = vec![
            (a, ta_account(trading_bytes(&Pubkey::new_unique(), market, 1_000_000, TRADING_STATUS_REVEALED, SIDE_A, 1_000_000, 500_000))),
            (b, ta_account(trading_bytes(&Pubkey::new_unique(), market, 1_000_000, TRADING_STATUS_REVEALED, SIDE_B, 1_000_000, 100_000))),
        ];
        (a, b, world, vec![a, b])
    }

    #[test]
    fn full_match_sets_clearing_price_and_phase() {
        let mut fx = setup();
        let market = fx.market_key;
        let (a, b, world, metas) = two_full_match_tas(&market);
        let resulting = fx.run_raw(PHASE_REVEAL, 2, 1_000, 2_000, world, metas, &[Check::success()]);

        let market_after = resulting.iter().find(|(k, _)| *k == fx.market_key).unwrap();
        assert_eq!(market_after.1.data[118], PHASE_MATCHED);
        assert_eq!(&market_after.1.data[119..127], &100_000u64.to_le_bytes(), "smallest limit price wins");
        assert_eq!(&market_after.1.data[52..60], &1_000_000u64.to_le_bytes(), "total_side_a");
        assert_eq!(&market_after.1.data[60..68], &1_000_000u64.to_le_bytes(), "total_side_b");

        for k in [a, b] {
            let after = resulting.iter().find(|(ak, _)| *ak == k).unwrap();
            assert_eq!(after.1.data[129], TRADING_STATUS_MATCHED);
            assert_eq!(&after.1.data[152..160], &1_000_000u64.to_le_bytes(), "matched_size");
            assert_eq!(&after.1.data[88..96], &0u64.to_le_bytes(), "locked cleared");
        }
    }

    #[test]
    fn partial_fill_releases_unmatched_locked_to_available() {
        // Same numbers as er_partial_fill_test.ts's live proof: 2,000,000
        // locked vs 1,000,000 -- only 1,000,000 can match, the larger side's
        // remaining 1,000,000 must flow back to `available`, not vanish.
        let mut fx = setup();
        let market = fx.market_key;
        let big = Pubkey::new_unique();
        let small = Pubkey::new_unique();
        let world = vec![
            (big, ta_account(trading_bytes(&Pubkey::new_unique(), &market, 2_000_000, TRADING_STATUS_REVEALED, SIDE_A, 2_000_000, 500_000))),
            (small, ta_account(trading_bytes(&Pubkey::new_unique(), &market, 1_000_000, TRADING_STATUS_REVEALED, SIDE_B, 1_000_000, 100_000))),
        ];
        let resulting = fx.run_raw(PHASE_REVEAL, 2, 1_000, 2_000, world, vec![big, small], &[Check::success()]);

        let big_after = resulting.iter().find(|(k, _)| *k == big).unwrap();
        assert_eq!(&big_after.1.data[152..160], &1_000_000u64.to_le_bytes(), "matched only 1,000,000");
        assert_eq!(&big_after.1.data[80..88], &1_000_000u64.to_le_bytes(), "unmatched 1,000,000 released to available");
        assert_eq!(&big_after.1.data[88..96], &0u64.to_le_bytes(), "locked fully cleared");

        let small_after = resulting.iter().find(|(k, _)| *k == small).unwrap();
        assert_eq!(&small_after.1.data[152..160], &1_000_000u64.to_le_bytes());
        assert_eq!(&small_after.1.data[80..88], &0u64.to_le_bytes(), "fully matched, nothing to release");
    }

    #[test]
    fn rejects_wrong_count_omission() {
        // revealed_count says 2 genuinely revealed orders exist, caller only
        // passes 1 -- CHECK 1.
        let mut fx = setup();
        let market = fx.market_key;
        let (_, _, world, metas) = two_full_match_tas(&market);
        let only_first = vec![metas[0]];
        let world_one = vec![world[0].clone()];
        fx.run_raw(
            PHASE_REVEAL, /* revealed_count */ 2, 1_000, 2_000, world_one, only_first,
            &[Check::err(SvmProgramError::Custom(OnyxError::TooManyOrders as u32))],
        );
    }

    #[test]
    fn rejects_duplicate_account_padding() {
        // revealed_count=2, caller passes the SAME real revealed account
        // twice instead of a second genuinely distinct one -- CHECK 2.
        // Passes the length check (n==2), but the second occurrence's
        // pre-write status re-check sees Matched (written by the first
        // occurrence, since duplicate metas alias the same account), so the
        // whole tx must fail atomically.
        let mut fx = setup();
        let market = fx.market_key;
        let only = Pubkey::new_unique();
        let world = vec![(only, ta_account(trading_bytes(&Pubkey::new_unique(), &market, 1_000_000, TRADING_STATUS_REVEALED, SIDE_A, 1_000_000, 500_000)))];
        fx.run_raw(
            PHASE_REVEAL, /* revealed_count */ 2, 1_000, 2_000, world, vec![only, only],
            &[Check::err(SvmProgramError::Custom(OnyxError::WrongPhase as u32))],
        );
    }

    #[test]
    fn rejects_if_already_matched() {
        let mut fx = setup();
        let market = fx.market_key;
        let (_, _, world, metas) = two_full_match_tas(&market);
        fx.run_raw(
            PHASE_MATCHED, 2, 1_000, 2_000, world, metas,
            &[Check::err(SvmProgramError::Custom(OnyxError::WrongPhase as u32))],
        );
    }

    #[test]
    fn rejects_before_reveal_window_closes() {
        let mut fx = setup();
        let market = fx.market_key;
        let (_, _, world, metas) = two_full_match_tas(&market);
        // now (500) is BEFORE reveal_end_ts (1_000) -- window still open.
        fx.run_raw(
            PHASE_REVEAL, 2, /* reveal_end_ts */ 1_000, /* now */ 500, world, metas,
            &[Check::err(SvmProgramError::Custom(OnyxError::WrongPhase as u32))],
        );
    }

    #[test]
    fn rejects_trading_account_from_a_different_market() {
        let mut fx = setup();
        let market = fx.market_key;
        let other_market = Pubkey::new_unique();
        let stray = Pubkey::new_unique();
        let world = vec![(stray, ta_account(trading_bytes(&Pubkey::new_unique(), &other_market, 1_000_000, TRADING_STATUS_REVEALED, SIDE_A, 1_000_000, 500_000)))];
        fx.run_raw(
            PHASE_REVEAL, 1, 1_000, 2_000, world, vec![stray],
            &[Check::err(SvmProgramError::Custom(OnyxError::BadParams as u32))],
        );
    }

    #[test]
    fn rejects_trading_account_not_yet_revealed() {
        let mut fx = setup();
        let market = fx.market_key;
        let still_locked = Pubkey::new_unique();
        let world = vec![(still_locked, ta_account(trading_bytes(&Pubkey::new_unique(), &market, 1_000_000, TRADING_STATUS_LOCKED, SIDE_A, 0, 0)))];
        fx.run_raw(
            PHASE_REVEAL, 1, 1_000, 2_000, world, vec![still_locked],
            &[Check::err(SvmProgramError::Custom(OnyxError::WrongPhase as u32))],
        );
    }

    #[test]
    fn rejects_zero_accounts() {
        let mut fx = setup();
        fx.run_raw(
            PHASE_REVEAL, 0, 1_000, 2_000, vec![], vec![],
            &[Check::err(SvmProgramError::Custom(OnyxError::TooManyOrders as u32))],
        );
    }
}
