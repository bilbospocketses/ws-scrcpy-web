// Thin launcher-side wrapper around `common::tray::run`.
//
// In non-service mode, the launcher itself is the only long-lived process
// the user sees. We spawn a tray icon on a dedicated thread so the user has
// a way to stop the server cleanly without finding/killing the (subsystem
// = windows) launcher.exe via Task Manager.
//
// In service mode, the launcher is wrapped by Servy and the user-visible
// tray is a separate `ws-scrcpy-web-tray.exe` process registered under
// HKCU Run. The launcher itself does NOT spawn a tray in that case (would
// double up + race the helper's HTTP shutdown call).

use std::thread;

use crate::log;

const ICON_BYTES: &[u8] = include_bytes!("../../assets/tray-icon.ico");

/// Spawn the tray icon on a dedicated thread. Returns immediately.
///
/// Returns `None` when in service mode (tray helper handles it instead).
/// Returns `Some(JoinHandle)` otherwise; the caller is not expected to
/// `join` — the thread terminates with the process when the supervisor
/// returns and `main` exits, or earlier if the tray thread itself calls
/// `process::exit` after the user confirms exit.
pub fn spawn(install_mode_is_service: bool) -> Option<thread::JoinHandle<()>> {
    if install_mode_is_service {
        log::info("tray: service mode -> tray helper handles UI; not spawning launcher tray");
        return None;
    }
    let handle = thread::Builder::new()
        .name("ws-tray".to_string())
        .spawn(run_tray)
        .map_err(|e| {
            log::error(&format!("tray: failed to spawn thread: {e}"));
            e
        })
        .ok()?;
    Some(handle)
}

fn run_tray() {
    // URL provider closure re-reads config.json on every tray click.
    // The launcher tray only runs in local mode (service mode hands UI
    // to the standalone tray helper), but the resume flow after a
    // service uninstall (Theory D) can rebind the local port mid-session,
    // so a cached URL would go stale.
    let url_provider: Box<dyn Fn() -> String> = Box::new(|| {
        let port = common::config::data_root_from_env()
            .as_deref()
            .map(common::config::AppConfig::load)
            .and_then(|cfg| cfg.web_port)
            .unwrap_or(8000);
        format!("http://localhost:{port}")
    });

    match common::tray::run(
        ICON_BYTES,
        "ws-scrcpy-web",
        "Exit ws-scrcpy-web?",
        "Stop the server and quit?",
        url_provider,
    ) {
        Ok(common::tray::TrayAction::ConfirmedExit) => {
            log::info("tray: user confirmed exit; terminating process");
            // Cleanest integration point for P4a: process::exit(0) from
            // the tray thread. The supervisor doesn't currently expose a
            // graceful "stop from external thread" signal, and the Node
            // child process tree gets torn down by the OS when the
            // launcher process exits. P4a contract explicitly does not
            // gate on a graceful-shutdown channel.
            std::process::exit(0);
        }
        Ok(common::tray::TrayAction::Cancelled) => {
            // Not produced by the public API today, but exhaustive match
            // future-proofs against an upstream behavior change.
            log::info("tray: cancelled (loop exited without confirmation)");
        }
        Err(e) => {
            log::error(&format!("tray: loop failed: {e:?}"));
        }
    }
}
