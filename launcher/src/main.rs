#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod elevated_runner;
mod hooks;
mod log;
mod paths;
mod single_instance;
mod spawn;
mod supervisor;
mod tray;
#[cfg(windows)]
mod user_session_spawn;

fn main() {
    log::info(&format!(
        "ws-scrcpy-web-launcher v{} starting",
        env!("CARGO_PKG_VERSION")
    ));

    let args: Vec<String> = std::env::args().collect();

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
    velopack::VelopackApp::build().run();

    // Spawn the tray icon thread BEFORE the supervisor's blocking loop.
    // In service mode this is a no-op (separate tray helper handles UI).
    // We deliberately use the lenient `load` here: a missing/malformed
    // config.json should never block startup over a tray decision.
    //
    // Phase 1: load from <dataRoot> (PROGRAMDATA-rooted on Windows). Falls
    // back to the install_root walk on non-Windows or if data_root_from_env
    // returns None for any reason — preserves the pre-Phase-1 behavior in
    // those cases.
    let config_dir = match common::config::data_root_from_env() {
        Some(p) => Some(p),
        None => match resolve_install_root() {
            Ok(p) => Some(p),
            Err(e) => {
                log::error(&format!("could not resolve install root for tray: {e}"));
                None
            }
        },
    };
    let is_service_mode = config_dir
        .as_deref()
        .map(common::config::AppConfig::load)
        .map(|cfg| cfg.is_service_mode())
        .unwrap_or(false);
    let _tray_handle = tray::spawn(is_service_mode);

    let exit_code = match supervisor::run() {
        Ok(code) => code,
        Err(e) => {
            log::error(&format!("launcher failed: {e:#}"));
            1
        }
    };

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
