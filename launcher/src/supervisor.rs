// Supervisor loop — replaces start.cmd's exit-75 + .restart marker behavior.
//
// Lifecycle:
//   1. Stale marker cleanup (delete `.restart` if left over from prior crash)
//   2. Install Ctrl+C handler that signals shutdown intent
//   3. Loop:
//      a. Clean up stale node binary (Node auto-update artifact)
//      b. Spawn Node child via spawn::spawn_server
//      c. Wait for child OR Ctrl+C (poll-based, 100ms granularity)
//      d. Decide restart based on (exit code == 75) || marker present
//      e. Otherwise, a non-zero exit in local mode is a crash: restart it up to
//         MAX_CRASH_RESTARTS times in a row (item 163; the count resets once a
//         server stays up CRASH_COUNT_RESET_UPTIME). The service leaves crashes
//         to systemd / servy.
//      f. If shutting down or no restart: return child's exit code
//      g. Otherwise sleep RESTART_DELAY and loop

use anyhow::Result;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use crate::log;
use crate::paths::Paths;
use crate::spawn;

/// How long a stop request waits for Node to exit on its own after SIGTERM
/// before the supervisor kills it. Node's SIGTERM handler runs
/// `gracefulShutdown` (adb kill-server, service release, SQLite backup) and
/// exits 0 well inside this. (Item 63: the Linux tray's exit and Ctrl+C both
/// arrive as a stop request.)
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Pure: has the graceful window closed? Kept separate so the timing rule is
/// unit-tested without a child process.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn graceful_wait_exhausted(elapsed: Duration) -> bool {
    elapsed >= GRACEFUL_STOP_TIMEOUT
}

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

/// Item 163: in local mode a crashed server is restarted at most this many times
/// in a row before the launcher gives up and stays down.
pub(crate) const MAX_CRASH_RESTARTS: u32 = 3;
/// A server that stayed up this long before crashing was healthy: the crash
/// count starts again from zero.
pub(crate) const CRASH_COUNT_RESET_UPTIME: Duration = Duration::from_secs(60);
/// Logged once the restarts are used up (wording decided by the user, 2026-10-04).
pub(crate) const CRASH_GIVE_UP_LINE: &str = "3 restart attempts, won't retry, review error logging";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CrashDecision {
    /// Exit 0: the server stopped on purpose.
    CleanExit,
    /// We are the installed service: systemd's `Restart=on-failure` and servy's
    /// recovery decide, so the launcher exits and lets them see the failure.
    LeaveToServiceManager,
    /// Restart the server; `attempt` is this restart's number, from 1.
    Restart { attempt: u32 },
    /// The restarts are used up: log `CRASH_GIVE_UP_LINE` and stay down.
    GiveUp,
}

/// Pure decision for an exit that `decide_restart` did not claim (not 75, no
/// marker). `restarts_so_far` is the consecutive crash restarts already made;
/// `uptime` is how long the server that just exited had been running.
pub(crate) fn decide_crash_restart(
    exit_code: i32,
    running_as_service: bool,
    restarts_so_far: u32,
    uptime: Duration,
) -> CrashDecision {
    if exit_code == 0 {
        return CrashDecision::CleanExit;
    }
    if running_as_service {
        return CrashDecision::LeaveToServiceManager;
    }
    let prior = if uptime >= CRASH_COUNT_RESET_UPTIME {
        0
    } else {
        restarts_so_far
    };
    if prior >= MAX_CRASH_RESTARTS {
        CrashDecision::GiveUp
    } else {
        CrashDecision::Restart { attempt: prior + 1 }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Item 173: how often, and for how long, the supervisor retries a helper
/// refresh in the background when the helper was busy AND could not be moved
/// aside (Windows). Moving aside is the normal after-update path and needs no
/// retry; this covers a rename that failed too (another process holding the
/// file without delete sharing, briefly). The budget outlasts the longest an
/// earlier operation-server can run: a 10 s bind retry, its 30 s lifetime and
/// a 15 s wind-down.
pub(crate) const HELPER_REFRESH_RETRY_INTERVAL: Duration = Duration::from_secs(2);
pub(crate) const HELPER_REFRESH_RETRY_BUDGET: Duration = Duration::from_secs(120);

/// Pure: the log line for a startup helper refresh, and whether to start the
/// background retry. `windows` is the platform, a parameter so both rules are
/// tested on either host.
///
/// - Copied: INFO.
/// - Moved aside (Windows, item 173): INFO. The previous update's
///   operation-server still running from the helper is the routine
///   after-update case, not a failure: it was renamed and the new build is in
///   place before Node starts.
/// - Busy and not movable, Windows: WARN, and retry until it frees up.
/// - Busy on Linux (ETXTBSY): WARN, no retry. That is service start, where
///   the helper IS the running launcher; the next start refreshes it.
/// - Anything else (permissions, missing source, disk full): ERROR.
pub(crate) fn describe_helper_refresh(
    result: &std::io::Result<crate::operation_server::HelperRefresh>,
    windows: bool,
) -> (LogLevel, String, bool) {
    use crate::operation_server::{HelperRefresh, is_helper_busy_code};
    match result {
        Ok(HelperRefresh::Copied(p)) => (
            LogLevel::Info,
            format!("supervisor: refreshed operation-server helper at {p:?}"),
            false,
        ),
        Ok(HelperRefresh::MovedAside { path, aside }) => (
            LogLevel::Info,
            format!(
                "supervisor: refreshed operation-server helper at {path:?}; the previous operation-server was still running from it (expected after an update), so that copy was moved to {aside:?} and is deleted on a later start"
            ),
            false,
        ),
        Err(e) if windows && is_helper_busy_code(e.raw_os_error(), true) => (
            LogLevel::Warn,
            format!(
                "supervisor: operation-server helper is in use and could not be moved aside; retrying every {}s for up to {}s: {e}",
                HELPER_REFRESH_RETRY_INTERVAL.as_secs(),
                HELPER_REFRESH_RETRY_BUDGET.as_secs()
            ),
            true,
        ),
        Err(e) if is_helper_busy_code(e.raw_os_error(), windows) => (
            LogLevel::Warn,
            format!(
                "supervisor: operation-server helper is in use (text file busy); keeping the running copy — it refreshes on the next start when free: {e}"
            ),
            false,
        ),
        Err(e) => (
            LogLevel::Error,
            format!(
                "supervisor: could not refresh operation-server helper (operation-server spawn will use stale binary or fail): {e}"
            ),
            false,
        ),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HelperRetryOutcome {
    /// A retry succeeded `after` this long.
    Refreshed { after: Duration },
    /// A retry failed with something other than busy: a genuine error.
    Failed(String),
    /// Still busy when the budget ran out.
    GaveUp,
}

/// The background retry, with the attempt and the sleep as parameters so it is
/// tested without a real helper or real time.
pub(crate) fn retry_helper_refresh(
    mut attempt: impl FnMut() -> std::io::Result<crate::operation_server::HelperRefresh>,
    mut sleep: impl FnMut(Duration),
    interval: Duration,
    budget: Duration,
) -> HelperRetryOutcome {
    let mut waited = Duration::ZERO;
    while waited < budget {
        sleep(interval);
        waited += interval;
        match attempt() {
            Ok(_) => return HelperRetryOutcome::Refreshed { after: waited },
            Err(e) if crate::operation_server::helper_busy_error(&e) => continue,
            Err(e) => return HelperRetryOutcome::Failed(e.to_string()),
        }
    }
    HelperRetryOutcome::GaveUp
}

fn log_at(level: LogLevel, line: &str) {
    match level {
        LogLevel::Info => log::info(line),
        LogLevel::Warn => log::warn(line),
        LogLevel::Error => log::error(line),
    }
}

/// Refresh the operation-server helper at startup, log what happened, and on
/// Windows start the bounded background retry if it is busy and immovable.
fn refresh_operation_server_helper(data_root: &Path) {
    let result = crate::operation_server::refresh_helper_binary(data_root);
    let (level, line, retry) = describe_helper_refresh(&result, cfg!(windows));
    log_at(level, &line);
    if !retry {
        return;
    }
    let data_root = data_root.to_path_buf();
    thread::spawn(move || {
        match retry_helper_refresh(
            || crate::operation_server::refresh_helper_binary(&data_root),
            thread::sleep,
            HELPER_REFRESH_RETRY_INTERVAL,
            HELPER_REFRESH_RETRY_BUDGET,
        ) {
            HelperRetryOutcome::Refreshed { after } => log::info(&format!(
                "supervisor: refreshed operation-server helper after {}s, once it was free",
                after.as_secs()
            )),
            HelperRetryOutcome::Failed(e) => log::error(&format!(
                "supervisor: could not refresh operation-server helper (operation-server spawn will use stale binary or fail): {e}"
            )),
            HelperRetryOutcome::GaveUp => log::error(&format!(
                "supervisor: operation-server helper still in use after {}s; the next update or uninstall runs the previous build's helper until the launcher restarts",
                HELPER_REFRESH_RETRY_BUDGET.as_secs()
            )),
        }
    });
}

/// Main supervisor entry. Returns the final exit code alongside the tray-supervisor
/// stop_flag (Windows-only; `None` on non-Windows platforms). The caller should
/// signal the flag BEFORE reaping the tray so the poll thread cannot respawn
/// the tray between the signal and the `taskkill`.
pub fn run() -> Result<(i32, Option<Arc<AtomicBool>>)> {
    // Windows: tray-supervisor stop_flag threaded out so main.rs can signal it
    // BEFORE calling reap_tray_on_terminal_exit. Declared `mut` on Windows so
    // the cfg(windows) block below can assign the flag returned by
    // start_background; the initial None is immediately overwritten, hence the
    // allow. Non-Windows: immutable None (tray-supervisor does not run there).
    #[cfg_attr(windows, allow(unused_assignments))]
    #[cfg(windows)]
    let mut tray_stop_flag: Option<Arc<AtomicBool>> = None;
    #[cfg(not(windows))]
    let tray_stop_flag: Option<Arc<AtomicBool>> = None;

    let paths = Paths::from_env()?;
    log::info(&format!(
        "supervisor: install_root={:?} data_root={:?} deps_path={:?}",
        paths.install_root, paths.data_root, paths.deps_path
    ));

    // D14: as root (the system service), never run anything from a dependencies
    // tree another user can change. beta.145's install left one owned by the
    // desktop user; this removes it and the service provisions a fresh one.
    #[cfg(target_os = "linux")]
    crate::root_trust_guard::guard(&paths.deps_path);
    #[cfg(target_os = "linux")]
    crate::root_trust_guard::guard_opt_install();

    // Stale marker cleanup on startup. Prevents an old marker from a
    // previous crash from triggering an immediate respawn loop.
    cleanup_stale_marker(&paths.restart_marker);

    // CONSUME the update hand-off marker. UpdateService writes
    // control/apply-update-pending before the app exits to apply an update, so
    // that the OLD launcher's exit-time tray reap leaves the tray alone
    // (tray_supervisor::reap_tray_on_terminal_exit). In service mode the
    // post-stop bat deletes it afterwards; in LOCAL mode nothing did. MEASURED
    // 2026-09-09 (qa-harness Arc 3, beta.103 -> beta.114): the marker survived
    // the swap, and the updated app's next plain stop-exit left the tray
    // running while launcher and node exited -- "terminal exit with
    // update/uninstall handoff pending; leaving tray for relaunch" on an exit
    // that was no hand-off at all. That is the orphan the reap exists to
    // prevent, one update later, and on every graceful exit after it.
    //
    // By the time THIS launcher starts, every reader that needed the marker
    // has had it: the old launcher's reap ran at its exit, the operation
    // server chose its page when it was spawned, the bat (service mode) has
    // fired. So the launcher that comes up after the swap consumes it here,
    // beside the .restart cleanup. Harmless where another path already
    // removed it, and correct when an apply was aborted before the exit.
    cleanup_stale_marker(&apply_update_pending_marker(&paths.data_root));

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
            let stop_flag = crate::tray_supervisor::start_background(
                &paths.install_root,
                &paths.data_root,
                is_service_mode,
            );
            // Thread the stop_flag out so main.rs can signal it BEFORE
            // reap_tray_on_terminal_exit, preventing the poll thread from
            // respawning the tray between the signal and the taskkill.
            tray_stop_flag = Some(stop_flag);
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
        //
        // Item 173: after an update the previous operation-server is still
        // running from the helper here. On Windows it is moved aside and the
        // new build copied in its place, so the helper matches `current/`
        // BEFORE Node is spawned below -- and Node (UpdateService,
        // ServiceApi) or the post-stop bat it arms are the only things that
        // spawn the helper. So the next update or uninstall never runs the
        // previous build's helper, and a change to the apply-update-verify
        // manifest Node writes cannot meet an older helper that cannot read
        // it. (Only if the move-aside ALSO fails does a stale helper remain,
        // for the bounded retry's window; an older helper given a manifest it
        // cannot parse refuses to extract -- `read_apply_verify_manifest`
        // fails closed -- so even then the update fails safely, not
        // half-applied.)
        refresh_operation_server_helper(&paths.data_root);

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
            crate::operation_server::wait_for_port_free(port, std::time::Duration::from_secs(5));
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

    // Item 63 — the Linux tray is a thread in THIS process (Windows spawns a
    // helper above, in the cfg(windows) block). It shares `stop` with the
    // Ctrl+C handler: a confirmed exit from the tray menu is a stop request,
    // and wait_with_signal turns that into SIGTERM → graceful teardown.
    #[cfg(target_os = "linux")]
    crate::linux_tray::spawn_if_eligible(&paths.data_root, stop.clone());

    // spawn_server now passes deps_path directly to resolve_node_with, which
    // tries <deps_path>/node/<node-binary> first and falls back to seed/node/<node-binary>
    // when deps node is absent (first-run bootstrap). DEPS_PATH is also set on
    // the Node CHILD's env so the backend DependencyManager knows where to
    // install Node / ADB / scrcpy-server.
    log::info(&format!(
        "supervisor: deps_path resolved to {:?} (passed to Node child)",
        paths.deps_path
    ));

    // D1: only the FIRST Node spawn of this fresh launch should tell Node to open
    // a browser tab (WS_SCRCPY_OPEN_BROWSER, both platforms). Subsequent loop
    // iterations are restarts (webPort change, crash) — the user already has a
    // tab, so they must NOT re-pop one.
    let mut first_spawn = true;
    // Item 163: the installed service (systemd unit or servy, both of which set
    // WS_SCRCPY_SERVICE=1) leaves crash restarts to its service manager.
    let running_as_service = matches!(std::env::var("WS_SCRCPY_SERVICE").as_deref(), Ok("1"));
    let mut crash_restarts: u32 = 0;
    loop {
        cleanup_old_node(&paths.old_node);

        let mut child = spawn::spawn_server(&paths.deps_path, &paths.data_root, first_spawn)?;
        first_spawn = false;
        let started = std::time::Instant::now();
        log::info(&format!("supervisor: server started (pid {})", child.id()));

        let status = wait_with_signal(&mut child, &stop)?;
        let uptime = started.elapsed();
        let code = status.code().unwrap_or(1);
        log::info(&format!("supervisor: server exited with code {code}"));

        if stop.load(Ordering::SeqCst) {
            log::info("supervisor: shutdown signal received; not restarting");
            return Ok((code, tray_stop_flag.clone()));
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
                let launcher_path = paths
                    .install_root
                    .join("current")
                    .join("ws-scrcpy-web-launcher.exe");
                let log_dir = paths.data_root.join("logs");

                let bat_path = paths.data_root.join("control").join("uninstall-now.bat");
                let task_name = "WsScrcpyWebUninstall";
                // Defense in depth (#13): refuse to write the elevated uninstall bat
                // if any interpolated path carries a batch metacharacter.
                if let Err(e) = crate::elevated_runner::assert_safe_bat_token(
                    &log_dir.to_string_lossy(),
                    "log_dir",
                )
                .and_then(|()| {
                    crate::elevated_runner::assert_safe_bat_token(
                        &servy_path.to_string_lossy(),
                        "servy_path",
                    )
                })
                .and_then(|()| {
                    crate::elevated_runner::assert_safe_bat_token(
                        &launcher_path.to_string_lossy(),
                        "launcher_path",
                    )
                }) {
                    log::error(&format!("supervisor: refusing to write uninstall bat: {e}"));
                    return Ok((code, tray_stop_flag.clone()));
                }
                let bat_content = format!(
                    "@echo off\r\n\
                     echo %date% %time% [uninstall-now] starting >> \"{log}\\uninstall-now.log\"\r\n\
                     \"{servy}\" stop --name WsScrcpyWeb -q\r\n\
                     echo %date% %time% [uninstall-now] stop exit=%errorlevel% >> \"{log}\\uninstall-now.log\"\r\n\
                     \"{servy}\" uninstall --name WsScrcpyWeb -q\r\n\
                     echo %date% %time% [uninstall-now] uninstall exit=%errorlevel% >> \"{log}\\uninstall-now.log\"\r\n\
                     \"{launcher}\" --spawn-user-launcher --launcher-path \"{launcher}\"\r\n\
                     echo %date% %time% [uninstall-now] spawn-user-launcher exit=%errorlevel% >> \"{log}\\uninstall-now.log\"\r\n\
                     schtasks /delete /tn \"{task}\" /f >nul 2>&1\r\n\
                     del \"%~f0\"\r\n",
                    log = log_dir.display(),
                    servy = servy_path.display(),
                    launcher = launcher_path.display(),
                    task = task_name,
                );

                if let Err(e) = std::fs::write(&bat_path, &bat_content) {
                    log::error(&format!(
                        "supervisor: failed to write uninstall bat at {bat_path:?}: {e}; exiting (post-stop.bat is fallback)"
                    ));
                    return Ok((code, tray_stop_flag.clone()));
                }
                log::info(&format!("supervisor: wrote uninstall bat at {bat_path:?}"));

                let bat_str = bat_path.to_str().unwrap_or("uninstall-now.bat");
                let schtasks = "C:\\Windows\\System32\\schtasks.exe";

                let create_result = std::process::Command::new(schtasks)
                    .args([
                        "/create",
                        "/tn",
                        task_name,
                        "/tr",
                        &format!("C:\\Windows\\System32\\cmd.exe /c \"{bat_str}\""),
                        "/sc",
                        "once",
                        "/st",
                        "00:00",
                        "/rl",
                        "highest",
                        "/ru",
                        "SYSTEM",
                        "/f",
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();

                match create_result {
                    Ok(s) if s.success() => {
                        log::info("supervisor: created scheduled task for uninstall");
                    }
                    Ok(s) => {
                        log::error(&format!(
                            "supervisor: schtasks /create failed (exit {:?}); exiting (post-stop.bat is fallback)",
                            s.code()
                        ));
                        return Ok((code, tray_stop_flag.clone()));
                    }
                    Err(e) => {
                        log::error(&format!(
                            "supervisor: schtasks spawn failed: {e}; exiting (post-stop.bat is fallback)"
                        ));
                        return Ok((code, tray_stop_flag.clone()));
                    }
                }

                let run_result = std::process::Command::new(schtasks)
                    .args(["/run", "/tn", task_name])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();

                match run_result {
                    Ok(s) if s.success() => {
                        log::info(
                            "supervisor: triggered scheduled task; blocking until stop signal",
                        );
                    }
                    Ok(s) => {
                        log::error(&format!(
                            "supervisor: schtasks /run failed (exit {:?}); exiting (post-stop.bat is fallback)",
                            s.code()
                        ));
                        return Ok((code, tray_stop_flag.clone()));
                    }
                    Err(e) => {
                        log::error(&format!(
                            "supervisor: schtasks /run spawn failed: {e}; exiting (post-stop.bat is fallback)"
                        ));
                        return Ok((code, tray_stop_flag.clone()));
                    }
                }

                loop {
                    if stop.load(Ordering::SeqCst) {
                        log::info(
                            "supervisor: stop signal received during uninstall; exiting cleanly",
                        );
                        return Ok((0, tray_stop_flag.clone()));
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            }
        }

        let marker_exists = paths.restart_marker.exists();
        let reason = decide_restart(code, marker_exists);

        match reason {
            None => match decide_crash_restart(code, running_as_service, crash_restarts, uptime) {
                CrashDecision::CleanExit => {
                    log::info("supervisor: clean exit; not restarting");
                    return Ok((code, tray_stop_flag.clone()));
                }
                CrashDecision::LeaveToServiceManager => {
                    log::info(
                        "supervisor: running as the service; leaving the restart to the service manager",
                    );
                    return Ok((code, tray_stop_flag.clone()));
                }
                CrashDecision::GiveUp => {
                    log::error(&format!("supervisor: {CRASH_GIVE_UP_LINE}"));
                    return Ok((code, tray_stop_flag.clone()));
                }
                CrashDecision::Restart { attempt } => {
                    crash_restarts = attempt;
                    log::warn(&format!(
                        "supervisor: server crashed after {}s up; restarting (attempt {attempt} of {MAX_CRASH_RESTARTS})",
                        uptime.as_secs()
                    ));
                }
            },
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
            Err(e) => log::error(&format!(
                "supervisor: could not remove stale marker {marker:?}: {e}"
            )),
        }
    }
}

/// `<data_root>/control/apply-update-pending` -- the update hand-off marker.
/// ONE definition on the launcher side: the exit-time tray reap reads it
/// (tray_supervisor.rs), the operation server reads it to pick its page
/// (operation_server.rs), the service-mode post-stop bat deletes it
/// (elevated_runner.rs), and the launcher that comes up after the swap
/// consumes it at startup (`run`, above). Node's twin is
/// `Config.applyUpdatePendingMarkerPath`.
pub(crate) fn apply_update_pending_marker(data_root: &Path) -> std::path::PathBuf {
    data_root.join("control").join("apply-update-pending")
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

/// Wait for child to exit, polling for the stop flag at POLL_INTERVAL.
///
/// On stop: Linux sends SIGTERM first — Node's `process.on('SIGTERM')` runs the
/// same graceful teardown the Settings "stop server & exit" button does — and
/// only kills after `GRACEFUL_STOP_TIMEOUT`. Windows has no SIGTERM
/// (`kill()` is TerminateProcess either way), so it keeps the immediate kill.
/// The Linux tray's exit and Ctrl+C both arrive here through `stop`.
fn wait_with_signal(
    child: &mut std::process::Child,
    stop: &Arc<AtomicBool>,
) -> Result<std::process::ExitStatus> {
    loop {
        if stop.load(Ordering::SeqCst) {
            #[cfg(target_os = "linux")]
            {
                log::info(&format!(
                    "supervisor: stop requested; sending SIGTERM to child pid {} for a graceful exit",
                    child.id()
                ));
                let pid = rustix::process::Pid::from_child(child);
                if let Err(e) = rustix::process::kill_process(pid, rustix::process::Signal::TERM) {
                    log::error(&format!(
                        "supervisor: SIGTERM to child failed ({e}); killing instead"
                    ));
                } else {
                    let started = std::time::Instant::now();
                    loop {
                        if let Some(status) = child.try_wait()? {
                            log::info("supervisor: child exited on SIGTERM");
                            return Ok(status);
                        }
                        if graceful_wait_exhausted(started.elapsed()) {
                            log::error(&format!(
                                "supervisor: child ignored SIGTERM for {}s; killing",
                                GRACEFUL_STOP_TIMEOUT.as_secs()
                            ));
                            break;
                        }
                        thread::sleep(POLL_INTERVAL);
                    }
                }
            }
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
    fn graceful_wait_is_exhausted_exactly_at_the_timeout() {
        assert!(!graceful_wait_exhausted(Duration::from_secs(0)));
        assert!(!graceful_wait_exhausted(
            GRACEFUL_STOP_TIMEOUT - Duration::from_millis(1)
        ));
        assert!(graceful_wait_exhausted(GRACEFUL_STOP_TIMEOUT));
        assert!(graceful_wait_exhausted(
            GRACEFUL_STOP_TIMEOUT + Duration::from_secs(1)
        ));
    }

    #[test]
    fn graceful_timeout_is_ten_seconds() {
        // Long enough for adb kill-server + the SQLite backup on a slow disk,
        // short enough that a wedged Node does not hold a Ctrl+C for long.
        assert_eq!(GRACEFUL_STOP_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn apply_update_pending_marker_is_under_control() {
        assert_eq!(
            apply_update_pending_marker(Path::new("D")),
            std::path::PathBuf::from("D")
                .join("control")
                .join("apply-update-pending")
        );
    }

    #[test]
    fn startup_consumes_a_left_over_apply_update_marker() {
        // The launcher that comes up after a swap must not leave the hand-off
        // marker for its own exit-time reap to misread (qa-harness Arc 3,
        // 2026-09-09: the updated app's next stop-exit orphaned the tray).
        let dir = tempfile::tempdir().unwrap();
        let marker = apply_update_pending_marker(dir.path());
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, b"").unwrap();
        assert!(marker.exists());
        cleanup_stale_marker(&marker);
        assert!(
            !marker.exists(),
            "the marker must not outlive the launcher that comes up after the swap"
        );
        // Idempotent: a second call on an absent marker is a no-op, not an error.
        cleanup_stale_marker(&marker);
        assert!(!marker.exists());
    }

    // Item 163 / smoke row 12.11 — the local-mode crash-restart limit.
    const SHORT: Duration = Duration::from_secs(5);

    #[test]
    fn crash_restart_clean_exit_is_not_a_crash() {
        assert_eq!(
            decide_crash_restart(0, false, 0, SHORT),
            CrashDecision::CleanExit
        );
    }

    #[test]
    fn crash_restart_service_mode_leaves_it_to_the_service_manager() {
        // systemd Restart=on-failure and servy recovery own the service paths;
        // a restart here would hide the failure from them.
        assert_eq!(
            decide_crash_restart(1, true, 0, SHORT),
            CrashDecision::LeaveToServiceManager
        );
        assert_eq!(
            decide_crash_restart(0, true, 0, SHORT),
            CrashDecision::CleanExit
        );
    }

    #[test]
    fn crash_restart_restarts_three_times_then_gives_up() {
        assert_eq!(
            decide_crash_restart(1, false, 0, SHORT),
            CrashDecision::Restart { attempt: 1 }
        );
        assert_eq!(
            decide_crash_restart(1, false, 1, SHORT),
            CrashDecision::Restart { attempt: 2 }
        );
        assert_eq!(
            decide_crash_restart(1, false, 2, SHORT),
            CrashDecision::Restart { attempt: 3 }
        );
        assert_eq!(
            decide_crash_restart(1, false, 3, SHORT),
            CrashDecision::GiveUp
        );
    }

    #[test]
    fn crash_restart_count_resets_after_sixty_seconds_up() {
        assert_eq!(
            decide_crash_restart(1, false, 3, Duration::from_secs(60)),
            CrashDecision::Restart { attempt: 1 }
        );
        assert_eq!(
            decide_crash_restart(1, false, 3, Duration::from_secs(59)),
            CrashDecision::GiveUp
        );
    }

    #[test]
    fn crash_restart_limits_are_the_decided_ones() {
        assert_eq!(MAX_CRASH_RESTARTS, 3);
        assert_eq!(CRASH_COUNT_RESET_UPTIME, Duration::from_secs(60));
        assert_eq!(
            CRASH_GIVE_UP_LINE,
            "3 restart attempts, won't retry, review error logging"
        );
    }

    #[test]
    fn decide_restart_marker_takes_precedence_over_exit_75() {
        // If both signals are present, marker wins (matches start.cmd's
        // ordering — marker checked before exit code).
        assert_eq!(decide_restart(75, true), Some(RestartReason::RestartMarker));
    }

    // ---- Item 173: the startup helper refresh ----

    use crate::operation_server::HelperRefresh;

    fn os_err(code: i32) -> std::io::Result<HelperRefresh> {
        Err(std::io::Error::from_raw_os_error(code))
    }

    /// The busy code of the platform these tests run on.
    fn host_busy() -> i32 {
        if cfg!(windows) { 32 } else { 26 }
    }

    #[test]
    fn helper_refresh_that_moved_a_running_copy_aside_is_info_not_error() {
        // The 2026-10-08 report: every Windows upgrade-path install logged
        // ERROR here for the routine after-update case.
        let (level, line, retry) = describe_helper_refresh(
            &Ok(HelperRefresh::MovedAside {
                path: "h.exe".into(),
                aside: "h.exe.stale-1".into(),
            }),
            true,
        );
        assert_eq!(level, LogLevel::Info);
        assert!(line.contains("moved to"), "{line}");
        assert!(!retry);
        let (level, _, retry) =
            describe_helper_refresh(&Ok(HelperRefresh::Copied("h.exe".into())), true);
        assert_eq!((level, retry), (LogLevel::Info, false));
    }

    #[test]
    fn windows_sharing_violation_is_expected_busy_and_retried() {
        let (level, line, retry) = describe_helper_refresh(&os_err(32), true);
        assert_eq!(level, LogLevel::Warn);
        assert!(retry, "the helper must end up matching current/");
        assert!(line.contains("retrying"), "{line}");
    }

    #[test]
    fn linux_etxtbsy_stays_warn_without_a_retry() {
        // Service start on Linux: the helper IS the running launcher.
        let (level, line, retry) = describe_helper_refresh(&os_err(26), false);
        assert_eq!(level, LogLevel::Warn);
        assert!(line.contains("text file busy"), "{line}");
        assert!(!retry);
    }

    #[test]
    fn the_other_platforms_busy_code_and_real_failures_stay_error() {
        // 26 on Windows and 32 (EPIPE) on Linux are not "busy"; access denied
        // (5 / 13), not found (2) and a non-OS error are genuine failures.
        for (code, windows) in [
            (26, true),
            (32, false),
            (5, true),
            (13, false),
            (2, true),
            (2, false),
        ] {
            let (level, _, retry) = describe_helper_refresh(&os_err(code), windows);
            assert_eq!(
                (level, retry),
                (LogLevel::Error, false),
                "code {code} windows={windows}"
            );
        }
        let (level, _, _) = describe_helper_refresh(&Err(std::io::Error::other("synthetic")), true);
        assert_eq!(level, LogLevel::Error);
    }

    #[test]
    fn retry_refreshes_once_the_old_helper_has_exited() {
        // Busy for three attempts (the old operation-server's remaining
        // lifetime), then free.
        let mut attempts = 0;
        let mut slept = Duration::ZERO;
        let outcome = retry_helper_refresh(
            || {
                attempts += 1;
                if attempts <= 3 {
                    os_err(host_busy())
                } else {
                    Ok(HelperRefresh::Copied("h.exe".into()))
                }
            },
            |d| slept += d,
            HELPER_REFRESH_RETRY_INTERVAL,
            HELPER_REFRESH_RETRY_BUDGET,
        );
        assert_eq!(
            outcome,
            HelperRetryOutcome::Refreshed {
                after: HELPER_REFRESH_RETRY_INTERVAL * 4
            }
        );
        assert_eq!(attempts, 4);
        assert_eq!(slept, HELPER_REFRESH_RETRY_INTERVAL * 4);
    }

    #[test]
    fn retry_gives_up_when_the_budget_runs_out() {
        let mut attempts = 0u32;
        let outcome = retry_helper_refresh(
            || {
                attempts += 1;
                os_err(host_busy())
            },
            |_| {},
            HELPER_REFRESH_RETRY_INTERVAL,
            HELPER_REFRESH_RETRY_BUDGET,
        );
        assert_eq!(outcome, HelperRetryOutcome::GaveUp);
        assert_eq!(
            attempts,
            (HELPER_REFRESH_RETRY_BUDGET.as_secs() / HELPER_REFRESH_RETRY_INTERVAL.as_secs())
                as u32
        );
    }

    #[test]
    fn retry_stops_at_a_genuine_error() {
        let mut attempts = 0;
        let outcome = retry_helper_refresh(
            || {
                attempts += 1;
                if attempts == 1 {
                    os_err(host_busy())
                } else {
                    os_err(5)
                }
            },
            |_| {},
            HELPER_REFRESH_RETRY_INTERVAL,
            HELPER_REFRESH_RETRY_BUDGET,
        );
        assert!(
            matches!(outcome, HelperRetryOutcome::Failed(_)),
            "{outcome:?}"
        );
        assert_eq!(attempts, 2);
    }

    #[test]
    fn retry_budget_outlasts_an_old_operation_server() {
        // 10 s bind retry + 30 s lifetime + 15 s wind-down = 55 s.
        assert!(HELPER_REFRESH_RETRY_BUDGET >= Duration::from_secs(55));
    }
}
