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
// spawned by the server via `systemd-run --user --collect`) runs the
// `privileged` group FIRST (so a declined/failed elevation aborts before
// anything is removed), then the `user_owned` group. HOW the privileged group
// runs depends on the server's uid — mirroring the service-update path's
// `getuid()==0 ? direct : pkexec` split (the decision is the pure
// `privileged_mode`):
//   * already root (the ROOT system-service launched the helper): run the
//     privileged group DIRECTLY, no pkexec (it would prompt redundantly). A
//     complete uninstall, so this path never relaunches.
//   * non-root (local / user-scope service): re-invoke the launcher under ONE
//     pkexec; that lands on the ELEVATED entry `handle_elevated`
//     (`--linux-app-uninstall-elevated`), which runs ONLY the `privileged` group
//     as root. A pkexec decline (126/127) or a privileged failure aborts the
//     uninstall and relaunches the running AppImage locally so the user is never
//     stranded.
// The direct and the pkexec-elevated executions feed the SAME args to the SAME
// builder, so the privileged/user_owned split is identical either way.
//
// Local-Dependencies-Only: every tool is resolved under `bindir` (sbin tools via
// `sbindir_from(bindir)`) — never a bare name and never via PATH.
use crate::linux_service::{is_safe_relaunch_target, scope_prefix, sbindir_from, tool_dir, unit_path, Scope};
use crate::log;

/// App / systemd-unit identity shared by every footprint path.
const UNIT_NAME: &str = "WsScrcpyWeb";
/// `pkill -f` pattern matching every long-lived process the app can spawn
/// (server, launcher, the standalone tray, and an escaped scrcpy-server).
const PROC_PATTERN: &str = "WsScrcpyWeb|ws-scrcpy-web-tray|ws-scrcpy-web-launcher|scrcpy-server";
/// Machine-wide install staging dir: binary + bundled deps, root-owned, ALWAYS
/// fully removed (never "kept"). The system-service DATA root (/var/lib, holding
/// config.json + logs) is deliberately NOT a const — it arrives as `data_root` so
/// keep/wipe applies to it exactly like a user data root.
const OPT_DIR: &str = "/opt/ws-scrcpy-web";
/// System menu entry + icon a machine-wide install drops under /usr/share.
const SYS_DESKTOP: &str = "/usr/share/applications/ws-scrcpy-web.desktop";
const SYS_ICON: &str = "/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png";
/// SELinux fcontext specs the install adds / may need cleaning: the /opt bin_t
/// tree rule, plus the legacy beta.40 /opt/.../data rule (removed too so a stale
/// rule never lingers). The /var/lib state needs NO rule (var_lib_t by the policy
/// default `/var/lib(/.*)?`), so it is not listed. Matches clear-install.sh.
const FCONTEXT_SPECS: [&str; 2] = [
    "/opt/ws-scrcpy-web(/.*)?",
    "/opt/ws-scrcpy-web/data(/.*)?",
];

/// Ordered teardown argv-vectors for a complete app uninstall, split by
/// privilege. `privileged` is meant to run under ONE elevation (pkexec, Task 2);
/// an EMPTY `privileged` means a purely-local install with no root footprint, so
/// the dispatch layer can skip the elevation prompt entirely.
#[derive(Debug, Clone)]
pub struct UninstallPlan {
    /// Root-only steps: system service cascade, the /opt staging removal, the
    /// system-service data root (/var/lib) keep/wipe, the .desktop + icon plus a
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
/// system-service data root (/var/lib/...) — whichever owns config.json + logs.
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
    //    ~/.local/...). A system service's data_root is /var/lib (root-owned), so
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
        // 2b. system-service data root (/var/lib) keep/wipe — root-owned, emitted
        //     here (NOT in user_owned). No blanket /var/lib rm: that would delete the
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

/// Validate a `--data-root` before it is forwarded across pkexec into a root
/// `rm -rf {data_root}/...`. Only the two paths the app actually uses are
/// allowed; an arbitrary absolute path, a `..` traversal, a relative value or a
/// flag-shaped value is refused so the privileged delete can never be
/// retargeted. (#14)
fn is_valid_data_root(s: &str) -> bool {
    if s.is_empty() || s.starts_with('-') || !s.starts_with('/') {
        return false;
    }
    if s.split('/').any(|seg| seg == ".." || seg == ".") {
        return false;
    }
    s == "/var/lib/ws-scrcpy-web" || s.ends_with("/.local/share/WsScrcpyWeb")
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
    if !is_valid_data_root(&data_root) {
        return None;
    }
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

/// Unelevated run, invoked from the (possibly non-root) server. The privileged
/// group runs FIRST, then the best-effort `user_owned` group runs on EVERY path.
/// `privileged_mode` picks HOW the privileged group runs — mirroring the
/// service-update path's `getuid()==0 ? direct : pkexec` split:
///   * `Skip`   — empty group (purely-local install): no elevation at all.
///   * `Direct` — already root (the root system-service launched us): run the
///     group DIRECTLY, best-effort (same idiom as `user_owned`); pkexec would
///     prompt redundantly. A complete uninstall, so it never relaunches.
///   * `Pkexec` — non-root: re-invoke self under ONE pkexec. A decline (126/127),
///     a privileged failure, or a spawn error aborts + relaunches the local
///     AppImage and returns 0 (the privileged group is all-or-nothing there — it
///     never partially ran — so the user keeps a working local app).
fn run_unelevated(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "linux-app-uninstall: scope={:?} machine_wide={} keep={}",
        a.svc_scope, a.machine_wide, a.keep
    ));
    let plan = plan_for(a);

    // 1. Privileged group FIRST. Already root -> run it directly (no pkexec);
    //    non-root -> re-invoke self under ONE pkexec; empty -> skip elevation.
    let is_root = rustix::process::getuid().is_root();
    match privileged_mode(is_root, plan.privileged.is_empty()) {
        PrivMode::Skip => {}
        PrivMode::Direct => {
            // Already root (system-service mode): run the privileged group
            // DIRECTLY, best-effort (mirrors linux_service::run / the user_owned
            // loop). No relaunch — a complete uninstall never relaunches.
            log::info("uninstall: already root (system-service) — running privileged group directly");
            run_best_effort(&plan.privileged, "uninstall (root)");
        }
        PrivMode::Pkexec => {
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
            // argv all the way (no `sh -c`): re-invoke ourselves under pkexec with
            // the same inputs MINUS --relaunch (the elevated half never relaunches).
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
    }

    // 2. Unelevated group (kills our own processes + tears down the user data
    //    root). Best-effort: log non-zero, KEEP GOING (mirrors linux_service::run).
    run_best_effort(&plan.user_owned, "uninstall");
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
    run_best_effort(&plan.privileged, "uninstall (root)");
    0
}

/// Run a best-effort command group: log each step's outcome and KEEP GOING on
/// failure (never aborts the teardown). `label` distinguishes the privileged
/// (root) group from the user-owned group in the log lines.
fn run_best_effort(group: &[Vec<String>], label: &str) {
    for argv in group {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        match std::process::Command::new(cmd).args(rest).status() {
            Ok(s) if s.success() => log::info(&format!("{label} ok: {}", argv.join(" "))),
            Ok(s) => log::error(&format!("{label} non-zero ({:?}): {}", s.code(), argv.join(" "))),
            Err(e) => log::error(&format!("{label} spawn failed: {} ({e})", argv.join(" "))),
        }
    }
}

/// How `run_unelevated` runs the privileged teardown group — the
/// `getuid()==0 ? direct : pkexec` decision, made pure so its three outcomes are
/// unit-testable even though the run fns themselves shell out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrivMode {
    /// Empty privileged group (purely-local install): no elevation at all.
    Skip,
    /// Already root (the root system-service launched the helper): run the group
    /// directly, no pkexec.
    Direct,
    /// Non-root (local / user-scope server): re-invoke self under ONE pkexec.
    Pkexec,
}

/// Decide how to run the privileged group: `Skip` when it's empty (no root-owned
/// footprint), else `Direct` when already root (pkexec would prompt redundantly /
/// wrongly when the root system-service launched us), else `Pkexec`. Pure — the
/// caller passes `is_root` from `getuid().is_root()` — so all three branches are
/// unit-testable.
fn privileged_mode(is_root: bool, privileged_empty: bool) -> PrivMode {
    if privileged_empty {
        PrivMode::Skip
    } else if is_root {
        PrivMode::Direct
    } else {
        PrivMode::Pkexec
    }
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
    // #50: the --relaunch path is externally supplied; validate it before it
    // becomes an exec target. This relaunch runs as the user (systemd-run
    // --user), so no root-owned requirement.
    if !is_safe_relaunch_target(std::path::Path::new(path), false) {
        log::error(&format!(
            "uninstall: refusing unsafe --relaunch target {path:?}; skipping local relaunch"
        ));
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
        // /var/lib fully removed (the data root here IS /var/lib). All root-owned.
        let plan = app_uninstall_commands(
            Some(Scope::System),
            true,
            false,
            "/usr/bin",
            "/var/lib/ws-scrcpy-web",
            None,
        );
        let p = joined(&plan.privileged);
        // system service cascade (system prefix = empty, so NO --user).
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/systemctl stop WsScrcpyWeb.service"));
        assert!(!p.iter().any(|c| c.contains("--user")));
        // /opt removed; /var/lib fully removed (bare rm -rf) because keep=false.
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web"));
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
        // SELinux fcontext: the /opt bin_t rule + the legacy /opt/.../data rule, via
        // sbin. NO /var/lib rule is removed — the state dir needs none (var_lib_t default).
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web(/.*)?"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web/data(/.*)?"));
        assert!(!p.iter().any(|c| c.contains("fcontext -d /var/lib")));
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
        // no service installed -> no systemctl, and no system DATA-ROOT removal
        // (the /opt fcontext -d still runs as machine-wide cleanup; only the `rm` of
        // the /var/lib state dir is absent — there is no system service).
        assert!(!p.iter().any(|c| c.contains("systemctl")));
        assert!(!p.iter().any(|c| c.contains("rm -rf /var/lib")));
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
    fn system_keep_preserves_var_lib_config_logs() {
        // system service + KEEP: /opt removed fully, but /var/lib gets the SELECTIVE
        // subdir rm so /var/lib/config.json + /var/lib/logs survive.
        let plan = app_uninstall_commands(
            Some(Scope::System),
            true,
            true,
            "/usr/bin",
            "/var/lib/ws-scrcpy-web",
            None,
        );
        let p = joined(&plan.privileged);
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web"));
        assert!(p
            .iter()
            .any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web/dependencies"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web/bin"));
        assert!(p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web/control"));
        // NO bare wipe of /var/lib (would delete the preserved config.json + logs).
        assert!(!p.iter().any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web"));
        assert!(!p.iter().any(|c| c.contains("config.json")));
        assert!(!p.iter().any(|c| c.contains("/logs")));
        // data root handled ONCE, in privileged — user_owned must not touch /var/lib.
        assert!(!joined(&plan.user_owned).iter().any(|c| c.contains("/var/lib")));
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
            "/var/lib/ws-scrcpy-web",
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
                data_root: "/var/lib/ws-scrcpy-web".to_string(),
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
            "/var/lib/ws-scrcpy-web",
            "--relaunch",
            "/home/u/Apps/App.AppImage",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_invalid_data_root() {
        let with_data_root = |dr: &str| -> Vec<String> {
            [
                "--linux-app-uninstall",
                "--scope",
                "system",
                "--machine-wide",
                "1",
                "--wipe",
                "--data-root",
                dr,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect()
        };
        // The two real data roots are accepted.
        assert!(parse_args(&with_data_root("/var/lib/ws-scrcpy-web")).is_some());
        assert!(parse_args(&with_data_root("/home/u/.local/share/WsScrcpyWeb")).is_some());
        // Arbitrary, traversal, flag-shaped, relative and empty values are
        // rejected — the elevated `rm -rf {data_root}` must never be retargeted (#14).
        assert_eq!(parse_args(&with_data_root("/etc")), None);
        assert_eq!(parse_args(&with_data_root("/var/lib/ws-scrcpy-web/../../etc")), None);
        assert_eq!(parse_args(&with_data_root("--privileged")), None);
        assert_eq!(parse_args(&with_data_root("relative/WsScrcpyWeb")), None);
        assert_eq!(parse_args(&with_data_root("")), None);
    }

    #[test]
    fn privileged_mode_skip_direct_pkexec() {
        // Empty privileged group → no elevation at all, whatever the uid.
        assert_eq!(privileged_mode(false, true), PrivMode::Skip);
        assert_eq!(privileged_mode(true, true), PrivMode::Skip);
        // Non-empty + already root → run directly (no pkexec).
        assert_eq!(privileged_mode(true, false), PrivMode::Direct);
        // Non-empty + non-root → pkexec re-invoke.
        assert_eq!(privileged_mode(false, false), PrivMode::Pkexec);
    }
}
