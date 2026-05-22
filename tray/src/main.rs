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
        // Use the canonical WTSEnumerateSessionsW resolver in
        // `common::session`. Pre-2026-05-22 this called
        // `WTSGetActiveConsoleSessionId` directly, returning the
        // *physical console* session which on VM / RDP / Hyper-V Enhanced
        // Session diverged from the actual user session and broke the
        // marker check at `common/src/control_marker.rs:110-113`.
        // See todo §33 Bug B.
        match common::session::active_interactive_session() {
            Some(own_session) => {
                // Thread killed at process exit is safe: if a spawn-
                // without-delete window leaves a stale marker on disk,
                // cleanup_stale on next tray startup (60s threshold)
                // reaps it before the poll loop resumes.
                std::thread::spawn(move || {
                    common::control_marker::poll_for_handoff(
                        &data_root,
                        own_session,
                        std::time::Duration::from_millis(750),
                    );
                });
            }
            None => {
                // No active interactive session resolvable (e.g., post-
                // boot before any logon, fully headless install). Skip
                // the poller — we'd silently mis-route any marker that
                // targets a real session.
                eprintln!(
                    "tray: no active interactive session resolvable; control-marker poller not started"
                );
            }
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
    // The tray menu's exit option is the only intended path to clear the
    // tray in either mode. Service-mode Settings exposes uninstall (which
    // tears down service + tray) but no "stop service" action; local-mode
    // Settings has no server-lifecycle affordances at all. The balloon
    // body is identical for both modes for this reason; the title carries
    // the service suffix to mirror the tooltip.
    let (tooltip, exit_title, exit_msg, balloon_title, balloon_text): (&str, &str, &str, &str, &str) =
        if is_service_mode_at_start {
            (
                "ws-scrcpy-web (service)",
                "Exit ws-scrcpy-web?",
                "Stop the service and quit?",
                "ws-scrcpy-web (service) tray",
                "tray started by launcher. to clear the tray, use the exit option from the tray menu.",
            )
        } else {
            (
                "ws-scrcpy-web",
                "Exit ws-scrcpy-web?",
                "Stop the server and quit?",
                "ws-scrcpy-web tray",
                "tray started by launcher. to clear the tray, use the exit option from the tray menu.",
            )
        };

    let balloon: Option<(&str, &str)> = if show_launcher_balloon {
        Some((balloon_title, balloon_text))
    } else {
        None
    };

    // §33 Bug A fix — the §32 Part 5i 5s-poll mode-detection thread was
    // removed here. It called `std::process::exit(0)` on installMode
    // change, which race-killed the Theory D handoff polling thread mid-
    // uninstall (kills ALL threads in the process). Mode-change detection
    // now lives in `launcher/src/tray_supervisor.rs` where the kill is
    // supervisor-mediated (taskkill) so the handoff thread isn't running
    // in the doomed tray when it dies. Trade-off: ~10s detection latency
    // (supervisor poll cadence) vs ~5s previously — acceptable.

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
