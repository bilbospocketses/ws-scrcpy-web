// In-app "complete uninstall" (beta.49) — the PURE command-vector builder plus
// the Task-2 dispatch/exec layer that runs it.
//
// `app_uninstall_commands` returns the ordered teardown argv-vectors for a full
// app removal, split into a `privileged` group (run under ONE pkexec elevation
// by the Task-2 dispatch layer) and an unelevated `user_owned` group. It mirrors
// the teardown phases of docs/smoke-tests/clear-install.sh and reuses the scope /
// unit-path / sbin helpers from `linux_service` so the two stay in lockstep.
//
// Dispatch (Task 2): the UNELEVATED entry `handle` (`--linux-app-uninstall`,
// spawned by the Node server via `systemd-run --user --collect`) re-invokes the
// launcher under ONE pkexec for the `privileged` group FIRST (so a declined
// prompt aborts before anything is removed), then runs the unelevated
// `user_owned` group. That pkexec lands on the ELEVATED entry `handle_elevated`
// (`--linux-app-uninstall-elevated`), which runs ONLY the `privileged` group as
// root. Both sides feed the SAME args to the SAME builder, so the split is
// identical and each instance runs exactly its own half. On a pkexec decline
// (126/127) or a privileged failure the uninstall aborts and the running
// AppImage is relaunched locally so the user is never stranded.
//
// Local-Dependencies-Only: every tool is resolved under `bindir` (sbin tools via
// `sbindir_from(bindir)`) — never a bare name and never via PATH.
use crate::linux_service::{scope_prefix, sbindir_from, tool_dir, unit_path, Scope};
use crate::log;

/// App / systemd-unit identity shared by every footprint path.
const UNIT_NAME: &str = "WsScrcpyWeb";
/// `pkill -f` pattern matching every long-lived process the app can spawn
/// (server, launcher, the standalone tray, and an escaped scrcpy-server).
const PROC_PATTERN: &str = "WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server";
/// Machine-wide install staging dir: binary + bundled deps, root-owned, ALWAYS
/// fully removed (never "kept"). The system-service DATA root (/var/opt, holding
/// config.json + logs) is deliberately NOT a const — it arrives as `data_root` so
/// keep/wipe applies to it exactly like a user data root.
const OPT_DIR: &str = "/opt/ws-scrcpy-web";
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
    /// Root-only steps: system service cascade, the /opt staging removal, the
    /// system-service data root (/var/opt) keep/wipe, the .desktop + icon plus a
    /// menu-cache refresh, and the SELinux fcontext rules.
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

/// `rm -rf` argv-vectors for a data root. `keep=false` wipes the whole root;
/// `keep=true` deletes ONLY the regenerable subdirs (dependencies/bin/control),
/// preserving the root itself, config.json and logs/. `rm` is the resolved
/// absolute rm path. Used for BOTH the user data root (~/.local/...) and the
/// system-service data root (/var/opt/...) — whichever owns config.json + logs.
fn data_root_commands(rm: &str, data_root: &str, keep: bool) -> Vec<Vec<String>> {
    if keep {
        ["dependencies", "bin", "control"]
            .into_iter()
            .map(|sub| vec![rm.to_string(), "-rf".into(), format!("{data_root}/{sub}")])
            .collect()
    } else {
        vec![vec![rm.to_string(), "-rf".into(), data_root.to_string()]]
    }
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

    // 1b. reap the bundled adb daemon by exact name — it daemonizes and escapes
    //     the pattern pkill above.
    user_owned.push(vec![format!("{bindir}/pkill"), "-KILL".into(), "-x".into(), "adb".into()]);

    // 2. user-scope service cascade — only when the service was installed --user.
    if svc_scope == Some(Scope::User) {
        user_owned.extend(service_teardown(Scope::User, bindir));
    }

    // 2b. tray autostart entry — defensive: pre-beta.45 installs wrote it. Always
    //     attempted; HOME-relative (resolved like unit_path).
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    user_owned.push(vec![
        rm.clone(),
        "-f".into(),
        format!("{home}/.config/autostart/ws-scrcpy-web-tray.desktop"),
    ]);

    // 3. single-instance lock — only when the runtime dir is known.
    if let Some(xrd) = xdg_runtime_dir {
        user_owned.push(vec![rm.clone(), "-f".into(), format!("{xrd}/ws-scrcpy-web.lock")]);
    }

    // 4. data root — user-owned ONLY for local / user-scope installs (data_root is
    //    ~/.local/...). A system service's data_root is /var/opt (root-owned), so
    //    its keep/wipe is emitted in the privileged group instead — exactly once,
    //    in the group that owns it.
    if svc_scope != Some(Scope::System) {
        user_owned.extend(data_root_commands(&rm, data_root, keep));
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
        // 2. /opt staging: binary + bundled deps are ALWAYS fully removed (never kept).
        privileged.push(vec![rm.clone(), "-rf".into(), OPT_DIR.to_string()]);
        // 2b. system-service data root (/var/opt) keep/wipe — root-owned, emitted
        //     here (NOT in user_owned). No blanket /var/opt rm: that would delete the
        //     preserved config.json + logs on keep.
        if svc_scope == Some(Scope::System) {
            privileged.extend(data_root_commands(&rm, data_root, keep));
        }
        // 3. system menu entry, refresh the menu cache, then the icon.
        privileged.push(vec![rm.clone(), "-f".into(), SYS_DESKTOP.to_string()]);
        privileged.push(vec![
            format!("{bindir}/update-desktop-database"),
            "/usr/share/applications".into(),
        ]);
        privileged.push(vec![rm.clone(), "-f".into(), SYS_ICON.to_string()]);
        // 4. SELinux fcontext rules (current x2 + legacy /opt/.../data).
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

// ─── Task 2: dispatch + execution (runs the pure builder above) ────────────────

/// Parsed `--linux-app-uninstall[-elevated]` invocation. `relaunch` is only
/// meaningful on the unelevated path (the currently-running `$APPIMAGE` to
/// restart if the user declines the pkexec prompt); it defaults to `""` on the
/// elevated path, which never relaunches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallArgs {
    pub svc_scope: Option<Scope>,
    pub machine_wide: bool,
    pub keep: bool,
    pub data_root: String,
    pub relaunch: String,
}

/// Parse the uninstall flags. Returns `None` (a parse error) on a missing/invalid
/// `--scope`, a missing/invalid `--machine-wide`, a missing `--data-root`, or
/// anything other than EXACTLY one of `--keep` / `--wipe`. `--scope none` is a
/// VALID value mapping to `svc_scope: None` (no service was installed) — distinct
/// from the outer `None` that signals a parse error. `--relaunch` is optional and
/// defaults to `""` (the elevated path never reads it).
pub fn parse_args(args: &[String]) -> Option<UninstallArgs> {
    // --scope user|system|none  (none = no service; missing/invalid = parse error)
    let svc_scope = match args
        .iter()
        .position(|a| a == "--scope")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
    {
        Some("user") => Some(Scope::User),
        Some("system") => Some(Scope::System),
        Some("none") => None,
        _ => return None,
    };
    // --machine-wide 0|1  (missing/invalid = parse error)
    let machine_wide = match args
        .iter()
        .position(|a| a == "--machine-wide")
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
    {
        Some("1") => true,
        Some("0") => false,
        _ => return None,
    };
    // --keep XOR --wipe  (exactly one required)
    let keep = match (
        args.iter().any(|a| a == "--keep"),
        args.iter().any(|a| a == "--wipe"),
    ) {
        (true, false) => true,
        (false, true) => false,
        _ => return None,
    };
    // --data-root <abs path>  (required)
    let data_root = args
        .iter()
        .position(|a| a == "--data-root")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    // --relaunch <abs path>  (optional; only read on a pkexec decline)
    let relaunch = args
        .iter()
        .position(|a| a == "--relaunch")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_default();
    Some(UninstallArgs { svc_scope, machine_wide, keep, data_root, relaunch })
}

/// Dispatch the UNELEVATED entry `--linux-app-uninstall` — the one the Node
/// server spawns (via `systemd-run --user --collect`). Returns `Some(exit_code)`
/// when it owns the invocation, `None` to let the next dispatcher try.
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-app-uninstall") {
        return None;
    }
    let a = match parse_args(args) {
        Some(v) => v,
        None => {
            log::error("linux-app-uninstall: missing/invalid args");
            return Some(2);
        }
    };
    Some(run_unelevated(&a))
}

/// Dispatch the ELEVATED entry `--linux-app-uninstall-elevated` — the pkexec
/// re-invoke lands here as root and runs ONLY the privileged group. Returns
/// `Some(exit_code)` when it owns the invocation, `None` otherwise.
pub fn handle_elevated(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-app-uninstall-elevated") {
        return None;
    }
    let a = match parse_args(args) {
        Some(v) => v,
        None => {
            log::error("linux-app-uninstall-elevated: missing/invalid args");
            return Some(2);
        }
    };
    Some(run_elevated(&a))
}

/// Unelevated run: the privileged group FIRST under ONE pkexec (re-invoking the
/// launcher as root), then the best-effort `user_owned` group. A pkexec decline
/// (126/127), a privileged failure, or a spawn error aborts the teardown and
/// relaunches the local AppImage, returning 0 — the privileged group is all-or-
/// nothing (it never partially ran), so the user keeps a working local app.
fn run_unelevated(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "linux-app-uninstall: scope={:?} machine_wide={} keep={}",
        a.svc_scope, a.machine_wide, a.keep
    ));
    let plan = plan_for(a);

    // 1. Privileged group FIRST, under ONE pkexec (re-invoke self as root). An
    //    empty privileged group (purely-local install) skips elevation entirely.
    if !plan.privileged.is_empty() {
        let pkexec = format!("{}/pkexec", tool_dir("pkexec"));
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                log::error(&format!(
                    "uninstall: cannot resolve self exe for pkexec re-invoke ({e}) — aborting + relaunching local"
                ));
                relaunch(&a.relaunch);
                return 0;
            }
        };
        let scope_arg = match a.svc_scope {
            Some(Scope::User) => "user",
            Some(Scope::System) => "system",
            None => "none",
        };
        let mw_arg = if a.machine_wide { "1" } else { "0" };
        let keep_arg = if a.keep { "--keep" } else { "--wipe" };
        // argv all the way (no `sh -c`): re-invoke ourselves under pkexec with the
        // same inputs MINUS --relaunch (the elevated half never relaunches).
        match std::process::Command::new(&pkexec)
            .arg(&exe)
            .args([
                "--linux-app-uninstall-elevated",
                "--scope",
                scope_arg,
                "--machine-wide",
                mw_arg,
                keep_arg,
                "--data-root",
                a.data_root.as_str(),
            ])
            .status()
        {
            Ok(s) if s.success() => log::info("uninstall: privileged group complete (pkexec)"),
            Ok(s) if declined(s) => {
                log::error("uninstall: pkexec declined — aborting + relaunching local");
                relaunch(&a.relaunch);
                return 0;
            }
            Ok(s) => {
                log::error(&format!(
                    "uninstall: privileged step failed ({:?}) — aborting + relaunching local",
                    s.code()
                ));
                relaunch(&a.relaunch);
                return 0;
            }
            Err(e) => {
                log::error(&format!(
                    "uninstall: pkexec spawn failed ({e}) — aborting + relaunching local"
                ));
                relaunch(&a.relaunch);
                return 0;
            }
        }
    }

    // 2. Unelevated group (kills our own processes + tears down the user data
    //    root). Best-effort: log non-zero, KEEP GOING (mirrors linux_service::run).
    for argv in plan.user_owned {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) if s.success() => log::info(&format!("uninstall ok: {}", argv.join(" "))),
            Ok(s) => log::error(&format!("uninstall non-zero ({:?}): {}", s.code(), argv.join(" "))),
            Err(e) => log::error(&format!("uninstall spawn failed: {} ({e})", argv.join(" "))),
        }
    }
    0
}

/// Elevated run (under pkexec, as root): the privileged group ONLY, best-effort
/// (log non-zero, keep going). The unelevated instance runs the `user_owned`
/// half; same builder + same args on both sides → an identical split.
fn run_elevated(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "linux-app-uninstall-elevated: scope={:?} machine_wide={} keep={}",
        a.svc_scope, a.machine_wide, a.keep
    ));
    let plan = plan_for(a);
    for argv in plan.privileged {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) if s.success() => log::info(&format!("uninstall (root) ok: {}", argv.join(" "))),
            Ok(s) => log::error(&format!("uninstall (root) non-zero ({:?}): {}", s.code(), argv.join(" "))),
            Err(e) => log::error(&format!("uninstall (root) spawn failed: {} ({e})", argv.join(" "))),
        }
    }
    0
}

/// Build the teardown plan from parsed args, resolving `bindir` + XDG from the
/// live environment. BOTH entries call this with the SAME `a`, so the
/// privileged / user_owned split is identical on the two sides — each then runs
/// only its own half. (XDG only feeds `user_owned`; the elevated side, which
/// runs only `privileged`, is unaffected by whatever value root's env carries.)
fn plan_for(a: &UninstallArgs) -> UninstallPlan {
    let bindir = tool_dir("systemctl");
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    app_uninstall_commands(
        a.svc_scope,
        a.machine_wide,
        a.keep,
        &bindir,
        &a.data_root,
        xdg.as_deref(),
    )
}

/// pkexec exit codes meaning auth was NOT granted: 126 = the user dismissed /
/// cancelled the auth dialog, 127 = authorization could not be obtained. Either
/// is treated as a decline → abort the uninstall and relaunch local.
fn declined(status: std::process::ExitStatus) -> bool {
    matches!(status.code(), Some(126 | 127))
}

/// Relaunch the currently-running AppImage in its OWN transient unit so it
/// survives this helper's exit — the same `systemd-run --user --collect <path>`
/// seam as `linux_service::run`. Best-effort: log ok/err, never fail over it.
/// Skipped when `path` is empty (no `--relaunch` was supplied).
fn relaunch(path: &str) {
    if path.is_empty() {
        log::info("uninstall: no --relaunch target supplied; skipping local relaunch");
        return;
    }
    let systemd_run = format!("{}/systemd-run", tool_dir("systemd-run"));
    match std::process::Command::new(&systemd_run)
        .args(["--user", "--collect", path])
        .status()
    {
        Ok(s) => log::info(&format!(
            "uninstall: relaunched local {path} via systemd-run (exit {:?})",
            s.code()
        )),
        Err(e) => log::error(&format!("uninstall: relaunch via systemd-run failed: {e}")),
    }
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
        // Exact ordered user_owned: pattern-kill -> adb-kill -> autostart -> lock
        // -> data-root wipe. (autostart is HOME-relative: matched by prefix+suffix.)
        let u = joined(&plan.user_owned);
        assert_eq!(u.len(), 5);
        assert_eq!(
            u[0],
            "/usr/bin/pkill -KILL -f WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server"
        );
        assert_eq!(u[1], "/usr/bin/pkill -KILL -x adb");
        assert!(u[2].starts_with("/usr/bin/rm -f ")
            && u[2].ends_with("/.config/autostart/ws-scrcpy-web-tray.desktop"));
        assert_eq!(u[3], "/usr/bin/rm -f /run/user/1000/ws-scrcpy-web.lock");
        assert_eq!(u[4], "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb");
        // privileged is empty -> no elevation.
        assert!(plan.privileged.is_empty());
        // no systemctl anywhere (no service installed).
        assert!(!u.iter().any(|c| c.contains("systemctl")));
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
        // system service + machine-wide, WIPE (keep=false): /opt fully removed AND
        // /var/opt fully removed (the data root here IS /var/opt). All root-owned.
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
        // /opt removed; /var/opt fully removed (bare rm -rf) because keep=false.
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/opt/ws-scrcpy-web"));
        // system menu entry, menu-cache refresh, icon.
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -f /usr/share/applications/ws-scrcpy-web.desktop"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/update-desktop-database /usr/share/applications"));
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
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/update-desktop-database /usr/share/applications"));
        assert!(p.iter().any(|c| c.contains("ws-scrcpy-web.png")));
        // no service installed -> no systemctl, and no /var/opt DATA-ROOT removal
        // (the fcontext -d /var/opt rule still stands as SELinux cleanup; only the
        // `rm` of the /var/opt state dir is absent — there is no system service).
        assert!(!p.iter().any(|c| c.contains("systemctl")));
        assert!(!p.iter().any(|c| c.contains("rm -rf /var/opt")));
        // user_owned still wipes the (user) data root.
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

    #[test]
    fn user_service_keep() {
        // user-scope service + KEEP: cascade in user_owned; data root selectively
        // cleaned (deps/bin/control) with config.json + logs preserved; none privileged.
        let plan = app_uninstall_commands(
            Some(Scope::User),
            false,
            true,
            "/usr/bin",
            DR_LOCAL,
            Some("/run/user/1000"),
        );
        let u = joined(&plan.user_owned);
        assert!(u.iter().any(|c| c.as_str() == "/usr/bin/systemctl --user stop WsScrcpyWeb.service"));
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/dependencies"));
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/control"));
        // never a bare wipe; never the preserved paths.
        assert!(!u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb"));
        assert!(!u.iter().any(|c| c.contains("config.json")));
        assert!(!u.iter().any(|c| c.contains("/logs")));
        assert!(plan.privileged.is_empty());
    }

    #[test]
    fn system_keep_preserves_var_opt_config_logs() {
        // system service + KEEP: /opt removed fully, but /var/opt gets the SELECTIVE
        // subdir rm so /var/opt/config.json + /var/opt/logs survive.
        let plan = app_uninstall_commands(
            Some(Scope::System),
            true,
            true,
            "/usr/bin",
            "/var/opt/ws-scrcpy-web",
            None,
        );
        let p = joined(&plan.privileged);
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /var/opt/ws-scrcpy-web/dependencies"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/opt/ws-scrcpy-web/bin"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/opt/ws-scrcpy-web/control"));
        // NO bare wipe of /var/opt (would delete the preserved config.json + logs).
        assert!(!p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/opt/ws-scrcpy-web"));
        assert!(!p.iter().any(|c| c.contains("config.json")));
        assert!(!p.iter().any(|c| c.contains("/logs")));
        // data root handled ONCE, in privileged — user_owned must not touch /var/opt.
        assert!(!joined(&plan.user_owned).iter().any(|c| c.contains("/var/opt")));
    }

    // ── Task 2: pure arg-parsing. The run fns shell out (and aren't even compiled
    //    on the Windows dev host), so `parse_args` is the only unit-testable part. ──

    #[test]
    fn parse_args_round_trips_full_valid() {
        let args: Vec<String> = [
            "--linux-app-uninstall",
            "--scope",
            "system",
            "--machine-wide",
            "1",
            "--wipe",
            "--data-root",
            "/var/opt/ws-scrcpy-web",
            "--relaunch",
            "/home/u/Apps/App.AppImage",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_args(&args),
            Some(UninstallArgs {
                svc_scope: Some(Scope::System),
                machine_wide: true,
                keep: false,
                data_root: "/var/opt/ws-scrcpy-web".to_string(),
                relaunch: "/home/u/Apps/App.AppImage".to_string(),
            })
        );
    }

    #[test]
    fn parse_args_scope_none_and_user() {
        // A full, otherwise-valid vector with only --scope varying.
        let with_scope = |scope: &str| -> Vec<String> {
            [
                "--linux-app-uninstall",
                "--scope",
                scope,
                "--machine-wide",
                "0",
                "--keep",
                "--data-root",
                "/home/u/.local/share/WsScrcpyWeb",
                "--relaunch",
                "/home/u/Apps/App.AppImage",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect()
        };
        // --scope none is VALID and maps to svc_scope: None (no service installed).
        assert_eq!(parse_args(&with_scope("none")).unwrap().svc_scope, None);
        assert_eq!(
            parse_args(&with_scope("user")).unwrap().svc_scope,
            Some(Scope::User)
        );
    }

    #[test]
    fn parse_args_requires_exactly_one_of_keep_wipe() {
        // Base vector WITHOUT --keep / --wipe; the test appends the combination.
        let with_flags = |flags: &[&str]| -> Vec<String> {
            let mut v: Vec<String> = [
                "--linux-app-uninstall",
                "--scope",
                "user",
                "--machine-wide",
                "0",
                "--data-root",
                "/home/u/.local/share/WsScrcpyWeb",
                "--relaunch",
                "/home/u/Apps/App.AppImage",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            v.extend(flags.iter().map(|s| s.to_string()));
            v
        };
        // both present → parse error; neither present → parse error.
        assert_eq!(parse_args(&with_flags(&["--keep", "--wipe"])), None);
        assert_eq!(parse_args(&with_flags(&[])), None);
        // exactly one → ok, with the expected keep bool (sanity).
        assert!(parse_args(&with_flags(&["--keep"])).unwrap().keep);
        assert!(!parse_args(&with_flags(&["--wipe"])).unwrap().keep);
    }

    #[test]
    fn parse_args_rejects_invalid_scope() {
        let args: Vec<String> = [
            "--linux-app-uninstall",
            "--scope",
            "bogus",
            "--machine-wide",
            "1",
            "--wipe",
            "--data-root",
            "/var/opt/ws-scrcpy-web",
            "--relaunch",
            "/home/u/Apps/App.AppImage",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_args(&args), None);
    }
}
