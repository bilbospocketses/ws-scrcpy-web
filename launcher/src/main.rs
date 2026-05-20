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
mod tray;
mod uac_requester;
mod unzip_handler;
#[cfg(windows)]
mod user_session_spawn;

fn main() {
    // --print-active-session: one-shot Win32 query. Used by the service-Node
    // (running as LocalSystem) to discover the user's interactive session
    // before writing a control marker. Must fire BEFORE any logging or
    // supervisor init — it's a pure stdout query that exits immediately.
    // (Checked first so service polls don't generate launcher-start log noise.)
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--print-active-session") {
        #[cfg(windows)]
        {
            use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
            // SAFETY: WTSGetActiveConsoleSessionId has no preconditions and is
            // safe to call from any context. Returns 0xFFFFFFFF when no session
            // is attached to the physical console.
            let session = unsafe { WTSGetActiveConsoleSessionId() };
            println!("{}", session);
            std::process::exit(0);
        }
        #[cfg(not(windows))]
        {
            // Non-Windows: service-mode is Windows-only; we shouldn't be
            // invoked here, but exit cleanly anyway.
            println!("0");
            std::process::exit(0);
        }
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

    let config_dir = data_root.or(install_root);
    let mut is_service_mode = config_dir
        .as_deref()
        .map(common::config::AppConfig::load)
        .map(|cfg| cfg.is_service_mode())
        .unwrap_or(false);

    // v0.1.23 §1c bug 1.c: `--local-takeover` flag forces local-mode tray
    // spawn even when config.json still says installMode='user-service' /
    // 'system-service'. Set by ServiceApi.handoffUninstallToUserSession
    // when it spawns a user-session launcher to perform the uninstall —
    // at spawn time config still reflects the OUTGOING service mode (the
    // resume flow updates it post-uninstall). Without this hint, the
    // freshly spawned local launcher reads is_service_mode=true → skips
    // tray spawn → user is left with no tray after the service goes away.
    if args.iter().any(|a| a == "--local-takeover") && is_service_mode {
        log::info("--local-takeover override: forcing is_service_mode=false (post-uninstall handoff)");
        is_service_mode = false;
    }

    let _tray_handle = tray::spawn(is_service_mode);

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
