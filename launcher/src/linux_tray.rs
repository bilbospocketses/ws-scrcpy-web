//! The Linux tray, as a thread inside the launcher (todo item 63, decision 2).
//!
//! Windows needs a separate tray process and a supervisor because that
//! launcher runs as LocalSystem under Servy and the icon must live in the
//! user's session. On Linux the launcher already runs in the session for local
//! and user-scope service runs, so the icon simply lives and dies with the
//! instance: nothing to respawn. System scope has no session and stands down.
//!
//! Stand-down cases (decision 1 — silently, one info line):
//!   - `installMode` is `system-service`,
//!   - no session bus (`DBUS_SESSION_BUS_ADDRESS` unset AND no `$XDG_RUNTIME_DIR/bus`),
//!   - no StatusNotifier host on the bus (stock GNOME, Fedora Workstation) —
//!     detected by `common::tray::run`, which returns `Cancelled`.
//!
//! A confirmed exit flips the supervisor's `stop` flag; `wait_with_signal`
//! then SIGTERMs Node (graceful teardown) and the launcher exits.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use common::config::AppConfig;
use common::tray::TrayAction;
use common::tray_policy::{icon_argb_22, session_bus_present, should_spawn_tray, TrayLabels};

use crate::log;

/// `$XDG_RUNTIME_DIR/bus` — where systemd's user manager puts the session bus.
fn runtime_bus_socket() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR").map(|dir| PathBuf::from(dir).join("bus"))
}

/// A user-scope systemd unit can run without `DBUS_SESSION_BUS_ADDRESS` in its
/// environment while the bus socket is right there in the runtime dir. zbus
/// needs the variable, so export it from the socket when it is missing.
/// Returns whether a session bus is now reachable.
fn ensure_session_bus_env() -> bool {
    let addr = std::env::var("DBUS_SESSION_BUS_ADDRESS").ok();
    let socket = runtime_bus_socket();
    let socket_exists = socket.as_deref().is_some_and(Path::exists);
    if !session_bus_present(addr.as_deref(), socket_exists) {
        return false;
    }
    if addr.as_deref().is_none_or(|a| a.trim().is_empty()) {
        if let Some(sock) = socket {
            let value = format!("unix:path={}", sock.display());
            log::info(&format!("linux-tray: DBUS_SESSION_BUS_ADDRESS was unset; using {value}"));
            std::env::set_var("DBUS_SESSION_BUS_ADDRESS", value);
        }
    }
    true
}

/// Spawn the tray thread when this instance should have one. Never blocks;
/// never fails the caller.
pub fn spawn_if_eligible(data_root: &Path, stop: Arc<AtomicBool>) {
    let cfg = AppConfig::load(data_root);
    let bus = ensure_session_bus_env();
    if !should_spawn_tray(cfg.install_mode.as_deref(), bus) {
        log::info(&format!(
            "linux-tray: not spawning (installMode={:?}, session bus={bus}); Settings → Server stops the app",
            cfg.install_mode
        ));
        return;
    }
    let icon = match icon_argb_22() {
        Ok(bytes) => bytes,
        Err(e) => {
            log::error(&format!("linux-tray: {e}; not spawning"));
            return;
        }
    };
    let labels = TrayLabels::for_mode(cfg.is_service_mode());
    let data_root = data_root.to_path_buf();

    let spawned = std::thread::Builder::new().name("linux-tray".into()).spawn(move || {
        // Re-read config.json on every click: a web-port change or a mode swap
        // mid-session must open the port that is live NOW (same rule as the
        // Windows helper). The tray opens the browser ON this machine, so
        // localhost is the right host here.
        let provider: Box<dyn Fn() -> String> = Box::new(move || {
            let live = AppConfig::load(&data_root);
            format!("http://localhost:{}", live.web_port.unwrap_or(8000))
        });
        match common::tray::run(icon, labels.tooltip, labels.exit_title, labels.exit_action, provider, None) {
            Ok(TrayAction::ConfirmedExit) => {
                log::info("linux-tray: exit confirmed; asking the supervisor to stop Node");
                stop.store(true, Ordering::SeqCst);
            }
            Ok(TrayAction::Cancelled) => {
                // run() already logged why (no host / no bus / host gone).
            }
            Err(e) => log::error(&format!("linux-tray: {e}")),
        }
    });
    if let Err(e) = spawned {
        log::error(&format!("linux-tray: could not spawn the tray thread: {e}"));
    }
}
