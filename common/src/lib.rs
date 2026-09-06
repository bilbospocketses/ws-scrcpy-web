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
//!     has a full Win32 implementation; Linux has a StatusNotifierItem
//!     implementation on `ksni` (item 63) that stands down with
//!     [`tray::TrayAction::Cancelled`] when the desktop has no tray host.
//!   - [`tray_policy`] — pure tray decisions (eligibility, session-bus
//!     detection, labels, the 22×22 ARGB icon) shared by both trays

pub mod config;
pub mod control_marker;
pub mod log;
pub mod session;
pub mod tray;
pub mod tray_policy;
