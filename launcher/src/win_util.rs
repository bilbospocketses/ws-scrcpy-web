//! Shared Windows-only helpers: UTF-16 widening for the W-suffixed Win32 APIs
//! and the process-creation flags used across the spawn / elevation paths.
//! Plain `u32` constants (not the `windows` crate's) so pure-logic modules can
//! reference them without threading the crate through on non-Windows hosts.
//! (#95, #96)

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

/// Suppress the child's console window (`CREATE_NO_WINDOW`).
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Detach the child from this process's console and parent-exit kill-chain
/// (`DETACHED_PROCESS`).
pub const DETACHED_PROCESS: u32 = 0x0000_0008;

/// Convert a Rust string to a null-terminated UTF-16 buffer for the W-suffixed
/// Win32 APIs.
pub fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}
