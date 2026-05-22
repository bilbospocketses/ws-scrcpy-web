//! Shared library for the ws-scrcpy-web Rust binaries (`launcher` + `tray`).
//!
//! Holds code that both binaries need:
//!   - [`config`] — read-only view of `<installRoot>/config.json`
//!   - [`control_marker`] — Theory D uninstall-handoff marker reader/writer
//!     with a session-filtered poll loop for the tray's handoff thread
//!   - [`log`] — file logger (per-binary log file name; called via
//!     `crate::log::info(...)` in launcher via the shim at
//!     `launcher/src/log.rs`, called via `common::log::info(...)`
//!     directly in tray)
//!   - [`session`] — canonical WTS-active-interactive-session resolver
//!     (post-§33 Bug B fix — replaces the historically-broken
//!     `WTSGetActiveConsoleSessionId` usage)
//!   - [`tray`] — tray-icon event loop with exit-confirm dialog. Windows
//!     has a full implementation; Linux ships a best-effort stub that
//!     returns [`tray::TrayAction::Cancelled`] — see the module docs for
//!     the SP3 P4b decision rationale.

pub mod config;
pub mod control_marker;
pub mod log;
pub mod session;
pub mod tray;
