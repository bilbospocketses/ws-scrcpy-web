// Post-stop handler — fires whenever Servy detects the supervised
// launcher exit. Registered as the service's `--postStopPath` at
// install time (see elevated_runner::install_service).
//
// Background — §32 Part 3 (caught by v0.1.25-beta.9 → beta.10 + beta.11
// smokes): when the in-app updater applies a Velopack swap in service
// mode, the SOURCE Node calls process.exit(0), the launcher exits clean,
// Servy reports STOPPED to SCM. Because the exit is clean (code 0), SCM
// does NOT trigger the RestartProcess RecoveryAction. The `--veloapp-updated`
// hook fires on the NEW launcher binary AFTER the swap, but:
//   * Synchronous `servy-cli restart` inside the hook had Update.exe still
//     alive — the new SERVICE LAUNCHER's Node child got killed by
//     file-sharing-violation on current/ (caught by beta.10 smoke).
//   * Detached deferred-spawn inside the hook had the helper killed by
//     Velopack's Job Object cleanup before its sleep completed (beta.11).
// Neither approach survived Velopack's process-tree teardown.
//
// Fix: use Servy's `--postStopPath` (fire-and-forget executable that runs
// AFTER the wrapped process and all of its child processes have exited).
// The post-stop process is spawned by Servy itself — Servy sits in SCM's
// process tree (independent of Velopack), so the post-stop process is
// outside any Velopack-managed Job Object. It can sleep, log, and
// invoke `sc start` without being killed mid-flight.
//
// Argv shape (invoked by Servy at every supervised-process exit):
//   ws-scrcpy-web-launcher.exe --post-stop-handler
//
// Behavior:
//   1. Check for the marker file at <data_root>/control/apply-update-pending.
//   2. If the marker is absent → user-initiated stop (sc stop, services.msc,
//      shutdown). Exit 0 immediately, do NOT restart the service.
//   3. If the marker is present → in-app updater asked us to restart.
//      Delete the marker, sleep DEFERRED_RESTART_DELAY_SECS to let
//      Update.exe finish its swap + cleanup + exit, then invoke
//      `sc.exe start WsScrcpyWeb`. Exit with the sc.exe exit code.
//
// Exit codes:
//   0 = post-stop completed cleanly (either no marker → no-op, or sc start succeeded)
//   3 = marker present but sc.exe spawn failed
//   4 = sc.exe ran but returned non-zero

use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::log;

const APPLY_UPDATE_PENDING_FILENAME: &str = "apply-update-pending";
const SERVICE_NAME: &str = "WsScrcpyWeb";

/// 12 seconds: empirical buffer above the observed Update.exe lifetime.
/// v0.1.25-beta.10 smoke A.2 showed Update.exe holding file handles ~5s
/// into its post-apply window. 12s gives Update.exe time to exit and
/// release handles before sc.exe asks SCM to start the service again.
/// Servy itself fires the post-stop process IMMEDIATELY on supervised-
/// process exit, so the user-visible "applying update" window is
/// effectively ~12s + Velopack's own swap time.
const DEFERRED_RESTART_DELAY_SECS: u64 = 12;

/// Public entry: if argv contains `--post-stop-handler`, handle it and
/// return `Some(exit_code)`. Otherwise return None (caller proceeds to
/// normal launcher dispatch).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--post-stop-handler") {
        return None;
    }
    Some(handle_impl())
}

fn handle_impl() -> i32 {
    log::info("post-stop-handler: invoked by Servy after supervised launcher exit");

    let data_root = match resolve_data_root() {
        Some(p) => p,
        None => {
            log::error("post-stop-handler: cannot resolve data_root; no-op exit 0");
            return 0;
        }
    };
    log::info(&format!("post-stop-handler: data_root={data_root:?}"));

    let marker = data_root
        .join(common::control_marker::CONTROL_DIR)
        .join(APPLY_UPDATE_PENDING_FILENAME);

    if !marker.exists() {
        log::info(
            "post-stop-handler: no apply-update-pending marker — user-initiated stop, not restarting",
        );
        return 0;
    }

    log::info(&format!(
        "post-stop-handler: apply-update-pending marker present at {marker:?} — Velopack apply path active"
    ));

    // Delete the marker BEFORE the sleep + restart so a crash mid-restart
    // doesn't trap us in a loop on the next stop.
    if let Err(e) = std::fs::remove_file(&marker) {
        log::error(&format!(
            "post-stop-handler: failed to delete marker {marker:?}: {e} — continuing anyway"
        ));
    }

    log::info(&format!(
        "post-stop-handler: sleeping {DEFERRED_RESTART_DELAY_SECS}s to let Update.exe finish"
    ));
    thread::sleep(Duration::from_secs(DEFERRED_RESTART_DELAY_SECS));

    log::info(&format!(
        "post-stop-handler: invoking sc.exe start {SERVICE_NAME}"
    ));
    match Command::new("sc.exe")
        .args(["start", SERVICE_NAME])
        .status()
    {
        Ok(status) => {
            let code = status.code().unwrap_or(1);
            // sc.exe exit 0 = success. Non-zero (1056 = service already
            // running, 1058 = service disabled, etc.) we log but don't
            // catastrophize — SCM is the source of truth, our job is done.
            log::info(&format!("post-stop-handler: sc.exe exited with {code}"));
            if code == 0 { 0 } else { 4 }
        }
        Err(e) => {
            log::error(&format!("post-stop-handler: failed to spawn sc.exe: {e}"));
            3
        }
    }
}

/// Resolve `<dataRoot>` for the marker lookup. Mirrors the launcher's normal
/// data_root resolution: PROGRAMDATA env override + common helper. We
/// intentionally do NOT use Paths::from_env() here because it requires
/// install_root derivation (current_exe + parent walk) which is irrelevant
/// to the post-stop handler — the only thing we need is data_root.
fn resolve_data_root() -> Option<PathBuf> {
    common::config::data_root_from_env()
}

/// Public helper for UpdateService (Node-side) and supervisor-startup
/// cleanup: where to write the apply-update-pending marker.
pub fn marker_path(data_root: &Path) -> PathBuf {
    data_root
        .join(common::control_marker::CONTROL_DIR)
        .join(APPLY_UPDATE_PENDING_FILENAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_string()
    }

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args = vec![s("launcher.exe"), s("--unrelated")];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_returns_none_for_empty_args() {
        let args: Vec<String> = vec![];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_recognizes_flag() {
        let args = vec![s("launcher.exe"), s("--post-stop-handler")];
        let result = handle(&args);
        // We dispatched — return value is Some. Concrete code is 0 when
        // data_root has no marker (or fails to resolve under cargo test,
        // which is acceptable for the no-op exit path).
        assert!(result.is_some());
    }

    #[test]
    fn handle_recognizes_flag_at_any_position() {
        let args = vec![
            s("launcher.exe"),
            s("--unrelated"),
            s("--post-stop-handler"),
            s("--also-unrelated"),
        ];
        assert!(handle(&args).is_some());
    }

    #[test]
    fn marker_path_is_under_control_dir() {
        let data_root = Path::new("C:\\fake\\data");
        let path = marker_path(data_root);
        assert!(path.ends_with("apply-update-pending"));
        assert!(path.to_string_lossy().contains("control"));
    }

    #[test]
    fn marker_filename_constant_matches_node_side_expectation() {
        // Node's UpdateService writes <dataRoot>/control/apply-update-pending.
        // If you change this constant, also bump the Node side in
        // src/server/UpdateService.ts:applyUpdate.
        assert_eq!(APPLY_UPDATE_PENDING_FILENAME, "apply-update-pending");
    }
}
