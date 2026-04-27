//! Shared library for the ws-scrcpy-web Rust binaries (`launcher` + `tray`).
//!
//! Holds code that both binaries need:
//!   - [`config`] — read-only view of `<installRoot>/config.json`
//!   - [`tray`] — tray-icon event loop with exit-confirm dialog. Windows has
//!     a full implementation; Linux ships a best-effort stub that returns
//!     [`tray::TrayAction::Cancelled`] — see the module docs for the SP3 P4b
//!     decision rationale.
//!
//! This crate intentionally has no dependency on launcher-specific modules
//! (e.g., the launcher's `log` module). Callers handle their own logging on
//! lenient/fallback paths.

pub mod config;
pub mod tray;
