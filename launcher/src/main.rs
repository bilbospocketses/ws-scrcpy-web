#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod elevated_runner;
mod hooks;
#[cfg(windows)]
mod install_acl;
#[cfg(windows)]
mod job_object;
mod log;
mod paths;
mod single_instance;
mod spawn;
mod supervisor;
// §32 Part 5h — local-mode tray is no longer a thread inside the launcher;
// the tray-supervisor (mod below) now spawns the standalone
// ws-scrcpy-web-tray.exe in BOTH modes. `mod tray;` was deleted; the in-
// process thread variant in tray.rs is gone.
mod tray_supervisor;
mod uac_requester;
mod unzip_handler;
mod operation_server;
#[cfg(target_os = "linux")]
mod linux_apply;
#[cfg(target_os = "linux")]
mod linux_service;
#[cfg(windows)]
mod user_session_spawn;

fn main() {
    // --print-active-session: one-shot Win32 query. Used by the service-Node
    // (running as LocalSystem) to discover the user's interactive session
    // before writing a control marker. Must fire BEFORE any logging or
    // supervisor init — it's a pure stdout query that exits immediately.
    // (Checked first so service polls don't generate launcher-start log noise.)
    //
    // Uses `common::session::active_interactive_session()` which walks
    // `WTSEnumerateSessionsW` for an active session with a non-empty
    // username, falling back to `WTSGetActiveConsoleSessionId` only when
    // enumeration finds nothing. Pre-2026-05-22 this handler called
    // `WTSGetActiveConsoleSessionId` directly — that returned stale
    // "physical console" session IDs on VM / RDP / Hyper-V Enhanced Session,
    // mismatched the tray's session check, and silently broke the uninstall
    // handoff every time. See todo §33 Bug B.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--print-active-session") {
        if let Some(id) = common::session::active_interactive_session() {
            println!("{}", id);
        }
        // No active interactive session resolvable (None): print nothing.
        // Node-side `active-session.ts` treats non-numeric stdout as
        // `ok: false` and writes the marker WITHOUT a session filter
        // ("marker accepts any tray helper") — the safest fallback.
        std::process::exit(0);
    }

    log::info(&format!(
        "ws-scrcpy-web-launcher v{} starting",
        env!("CARGO_PKG_VERSION")
    ));

    // Diagnostic: log the full argv on every launcher start. v0.1.22 ship
    // surfaced an in-app updater spawn-loop where Update.exe respawned the
    // launcher every ~13 s, each spawn exiting silently before reaching any
    // logged branch — likely VelopackApp::build().run() consuming an unknown
    // --veloapp-* flag and exiting. Without seeing the exact argv we can't
    // know which flag to handle. Cheap to keep around long-term.
    log::info(&format!("argv: {:?}", args));

    // Request-UAC dispatch (§30, replaces the prior PowerShell
    // Start-Process -Verb RunAs path that the Node server used to fire
    // the UAC prompt). When invoked, this launcher process ShellExecuteEx's
    // ITSELF with --elevate-and-run + verb=runas, returns exit 0 on UAC
    // accept / 1223 on decline / 3 on other failure. Same exit-code
    // contract Node was reading off PowerShell pre-§30, so the surrounding
    // result-file polling stays unchanged.
    if let Some(code) = uac_requester::handle(&args) {
        log::info(&format!("request-uac exiting with code {code}"));
        std::process::exit(code);
    }

    // Unzip dispatch — replaces the Node side's PowerShell Expand-Archive +
    // linux `unzip` shellouts in DependencyManager.installNodejs /
    // installAdb. Same Local-Dependencies-Only rationale as the §30
    // PowerShell scrub: keep all platform-specific binary work inside
    // the SHA-pinned launcher instead of resolving via system PATH.
    if let Some(code) = unzip_handler::handle(&args) {
        log::info(&format!("unzip exiting with code {code}"));
        std::process::exit(code);
    }

    // Linux in-app update apply helper (spawned by the Node server in dataRoot,
    // outside the AppImage mount). Swaps $APPIMAGE + relaunches. Linux-only.
    #[cfg(target_os = "linux")]
    if let Some(code) = linux_apply::handle(&args) {
        log::info(&format!("linux-apply exiting with code {code}"));
        std::process::exit(code);
    }

    #[cfg(target_os = "linux")]
    if let Some(code) = linux_service::handle(&args) {
        log::info(&format!("linux-service-teardown exiting with code {code}"));
        std::process::exit(code);
    }

    // Service-defer: if an ACTIVE system-scope service owns the app, open the
    // browser at its URL and exit instead of spawning a duplicate local server.
    #[cfg(target_os = "linux")]
    {
        let cfg = common::config::AppConfig::load(std::path::Path::new("/var/opt/ws-scrcpy-web"));
        if let (Some(mode), Some(port)) = (cfg.install_mode.as_deref(), cfg.web_port) {
            let live = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                std::time::Duration::from_millis(200),
            ).is_ok();
            if let Some(url) = linux_service::service_defer_url(Some(mode), Some(port), live) {
                log::info(&format!("service-defer: active system service; opening {url}"));
                let xdg = format!("{}/xdg-open", linux_service::tool_dir("xdg-open"));
                let _ = std::process::Command::new(&xdg).arg(&url).status();
                std::process::exit(0);
            }
        }
    }

    // Bootstrapper: if the shared machine-wide /opt binary exists and we are a
    // home AppImage (not /opt itself), re-exec the /opt copy and exit. MUST run
    // before single_instance::acquire so the /opt child — not this wrapper — owns
    // the per-user lock.
    //
    // Version-aware (Phase 3): reads /opt/ws-scrcpy-web/VERSION; if the home
    // AppImage is NEWER than /opt, runs in-place and sets
    // WS_SCRCPY_OPT_UPDATE_AVAILABLE=1 so the frontend can offer an /opt upgrade.
    #[cfg(target_os = "linux")]
    {
        let opt = std::path::Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
        let appimage = std::env::var("APPIMAGE").ok();
        let opt_version = std::fs::read_to_string("/opt/ws-scrcpy-web/VERSION")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let action = linux_service::bootstrap_decision(
            opt.exists(),
            appimage.as_deref(),
            env!("CARGO_PKG_VERSION"),
            opt_version.as_deref(),
        );
        match action {
            linux_service::BootstrapAction::ExecOpt(target) => {
                log::info(&format!("bootstrap: exec'ing machine-wide /opt binary {target:?}"));
                let status = std::process::Command::new(&target).status();
                let code = status.ok().and_then(|s| s.code()).unwrap_or(0);
                std::process::exit(code);
            }
            linux_service::BootstrapAction::RunHomeOfferUpdate => {
                log::info("bootstrap: home AppImage is newer than /opt; running in-place, flagging update offer");
                std::env::set_var("WS_SCRCPY_OPT_UPDATE_AVAILABLE", "1");
                // fall through to normal launch
            }
            linux_service::BootstrapAction::RunHome => {
                // no /opt, or we ARE /opt, or no $APPIMAGE — launch in place
            }
        }
    }

    // Cross-session user-launcher spawn dispatch. Invoked from post-stop.bat
    // after `servy-cli uninstall` completes, to drop a fresh user-session
    // launcher so the user lands on local-mode UI post-uninstall. Wraps
    // user_session_spawn::spawn_in_active_user_session. See spec
    // docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md.
    #[cfg(windows)]
    if let Some(code) = user_session_spawn::spawn_user_launcher_handle(&args) {
        log::info(&format!("spawn-user-launcher exiting with code {code}"));
        std::process::exit(code);
    }

    // §32 Part 5 — upgrade-server dispatch. Post-stop bat spawns this
    // subcommand AFTER Node exits but BEFORE sc start, so the port stays
    // covered by SOMETHING during the upgrade window. Serves a static
    // "updating, please wait…" HTML page. Self-exits on stop marker
    // (written by the new supervised launcher before spawning Node) or
    // 30s safety cap. Replaces the in-browser ServerReachabilityOverlay
    // approach with a fully server-side mechanism per user request.
    if let Some(code) = operation_server::handle(&args) {
        log::info(&format!("operation-server exiting with code {code}"));
        std::process::exit(code);
    }

    // §32 Part 4 — post-stop dispatch removed. The post-stop handler is
    // now a cmd.exe-invoked bat file at <dataRoot>/post-stop/post-stop.bat
    // (written by elevated_runner::install_service). cmd.exe lives in
    // C:\Windows\System32\ (OS-stable); the bat is in dataRoot
    // (Velopack-untouchable). Part 3's launcher-as-post-stop approach
    // got the launcher process killed mid-sleep when Velopack swapped
    // current/. The new architecture has no in-launcher post-stop code.

    // Elevate-and-run dispatch comes BEFORE Velopack hooks because the
    // helper is invoked through a UAC prompt and is a single-shot
    // operation — no need to bring up the supervisor, no need to register
    // Velopack hooks (this process started elevated solely to do the
    // service install/uninstall and exit).
    if let Some(code) = elevated_runner::handle(&args) {
        log::info(&format!("elevate-and-run exiting with code {code}"));
        std::process::exit(code);
    }

    // Velopack lifecycle-arg dispatch must happen BEFORE
    // VelopackApp::build().run(). The Rust velopack crate (0.0.x) does NOT
    // expose fast-callback builder methods (those are C# only), so we parse
    // the flags ourselves and exit synchronously per Contract 4.
    if let Some(code) = hooks::handle_velopack_hook(&args) {
        log::info(&format!("hook handler exiting with code {code}"));
        std::process::exit(code);
    }

    // v0.1.23-beta.7: ensure the install root has Authenticated Users:Modify
    // so Velopack's writability self-test passes and the in-app updater can
    // swap `current\` without falling back to LocalAppData + elevated
    // Update.exe (which silently dies during the swap on Windows). The
    // grant attempted during the `--veloapp-install` hook gets stripped by
    // MSI's component-permission step, so we apply it from the running
    // launcher's first non-hook startup. ShellExecuteEx with verb=runas
    // fires a one-time UAC prompt; subsequent launches find the install
    // root writable and skip the elevation entirely.
    //
    // Failure (UAC dismissed, no admin available, etc.) is logged and
    // swallowed — the app itself works without this grant; only the
    // in-app updater is degraded. User can manually re-grant via
    // `icacls "C:\Program Files\WsScrcpyWeb" /grant *S-1-5-11:(OI)(CI)M /T /C /Q`
    // or just relaunch the app to retry.
    #[cfg(windows)]
    {
        match resolve_install_root() {
            Ok(install_root) => {
                if let Err(e) = install_acl::ensure_writable(&install_root) {
                    log::error(&format!(
                        "install-root ACL grant failed; in-app updater will be degraded: {e:#}"
                    ));
                }
            }
            Err(e) => {
                log::error(&format!(
                    "could not resolve install_root for ACL check: {e:#}"
                ));
            }
        }
    }

    // Single-instance guard. Runs AFTER hook + elevate-and-run dispatch
    // (those are short-lived single-shot operations that can legitimately
    // run alongside the main launcher). Acquired BEFORE Velopack init,
    // tray spawn, supervisor — any side effect of "we are running."
    //
    // Failure modes:
    //   - Mutex acquire failed unexpectedly: log + proceed without guard.
    //     This shouldn't normally happen and we'd rather have one extra
    //     instance than refuse to start.
    //   - Mutex already held: another instance is running; exit 0.
    let mutex_name = single_instance::current_mutex_name();
    let _instance_guard = match single_instance::acquire(&mutex_name) {
        Ok(Some(guard)) => Some(guard),
        Ok(None) => {
            log::info("another ws-scrcpy-web-launcher instance is already running; exiting");
            std::process::exit(0);
        }
        Err(e) => {
            log::error(&format!(
                "could not acquire single-instance mutex (proceeding without guard): {e:#}"
            ));
            None
        }
    };

    // Per SP3 P2 Contract 5: VelopackApp::build().run() MUST be the first
    // executable code path on the normal-launch branch. May terminate or
    // restart the process.
    //
    // v0.1.23-beta.11: explicitly disable auto-apply-on-startup on the Rust
    // SDK side. This is the parallel fix to v0.1.23-beta.3's Node-side
    // `setAutoApplyOnStartup(false)` (`src/server/index.ts`); we'd disabled
    // it on the JS layer but missed that the Rust `VelopackApp` (velopack
    // crate 0.0.1298, src/app.rs:147–162) defaults `auto_apply: true` and
    // does the EXACT same thing — checks `manager.get_update_pending_restart()`
    // for any downloaded package with version > current, and auto-fires
    // `apply_updates_and_restart_with_args`. After a successful apply, the
    // .nupkg stays in `<installRoot>\packages\` so this re-fired Update.exe
    // every time the launcher booted post-update — visible to the user as
    // "Update.exe runs the update, closes, then launches and runs the
    // update again" loop on beta.9 → beta.10 VM testing 2026-04-29.
    //
    // Apply must fire ONLY on explicit user click via `UpdateService.applyUpdate`
    // — same rationale as Gotcha 1 in feedback_velopack_permachine_lessons.md.
    // The defense is needed on BOTH SDKs because BOTH evaluate the same
    // pending-package check, independently.
    velopack::VelopackApp::build().set_auto_apply_on_startup(false).run();

    // Spawn the tray icon thread BEFORE the supervisor's blocking loop.
    // In service mode this is a no-op (separate tray helper handles UI).
    // We deliberately use the lenient `load` here: a missing/malformed
    // config.json should never block startup over a tray decision.
    //
    // Phase 1: load from <dataRoot> (PROGRAMDATA-rooted on Windows). Falls
    // back to the install_root walk on non-Windows or if data_root_from_env
    // returns None for any reason — preserves the pre-Phase-1 behavior in
    // those cases.
    let install_root = match resolve_install_root() {
        Ok(p) => Some(p),
        Err(e) => {
            log::error(&format!("could not resolve install root: {e}"));
            None
        }
    };
    let data_root = common::config::data_root_from_env();

    // §32 Part 5h — tray spawn (BOTH local and service mode) is now owned
    // by `supervisor::run` -> `tray_supervisor::start_background`. The
    // previous in-process thread tray (tray.rs::spawn) for local mode is
    // retired; both modes converge on the standalone
    // `ws-scrcpy-web-tray.exe` process so the local-mode tray survives
    // launcher crashes / restarts / post-uninstall handoffs the way
    // service mode already did. The `--local-takeover` override that
    // forced local-mode tray spawn (per v0.1.23 §1c bug 1.c) is now read
    // inside supervisor.rs where the tray-supervisor mode decision is
    // made.
    // (Pre-Part-5h this block computed is_service_mode + applied the
    // --local-takeover override, then passed the flag to tray::spawn.
    // tray::spawn is gone; the install_root / data_root resolutions above
    // are still used elsewhere in this function below if needed.)
    let _ = data_root; // keep the load above visible to the compiler; supervisor reads its own env probe
    let _ = install_root;

    let exit_code = match supervisor::run() {
        Ok(code) => code,
        Err(e) => {
            log::error(&format!("launcher failed: {e:#}"));
            1
        }
    };

    // v0.1.23-beta.9: clear KILL_ON_JOB_CLOSE before our last handle to the
    // job closes. This is the graceful-exit path; hard kills (Servy stop,
    // Task Manager) bypass us and KILL_ON_JOB_CLOSE still cleans up via the
    // kernel. Letting the job dissolve quietly here lets Velopack's
    // Update.exe grandchild survive past launcher exit during in-app
    // updater apply, which previously cut off mid-extract because the job
    // tear-down TerminateProcess'd it. See job_object.rs module docs.
    #[cfg(windows)]
    match job_object::release() {
        Ok(true) => log::info("job_object: kill-on-close released; grandchildren may survive exit"),
        Ok(false) => log::info("job_object: no job to release (never adopted)"),
        Err(e) => log::error(&format!(
            "job_object: release failed (continuing exit anyway): {e:#}"
        )),
    }

    // §27 — reap the standalone tray helper on terminal exit. It is spawned
    // detached and NOT in the kill-on-close job object, so it survives launcher
    // exit on its own; without this a plain "stop server & exit" (or any clean
    // exit) leaves an orphaned tray pointing at a dead launcher. Marker-gated so
    // update-apply / uninstall handoffs (which relaunch) keep their tray.
    #[cfg(windows)]
    if let Some(dr) = common::config::data_root_from_env() {
        tray_supervisor::reap_tray_on_terminal_exit(&dr);
    }

    log::info(&format!("ws-scrcpy-web-launcher exiting with code {exit_code}"));
    std::process::exit(exit_code);
}

/// Local helper: derive install root from current_exe (matches
/// hooks::resolve_install_root's contract — exe lives in `<root>/current/`
/// in production; in dev builds it lives in `target/<profile>/`, in which
/// case the parent is still a valid argument to `AppConfig::load` even
/// though it won't have a config.json — `load` will just return defaults).
fn resolve_install_root() -> anyhow::Result<std::path::PathBuf> {
    use anyhow::Context;
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    let install_root = exe_dir
        .parent()
        .context("exe_dir has no parent (cannot derive install_root)")?;
    Ok(install_root.to_path_buf())
}
