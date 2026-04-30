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
    // Phase 1 of the Program Files migration: config.json lives under
    // <dataRoot> (PROGRAMDATA-rooted on Windows). Fall back to the
    // pre-Phase-1 install_root location on non-Windows or if data_root
    // resolution returns None for any reason.
    let config_dir = match common::config::data_root_from_env() {
        Some(p) => p,
        None => install_root_from_exe().context("resolve install root")?,
    };
    // Build a URL provider closure that re-reads config.json on every
    // invocation. Necessary because the user may flip between local and
    // service modes during the tray helper's lifetime — each mode binds a
    // different port, and a cached URL would point at a dead port after
    // the swap. The closure is invoked on every tray click (left + Open).
    let config_dir_for_url = config_dir.clone();
    let url_provider: Box<dyn Fn() -> String> = Box::new(move || {
        let cfg = common::config::AppConfig::load(&config_dir_for_url);
        let port = cfg.web_port.unwrap_or(8000);
        format!("http://localhost:{port}")
    });

    // Theory D: poll <dataRoot>/control/uninstall-handoff.json on a background
    // thread so service-Node can hand off uninstall flows without WTS APIs.
    // Runs for the lifetime of the tray helper; thread is killed on exit.
    //
    // Known Phase-4 polish items (deferred, not a regression):
    //   - stdio inheritance: spawned launcher inherits tray's stdio handles
    //     (typically NUL for windowless process, so likely benign).
    //   - cwd inheritance: spawned launcher inherits tray cwd; could create
    //     a cwd lock per feedback_velopack_permachine_lessons (adb daemon
    //     cwd-handle incident). Harden in Phase 4 with explicit cwd= on
    //     the Command if real-world testing surfaces a swap failure.
    //   - CREATE_NO_WINDOW: not set; launcher is windowed-subsystem so no
    //     console flicker expected.
    {
        let data_root = config_dir.clone();
        // SAFETY: WTSGetActiveConsoleSessionId has no preconditions on
        // Windows; on non-Windows we don't compile this branch.
        #[cfg(windows)]
        let own_session = unsafe {
            windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId()
        };
        #[cfg(not(windows))]
        let own_session: u32 = 0;
        if own_session == u32::MAX {
            // 0xFFFFFFFF means no session attached to the physical console.
            // Skip spawning the poller — we'd silently mis-route any marker
            // that targets a real session.
            eprintln!("tray: WTSGetActiveConsoleSessionId returned 0xFFFFFFFF; control-marker poller not started");
        } else {
            // Thread killed at process exit is safe: if a spawn-without-delete
            // window leaves a stale marker on disk, cleanup_stale on next tray
            // startup (60s threshold) reaps it before the poll loop resumes.
            std::thread::spawn(move || {
                common::control_marker::poll_for_handoff(
                    &data_root,
                    own_session,
                    std::time::Duration::from_millis(750),
                );
            });
        }
    }

    let action = common::tray::run(
        ICON_BYTES,
        "ws-scrcpy-web (service)",
        "Exit ws-scrcpy-web?",
        "Stop the service and quit?",
        url_provider,
    )
    .context("tray loop")?;

    if matches!(action, common::tray::TrayAction::ConfirmedExit) {
        // Re-read config to get the CURRENT port — may have changed since
        // the tray started (mode swap mid-session).
        let shutdown_port = common::config::AppConfig::load(&config_dir)
            .web_port
            .unwrap_or(8000);
        request_server_shutdown(shutdown_port);
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
