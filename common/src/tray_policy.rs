//! Pure, platform-independent tray decisions (todo item 63).
//!
//! Everything here is testable on every host: which instances get a tray, how
//! a session bus is detected, and the label set both trays share. The Linux
//! tray (`common::tray`, `launcher/src/linux_tray.rs`) consumes all of it; the
//! Windows tray helper (`tray/src/main.rs`) consumes `TrayLabels`.

/// `installMode` value of a system-scope service. It has no user session and
/// therefore no tray, whatever the environment says.
pub const SYSTEM_SERVICE_MODE: &str = "system-service";

/// Whether this launcher instance should show a tray icon at all.
///
/// Local runs (`installMode` absent or `"user"`) and user-scope services
/// (`"user-service"`) run inside the user's session and get one — provided a
/// session bus exists to register on. A system-scope service never does.
pub fn should_spawn_tray(install_mode: Option<&str>, session_bus_present: bool) -> bool {
    session_bus_present && install_mode != Some(SYSTEM_SERVICE_MODE)
}

/// Whether a D-Bus session bus is reachable: either `DBUS_SESSION_BUS_ADDRESS`
/// is set (non-blank), or `$XDG_RUNTIME_DIR/bus` exists (systemd's user
/// manager puts the bus there even when a unit's environment lacks the
/// variable — the caller then exports the address itself before spawning).
pub fn session_bus_present(dbus_session_bus_address: Option<&str>, runtime_bus_socket_exists: bool) -> bool {
    dbus_session_bus_address.is_some_and(|a| !a.trim().is_empty()) || runtime_bus_socket_exists
}

/// The text both trays show. Mode-aware because the service instance binds a
/// different port and the user should see which one they are quitting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrayLabels {
    /// Hover text on the icon.
    pub tooltip: &'static str,
    /// Windows confirm-dialog title.
    pub exit_title: &'static str,
    /// Windows confirm-dialog body.
    pub exit_body: &'static str,
    /// Linux `Exit…` submenu action — there is no dialog, the menu item IS the confirmation.
    pub exit_action: &'static str,
    /// Windows startup balloon title (launcher-spawned tray).
    pub balloon_title: &'static str,
    /// Windows startup balloon body — identical in both modes on purpose.
    pub balloon_body: &'static str,
}

impl TrayLabels {
    pub fn for_mode(is_service_mode: bool) -> Self {
        const BALLOON_BODY: &str =
            "tray started by launcher. to clear the tray, use the exit option from the tray menu.";
        if is_service_mode {
            Self {
                tooltip: "ws-scrcpy-web (service)",
                exit_title: "Exit ws-scrcpy-web?",
                exit_body: "Stop the service and quit?",
                exit_action: "stop the service and quit",
                balloon_title: "ws-scrcpy-web (service) tray",
                balloon_body: BALLOON_BODY,
            }
        } else {
            Self {
                tooltip: "ws-scrcpy-web",
                exit_title: "Exit ws-scrcpy-web?",
                exit_body: "Stop the server and quit?",
                exit_action: "stop the server and quit",
                balloon_title: "ws-scrcpy-web tray",
                balloon_body: BALLOON_BODY,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_and_user_service_runs_get_a_tray_when_a_session_bus_exists() {
        assert!(should_spawn_tray(None, true));
        assert!(should_spawn_tray(Some("user"), true));
        assert!(should_spawn_tray(Some("user-service"), true));
    }

    #[test]
    fn system_scope_never_gets_a_tray() {
        // No session to draw in, even if a bus address leaked into the env.
        assert!(!should_spawn_tray(Some("system-service"), true));
        assert!(!should_spawn_tray(Some("system-service"), false));
    }

    #[test]
    fn no_session_bus_means_no_tray() {
        assert!(!should_spawn_tray(None, false));
        assert!(!should_spawn_tray(Some("user-service"), false));
    }

    #[test]
    fn session_bus_is_detected_from_the_env_var_or_the_runtime_socket() {
        assert!(session_bus_present(Some("unix:path=/run/user/1000/bus"), false));
        assert!(session_bus_present(None, true));
        assert!(!session_bus_present(None, false));
        // An empty or blank address is not an address.
        assert!(!session_bus_present(Some(""), false));
        assert!(!session_bus_present(Some("   "), false));
    }

    #[test]
    fn labels_mirror_the_windows_helper_strings() {
        let local = TrayLabels::for_mode(false);
        assert_eq!(local.tooltip, "ws-scrcpy-web");
        assert_eq!(local.exit_title, "Exit ws-scrcpy-web?");
        assert_eq!(local.exit_body, "Stop the server and quit?");
        assert_eq!(local.exit_action, "stop the server and quit");
        assert_eq!(local.balloon_title, "ws-scrcpy-web tray");

        let service = TrayLabels::for_mode(true);
        assert_eq!(service.tooltip, "ws-scrcpy-web (service)");
        assert_eq!(service.exit_body, "Stop the service and quit?");
        assert_eq!(service.exit_action, "stop the service and quit");
        assert_eq!(service.balloon_title, "ws-scrcpy-web (service) tray");
        // The balloon body is identical in both modes on purpose (see tray/src/main.rs).
        assert_eq!(local.balloon_body, service.balloon_body);
        assert!(local.balloon_body.contains("exit option from the tray menu"));
    }
}
