#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hooks;
mod log;
mod paths;
mod spawn;
mod supervisor;
mod tray;

fn main() {
    log::info(&format!(
        "ws-scrcpy-web-launcher v{} starting",
        env!("CARGO_PKG_VERSION")
    ));

    // Velopack lifecycle-arg dispatch must happen BEFORE
    // VelopackApp::build().run(). The Rust velopack crate (0.0.x) does NOT
    // expose fast-callback builder methods (those are C# only), so we parse
    // the flags ourselves and exit synchronously per Contract 4.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = hooks::handle_velopack_hook(&args) {
        log::info(&format!("hook handler exiting with code {code}"));
        std::process::exit(code);
    }

    // Per SP3 P2 Contract 5: VelopackApp::build().run() MUST be the first
    // executable code path on the normal-launch branch. May terminate or
    // restart the process.
    velopack::VelopackApp::build().run();

    // Spawn the tray icon thread BEFORE the supervisor's blocking loop.
    // In service mode this is a no-op (separate tray helper handles UI).
    // We deliberately use the lenient `load` here: a missing/malformed
    // config.json should never block startup over a tray decision.
    let install_root = match resolve_install_root() {
        Ok(p) => Some(p),
        Err(e) => {
            log::error(&format!("could not resolve install root for tray: {e}"));
            None
        }
    };
    let is_service_mode = install_root
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
