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

mod single_instance;

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};

const ICON_BYTES: &[u8] = include_bytes!("../../assets/tray-icon.ico");
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

fn main() -> Result<()> {
    // Per-session single-instance gate. If another tray helper is already
    // running in this logon session, exit silently. This handles the
    // transitional state where both HKLM\Run (new) and HKCU\Run (stale
    // from v0.1.24 install) point at the tray exe and both fire at logon.
    let _instance_guard = match single_instance::acquire(single_instance::MUTEX_NAME) {
        Ok(Some(guard)) => Some(guard),
        Ok(None) => return Ok(()), // duplicate; exit silently
        Err(e) => {
            eprintln!("tray: single-instance acquire failed: {e:?}; continuing without guard");
            None
        }
    };

    // Best-effort cleanup of the pre-v0.1.25 HKCU\...\Run\WsScrcpyWebTray
    // value for the current user. v0.1.24 wrote this from elevated install
    // context, so only the original installing admin had it. For everyone
    // else this is a no-op (reg.exe exits 1 on value-not-found, treated as
    // success).
    if let Err(e) = cleanup_stale_hkcu_run_value() {
        eprintln!("tray: HKCU\\Run cleanup failed (non-fatal): {e:?}");
    }

    run_tray()
}

fn run_tray() -> Result<()> {
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

    // §32 Part 5: when launched by the launcher's tray_supervisor poller
    // (--launcher-spawn arg), show a one-time balloon explaining that the
    // launcher owns the tray lifecycle so the user understands why it
    // keeps coming back if they try to close it.
    //
    // §32 Part 5h: tooltip + exit-confirmation copy is now mode-aware.
    // Pre-Part-5h the standalone tray was only spawned in service mode
    // and the copy was hardcoded "service" / "Stop the service". Now the
    // tray runs in BOTH modes (local-mode launcher's in-process thread
    // tray was retired in favor of the standalone). Mode is read from
    // config.json's installMode field; the URL provider re-reads on
    // every click so the tray naturally tracks mode swaps mid-session.
    let argv: Vec<String> = std::env::args().collect();
    let show_launcher_balloon = argv.iter().any(|a| a == "--launcher-spawn");

    let is_service_mode_at_start =
        common::config::AppConfig::load(&config_dir).is_service_mode();
    let (tooltip, exit_title, exit_msg, balloon_text): (&str, &str, &str, &str) =
        if is_service_mode_at_start {
            (
                "ws-scrcpy-web (service)",
                "Exit ws-scrcpy-web?",
                "Stop the service and quit?",
                "tray started by launcher. to clear the tray, stop the ws-scrcpy-web service via Settings.",
            )
        } else {
            (
                "ws-scrcpy-web",
                "Exit ws-scrcpy-web?",
                "Stop the server and quit?",
                // Local mode has no "stop server" affordance in Settings —
                // only the service install/uninstall buttons. The only
                // intended exit path is the tray's own context menu.
                "tray started by launcher. to clear the tray, use the exit option from the tray menu.",
            )
        };

    let balloon: Option<(&str, &str)> = if show_launcher_balloon {
        Some(("ws-scrcpy-web tray", balloon_text))
    } else {
        None
    };

    // §32 Part 5i — mode-change detection thread. Watches config.json's
    // installMode for changes from the spawn-time value (e.g., user opts
    // INTO service mode from local, or uninstalls service while tray is
    // alive). On change, exit the tray; the launcher's tray-supervisor
    // respawns within ~10s with mode-aware text. Without this, the tray
    // text + balloon stay frozen at the spawn-time mode (URL provider
    // already re-reads per-click so the navigation target was already
    // mode-tracking; this only fixes the static text).
    //
    // Polling intentionally lives in the tray process (not the launcher
    // supervisor) so the supervisor stays stateless — the decision is
    // co-located with the value being checked. 5s gives a snappy
    // transition without spamming disk I/O.
    {
        let data_root_for_mode = config_dir.clone();
        let initial_service_mode = is_service_mode_at_start;
        std::thread::spawn(move || {
            const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
            loop {
                std::thread::sleep(POLL_INTERVAL);
                let current = common::config::AppConfig::load(&data_root_for_mode).is_service_mode();
                if current != initial_service_mode {
                    eprintln!(
                        "tray: installMode changed (was service={}, is service={}); exiting for tray-supervisor respawn with mode-aware text",
                        initial_service_mode, current,
                    );
                    std::process::exit(0);
                }
            }
        });
    }

    let action = common::tray::run(
        ICON_BYTES,
        tooltip,
        exit_title,
        exit_msg,
        url_provider,
        balloon,
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

/// Best-effort delete of the pre-v0.1.25 HKCU\...\Run\WsScrcpyWebTray value
/// for the current user. v0.1.24 wrote this from elevated install context,
/// which only landed in the installing admin's hive — so for non-admin users
/// this is always a no-op. For the original installing admin, this removes
/// the stale registration that would otherwise spawn a duplicate tray
/// alongside the new HKLM-Run-spawned one.
///
/// Returns Ok on exit code 0 (deleted) AND exit code 1 (not present, or
/// other recoverable failure). Same exit-code-classification pattern as
/// `classify_reg_delete_outcome` in `launcher/src/elevated_runner.rs`,
/// inlined here rather than shared because the tray crate doesn't depend
/// on launcher (different process boundaries, different ownership). Other
/// exit codes return Err so the caller can log; they should not abort
/// startup.
#[cfg(windows)]
fn cleanup_stale_hkcu_run_value() -> Result<()> {
    use std::process::Command;

    let out = Command::new("reg.exe")
        .args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "WsScrcpyWebTray",
            "/f",
        ])
        .output()
        .context("reg.exe delete HKCU Run-key")?;

    match out.status.code() {
        Some(0) | Some(1) => Ok(()),
        _ => {
            anyhow::bail!(
                "reg.exe exited with {:?}; stderr: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
}

#[cfg(not(windows))]
fn cleanup_stale_hkcu_run_value() -> Result<()> {
    Ok(())
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
