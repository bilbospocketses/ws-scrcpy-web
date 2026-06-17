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

/// Resolve the invoking user's HOME for building user-scope (`$HOME/.config`)
/// paths. Logs when HOME is unset rather than silently assuming `/root`: the
/// fallback only applies when HOME is absent (typically running as root, where
/// `/root` is in fact correct), so it stays a last resort but is no longer
/// invisible. (#98)
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| {
        log::error("HOME unset; falling back to /root for user-scope path resolution");
        "/root".to_string()
    })
}

pub fn unit_path(scope: Scope, name: &str) -> PathBuf {
    match scope {
        Scope::User => {
            let home = home_dir();
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
    // system scope also removes the /opt staging + /var/lib state + the /opt fcontext rule
    if scope == Scope::System {
        let semanage = format!("{}/semanage", sbindir_from(bindir));
        for dir in ["/opt/ws-scrcpy-web", "/var/lib/ws-scrcpy-web"] {
            cmds.push(vec![rm.clone(), "-rf".into(), dir.into()]);
        }
        // remove the /opt bin_t fcontext rule the install added. The /var/lib state
        // needs NO custom rule (var_lib_t by the policy's default /var/lib(/.*)? rule),
        // so there is nothing else to remove.
        cmds.push(vec![semanage, "fcontext".into(), "-d".into(), "/opt/ws-scrcpy-web(/.*)?".into()]);
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapAction { ExecOpt(PathBuf), RunHomeOfferUpdate, RunHome }

/// Compare versions like "0.1.31" / "0.1.31-beta.4". Core (X.Y.Z) numeric; a
/// `-beta.N` pre-release sorts BEFORE the same core release, and by N among betas.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(v: &str) -> ([u64; 3], Option<u64>) {
        let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p)));
        let mut nums = [0u64; 3];
        for (i, part) in core.split('.').take(3).enumerate() { nums[i] = part.parse().unwrap_or(0); }
        let beta = pre.and_then(|p| p.rsplit('.').next()).and_then(|n| n.parse::<u64>().ok());
        (nums, beta)
    }
    let (ca, ba) = parse(a);
    let (cb, bb) = parse(b);
    ca.cmp(&cb).then_with(|| match (ba, bb) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    })
}

/// `self_version` = the running (home) AppImage's version; `opt_version` = parsed
/// /opt/ws-scrcpy-web/VERSION (None if absent/unreadable). Pure.
pub fn bootstrap_decision(opt_exists: bool, appimage_env: Option<&str>, self_version: &str, opt_version: Option<&str>) -> BootstrapAction {
    let opt = PathBuf::from("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
    let is_self_opt = appimage_env.map(|p| p == opt.to_string_lossy()).unwrap_or(false);
    if !opt_exists || appimage_env.is_none() || is_self_opt { return BootstrapAction::RunHome; }
    match opt_version {
        Some(ov) if version_cmp(self_version, ov) == std::cmp::Ordering::Greater => BootstrapAction::RunHomeOfferUpdate,
        _ => BootstrapAction::ExecOpt(opt),
    }
}

/// Pure bootstrapper decision. `opt_exists` = the shared /opt AppImage is present;
/// `appimage_env` = $APPIMAGE (the file we were launched from). Returns the /opt
/// binary to re-exec, or None to continue the in-place launch. No version-compare
/// (that is a later phase).
#[allow(dead_code)]
pub fn bootstrap_target(opt_exists: bool, appimage_env: Option<&str>) -> Option<PathBuf> {
    let opt = PathBuf::from("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
    match appimage_env {
        Some(p) if opt_exists && p != opt.to_string_lossy() => Some(opt),
        _ => None,
    }
}

/// `systemd-run --user --collect [extra_setenv...] <target>` — relaunch a
/// user-scope AppImage in its OWN transient unit (user-manager-owned cgroup) so
/// it survives the caller's exit. `extra_setenv` carries any `--setenv=K=V`
/// tokens (e.g. WS_SCRCPY_NO_BROWSER on the apply path), inserted before the
/// target. Pure — the single builder shared by the teardown, install-handoff,
/// uninstall, and apply user-scope relaunch seams. (#71)
pub fn user_relaunch_command(systemd_run: &str, extra_setenv: &[&str], target: &str) -> Vec<String> {
    let mut argv = vec![
        systemd_run.to_string(),
        "--user".to_string(),
        "--collect".to_string(),
    ];
    argv.extend(extra_setenv.iter().map(|s| s.to_string()));
    argv.push(target.to_string());
    argv
}

/// Validate a relaunch-target path that came from an externally-influenceable
/// source (a marker file, a `--relaunch` argv, or a fixed path whose on-disk
/// FILE could be tampered) before it is exec'd. Requires an absolute path with
/// no `..` component that `lstat`s to a REGULAR FILE — so a symlink can't
/// redirect the exec and a missing / directory / special target is refused. For
/// a relaunch performed in a root/system context pass `require_root_owned = true`
/// to also require uid-0 ownership, so a non-root user can't plant the binary a
/// privileged relaunch would run. (#50)
pub(crate) fn is_safe_relaunch_target(path: &Path, require_root_owned: bool) -> bool {
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() {
        return false;
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    // lstat — do NOT follow symlinks; the target must itself be a regular file
    // (a symlink, dir, fifo, device, or missing path is refused).
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.file_type().is_file() {
        return false;
    }
    if require_root_owned && meta.uid() != 0 {
        return false;
    }
    true
}

/// User scope relaunches the home AppImage (from the install-time marker) into
/// local mode. System scope never auto-relaunches (headless-dominant; the admin
/// re-launches their own AppImage). Returns the path to relaunch, or None. The
/// marker is attacker-influenceable, so the path is validated (#50) before it
/// becomes an exec target; the user-scope relaunch runs as the user (systemd-run
/// `--user`), so no root-owned requirement.
pub fn relaunch_target(scope: Scope, marker: Option<String>) -> Option<PathBuf> {
    match scope {
        Scope::User => {
            let p = PathBuf::from(marker?);
            is_safe_relaunch_target(&p, false).then_some(p)
        }
        Scope::System => None,
    }
}

/// The service URL to open (then exit) when an ACTIVE system service owns the
/// app, so a local launch doesn't spawn a duplicate. `install_mode` + `web_port`
/// come from the /var/lib system-service config; `port_live` is a TCP-probe
/// result the caller supplies. `running_as_service` is true when THIS process is
/// the systemd service itself (ExecStart sets WS_SCRCPY_SERVICE=1) — it must NEVER
/// defer (it would defer to the outgoing local instance during the install handoff
/// and exit, leaving nothing serving: the beta.56 self-defer). Pure.
pub fn service_defer_url(
    install_mode: Option<&str>,
    web_port: Option<u16>,
    port_live: bool,
    running_as_service: bool,
) -> Option<String> {
    if running_as_service {
        return None;
    }
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

/// A non-zero exit from a teardown step is benign — WARN, not ERROR — only for
/// `reset-failed`: systemctl returns non-zero there when the unit isn't in a
/// failed state, which is the normal case after a clean stop+disable. Every
/// other step's non-zero is a genuine teardown error. (Mirrors the
/// benign-error pattern in supervisor.rs's helper-refresh ETXTBSY handling.)
fn teardown_failure_is_benign(argv: &[String]) -> bool {
    argv.iter().any(|a| a == "reset-failed")
}

fn run(scope: Scope, unit: &str) -> i32 {
    let bd = tool_dir("systemctl");
    log::info(&format!("linux-service-teardown: scope={scope:?} unit={unit}"));

    // 1. Teardown sequence (best-effort; log non-zero, keep going).
    for argv in teardown_commands(scope, unit, &bd) {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) if s.success() => log::info(&format!("teardown ok: {}", argv.join(" "))),
            // `reset-failed` exits non-zero when the unit isn't in a failed state
            // (the normal case after a clean stop+disable) — benign, log at WARN.
            Ok(s) if teardown_failure_is_benign(&argv) => log::warn(&format!(
                "teardown: {} exited {:?} (benign — unit was not in a failed state)",
                argv.join(" "),
                s.code()
            )),
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
        let argv = user_relaunch_command(&systemd_run, &[], &target_str);
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) => log::info(&format!(
                "teardown: relaunched local {target_str} via systemd-run (exit {:?})", s.code()
            )),
            Err(e) => log::error(&format!("teardown: relaunch via systemd-run failed: {e}")),
        }
    }

    if scope == Scope::System {
        // §D5 — no auto-relaunch on system-scope teardown. The teardown above
        // `rm -rf`s BOTH /opt/ws-scrcpy-web and /var/lib/ws-scrcpy-web, so by
        // here the /opt AppImage and the /var/lib web_port the old relaunch
        // needed are already gone — the discover-uid + system_relaunch_command
        // attempt could never fire (it always hit the manual-fallback arm). The
        // admin re-launches their own AppImage; this is the chosen §12 outcome.
        log::info("system teardown: no auto-relaunch (admin re-launches manually)");
    }
    0
}

// ── install handoff (F4) ────────────────────────────────────────────────────
//
// A user-scope service and the local app run as the same user, so they share
// the per-$XDG_RUNTIME_DIR single-instance flock. Starting the service while the
// local app still holds the lock makes the service launcher see "already
// running" and exit 0 (never binding). So the install enables the unit (NOT
// --now) and hands off to THIS out-of-cgroup helper, which waits for the local
// instance to exit (port released → lock freed), starts the service, verifies it
// STAYS up (active AND serving — not the Type=simple flicker), and on failure
// rolls back + relaunches local so the user is never stranded. Mirror of `run`.

/// `systemctl [--user] start <unit>.service` argv (absolute systemctl, Local-Deps).
pub fn start_command(scope: Scope, name: &str, bindir: &str) -> Vec<String> {
    let systemctl = format!("{bindir}/systemctl");
    [
        vec![systemctl],
        scope_prefix(scope),
        vec!["start".into(), format!("{name}.service")],
    ]
    .concat()
}

/// The handoff treats the service as "up" only when systemd reports it active
/// AND the web port actually accepts a connection. `Type=simple` flips a unit to
/// active the instant it forks, so is-active alone is fooled by a start-then-
/// exit-0 (the beta.45 F3 flicker); the port probe is what makes the check real.
/// Pure.
pub fn service_up(is_active: bool, port_open: bool) -> bool {
    is_active && port_open
}

/// TCP-probe 127.0.0.1:<port>; true when a connection succeeds within 200ms.
fn port_is_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

/// Poll up to `secs` seconds (1s cadence) for the port to reach `want_open`.
fn wait_port(port: u16, want_open: bool, secs: u64) -> bool {
    for _ in 0..secs {
        if port_is_open(port) == want_open {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    port_is_open(port) == want_open
}

/// Poll up to `secs` seconds for the service to be active AND serving the port.
fn verify_up(scope: Scope, unit: &str, bindir: &str, port: u16, secs: u64) -> bool {
    let systemctl = format!("{bindir}/systemctl");
    let pre = scope_prefix(scope);
    let unit_svc = format!("{unit}.service");
    for _ in 0..secs {
        let mut a: Vec<&str> = pre.iter().map(String::as_str).collect();
        a.push("is-active");
        a.push(&unit_svc);
        let is_active = std::process::Command::new(&systemctl)
            .args(&a)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "active")
            .unwrap_or(false);
        if service_up(is_active, port_is_open(port)) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    false
}

/// Dispatch: handle `--linux-service-install-handoff`, return Some(exit_code).
pub fn handle_install_handoff(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-service-install-handoff") {
        return None;
    }
    match parse_args(args) {
        Some((scope, unit)) => Some(run_install_handoff(scope, &unit)),
        None => {
            log::error("linux-service-install-handoff: missing/invalid --scope or --unit");
            Some(2)
        }
    }
}

fn run_install_handoff(scope: Scope, unit: &str) -> i32 {
    let bd = tool_dir("systemctl");
    log::info(&format!("install-handoff: scope={scope:?} unit={unit}"));

    // Web port from the user config (default 8000). The local instance + the
    // service share it; it's our signal for the local exit and the service bind.
    let web_port = common::config::data_root_from_env()
        .map(|dr| common::config::AppConfig::load(&dr))
        .and_then(|c| c.web_port)
        .unwrap_or(8000);

    // 1. Wait for the local instance to release the port (it exits to free the
    //    per-user single-instance lock the service needs). Best-effort.
    if wait_port(web_port, false, 20) {
        log::info(&format!("install-handoff: local instance released port {web_port}"));
    } else {
        log::error(&format!(
            "install-handoff: port {web_port} still held after 20s; starting anyway"
        ));
    }

    // 2. Start the service (lock now free → it acquires it + binds the port).
    let argv = start_command(scope, unit, &bd);
    let (cmd, rest) = argv.split_first().expect("non-empty argv");
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) => log::info(&format!("install-handoff: started {unit} (exit {:?})", s.code())),
        Err(e) => log::error(&format!("install-handoff: start spawn failed: {e}")),
    }

    // 3. Verify it STAYS up (active AND serving) — not the Type=simple flicker.
    if verify_up(scope, unit, &bd, web_port, 12) {
        log::info("install-handoff: service active + serving; handoff complete");
        return 0;
    }

    // 4. Failure → roll back (teardown) + relaunch local so the user isn't stranded.
    log::error("install-handoff: service did not come up; rolling back + relaunching local");
    for argv in teardown_commands(scope, unit, &bd) {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        let _ = std::process::Command::new(cmd).args(rest).status();
    }
    if let Some(target) = relaunch_target(scope, read_local_appimage_marker()) {
        let systemd_run = format!("{}/systemd-run", tool_dir("systemd-run"));
        let target_str = target.to_string_lossy().into_owned();
        let argv = user_relaunch_command(&systemd_run, &[], &target_str);
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) => log::info(&format!(
                "install-handoff rollback: relaunched local {target_str} (exit {:?})",
                s.code()
            )),
            Err(e) => log::error(&format!("install-handoff rollback: relaunch failed: {e}")),
        }
    }
    if scope == Scope::System {
        // §D5-sibling — no auto-relaunch after a system-scope install rollback.
        // The rollback teardown above `rm -rf`s BOTH /opt/ws-scrcpy-web and
        // /var/lib/ws-scrcpy-web, so the /opt AppImage and the /var/lib web_port a
        // relaunch would need are already gone here — the discover-uid +
        // system_relaunch_command attempt could never fire (it always hit the
        // manual-fallback arm). The admin re-launches their own AppImage.
        log::error("install-handoff rollback: system install failed; admin can relaunch manually");
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
    fn reset_failed_nonzero_is_benign() {
        // systemctl reset-failed exits non-zero when the unit isn't failed —
        // the normal case after a clean stop+disable; must NOT log as ERROR.
        let argv = ["/usr/bin/systemctl", "--user", "reset-failed", "WsScrcpyWeb.service"]
            .map(String::from)
            .to_vec();
        assert!(teardown_failure_is_benign(&argv));
    }

    #[test]
    fn other_teardown_steps_nonzero_are_real_errors() {
        for step in ["stop", "disable", "daemon-reload"] {
            let argv = ["/usr/bin/systemctl", "--user", step, "WsScrcpyWeb.service"]
                .map(String::from)
                .to_vec();
            assert!(
                !teardown_failure_is_benign(&argv),
                "{step} non-zero should be a real error, not benign"
            );
        }
    }

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
    fn system_scope_teardown_removes_opt_and_var_lib() {
        let cmds = teardown_commands(Scope::System, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        let removes_dir = |d: &str| joined.iter().any(|c| c.contains("rm") && c.contains(d));
        let removes_fcontext = |spec: &str|
            joined.iter().any(|c| c.contains("semanage fcontext -d") && c.ends_with(spec));
        assert!(removes_dir("/opt/ws-scrcpy-web"));
        assert!(removes_dir("/var/lib/ws-scrcpy-web"));
        assert!(removes_fcontext("/opt/ws-scrcpy-web(/.*)?"));         // bin_t tree
        assert!(!removes_fcontext("/var/lib/ws-scrcpy-web(/.*)?"));    // /var/lib: NO custom rule
    }

    #[test]
    fn relaunch_target_accepts_a_valid_absolute_regular_file() {
        // user scope + a marker that points at a real absolute regular file -> Some
        let tmp = tempfile::tempdir().expect("tempdir");
        let app = tmp.path().join("App.AppImage");
        std::fs::write(&app, b"#!/bin/sh\n").expect("write");
        assert_eq!(
            relaunch_target(Scope::User, Some(app.to_string_lossy().into_owned())),
            Some(app)
        );
    }

    #[test]
    fn relaunch_target_rejects_unsafe_or_missing_markers() {
        // system scope -> never relaunch (even with a marker)
        assert_eq!(relaunch_target(Scope::System, Some("/opt/x/App.AppImage".into())), None);
        // missing marker
        assert_eq!(relaunch_target(Scope::User, None), None);
        // relative path
        assert_eq!(relaunch_target(Scope::User, Some("Apps/App.AppImage".into())), None);
        // absolute but nonexistent
        assert_eq!(relaunch_target(Scope::User, Some("/nonexistent/App.AppImage".into())), None);
        // absolute but contains a `..` traversal component
        let tmp = tempfile::tempdir().expect("tempdir");
        let app = tmp.path().join("App.AppImage");
        std::fs::write(&app, b"x").expect("write");
        let traversal = format!("{}/../App.AppImage", app.parent().unwrap().to_string_lossy());
        assert_eq!(relaunch_target(Scope::User, Some(traversal)), None);
    }

    #[test]
    fn is_safe_relaunch_target_enforces_absolute_no_dotdot_regular_file() {
        use std::os::unix::fs::MetadataExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("App.AppImage");
        std::fs::write(&file, b"x").expect("write");

        // valid: absolute, no `..`, regular file
        assert!(is_safe_relaunch_target(&file, false));
        // relative path
        assert!(!is_safe_relaunch_target(Path::new("App.AppImage"), false));
        // contains `..`
        assert!(!is_safe_relaunch_target(&tmp.path().join("..").join("App.AppImage"), false));
        // nonexistent
        assert!(!is_safe_relaunch_target(&tmp.path().join("nope.AppImage"), false));
        // a directory is not a regular file
        assert!(!is_safe_relaunch_target(tmp.path(), false));
        // a symlink lstat's as a symlink, not a regular file -> rejected (no redirect)
        let link = tmp.path().join("link.AppImage");
        std::os::unix::fs::symlink(&file, &link).expect("symlink");
        assert!(!is_safe_relaunch_target(&link, false));
        // require_root_owned: passes iff the file is actually uid-0 owned (robust to
        // whether the test runs as root, e.g. inside the cross container, or not).
        let owned_by_root = std::fs::metadata(&file).unwrap().uid() == 0;
        assert_eq!(is_safe_relaunch_target(&file, true), owned_by_root);
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
        // running_as_service = false: a plain local/home launch may defer to a live system service.
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), true, false),
                   Some("http://localhost:8000".to_string()));
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), false, false), None); // installed but down
        assert_eq!(service_defer_url(Some("user"), Some(8000), true, false), None);            // not service mode
        assert_eq!(service_defer_url(None, None, true, false), None);
    }

    #[test]
    fn never_defers_when_running_as_the_service() {
        // WS_SCRCPY_SERVICE=1 -> this process IS the system service; it must start its
        // server, never defer to a "live" port (which, during the install handoff, is
        // just the outgoing local instance). beta.56 self-defer regression guard.
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), true, true), None);
    }

    #[test]
    fn user_relaunch_command_builds_collect_unit() {
        // §71 — plain user-scope relaunch, no extra setenv.
        assert_eq!(
            user_relaunch_command("/usr/bin/systemd-run", &[], "/home/u/App.AppImage"),
            vec!["/usr/bin/systemd-run", "--user", "--collect", "/home/u/App.AppImage"]
        );
        // With an extra --setenv (the apply path's NO_BROWSER) inserted before
        // the target — same builder, one shared shape.
        assert_eq!(
            user_relaunch_command(
                "/usr/bin/systemd-run",
                &["--setenv=WS_SCRCPY_NO_BROWSER=1"],
                "/home/u/App.AppImage"
            ),
            vec![
                "/usr/bin/systemd-run", "--user", "--collect",
                "--setenv=WS_SCRCPY_NO_BROWSER=1", "/home/u/App.AppImage"
            ]
        );
    }

    #[test]
    fn version_cmp_orders_core_and_betas() {
        use std::cmp::Ordering::*;
        assert_eq!(version_cmp("0.1.31", "0.1.30"), Greater);
        assert_eq!(version_cmp("0.1.31", "0.1.31"), Equal);
        assert_eq!(version_cmp("0.1.31", "0.1.31-beta.4"), Greater); // release > its beta
        assert_eq!(version_cmp("0.1.31-beta.5", "0.1.31-beta.4"), Greater);
        assert_eq!(version_cmp("0.1.30", "0.1.31-beta.1"), Less);
    }

    #[test]
    fn bootstrap_decides_by_version() {
        let opt = "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage";
        assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.30", Some("0.1.31")), BootstrapAction::ExecOpt(opt.into()));
        assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.31", Some("0.1.31")), BootstrapAction::ExecOpt(opt.into()));
        assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.32", Some("0.1.31")), BootstrapAction::RunHomeOfferUpdate);
        assert_eq!(bootstrap_decision(true, Some(opt), "0.1.31", Some("0.1.31")), BootstrapAction::RunHome);   // we ARE /opt
        assert_eq!(bootstrap_decision(false, Some("/home/u/App.AppImage"), "0.1.31", None), BootstrapAction::RunHome);  // no /opt
        assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.31", None), BootstrapAction::ExecOpt(opt.into())); // unknown /opt version -> run /opt
    }

    #[test]
    fn start_command_user_and_system() {
        assert_eq!(
            start_command(Scope::User, "WsScrcpyWeb", "/usr/bin"),
            vec!["/usr/bin/systemctl", "--user", "start", "WsScrcpyWeb.service"]
        );
        assert_eq!(
            start_command(Scope::System, "WsScrcpyWeb", "/usr/bin"),
            vec!["/usr/bin/systemctl", "start", "WsScrcpyWeb.service"]
        );
    }

    #[test]
    fn service_up_requires_active_and_serving() {
        assert!(service_up(true, true));
        assert!(!service_up(true, false)); // active but not serving — the Type=simple flicker
        assert!(!service_up(false, true));
        assert!(!service_up(false, false));
    }
}
