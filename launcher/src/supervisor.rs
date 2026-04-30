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

    // Service-mode tray Run-key migration. Idempotent — fast-paths when
    // already correct. LocalSystem token (the privilege context Servy
    // runs the launcher under) has the rights to write HKLM without UAC.
    // In local mode this is a no-op: HKLM\Run is only used for the
    // standalone tray helper which only exists in service mode.
    {
        let cfg = common::config::AppConfig::load(&paths.data_root);
        if cfg.is_service_mode() {
            match crate::elevated_runner::migrate_tray_run_key_for_service(&paths.install_root) {
                Ok(()) => log::info("supervisor: tray HKLM migration check complete"),
                Err(e) => log::error(&format!("supervisor: tray HKLM migration: {e}")),
            }
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

    // NOTE: do NOT set DEPS_PATH on the launcher's process env. spawn::resolve_node
    // reads DEPS_PATH and enforces strict mode (no seed/ fallback) when it's set
    // — which would defeat the first-run bootstrap (deps/ not yet populated, only
    // seed/ exists). DEPS_PATH is instead passed to the Node CHILD's env directly
    // via spawn::spawn_server(deps_path). The launcher's resolve_node only sees
    // DEPS_PATH when the user explicitly set it (e.g., shared-deps install) —
    // strict mode kicks in only there, as SP2b intended.
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
