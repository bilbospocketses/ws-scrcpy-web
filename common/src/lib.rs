//! Shared library for the ws-scrcpy-web Rust binaries (`launcher` + `tray`).
//!
//! Holds code that both binaries need:
//!   - [`config`] — read-only view of `<installRoot>/config.json`
//!   - [`tray`]   — Windows tray-icon event loop with exit-confirm dialog
//!
//! This crate intentionally has no dependency on launcher-specific modules
//! (e.g., the launcher's `log` module). Callers handle their own logging on
//! lenient/fallback paths.

pub mod config;

#[cfg(target_os = "windows")]
pub mod tray;
