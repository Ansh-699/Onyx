//! Small byte-manipulation and validation helpers shared across instructions.
//!
//! These are pure functions (no syscalls) so they compile and run on the host
//! for unit tests as well as on the SBF target.

use crate::error::OnyxError;

/// Read a little-endian `u16` from `buf` at `off`.
#[inline]
pub fn read_u16_le(buf: &[u8], off: usize) -> Result<u16, OnyxError> {
    let end = off.checked_add(2).ok_or(OnyxError::InvalidInstructionData)?;
    let s = buf.get(off..end).ok_or(OnyxError::InvalidInstructionData)?;
    Ok(u16::from_le_bytes([s[0], s[1]]))
}

/// Read a little-endian `u32` from `buf` at `off`.
#[inline]
pub fn read_u32_le(buf: &[u8], off: usize) -> Result<u32, OnyxError> {
    let end = off.checked_add(4).ok_or(OnyxError::InvalidInstructionData)?;
    let s = buf.get(off..end).ok_or(OnyxError::InvalidInstructionData)?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// Read a little-endian `u64` from `buf` at `off`.
#[inline]
pub fn read_u64_le(buf: &[u8], off: usize) -> Result<u64, OnyxError> {
    let end = off.checked_add(8).ok_or(OnyxError::InvalidInstructionData)?;
    let s = buf.get(off..end).ok_or(OnyxError::InvalidInstructionData)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(s);
    Ok(u64::from_le_bytes(a))
}

/// Read a little-endian `i64` from `buf` at `off`.
#[inline]
pub fn read_i64_le(buf: &[u8], off: usize) -> Result<i64, OnyxError> {
    Ok(read_u64_le(buf, off)? as i64)
}

/// Read a 32-byte array from `buf` at `off`.
#[inline]
pub fn read_array32(buf: &[u8], off: usize) -> Result<[u8; 32], OnyxError> {
    let end = off.checked_add(32).ok_or(OnyxError::InvalidInstructionData)?;
    let s = buf.get(off..end).ok_or(OnyxError::InvalidInstructionData)?;
    let mut a = [0u8; 32];
    a.copy_from_slice(s);
    Ok(a)
}

/// TxLINE timestamps are milliseconds. Convert a ms timestamp to an epoch day.
#[inline]
pub fn epoch_day_from_ms(ts_ms: i64) -> u16 {
    (ts_ms.div_euclid(crate::constants::MS_PER_DAY)) as u16
}
