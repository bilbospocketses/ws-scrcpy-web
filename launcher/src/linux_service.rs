// §item32 — out-of-cgroup Linux service teardown. Launched via `systemd-run`
// from the Node server so it runs in its OWN transient unit, surviving the
// stop of the service unit it tears down (the service Node lives in that
// cgroup; calling systemctl stop from there kills itself mid-call — the
// root of item 32). Mirrors the Windows operation-server/post-stop handoff.

use std::path::{Path, PathBuf};

use crate::log;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    System,
}

/// `--user` prefix tokens for user scope, empty for system scope.
pub(crate) fn scope_prefix(scope: Scope) -> Vec<String> {
    match scope {
        Scope::User => vec!["--user".to_string()],
        Scope::System => vec![],
    }
}

pub fn unit_path(scope: Scope, name: &str) -> PathBuf {
    match scope {
        Scope::User => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
            PathBuf::from(home)
                .join(".config/systemd/user")
                .join(format!("{name}.service"))
        }
        Scope::System => PathBuf::from("/etc/systemd/system").join(format!("{name}.service")),
    }
}

/// Derive the sbin dir from the bin dir (`/usr/bin` -> `/usr/sbin`, `/bin` -> `/sbin`).
/// semanage/restorecon live in sbin; everything else in bin.
pub(crate) fn sbindir_from(bindir: &str) -> String {
    bindir
        .strip_suffix("/bin")
        .map(|p| format!("{p}/sbin"))
        .unwrap_or_else(|| bindir.to_string())
}

/// Ordered command argv-vectors for the teardown. `bindir` is the resolved
/// absolute bin dir (e.g. "/usr/bin") so we never invoke tools by bare name
/// (Local-Dependencies-Only).
pub fn teardown_commands(scope: Scope, name: &str, bindir: &str) -> Vec<Vec<String>> {
    let systemctl = format!("{bindir}/systemctl");
    let rm = format!("{bindir}/rm");
    let pre = scope_prefix(scope);
    let unit = format!("{name}.service");
    let unit_file = unit_path(scope, name);

    // stop (synchronous; reaps the in-cgroup launcher+Node+children), disable, reset-failed,
    // remove unit file, reload — always present.
    let mut cmds: Vec<Vec<String>> = vec![
        [vec![systemctl.clone()], pre.clone(), vec!["stop".into(), unit.clone()]].concat(),
        [vec![systemctl.clone()], pre.clone(), vec!["disable".into(), unit.clone()]].concat(),
        [vec![systemctl.clone()], pre.clone(), vec!["reset-failed".into(), unit.clone()]].concat(),
        vec![rm.clone(), "-f".into(), unit_file.to_string_lossy().into_owned()],
    ];
    // system scope also removes the /opt staging + /var/opt state + BOTH fcontext rules
    if scope == Scope::System {
        let semanage = format!("{}/semanage", sbindir_from(bindir));
        for dir in ["/opt/ws-scrcpy-web", "/var/opt/ws-scrcpy-web"] {
            cmds.push(vec![rm.clone(), "-rf".into(), dir.into()]);
        }
        // remove BOTH fcontext rules the install added: the /opt bin_t tree rule
        // AND the /var/opt var_lib_t state rule (else the rule lingers post-uninstall).
        for pathspec in ["/opt/ws-scrcpy-web(/.*)?", "/var/opt/ws-scrcpy-web(/.*)?"] {
            cmds.push(vec![semanage.clone(), "fcontext".into(), "-d".into(), pathspec.to_string()]);
        }
    }
    // reload
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["daemon-reload".into()]].concat());
    cmds
}

/// Parse `--scope user|system` + `--unit <name>` from argv.
pub fn parse_args(args: &[String]) -> Option<(Scope, String)> {
    let scope = args
        .iter()
        .position(|a| a == "--scope")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| match s.as_str() {
            "user" => Some(Scope::User),
            "system" => Some(Scope::System),
            _ => None,
        })?;
    let unit = args
        .iter()
        .position(|a| a == "--unit")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    Some((scope, unit))
}

/// Pure bootstrapper decision. `opt_exists` = the shared /opt AppImage is present;
/// `appimage_env` = $APPIMAGE (the file we were launched from). Returns the /opt
/// binary to re-exec, or None to continue the in-place launch. No version-compare
/// (that is a later phase).
pub fn bootstrap_target(opt_exists: bool, appimage_env: Option<&str>) -> Option<PathBuf> {
    let opt = PathBuf::from("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
    match appimage_env {
        Some(p) if opt_exists && p != opt.to_string_lossy() => Some(opt),
        _ => None,
    }
}

/// First column of each `loginctl list-sessions --no-legend` line = session id.
#[allow(dead_code)] // wired in P2-4 (system-scope relaunch)
pub fn parse_session_ids(list_output: &str) -> Vec<String> {
    list_output.lines().filter_map(|l| l.split_whitespace().next()).map(str::to_string).collect()
}

/// uid of the session from a `loginctl show-session <id> -p Active -p Type -p User -p Display`
/// block, IFF it is active AND graphical (x11/wayland). We don't need DISPLAY — the
/// relaunched app is a server the browser reconnects to.
#[allow(dead_code)] // wired in P2-4 (system-scope relaunch)
pub fn active_graphical_uid_from_show(show_output: &str) -> Option<u32> {
    let (mut active, mut kind, mut uid) = (false, String::new(), None::<u32>);
    for line in show_output.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "Active" => active = v.trim() == "yes",
                "Type" => kind = v.trim().to_string(),
                "User" => uid = v.trim().parse().ok(),
                _ => {}
            }
        }
    }
    if active && (kind == "x11" || kind == "wayland") { uid } else { None }
}

/// `systemd-run --uid=<uid> --setenv=HOME=<home> --setenv=WS_SCRCPY_WEB_PORT=<port>
/// --collect <appimage>` — relaunch the shared /opt binary AS the user, with HOME
/// (mandatory — else data_root_for_linux panics) and the service's port (so the
/// browser reconnects). No DISPLAY (it's a server). Pure.
#[allow(dead_code)] // wired in P2-4 (system-scope relaunch)
pub fn system_relaunch_command(systemd_run: &str, uid: u32, home: &str, web_port: u16, appimage: &str) -> Vec<String> {
    vec![
        systemd_run.to_string(),
        format!("--uid={uid}"),
        format!("--setenv=HOME={home}"),
        format!("--setenv=WS_SCRCPY_WEB_PORT={web_port}"),
        "--collect".to_string(),
        appimage.to_string(),
    ]
}

/// User scope relaunches the home AppImage (from the install-time marker) into
/// local mode. System scope never auto-relaunches (headless-dominant; the admin
/// re-launches their own AppImage). Returns the path to relaunch, or None.
pub fn relaunch_target(scope: Scope, marker: Option<String>) -> Option<PathBuf> {
    match scope {
        // `|| cfg!(test)` lets the unit test assert Some for a path that doesn't
        // exist on the test host; in production the marker must point at a real file.
        Scope::User => marker.map(PathBuf::from).filter(|p| p.exists() || cfg!(test)),
        Scope::System => None,
    }
}

/// The service URL to open (then exit) when an ACTIVE system service owns the
/// app, so a local launch doesn't spawn a duplicate. `install_mode` + `web_port`
/// come from the /var/opt system-service config; `port_live` is a TCP-probe
/// result the caller supplies. Pure.
pub fn service_defer_url(install_mode: Option<&str>, web_port: Option<u16>, port_live: bool) -> Option<String> {
    match (install_mode, web_port) {
        (Some("system-service"), Some(port)) if port_live => Some(format!("http://localhost:{port}")),
        _ => None,
    }
}

/// Dispatch: handle `--linux-service-teardown`, return Some(exit_code).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-service-teardown") {
        return None;
    }
    let (scope, unit) = match parse_args(args) {
        Some(v) => v,
        None => {
            log::error("linux-service-teardown: missing/invalid --scope or --unit");
            return Some(2);
        }
    };
    Some(run(scope, &unit))
}

/// Probe for the absolute dir (/usr/bin then /bin) containing `tool`. Falls back
/// to /usr/bin. Local-Dependencies-Only: never invoke a tool by bare name.
pub(crate) fn tool_dir(tool: &str) -> String {
    for d in ["/usr/bin", "/bin"] {
        if Path::new(&format!("{d}/{tool}")).exists() {
            return d.to_string();
        }
    }
    "/usr/bin".to_string()
}

fn run(scope: Scope, unit: &str) -> i32 {
    let bd = tool_dir("systemctl");
    log::info(&format!("linux-service-teardown: scope={scope:?} unit={unit}"));

    // 1. Teardown sequence (best-effort; log non-zero, keep going).
    for argv in teardown_commands(scope, unit, &bd) {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) if s.success() => log::info(&format!("teardown ok: {}", argv.join(" "))),
            Ok(s) => log::error(&format!("teardown non-zero ({:?}): {}", s.code(), argv.join(" "))),
            Err(e) => log::error(&format!("teardown spawn failed: {} ({e})", argv.join(" "))),
        }
    }

    // 2. Reap the escaped adb daemon (it daemonizes out of the cgroup, so the
    //    cgroup stop above does NOT kill it). Bundled adb, absolute path.
    if let Some(data_root) = common::config::data_root_from_env() {
        let adb = data_root.join("dependencies").join("adb").join("adb");
        if adb.exists() {
            let _ = std::process::Command::new(&adb).arg("kill-server").status();
            log::info("teardown: adb kill-server issued");
        }
    }

    // 3. Relaunch local (USER scope only). The relaunched app MUST run in its
    //    OWN transient unit, NOT as a child of this helper: this helper itself
    //    runs inside a `systemd-run` transient unit (ServiceApi launches it that
    //    way), so a plain spawn would be in THIS helper's cgroup and get killed
    //    when this helper exits and its transient unit deactivates. `systemd-run
    //    --user --collect` starts the AppImage as an independent transient unit
    //    that outlives this helper.
    //    >>> VERIFY ON FEDORA (Phase 1 Task 12): this is the key runtime-survival
    //    point. Confirm the relaunched local app actually survives this helper's
    //    exit and the browser reconnects. If the user-manager / XDG_RUNTIME_DIR
    //    context isn't right when invoked from inside the teardown transient unit,
    //    adjust this invocation. <<<
    let marker = read_local_appimage_marker();
    if let Some(target) = relaunch_target(scope, marker) {
        let systemd_run = format!("{}/systemd-run", tool_dir("systemd-run"));
        let target_str = target.to_string_lossy().into_owned();
        match std::process::Command::new(&systemd_run)
            .args(["--user", "--collect", &target_str])
            .status()
        {
            Ok(s) => log::info(&format!(
                "teardown: relaunched local {target_str} via systemd-run (exit {:?})", s.code()
            )),
            Err(e) => log::error(&format!("teardown: relaunch via systemd-run failed: {e}")),
        }
    }
    0
}

fn read_local_appimage_marker() -> Option<String> {
    let data_root = common::config::data_root_from_env()?;
    let p = data_root.join("control").join("local-appimage");
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_scope_teardown_sequence() {
        let cmds = teardown_commands(Scope::User, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert!(joined[0].contains("--user stop WsScrcpyWeb.service"));
        assert!(joined.iter().any(|c| c.contains("--user disable WsScrcpyWeb.service")));
        assert!(joined.iter().any(|c| c.contains("--user reset-failed WsScrcpyWeb.service")));
        assert!(joined.iter().any(|c| c.contains("--user daemon-reload")));
        // user scope does NOT touch /opt
        assert!(!joined.iter().any(|c| c.contains("/opt/ws-scrcpy-web")));
    }

    #[test]
    fn system_scope_teardown_removes_opt_and_fcontext() {
        let cmds = teardown_commands(Scope::System, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert!(joined.iter().any(|c| c.contains("stop WsScrcpyWeb.service") && !c.contains("--user")));
        assert!(joined.iter().any(|c| c.contains("rm") && c.contains("/opt/ws-scrcpy-web")));
        assert!(joined.iter().any(|c| c.contains("semanage fcontext -d")));
    }

    #[test]
    fn unit_path_is_scope_correct() {
        assert_eq!(
            unit_path(Scope::System, "WsScrcpyWeb"),
            PathBuf::from("/etc/systemd/system/WsScrcpyWeb.service")
        );
    }

    #[test]
    fn sbindir_derivation() {
        assert_eq!(sbindir_from("/usr/bin"), "/usr/sbin");
        assert_eq!(sbindir_from("/bin"), "/sbin");
    }

    #[test]
    fn system_scope_teardown_removes_opt_and_var_opt() {
        let cmds = teardown_commands(Scope::System, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        let removes_dir = |d: &str| joined.iter().any(|c| c.contains("rm") && c.contains(d));
        let removes_fcontext = |spec: &str|
            joined.iter().any(|c| c.contains("semanage fcontext -d") && c.ends_with(spec));
        assert!(removes_dir("/opt/ws-scrcpy-web"));
        assert!(removes_dir("/var/opt/ws-scrcpy-web"));
        assert!(removes_fcontext("/opt/ws-scrcpy-web(/.*)?"));      // bin_t tree
        assert!(removes_fcontext("/var/opt/ws-scrcpy-web(/.*)?"));  // var_lib_t state
    }

    #[test]
    fn relaunch_only_for_user_scope_with_marker() {
        // user scope + marker -> Some(path) (cfg!(test) bypasses the exists() check)
        assert_eq!(
            relaunch_target(Scope::User, Some("/home/u/Apps/App.AppImage".into())),
            Some(PathBuf::from("/home/u/Apps/App.AppImage"))
        );
        // system scope -> never relaunch
        assert_eq!(relaunch_target(Scope::System, Some("/home/u/Apps/App.AppImage".into())), None);
        // user scope, missing marker -> None
        assert_eq!(relaunch_target(Scope::User, None), None);
    }

    #[test]
    fn bootstrap_target_execs_opt_when_present_and_not_self() {
        let opt = "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage";
        assert_eq!(bootstrap_target(true, Some("/home/u/App.AppImage")), Some(PathBuf::from(opt)));
        assert_eq!(bootstrap_target(true, Some(opt)), None);              // we ARE /opt -> don't re-exec self
        assert_eq!(bootstrap_target(false, Some("/home/u/App.AppImage")), None); // no /opt -> run in place
        assert_eq!(bootstrap_target(true, None), None);                  // from-source (no $APPIMAGE) -> None
    }

    #[test]
    fn defer_to_service_only_when_system_service_and_port_live() {
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), true),
                   Some("http://localhost:8000".to_string()));
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), false), None); // installed but down
        assert_eq!(service_defer_url(Some("user"), Some(8000), true), None);            // not service mode
        assert_eq!(service_defer_url(None, None, true), None);
    }

    #[test]
    fn parses_session_ids_from_list() {
        let list = "   3 1000 jamie seat0 tty2\n  c1 0 root  -    -\n";
        assert_eq!(parse_session_ids(list), vec!["3".to_string(), "c1".to_string()]);
    }

    #[test]
    fn active_graphical_uid_only_when_active_and_graphical() {
        assert_eq!(active_graphical_uid_from_show("Active=yes\nType=wayland\nUser=1000\nDisplay="), Some(1000));
        assert_eq!(active_graphical_uid_from_show("Active=yes\nType=x11\nUser=1001\nDisplay=:0"), Some(1001));
        assert_eq!(active_graphical_uid_from_show("Active=no\nType=x11\nUser=1000\nDisplay=:0"), None);
        assert_eq!(active_graphical_uid_from_show("Active=yes\nType=tty\nUser=1000\nDisplay="), None);
    }

    #[test]
    fn system_relaunch_command_runs_as_user_on_service_port() {
        assert_eq!(
            system_relaunch_command("/usr/bin/systemd-run", 1000, "/home/jamie", 8000, "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"),
            vec!["/usr/bin/systemd-run", "--uid=1000", "--setenv=HOME=/home/jamie",
                 "--setenv=WS_SCRCPY_WEB_PORT=8000", "--collect", "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"]
        );
    }
}
