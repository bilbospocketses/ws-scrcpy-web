// File logger for the launcher binary. Promoted to common 2026-05-22
// (todo §33 beta.38 diagnostic-logging cut) so the tray crate and the
// common crate itself can write to disk too. This file is now a thin
// re-export shim — all existing `crate::log::info(...)` / `error(...)`
// call sites in the launcher continue working unchanged, and the
// launcher's default log name is "launcher" so the file path stays
// `<dataRoot>/logs/launcher.log` exactly as before.
//
// See `common/src/log.rs` for the full documentation + tests.

pub use common::log::*;
