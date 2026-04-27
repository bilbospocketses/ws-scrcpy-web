// Standalone tray helper for service-mode installs.
//
// In service mode, the launcher is wrapped by Servy and runs as a
// background service with no UI. This standalone helper is registered
// under HKCU\...\Run on install so that, on each user login, a tray
// icon appears as the user-facing "stop the service" affordance. On
// confirmed exit, it POSTs /api/server/shutdown so the Node server can
// shut down cleanly (and Servy decides whether to consider the service
// stopped — see Servy auto-restart-on-exit-0 risk in the contracts doc).
//
// Hidden window subsystem in release so no console window flashes when
// the helper is launched at login.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};

const ICON_BYTES: &[u8] = include_bytes!("../../assets/tray-icon.ico");
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

fn main() -> Result<()> {
    let install_root = install_root_from_exe().context("resolve install root")?;
    // Lenient: missing/malformed config means we use the default port.
    let cfg = common::config::AppConfig::load(&install_root);
    let port = cfg.web_port.unwrap_or(8000);

    let action = common::tray::run(
        ICON_BYTES,
        "ws-scrcpy-web (service)",
        "Exit ws-scrcpy-web?",
        "Stop the service and quit?",
    )
    .context("tray loop")?;

    if matches!(action, common::tray::TrayAction::ConfirmedExit) {
        request_server_shutdown(port);
    }
    Ok(())
}

/// Determine the install root from `current_exe`.
///
/// Production layout (Velopack-managed):
///   `<installRoot>/current/ws-scrcpy-web-tray.exe`
/// Dev / sibling layout (unit testing the helper):
///   `<some-dir>/ws-scrcpy-web-tray.exe`
///
/// If the exe's immediate parent is named `current`, install root is that
/// parent's parent. Otherwise we treat the exe's parent as the install
/// root — appropriate for a manual-test "drop next to config.json" run.
fn install_root_from_exe() -> Result<PathBuf> {
    let exe = env::current_exe().context("current_exe")?;
    let parent = exe
        .parent()
        .context("exe has no parent dir")?
        .to_path_buf();
    if parent.file_name().and_then(|n| n.to_str()) == Some("current") {
        let root = parent.parent().context("install root")?.to_path_buf();
        Ok(root)
    } else {
        Ok(parent)
    }
}

/// Fire-and-forget POST to the server's shutdown endpoint.
///
/// Errors are non-fatal: the user has already chosen to exit, and an
/// unreachable server (e.g., port mismatch, server already down) just
/// means there's nothing to ask. We exit successfully either way.
fn request_server_shutdown(port: u16) {
    let url = format!("http://127.0.0.1:{port}/api/server/shutdown");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(SHUTDOWN_TIMEOUT)
        .timeout(SHUTDOWN_TIMEOUT)
        .build();
    let _ = agent.post(&url).send_string("");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_root_from_exe_returns_a_path() {
        // Smoke: under cargo test the test binary lives under target/debug/
        // (or deps/), so the function should at least succeed and return a
        // path that exists. We don't assert specific layout because cargo
        // can place tests under several different parent dir shapes.
        let root = install_root_from_exe().expect("resolves under cargo test");
        assert!(root.exists(), "resolved root should exist on disk");
    }
}
