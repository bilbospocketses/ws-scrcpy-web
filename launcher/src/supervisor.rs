// Supervisor loop — replaces start.cmd's exit-75 + .restart marker behavior.
//
// Lifecycle:
//   1. Stale marker cleanup (delete `.restart` if left over from prior crash)
//   2. Install Ctrl+C handler that signals shutdown intent
//   3. Loop:
//      a. Clean up `node.exe.old` (Node auto-update artifact)
//      b. Spawn Node child via spawn::spawn_server
//      c. Wait for child OR Ctrl+C (poll-based, 100ms granularity)
//      d. Decide restart based on (exit code == 75) || marker present
//      e. If shutting down or no restart: return child's exit code
//      f. Otherwise sleep RESTART_DELAY and loop

use anyhow::Result;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::log;
use crate::paths::Paths;
use crate::spawn;

const EXIT_RESTART: i32 = 75;
const RESTART_DELAY: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq, Eq)]
pub enum RestartReason {
    ExitCode75,
    RestartMarker,
}

/// Pure decision function. Decides whether to restart and why.
pub fn decide_restart(exit_code: i32, marker_exists: bool) -> Option<RestartReason> {
    // Marker takes precedence (matches start.cmd behavior — checked first)
    if marker_exists {
        Some(RestartReason::RestartMarker)
    } else if exit_code == EXIT_RESTART {
        Some(RestartReason::ExitCode75)
    } else {
        None
    }
}

/// Main supervisor entry. Returns the final exit code to bubble to OS.
pub fn run() -> Result<i32> {
    let paths = Paths::from_env()?;
    log::info(&format!(
        "supervisor: install_root={:?} data_root={:?} deps_path={:?}",
        paths.install_root, paths.data_root, paths.deps_path
    ));

    // Stale marker cleanup on startup. Prevents an old marker from a
    // previous crash from triggering an immediate respawn loop.
    cleanup_stale_marker(&paths.restart_marker);

    // §32 Part 5 — launcher-owned tray lifecycle in service mode. Drops
    // HKLM\Run (no longer registered at install_service) + the Part 4
    // respawn-tray-after-upgrade flag mechanism. Replaced by a background
    // poller that spawns the tray helper into the active interactive
    // user session whenever it's missing. Tray's per-session
    // single-instance mutex handles dedup safely.
    //
    // The tray HKLM cleanup is now also handled here (one-time per
    // launcher start) to remove the legacy registry entry from
    // beta.18-and-earlier installs. The cleanup is idempotent — best-
    // effort delete, no error if absent.
    {
        let cfg = common::config::AppConfig::load(&paths.data_root);
        // --local-takeover override (was in main.rs pre-Part-5h, now lives
        // here where the tray-supervisor decision is made). Set by
        // ServiceApi.handoffUninstallToUserSession when spawning a
        // user-session launcher to perform a service uninstall. At spawn
        // time config.json still reflects the OUTGOING service mode; the
        // resume flow updates it post-uninstall. Without this hint the
        // freshly spawned local launcher would read is_service_mode=true
        // and try a cross-session WTS spawn from a non-privileged user
        // token (which fails) — user left with no tray after the service
        // goes away.
        let local_takeover_override = std::env::args().any(|a| a == "--local-takeover");
        if local_takeover_override && cfg.is_service_mode() {
            log::info(
                "supervisor: --local-takeover override; forcing is_service_mode=false for tray-supervisor",
            );
        }

        // §32 Part 5h — tray-supervisor runs in BOTH modes (was service-
        // mode-only pre-Part-5h). Mode-aware spawn dispatch inside the
        // supervisor: WTS cross-session for service mode (LocalSystem ->
        // user session), simple Command::new for local mode (already in
        // user session). Both modes converge on the standalone
        // ws-scrcpy-web-tray.exe process so the local-mode tray now
        // survives launcher crashes, post-service-uninstall handoff, and
        // any other event that previously killed the in-process thread
        // tray with no recovery. Polls every 10s and respawns if missing.
        #[cfg(windows)]
        {
            let is_service_mode = cfg.is_service_mode() && !local_takeover_override;
            let _stop = crate::tray_supervisor::start_background(
                &paths.install_root,
                &paths.data_root,
                is_service_mode,
            );
            // We intentionally drop `_stop` — the thread runs for the
            // lifetime of the process. If we ever need clean shutdown,
            // keep the handle and signal it.
            log::info("supervisor: tray-supervisor background thread started");
        }

        // §32 Part 5e — refresh the dataRoot copy of this launcher binary
        // that the upgrade-server is spawned from. Copying outside
        // `current/` lets the upgrade-server survive Velopack's swap of
        // `current/` (Velopack terminated the pre-Part-5e in-current
        // upgrade-server within ~1s of bind, per the beta.24 → beta.25
        // smoke). Refresh on every supervisor start so the helper tracks
        // the installed launcher version. Best-effort.
        //
        // §32 Part 5f — refresh unconditionally (not just in service
        // mode). Local-mode launcher also spawns the helper on apply-
        // update path, so the helper must be current there too.
        match crate::operation_server::refresh_helper_binary(&paths.data_root) {
            Ok(p) => log::info(&format!(
                "supervisor: refreshed operation-server helper at {p:?}"
            )),
            Err(e) => log::error(&format!(
                "supervisor: could not refresh operation-server helper (operation-server spawn will use stale binary or fail): {e}"
            )),
        }

        // §32 Part 5 — coordinate with any in-flight operation-server.
        // In service-mode, the operation-server binds the SAME port as
        // Node (config_port), so we need the stop-marker + port-wait
        // dance. In §40 local-mode, the operation-server binds a
        // DIFFERENT port (config_port+1), so no coordination needed.
        if cfg.is_service_mode() {
            let port = cfg.web_port.unwrap_or(8000);
            if let Err(e) = crate::operation_server::write_stop_marker(&paths.data_root) {
                log::error(&format!(
                    "supervisor: could not write operation-server stop marker (non-fatal): {e}"
                ));
            }
            crate::operation_server::wait_for_port_free(
                port,
                std::time::Duration::from_secs(5),
            );
            log::info(&format!(
                "supervisor: port {port} verified free, proceeding to spawn Node"
            ));
        }
    }

    // Install Ctrl+C handler. Failure is non-fatal — we'll still run, just
    // without graceful shutdown on signal.
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();
    if let Err(e) = ctrlc::set_handler(move || {
        stop_clone.store(true, Ordering::SeqCst);
    }) {
        log::error(&format!("could not install Ctrl+C handler: {e}"));
    }

    // spawn_server now passes deps_path directly to resolve_node_with, which
    // tries <deps_path>/node/node.exe first and falls back to seed/node/node.exe
    // when deps node is absent (first-run bootstrap). DEPS_PATH is also set on
    // the Node CHILD's env so the backend DependencyManager knows where to
    // install Node / ADB / scrcpy-server.
    log::info(&format!("supervisor: deps_path resolved to {:?} (passed to Node child)", paths.deps_path));

    loop {
        cleanup_old_node(&paths.old_node);

        let mut child = spawn::spawn_server(&paths.deps_path, &paths.data_root)?;
        log::info(&format!("supervisor: server started (pid {})", child.id()));

        let status = wait_with_signal(&mut child, &stop)?;
        let code = status.code().unwrap_or(1);
        log::info(&format!("supervisor: server exited with code {code}"));

        if stop.load(Ordering::SeqCst) {
            log::info("supervisor: shutdown signal received; not restarting");
            return Ok(code);
        }

        // Launcher-driven service uninstall. When the uninstall-pending marker
        // exists, the Node server requested a service removal (Settings →
        // Uninstall). Instead of relying on Servy's fire-and-forget post-stop
        // hook (which races against Servy's recovery timer), the launcher
        // handles the uninstall directly:
        //   1. Spawn a detached process that calls servy-cli stop + uninstall
        //   2. Block here until Servy's stop signal arrives (no recovery fires
        //      because servy-cli stop puts Servy in "stopping" state)
        //   3. The detached process then removes the service and spawns the
        //      local-mode launcher in the user's session
        #[cfg(windows)]
        {
            let uninstall_marker = paths.data_root.join("control").join("uninstall-pending");
            if uninstall_marker.exists() {
                log::info("supervisor: uninstall-pending marker found; handling service uninstall");

                match std::fs::remove_file(&uninstall_marker) {
                    Ok(()) => log::info("supervisor: deleted uninstall-pending marker"),
                    Err(e) => log::error(&format!(
                        "supervisor: could not delete uninstall-pending marker: {e}"
                    )),
                }

                let servy_path = paths.install_root.join("current").join("servy-cli.exe");
                let launcher_path =
                    paths.install_root.join("current").join("ws-scrcpy-web-launcher.exe");

                let script = format!(
                    "\"{}\" stop --name WsScrcpyWeb -q & \"{}\" uninstall --name WsScrcpyWeb -q & \"{}\" --spawn-user-launcher --launcher-path \"{}\"",
                    servy_path.display(),
                    servy_path.display(),
                    launcher_path.display(),
                    launcher_path.display(),
                );

                use std::os::windows::process::CommandExt;
                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;

                match std::process::Command::new("C:\\Windows\\System32\\cmd.exe")
                    .args(["/c", &script])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
                    .spawn()
                {
                    Ok(child) => {
                        log::info(&format!(
                            "supervisor: spawned detached uninstall process (pid {}); blocking until stop signal",
                            child.id()
                        ));
                    }
                    Err(e) => {
                        log::error(&format!(
                            "supervisor: failed to spawn uninstall process: {e}; exiting (post-stop.bat is fallback)"
                        ));
                        return Ok(code);
                    }
                }

                loop {
                    if stop.load(Ordering::SeqCst) {
                        log::info("supervisor: stop signal received during uninstall; exiting cleanly");
                        return Ok(0);
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            }
        }

        let marker_exists = paths.restart_marker.exists();
        let reason = decide_restart(code, marker_exists);

        match reason {
            None => {
                log::info("supervisor: clean exit; not restarting");
                return Ok(code);
            }
            Some(RestartReason::RestartMarker) => {
                let _ = std::fs::remove_file(&paths.restart_marker);
                log::info("supervisor: restart triggered by .restart marker");
            }
            Some(RestartReason::ExitCode75) => {
                log::info("supervisor: restart triggered by exit code 75");
            }
        }

        thread::sleep(RESTART_DELAY);
    }
}

fn cleanup_stale_marker(marker: &Path) {
    if marker.exists() {
        match std::fs::remove_file(marker) {
            Ok(()) => log::info(&format!("supervisor: removed stale marker {marker:?}")),
            Err(e) => log::error(&format!("supervisor: could not remove stale marker {marker:?}: {e}")),
        }
    }
}

// §32 Part 4 follow-up — `try_respawn_tray_after_upgrade` removed.
// Replaced by `tray_supervisor::start_background` which polls every 10s
// and ensures a tray exists regardless of why it went missing (post-
// upgrade, user-killed, never-spawned-on-first-logon). See
// `launcher/src/tray_supervisor.rs`.

fn cleanup_old_node(old: &Path) {
    if old.exists() {
        match std::fs::remove_file(old) {
            Ok(()) => log::info(&format!("supervisor: cleaned up {old:?}")),
            Err(e) => log::error(&format!("supervisor: could not remove {old:?}: {e}")),
        }
    }
}

/// Wait for child to exit, polling for shutdown signal at POLL_INTERVAL.
/// On signal, kills the child and waits for actual exit.
fn wait_with_signal(
    child: &mut std::process::Child,
    stop: &Arc<AtomicBool>,
) -> Result<std::process::ExitStatus> {
    loop {
        if stop.load(Ordering::SeqCst) {
            log::info(&format!("supervisor: terminating child pid {}", child.id()));
            let _ = child.kill();
            return Ok(child.wait()?);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_restart_returns_none_for_clean_exit_no_marker() {
        assert_eq!(decide_restart(0, false), None);
    }

    #[test]
    fn decide_restart_returns_none_for_failure_exit_no_marker() {
        assert_eq!(decide_restart(1, false), None);
        assert_eq!(decide_restart(42, false), None);
    }

    #[test]
    fn decide_restart_recognizes_exit_code_75() {
        assert_eq!(decide_restart(75, false), Some(RestartReason::ExitCode75));
    }

    #[test]
    fn decide_restart_recognizes_marker() {
        assert_eq!(decide_restart(0, true), Some(RestartReason::RestartMarker));
        assert_eq!(decide_restart(1, true), Some(RestartReason::RestartMarker));
    }

    #[test]
    fn decide_restart_marker_takes_precedence_over_exit_75() {
        // If both signals are present, marker wins (matches start.cmd's
        // ordering — marker checked before exit code).
        assert_eq!(decide_restart(75, true), Some(RestartReason::RestartMarker));
    }

}
