// In-app "complete uninstall" — PURE command-vector builder (beta.49).
//
// `app_uninstall_commands` returns the ordered teardown argv-vectors for a full
// app removal, split into a `privileged` group (run under ONE pkexec elevation
// by the Task-2 dispatch layer) and an unelevated `user_owned` group. It mirrors
// the teardown phases of docs/smoke-tests/clear-install.sh and reuses the scope /
// unit-path / sbin helpers from `linux_service` so the two stay in lockstep.
//
// PURE builder only — no dispatch, no std::process. Task 2 wires it into main.rs
// and runs the vectors (user_owned unelevated, privileged under a single pkexec).
// Until then nothing in production calls the builder, hence the module-level
// `dead_code` allow (same rationale as linux_service::bootstrap_target's
// `#[allow(dead_code)]`); Task 2 narrows/removes it once the dispatch lands.
//
// Local-Dependencies-Only: every tool is resolved under `bindir` (sbin tools via
// `sbindir_from(bindir)`) — never a bare name and never via PATH.
#![allow(dead_code)]

use crate::linux_service::{scope_prefix, sbindir_from, unit_path, Scope};

/// App / systemd-unit identity shared by every footprint path.
const UNIT_NAME: &str = "WsScrcpyWeb";
/// `pkill -f` pattern matching every long-lived process the app can spawn
/// (server, launcher, the standalone tray, and an escaped scrcpy-server).
const PROC_PATTERN: &str = "WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server";
/// Machine-wide install staging dir (root-owned).
const OPT_DIR: &str = "/opt/ws-scrcpy-web";
/// System-service state dir (root-owned).
const VAR_OPT_DIR: &str = "/var/opt/ws-scrcpy-web";
/// System menu entry + icon a machine-wide install drops under /usr/share.
const SYS_DESKTOP: &str = "/usr/share/applications/ws-scrcpy-web.desktop";
const SYS_ICON: &str = "/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png";
/// SELinux fcontext specs the install adds: the /opt bin_t tree, the /var/opt
/// var_lib_t state, and the legacy beta.40 /opt/.../data rule (removed too so a
/// stale rule never lingers post-uninstall). Matches clear-install.sh.
const FCONTEXT_SPECS: [&str; 3] = [
    "/opt/ws-scrcpy-web(/.*)?",
    "/var/opt/ws-scrcpy-web(/.*)?",
    "/opt/ws-scrcpy-web/data(/.*)?",
];

/// Ordered teardown argv-vectors for a complete app uninstall, split by
/// privilege. `privileged` is meant to run under ONE elevation (pkexec, Task 2);
/// an EMPTY `privileged` means a purely-local install with no root footprint, so
/// the dispatch layer can skip the elevation prompt entirely.
#[derive(Debug, Clone)]
pub struct UninstallPlan {
    /// Root-only steps: system service cascade, /opt + /var/opt, the system
    /// .desktop + icon, and the SELinux fcontext rules.
    pub privileged: Vec<Vec<String>>,
    /// Unelevated steps: kill strays, user-scope service cascade, the instance
    /// lock, and the data root (whole, or regenerable subdirs when `keep`).
    pub user_owned: Vec<Vec<String>>,
}

/// stop -> disable -> reset-failed -> `rm -f <unit>` -> daemon-reload for one
/// scope. The common core of `linux_service::teardown_commands` (which also
/// interleaves the system /opt + fcontext block); here those root steps are
/// emitted separately into `privileged`, so this stays scope-agnostic.
fn service_teardown(scope: Scope, bindir: &str) -> Vec<Vec<String>> {
    let systemctl = format!("{bindir}/systemctl");
    let rm = format!("{bindir}/rm");
    let pre = scope_prefix(scope);
    let unit = format!("{UNIT_NAME}.service");
    let unit_file = unit_path(scope, UNIT_NAME);
    vec![
        [vec![systemctl.clone()], pre.clone(), vec!["stop".into(), unit.clone()]].concat(),
        [vec![systemctl.clone()], pre.clone(), vec!["disable".into(), unit.clone()]].concat(),
        [vec![systemctl.clone()], pre.clone(), vec!["reset-failed".into(), unit.clone()]].concat(),
        vec![rm.clone(), "-f".into(), unit_file.to_string_lossy().into_owned()],
        [vec![systemctl.clone()], pre.clone(), vec!["daemon-reload".into()]].concat(),
    ]
}

/// Build the split teardown plan. See the module docs for the full contract.
///
/// * `svc_scope`       — installed service scope (None = no service installed).
/// * `machine_wide`    — a /opt/ws-scrcpy-web install exists.
/// * `keep`            — preserve config.json + logs/ (delete only deps/bin/control);
///   false wipes the whole data root.
/// * `bindir`          — resolved bin dir (e.g. "/usr/bin"); all tools resolve under it.
/// * `data_root`       — the app data root to tear down.
/// * `xdg_runtime_dir` — runtime dir holding the instance lock (None = skip the lock).
pub fn app_uninstall_commands(
    svc_scope: Option<Scope>,
    machine_wide: bool,
    keep: bool,
    bindir: &str,
    data_root: &str,
    xdg_runtime_dir: Option<&str>,
) -> UninstallPlan {
    let rm = format!("{bindir}/rm");

    // ── user_owned (always; in teardown order) ───────────────────────────────
    // 1. kill stray app processes (server, launcher, tray, escaped scrcpy-server).
    //    Seeds the vec (vec![..]-init mirrors teardown_commands; the rest is conditional).
    let mut user_owned: Vec<Vec<String>> = vec![vec![
        format!("{bindir}/pkill"),
        "-KILL".into(),
        "-f".into(),
        PROC_PATTERN.to_string(),
    ]];

    // 2. user-scope service cascade — only when the service was installed --user.
    if svc_scope == Some(Scope::User) {
        user_owned.extend(service_teardown(Scope::User, bindir));
    }

    // 3. single-instance lock — only when the runtime dir is known.
    if let Some(xrd) = xdg_runtime_dir {
        user_owned.push(vec![rm.clone(), "-f".into(), format!("{xrd}/ws-scrcpy-web.lock")]);
    }

    // 4. data root. keep=false wipes the whole root; keep=true deletes only the
    //    regenerable subdirs and preserves <data_root>, config.json and logs/.
    if keep {
        for sub in ["dependencies", "bin", "control"] {
            user_owned.push(vec![rm.clone(), "-rf".into(), format!("{data_root}/{sub}")]);
        }
    } else {
        user_owned.push(vec![rm.clone(), "-rf".into(), data_root.to_string()]);
    }

    // ── privileged (only when a root-owned footprint exists) ──────────────────
    // A /opt machine-wide install OR a system-scope service. Empty otherwise, so
    // a purely-local uninstall needs no elevation.
    let mut privileged: Vec<Vec<String>> = Vec::new();
    if machine_wide || svc_scope == Some(Scope::System) {
        // 1. system service cascade — only when the service was installed system-wide.
        if svc_scope == Some(Scope::System) {
            privileged.extend(service_teardown(Scope::System, bindir));
        }
        // 2 + 3. machine-wide staging + system state (always when this group runs).
        privileged.push(vec![rm.clone(), "-rf".into(), OPT_DIR.to_string()]);
        privileged.push(vec![rm.clone(), "-rf".into(), VAR_OPT_DIR.to_string()]);
        // 4. system menu entry + icon.
        privileged.push(vec![rm.clone(), "-f".into(), SYS_DESKTOP.to_string()]);
        privileged.push(vec![rm.clone(), "-f".into(), SYS_ICON.to_string()]);
        // 5. SELinux fcontext rules (current x2 + legacy /opt/.../data).
        let semanage = format!("{}/semanage", sbindir_from(bindir));
        for spec in FCONTEXT_SPECS {
            privileged.push(vec![
                semanage.clone(),
                "fcontext".into(),
                "-d".into(),
                spec.to_string(),
            ]);
        }
    }

    UninstallPlan { privileged, user_owned }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Space-join each argv-vector for readable, order-preserving assertions.
    fn joined(cmds: &[Vec<String>]) -> Vec<String> {
        cmds.iter().map(|c| c.join(" ")).collect()
    }

    const DR_LOCAL: &str = "/home/u/.local/share/WsScrcpyWeb";

    #[test]
    fn local_wipe() {
        // No service, no /opt, wipe the whole data root.
        let plan =
            app_uninstall_commands(None, false, false, "/usr/bin", DR_LOCAL, Some("/run/user/1000"));
        // Exact ordered user_owned: kill -> lock -> data-root wipe.
        assert_eq!(
            joined(&plan.user_owned),
            vec![
                "/usr/bin/pkill -KILL -f WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server",
                "/usr/bin/rm -f /run/user/1000/ws-scrcpy-web.lock",
                "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb",
            ]
        );
        // privileged is empty -> no elevation.
        assert!(plan.privileged.is_empty());
        // no systemctl anywhere (no service installed).
        assert!(!joined(&plan.user_owned).iter().any(|c| c.contains("systemctl")));
    }

    #[test]
    fn local_keep() {
        // keep=true deletes only deps/bin/control; preserves root, config.json, logs/.
        let plan =
            app_uninstall_commands(None, false, true, "/usr/bin", DR_LOCAL, Some("/run/user/1000"));
        let u = joined(&plan.user_owned);
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/dependencies"));
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/bin"));
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/control"));
        // NOT a bare wipe of the data root itself.
        assert!(!u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb"));
        // preserved paths are never referenced.
        assert!(!u.iter().any(|c| c.contains("config.json")));
        assert!(!u.iter().any(|c| c.contains("/logs")));
        assert!(plan.privileged.is_empty());
    }

    #[test]
    fn user_service_cascade() {
        // user-scope service -> cascade lands in user_owned; nothing privileged.
        let plan = app_uninstall_commands(
            Some(Scope::User),
            false,
            false,
            "/usr/bin",
            DR_LOCAL,
            Some("/run/user/1000"),
        );
        let u = joined(&plan.user_owned);
        assert!(u.iter().any(|c| c.as_str() == "/usr/bin/systemctl --user stop WsScrcpyWeb.service"));
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/systemctl --user disable WsScrcpyWeb.service"));
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/systemctl --user reset-failed WsScrcpyWeb.service"));
        assert!(u.iter().any(|c| c.as_str() == "/usr/bin/systemctl --user daemon-reload"));
        // user unit file removed (HOME-relative; assert on the stable suffix).
        assert!(u.iter().any(|c| c.starts_with("/usr/bin/rm -f ")
            && c.ends_with("/.config/systemd/user/WsScrcpyWeb.service")));
        assert!(plan.privileged.is_empty());
    }

    #[test]
    fn system_install() {
        // system service + machine-wide -> everything root-owned lands in privileged.
        let plan = app_uninstall_commands(
            Some(Scope::System),
            true,
            false,
            "/usr/bin",
            "/var/opt/ws-scrcpy-web",
            None,
        );
        let p = joined(&plan.privileged);
        // system service cascade (system prefix = empty, so NO --user).
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/systemctl stop WsScrcpyWeb.service"));
        assert!(!p.iter().any(|c| c.contains("--user")));
        // /opt + /var/opt removed.
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/opt/ws-scrcpy-web"));
        // system menu entry + icon removed.
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -f /usr/share/applications/ws-scrcpy-web.desktop"));
        assert!(p.iter().any(
            |c| c.as_str() == "/usr/bin/rm -f /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png"
        ));
        // SELinux fcontext: both current specs + the legacy /opt/.../data rule, via sbin.
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web(/.*)?"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/sbin/semanage fcontext -d /var/opt/ws-scrcpy-web(/.*)?"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web/data(/.*)?"));
    }

    #[test]
    fn machine_wide_no_service() {
        // /opt install but NO service -> privileged runs (no systemctl); data root still wiped.
        let plan =
            app_uninstall_commands(None, true, false, "/usr/bin", DR_LOCAL, Some("/run/user/1000"));
        let p = joined(&plan.privileged);
        assert!(!plan.privileged.is_empty());
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -f /usr/share/applications/ws-scrcpy-web.desktop"));
        assert!(p.iter().any(|c| c.contains("ws-scrcpy-web.png")));
        // no service installed -> no systemctl in the privileged group.
        assert!(!p.iter().any(|c| c.contains("systemctl")));
        // user_owned still wipes the data root.
        assert!(joined(&plan.user_owned)
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb"));
    }

    #[test]
    fn lock_skipped_when_no_runtime_dir() {
        // xdg_runtime_dir = None -> no lock-removal command is emitted.
        let plan = app_uninstall_commands(None, false, false, "/usr/bin", DR_LOCAL, None);
        let u = joined(&plan.user_owned);
        assert!(!u.iter().any(|c| c.contains("ws-scrcpy-web.lock")));
        // but the kill is still first and the data root is still wiped.
        assert!(u[0].starts_with("/usr/bin/pkill -KILL -f "));
        assert!(u.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb"));
    }
}
