//! Zero-copy account layouts (spec §5). Every account begins with a 1-byte
//! discriminator + 7 bytes padding for 8-byte field alignment. All multi-byte
//! integer fields are little-endian. Accessors read/write directly over the
//! account's data slice — no deserialization / allocation.

pub mod config;
pub mod market;
pub mod position;
pub mod sealed_order;
pub mod trading_account;

pub use config::Config;
pub use market::Market;
pub use position::Position;
pub use sealed_order::SealedOrder;
pub use trading_account::TradingAccount;

use crate::error::OnyxError;

/// Helper: interpret a byte slice as a fixed layout of `LEN`, checking length.
#[inline]
pub fn check_len(data: &[u8], len: usize) -> Result<(), OnyxError> {
    if data.len() < len {
        return Err(OnyxError::InvalidAccountSize);
    }
    Ok(())
}
