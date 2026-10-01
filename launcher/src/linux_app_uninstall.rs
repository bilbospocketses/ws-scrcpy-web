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
// On `--wipe` the step that deletes the WHOLE data root is lifted out of its
// group and run LAST in the process (`split_data_root_wipe` +
// `run_data_root_wipe`). Every log line does `create_dir_all(<dataRoot>/logs)`,
// so a process that logs inside the root it deletes must stop logging before
// the `rm`; anything after that would re-create `<dataRoot>/logs/launcher.log`
// (D6, qa-harness row 14.3 on beta.142). Same fix as the Windows cleaner:
// `log::disable()`, plus a report BESIDE the data root if the wipe fell short.
//
// The pkexec'd child logs to stderr, never a file (`main.rs` routes it on
// `PKEXEC_UID`), and the parent relays those lines into its own log as
// `elevated: …`. pkexec scrubs the env, so a file would land in
// `/root/.local/share/WsScrcpyWeb`; the privileged group also removes that
// stray tree, left by every pkexec'd run before the fix (D7).
//
// Local-Dependencies-Only: every tool is resolved under `bindir` (sbin tools via
// `sbindir_from(bindir)`) — never a bare name and never via PATH.
use crate::linux_service::{
    Scope, is_safe_relaunch_target, sbindir_from, scope_prefix, tool_dir, unit_path,
};
use crate::log;

/// App / systemd-unit identity shared by every footprint path.
const UNIT_NAME: &str = "WsScrcpyWeb";
/// Command-line substrings identifying every long-lived process the app can
/// spawn (server, launcher, the standalone tray, and an escaped scrcpy-server).
/// Matched in-process by `stray_kill_targets`, NOT handed to `pkill -f`: this
/// helper's own argv (`.../control/operation-server/ws-scrcpy-web-launcher.exe
/// ... --data-root .../WsScrcpyWeb`, or as root since beta.162
/// `/opt/ws-scrcpy-web/control/ws-scrcpy-web-launcher ...`) matches the pattern, and procps `pkill`
/// spares only ITSELF — so a `pkill -f` step SIGKILLed its parent, this helper,
/// before any later step ran (qa-harness arc L1, rows 14.3 / 14.6 on beta.140).
const PROC_NAMES: [&str; 4] = [
    "WsScrcpyWeb",
    "ws-scrcpy-web-tray",
    "ws-scrcpy-web-launcher",
    "scrcpy-server",
];
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
const FCONTEXT_SPECS: [&str; 2] = ["/opt/ws-scrcpy-web(/.*)?", "/opt/ws-scrcpy-web/data(/.*)?"];
/// Where every pkexec'd launcher run before D7's fix wrote its log: pkexec
/// scrubs `DATA_ROOT` and sets `HOME=/root`, so the log root resolved here and
/// left a root-owned `logs/launcher.log` nothing removed (D7). The privileged
/// group removes it. Never when it IS the data root (the app run as root).
const ROOT_STRAY_DATA_ROOT: &str = "/root/.local/share/WsScrcpyWeb";

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
    /// Unelevated steps: reap adb, user-scope service cascade, the instance
    /// lock, and the data root (whole, or regenerable subdirs when `keep`).
    /// The stray-process kill that precedes them is NOT an argv step — it runs
    /// in-process (`kill_strays`) so it can exclude this helper itself.
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
        [
            vec![systemctl.clone()],
            pre.clone(),
            vec!["stop".into(), unit.clone()],
        ]
        .concat(),
        [
            vec![systemctl.clone()],
            pre.clone(),
            vec!["disable".into(), unit.clone()],
        ]
        .concat(),
        [
            vec![systemctl.clone()],
            pre.clone(),
            vec!["reset-failed".into(), unit.clone()],
        ]
        .concat(),
        vec![
            rm.clone(),
            "-f".into(),
            unit_file.to_string_lossy().into_owned(),
        ],
        [
            vec![systemctl.clone()],
            pre.clone(),
            vec!["daemon-reload".into()],
        ]
        .concat(),
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
    // 1. stray app processes are killed in-process by `kill_strays` just before
    //    this group runs — see PROC_NAMES for why it is not a `pkill -f` step.
    //
    // 1b. reap the bundled adb daemon by exact name — it daemonizes and escapes
    //     the name match above. `-x adb` cannot match this helper.
    let mut user_owned: Vec<Vec<String>> = vec![vec![
        format!("{bindir}/pkill"),
        "-KILL".into(),
        "-x".into(),
        "adb".into(),
    ]];

    // 2. user-scope service cascade — only when the service was installed --user.
    if svc_scope == Some(Scope::User) {
        user_owned.extend(service_teardown(Scope::User, bindir));
    }

    // 2b. tray autostart entry — defensive: pre-beta.45 installs wrote it. Always
    //     attempted; HOME-relative (resolved like unit_path).
    let home = crate::linux_service::home_dir();
    user_owned.push(vec![
        rm.clone(),
        "-f".into(),
        format!("{home}/.config/autostart/ws-scrcpy-web-tray.desktop"),
    ]);

    // 3. single-instance lock — only when the runtime dir is known.
    if let Some(xrd) = xdg_runtime_dir {
        user_owned.push(vec![
            rm.clone(),
            "-f".into(),
            format!("{xrd}/ws-scrcpy-web.lock"),
        ]);
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
        // 5. the stray log root earlier pkexec'd runs left in root's home (D7).
        //    Skipped when it is the data root itself, so --keep still keeps it.
        if data_root != ROOT_STRAY_DATA_ROOT {
            privileged.push(vec![
                rm.clone(),
                "-rf".into(),
                ROOT_STRAY_DATA_ROOT.to_string(),
            ]);
        }
    }

    UninstallPlan {
        privileged,
        user_owned,
    }
}

// ─── Task 2: dispatch + execution (runs the pure builder above) ────────────────

/// Parsed `--linux-app-uninstall[-elevated]` invocation. `relaunch` is only
/// meaningful on the unelevated path (the currently-running `$APPIMAGE` to
/// restart if the user declines the pkexec prompt); it defaults to `""` on the
/// elevated path, which never relaunches. `server_pid` is the Node server that
/// asked for the uninstall (D17); only the unelevated path reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallArgs {
    pub svc_scope: Option<Scope>,
    pub machine_wide: bool,
    pub keep: bool,
    pub data_root: String,
    pub relaunch: String,
    pub server_pid: Option<i32>,
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
    // --server-pid <pid>  (optional; present but not a pid > 1 = parse error)
    let server_pid = match args.iter().position(|a| a == "--server-pid") {
        None => None,
        Some(i) => match args.get(i + 1).and_then(|v| v.parse::<i32>().ok()) {
            Some(pid) if pid > 1 => Some(pid),
            _ => return None,
        },
    };
    Some(UninstallArgs {
        svc_scope,
        machine_wide,
        keep,
        data_root,
        relaunch,
        server_pid,
    })
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
    // Identify the requesting server NOW, before a pkexec prompt gives its pid
    // time to be reused (D17).
    let server = a.server_pid.map(|pid| (pid, start_time_of(pid)));
    // Whole-data-root wipes held back until every other step has run and logged.
    let mut wipes: Vec<(Vec<String>, &str)> = Vec::new();

    // 1. Privileged group FIRST. Already root -> run it directly (no pkexec);
    //    non-root -> re-invoke self under ONE pkexec; empty -> skip elevation.
    let is_root = rustix::process::getuid().is_root();
    match privileged_mode(is_root, plan.privileged.is_empty()) {
        PrivMode::Skip => {}
        PrivMode::Direct => {
            // Already root (system-service mode): run the privileged group
            // DIRECTLY, best-effort (mirrors linux_service::run / the user_owned
            // loop). No relaunch — a complete uninstall never relaunches. The
            // root service hands us DATA_ROOT=/var/lib/ws-scrcpy-web, so this
            // process logs inside the /var/lib root it wipes: defer that step.
            log::info(
                "uninstall: already root (system-service) — running privileged group directly",
            );
            let (steps, wipe) = split_data_root_wipe(&plan.privileged, &a.data_root);
            run_best_effort(&steps, "uninstall (root)");
            wipes.extend(wipe.map(|w| (w, "uninstall (root)")));
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
            // The child logs to stderr, not a file (D7: under pkexec its log root
            // would be /root/.local/share/WsScrcpyWeb), so relay its lines here.
            match run_relaying_stderr(std::process::Command::new(&pkexec).arg(&exe).args([
                "--linux-app-uninstall-elevated",
                "--scope",
                scope_arg,
                "--machine-wide",
                mw_arg,
                keep_arg,
                "--data-root",
                a.data_root.as_str(),
            ])) {
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
    //    The requesting server goes first, by pid: its command line need not
    //    carry any PROC_NAMES entry (D17), and it logs one last line into the
    //    data root as it exits, so it must be gone before anything is wiped.
    if let Some((pid, start)) = server {
        wait_for_server_exit(pid, start);
    }
    kill_strays();
    let (steps, wipe) = split_data_root_wipe(&plan.user_owned, &a.data_root);
    run_best_effort(&steps, "uninstall");
    wipes.extend(wipe.map(|w| (w, "uninstall")));

    // 3. The whole-data-root wipe, last of all — nothing may log after it (D6).
    for (argv, label) in &wipes {
        run_data_root_wipe(argv, label, &a.data_root);
    }
    0
}

/// One `/proc` entry, as much of it as the stray kill needs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcEntry {
    pid: i32,
    ppid: i32,
    /// argv joined with spaces — what `pkill -f` matches against.
    cmdline: String,
}

/// Pids to SIGKILL: every process whose command line contains one of
/// `PROC_NAMES`, EXCEPT `self_pid` and its ancestors. Excluding the ancestor
/// chain is the part `pkill` cannot do: it spares only itself, so a pkill run
/// from this helper killed the helper. Pure so it is unit-testable off-Linux.
fn stray_kill_targets(procs: &[ProcEntry], self_pid: i32) -> Vec<i32> {
    let ppid_of: std::collections::HashMap<i32, i32> =
        procs.iter().map(|p| (p.pid, p.ppid)).collect();
    let mut spared = std::collections::HashSet::new();
    let mut cur = self_pid;
    // `insert` returning false stops a malformed (cyclic) chain; pid 0/1 end it.
    while cur > 1 && spared.insert(cur) {
        match ppid_of.get(&cur) {
            Some(&pp) => cur = pp,
            None => break,
        }
    }
    procs
        .iter()
        .filter(|p| !spared.contains(&p.pid))
        .filter(|p| PROC_NAMES.iter().any(|n| p.cmdline.contains(n)))
        .map(|p| p.pid)
        .collect()
}

/// Parse the ppid out of `/proc/<pid>/stat`. The comm field is parenthesised
/// and may itself contain spaces or `)`, so split after the LAST `)`: the
/// fields that follow are `state ppid ...`.
fn parse_stat_ppid(stat: &str) -> Option<i32> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// Snapshot `/proc`. Processes that vanish mid-read, and kernel threads (empty
/// cmdline), are skipped.
fn read_procs() -> Vec<ProcEntry> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(|e| {
        let pid: i32 = e.ok()?.file_name().to_str()?.parse().ok()?;
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        if raw.is_empty() {
            return None;
        }
        let cmdline = String::from_utf8_lossy(&raw)
            .trim_end_matches('\0')
            .replace('\0', " ");
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        Some(ProcEntry {
            pid,
            ppid: parse_stat_ppid(&stat)?,
            cmdline,
        })
    })
    .collect()
}

/// SIGKILL every stray app process except this helper and its ancestors.
/// Best-effort, like the argv groups: a failed kill is logged, never fatal.
fn kill_strays() {
    let self_pid = rustix::process::getpid().as_raw_nonzero().get();
    for pid in stray_kill_targets(&read_procs(), self_pid) {
        let Some(p) = rustix::process::Pid::from_raw(pid) else {
            continue;
        };
        match rustix::process::kill_process(p, rustix::process::Signal::KILL) {
            Ok(()) => log::info(&format!("uninstall ok: killed stray pid {pid}")),
            Err(e) => log::error(&format!("uninstall: kill stray pid {pid} failed: {e}")),
        }
    }
}

/// How long the requesting server gets to exit by itself. It schedules its own
/// exit 1.5 s after spawning this helper (`ServiceApi`, app-uninstall).
const SERVER_EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
const SERVER_EXIT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// `(state, starttime)` from `/proc/<pid>/stat`. As in `parse_stat_ppid`, the
/// fields after the LAST `)` start at field 3 (state); starttime is field 22.
fn parse_stat_state_start(stat: &str) -> Option<(char, u64)> {
    let mut rest = stat[stat.rfind(')')? + 1..].split_whitespace();
    let state = rest.next()?.chars().next()?;
    let start = rest.nth(18)?.parse().ok()?;
    Some((state, start))
}

/// Whether the process recorded as `(pid, start)` has exited, given its
/// current `/proc/<pid>/stat` (`None`: no such pid). A zombie has exited (its
/// parent has not reaped it yet), and a different starttime means the pid now
/// belongs to someone else. An unreadable start at record time falls back to
/// "the pid exists". Pure.
fn server_gone(stat_now: Option<&str>, start: Option<u64>) -> bool {
    let Some((state, now)) = stat_now.and_then(parse_stat_state_start) else {
        return true;
    };
    matches!(state, 'Z' | 'X') || start.is_some_and(|s| s != now)
}

fn read_stat(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()
}

fn start_time_of(pid: i32) -> Option<u64> {
    read_stat(pid)
        .as_deref()
        .and_then(parse_stat_state_start)
        .map(|(_, s)| s)
}

/// Wait for the server that requested the uninstall to exit by itself, then
/// SIGKILL it if it has not (D17). Matching it by name is not enough: the seed
/// node runs as `/tmp/.mount_WsScrc<rand>/usr/bin/seed/node/node ...`, which
/// carries no `PROC_NAMES` entry, so the stray kill missed it, the wipe ran
/// inside its 1.5 s exit delay, and its exit line re-created the data root.
fn wait_for_server_exit(pid: i32, start: Option<u64>) {
    wait_or_kill(pid, start, SERVER_EXIT_WAIT);
}

#[derive(Debug, PartialEq, Eq)]
enum ServerExit {
    Exited,
    Killed,
    KillFailed,
}

fn wait_or_kill(pid: i32, start: Option<u64>, wait: std::time::Duration) -> ServerExit {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if server_gone(read_stat(pid).as_deref(), start) {
            log::info(&format!(
                "uninstall: requesting server pid {pid} has exited"
            ));
            return ServerExit::Exited;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(SERVER_EXIT_POLL);
    }
    let Some(p) = rustix::process::Pid::from_raw(pid) else {
        return ServerExit::KillFailed;
    };
    if let Err(e) = rustix::process::kill_process(p, rustix::process::Signal::KILL) {
        log::error(&format!("uninstall: kill server pid {pid} failed: {e}"));
        return ServerExit::KillFailed;
    }
    log::info(&format!(
        "uninstall ok: requesting server pid {pid} did not exit in {}s; killed it",
        wait.as_secs()
    ));
    // A SIGKILL is delivered asynchronously; give it a moment to land.
    for _ in 0..10 {
        if server_gone(read_stat(pid).as_deref(), start) {
            break;
        }
        std::thread::sleep(SERVER_EXIT_POLL);
    }
    ServerExit::Killed
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
    let (steps, wipe) = split_data_root_wipe(&plan.privileged, &a.data_root);
    run_best_effort(&steps, "uninstall (root)");
    if let Some(argv) = wipe {
        run_data_root_wipe(&argv, "uninstall (root)", &a.data_root);
    }
    0
}

/// Lift the step that deletes the WHOLE data root out of `group`, keeping the
/// rest in order, so the caller can run it last. A `--keep` plan has no such
/// step (it deletes only regenerable subdirs, and there `logs/` is meant to
/// survive), so it comes back unchanged with `None`.
fn split_data_root_wipe(
    group: &[Vec<String>],
    data_root: &str,
) -> (Vec<Vec<String>>, Option<Vec<String>>) {
    let mut wipe = None;
    let mut steps = Vec::with_capacity(group.len());
    for argv in group {
        let whole_root =
            argv.len() == 3 && argv[0].ends_with("/rm") && argv[1] == "-rf" && argv[2] == data_root;
        if whole_root && wipe.is_none() {
            wipe = Some(argv.clone());
        } else {
            steps.push(argv.clone());
        }
    }
    (steps, wipe)
}

/// Whether this process's log root sits at or under the data root being wiped
/// — i.e. whether a log line written after the wipe would re-create it.
/// Component-wise, so `.../WsScrcpyWebX` is not inside `.../WsScrcpyWeb`. An
/// unresolvable log root counts as inside: when we cannot tell, silence is the
/// safe side of a wipe.
fn logs_inside(log_root: Option<&std::path::Path>, data_root: &std::path::Path) -> bool {
    match log_root {
        Some(root) => root.starts_with(data_root),
        None => true,
    }
}

/// Where the wipe report goes: a SIBLING of the data root, e.g.
/// `~/.local/share/WsScrcpyWeb-uninstall-report.txt` or
/// `/var/lib/ws-scrcpy-web-uninstall-report.txt`. Never inside it — that would
/// re-create the tree the wipe just removed. `None` when the data root has no
/// parent or name. The Windows cleaner's `residue_report_path` is the model.
fn residue_report_path(data_root: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(data_root);
    let name = path.file_name()?;
    let parent = path.parent()?;
    let mut filename = name.to_os_string();
    filename.push("-uninstall-report.txt");
    Some(parent.join(filename))
}

/// How many surviving entries the report lists before truncating.
const RESIDUE_REPORT_MAX_LISTED: usize = 40;

/// The wipe report body, or `None` when the wipe was clean — the file's
/// PRESENCE is the signal, so a clean uninstall leaves nothing behind. Pure: the
/// caller supplies the timestamp, the `rm` failure (if any) and what is left.
/// `remaining` is `None` when the data root is gone.
fn wipe_report_body(
    timestamp: &str,
    data_root: &str,
    failure: Option<&str>,
    remaining: Option<&[String]>,
) -> Option<String> {
    if failure.is_none() && remaining.is_none() {
        return None;
    }
    let mut out = format!("ws-scrcpy-web uninstall {timestamp} UTC (--wipe)\n");
    out.push_str(&format!(
        "rm -rf {data_root}: {}\n",
        failure.unwrap_or("exited 0")
    ));
    match remaining {
        None => out.push_str(&format!("{data_root} is gone\n")),
        Some(entries) => {
            out.push_str(&format!(
                "{data_root} still exists; {} entr{} left in it:\n",
                entries.len(),
                if entries.len() == 1 { "y" } else { "ies" }
            ));
            for e in entries.iter().take(RESIDUE_REPORT_MAX_LISTED) {
                out.push_str(&format!("  {e}\n"));
            }
            if entries.len() > RESIDUE_REPORT_MAX_LISTED {
                out.push_str(&format!(
                    "  … and {} more\n",
                    entries.len() - RESIDUE_REPORT_MAX_LISTED
                ));
            }
        }
    }
    Some(out)
}

/// Run the whole-data-root `rm -rf` as this process's LAST step (D6).
///
/// When this process logs inside the root it is deleting (the unelevated helper,
/// and the root-Direct helper whose DATA_ROOT is /var/lib), it says what it is
/// about to do, turns logging off, and then runs the `rm`; its outcome goes to
/// a report beside the data root, written only if the wipe fell short. When it
/// logs elsewhere (the pkexec child, whose HOME is /root) nothing can be
/// re-created, so the step runs and logs like any other.
fn run_data_root_wipe(argv: &[String], label: &str, data_root: &str) {
    let log_root = common::config::try_data_root_from_env();
    if !logs_inside(log_root.as_deref(), std::path::Path::new(data_root)) {
        run_best_effort(&[argv.to_vec()], label);
        return;
    }
    log::info(&format!(
        "{label}: wiping {data_root} last; this process logs inside it, so logging stops here"
    ));
    log::disable();
    let failure = match run_argv(argv) {
        Ok(s) if s.success() => None,
        Ok(s) => Some(format!("exited {:?}", s.code())),
        Err(e) => Some(format!("could not start ({e})")),
    };
    let remaining = std::fs::read_dir(data_root).ok().map(|dir| {
        let mut names: Vec<String> = dir
            .filter_map(|e| Some(e.ok()?.file_name().to_string_lossy().into_owned()))
            .collect();
        names.sort();
        names
    });
    let timestamp = log::format_timestamp_utc(std::time::SystemTime::now());
    if let (Some(body), Some(path)) = (
        wipe_report_body(
            &timestamp,
            data_root,
            failure.as_deref(),
            remaining.as_deref(),
        ),
        residue_report_path(data_root),
    ) {
        let _ = std::fs::write(path, body);
    }
}

/// Run `cmd` with its stderr piped, copying each line into this process's log
/// as it arrives, then wait for it. pkexec's own messages (a failed auth, a
/// missing agent) arrive the same way, so they are logged too.
fn run_relaying_stderr(
    cmd: &mut std::process::Command,
) -> std::io::Result<std::process::ExitStatus> {
    use std::io::BufRead;
    let mut child = cmd.stderr(std::process::Stdio::piped()).spawn()?;
    if let Some(stderr) = child.stderr.take() {
        for line in std::io::BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
        {
            log::info(&relayed_line(&line));
        }
    }
    child.wait()
}

/// How a relayed child line reads in the parent's log.
fn relayed_line(line: &str) -> String {
    format!("elevated: {line}")
}

/// Spawn one argv-vector and wait for it.
fn run_argv(argv: &[String]) -> std::io::Result<std::process::ExitStatus> {
    let (cmd, rest) = argv.split_first().expect("non-empty argv");
    std::process::Command::new(cmd).args(rest).status()
}

/// Run a best-effort command group: log each step's outcome and KEEP GOING on
/// failure (never aborts the teardown). `label` distinguishes the privileged
/// (root) group from the user-owned group in the log lines.
fn run_best_effort(group: &[Vec<String>], label: &str) {
    for argv in group {
        match run_argv(argv) {
            Ok(s) if s.success() => log::info(&format!("{label} ok: {}", argv.join(" "))),
            Ok(s) => log::error(&format!(
                "{label} non-zero ({:?}): {}",
                s.code(),
                argv.join(" ")
            )),
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
    // §71 — shared user-relaunch builder (--user --collect <target>).
    let argv = crate::linux_service::user_relaunch_command(&systemd_run, &[], path);
    let (cmd, rest) = argv.split_first().expect("non-empty argv");
    match std::process::Command::new(cmd).args(rest).status() {
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
        let plan = app_uninstall_commands(
            None,
            false,
            false,
            "/usr/bin",
            DR_LOCAL,
            Some("/run/user/1000"),
        );
        // Exact ordered user_owned: adb-kill -> autostart -> lock -> data-root
        // wipe. (autostart is HOME-relative: matched by prefix+suffix.) The
        // stray-process kill runs in-process before this group (kill_strays).
        let u = joined(&plan.user_owned);
        assert_eq!(u.len(), 4);
        assert_eq!(u[0], "/usr/bin/pkill -KILL -x adb");
        assert!(
            u[1].starts_with("/usr/bin/rm -f ")
                && u[1].ends_with("/.config/autostart/ws-scrcpy-web-tray.desktop")
        );
        assert_eq!(u[2], "/usr/bin/rm -f /run/user/1000/ws-scrcpy-web.lock");
        assert_eq!(u[3], "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb");
        // privileged is empty -> no elevation.
        assert!(plan.privileged.is_empty());
        // no systemctl anywhere (no service installed).
        assert!(!u.iter().any(|c| c.contains("systemctl")));
    }

    #[test]
    fn local_keep() {
        // keep=true deletes only deps/bin/control; preserves root, config.json, logs/.
        let plan = app_uninstall_commands(
            None,
            false,
            true,
            "/usr/bin",
            DR_LOCAL,
            Some("/run/user/1000"),
        );
        let u = joined(&plan.user_owned);
        assert!(
            u.iter()
                .any(|c| c.as_str()
                    == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/dependencies")
        );
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/bin")
        );
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/control")
        );
        // NOT a bare wipe of the data root itself.
        assert!(
            !u.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb")
        );
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
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/systemctl --user stop WsScrcpyWeb.service")
        );
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/systemctl --user disable WsScrcpyWeb.service")
        );
        assert!(u
            .iter()
            .any(|c| c.as_str() == "/usr/bin/systemctl --user reset-failed WsScrcpyWeb.service"));
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/systemctl --user daemon-reload")
        );
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
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/systemctl stop WsScrcpyWeb.service")
        );
        assert!(!p.iter().any(|c| c.contains("--user")));
        // /opt removed; /var/lib fully removed (bare rm -rf) because keep=false.
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web")
        );
        // system menu entry, menu-cache refresh, icon.
        assert!(
            p.iter()
                .any(|c| c.as_str()
                    == "/usr/bin/rm -f /usr/share/applications/ws-scrcpy-web.desktop")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/update-desktop-database /usr/share/applications")
        );
        assert!(p.iter().any(|c| c.as_str()
            == "/usr/bin/rm -f /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png"));
        // SELinux fcontext: the /opt bin_t rule + the legacy /opt/.../data rule, via
        // sbin. NO /var/lib rule is removed — the state dir needs none (var_lib_t default).
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web(/.*)?")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str()
                    == "/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web/data(/.*)?")
        );
        assert!(!p.iter().any(|c| c.contains("fcontext -d /var/lib")));
    }

    #[test]
    fn machine_wide_no_service() {
        // /opt install but NO service -> privileged runs (no systemctl); data root still wiped.
        let plan = app_uninstall_commands(
            None,
            true,
            false,
            "/usr/bin",
            DR_LOCAL,
            Some("/run/user/1000"),
        );
        let p = joined(&plan.privileged);
        assert!(!plan.privileged.is_empty());
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str()
                    == "/usr/bin/rm -f /usr/share/applications/ws-scrcpy-web.desktop")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/update-desktop-database /usr/share/applications")
        );
        assert!(p.iter().any(|c| c.contains("ws-scrcpy-web.png")));
        // no service installed -> no systemctl, and no system DATA-ROOT removal
        // (the /opt fcontext -d still runs as machine-wide cleanup; only the `rm` of
        // the /var/lib state dir is absent — there is no system service).
        assert!(!p.iter().any(|c| c.contains("systemctl")));
        assert!(!p.iter().any(|c| c.contains("rm -rf /var/lib")));
        // user_owned still wipes the (user) data root.
        assert!(
            joined(&plan.user_owned)
                .iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb")
        );
    }

    #[test]
    fn lock_skipped_when_no_runtime_dir() {
        // xdg_runtime_dir = None -> no lock-removal command is emitted.
        let plan = app_uninstall_commands(None, false, false, "/usr/bin", DR_LOCAL, None);
        let u = joined(&plan.user_owned);
        assert!(!u.iter().any(|c| c.contains("ws-scrcpy-web.lock")));
        // but the adb reap is still first and the data root is still wiped.
        assert_eq!(u[0], "/usr/bin/pkill -KILL -x adb");
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb")
        );
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
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/systemctl --user stop WsScrcpyWeb.service")
        );
        assert!(
            u.iter()
                .any(|c| c.as_str()
                    == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/dependencies")
        );
        assert!(
            u.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb/control")
        );
        // never a bare wipe; never the preserved paths.
        assert!(
            !u.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb")
        );
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
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web/dependencies")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web/bin")
        );
        assert!(
            p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web/control")
        );
        // NO bare wipe of /var/lib (would delete the preserved config.json + logs).
        assert!(
            !p.iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /var/lib/ws-scrcpy-web")
        );
        assert!(!p.iter().any(|c| c.contains("config.json")));
        assert!(!p.iter().any(|c| c.contains("/logs")));
        // data root handled ONCE, in privileged — user_owned must not touch /var/lib.
        assert!(
            !joined(&plan.user_owned)
                .iter()
                .any(|c| c.contains("/var/lib"))
        );
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
                server_pid: None,
            })
        );
    }

    // ── D17: the requesting server, by pid ──

    fn valid_with(extra: &[&str]) -> Vec<String> {
        [
            "--linux-app-uninstall",
            "--scope",
            "none",
            "--machine-wide",
            "0",
            "--wipe",
            "--data-root",
            "/home/qa/.local/share/WsScrcpyWeb",
        ]
        .iter()
        .chain(extra)
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn parse_args_takes_an_optional_server_pid() {
        assert_eq!(parse_args(&valid_with(&[])).unwrap().server_pid, None);
        assert_eq!(
            parse_args(&valid_with(&["--server-pid", "4242"]))
                .unwrap()
                .server_pid,
            Some(4242)
        );
        for bad in [
            &["--server-pid"][..],
            &["--server-pid", "x"],
            &["--server-pid", "1"],
            &["--server-pid", "-5"],
        ] {
            assert_eq!(parse_args(&valid_with(bad)), None, "{bad:?}");
        }
    }

    /// A `/proc/<pid>/stat` line with a comm that has a space and a `)` in it.
    fn stat(state: char, start: u64) -> String {
        format!(
            "4242 (node) x) {state} 4200 4242 4242 0 -1 4194304 1 0 0 0 5 3 0 0 20 0 11 0 {start} 1000 200"
        )
    }

    #[test]
    fn parse_stat_reads_state_and_starttime_after_the_last_paren() {
        assert_eq!(
            parse_stat_state_start(&stat('S', 987654)),
            Some(('S', 987654))
        );
        assert_eq!(parse_stat_state_start("garbage"), None);
    }

    #[test]
    fn server_gone_when_absent_zombie_or_reused_and_not_while_running() {
        // The seed node still running, as qa-harness caught it: not gone.
        assert!(!server_gone(Some(&stat('S', 100)), Some(100)));
        assert!(!server_gone(Some(&stat('R', 100)), None));
        // Exited: no /proc entry, or a zombie its parent has not reaped.
        assert!(server_gone(None, Some(100)));
        assert!(server_gone(Some(&stat('Z', 100)), Some(100)));
        // The pid now belongs to a different process.
        assert!(server_gone(Some(&stat('S', 555)), Some(100)));
    }

    #[test]
    fn wait_or_kill_waits_for_a_real_exit_and_kills_one_that_hangs() {
        use std::time::Duration;
        // Exits by itself: it stays a zombie of this test process, which counts as gone.
        let mut quick = std::process::Command::new("sleep")
            .arg("0.3")
            .spawn()
            .unwrap();
        let pid = quick.id() as i32;
        let t0 = std::time::Instant::now();
        assert_eq!(
            wait_or_kill(pid, start_time_of(pid), Duration::from_secs(5)),
            ServerExit::Exited
        );
        assert!(
            t0.elapsed() >= Duration::from_millis(200),
            "returned before it exited"
        );
        let _ = quick.wait();

        // Never exits in time: killed, and gone afterwards.
        let mut hung = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = hung.id() as i32;
        let start = start_time_of(pid);
        assert!(start.is_some());
        assert_eq!(
            wait_or_kill(pid, start, Duration::from_millis(300)),
            ServerExit::Killed
        );
        assert!(server_gone(read_stat(pid).as_deref(), start));
        let _ = hung.wait();
    }

    #[test]
    fn the_seed_node_carries_no_proc_name_so_only_the_pid_catches_it() {
        // Measured by qa-harness (row 14.3, beta.148): the mount point cuts the
        // app name to `WsScrc`, so the name match alone never selected it.
        let seed = ProcEntry {
            pid: 4242,
            ppid: 4200,
            cmdline: "/tmp/.mount_WsScrclgObOd/usr/bin/seed/node/node --max-old-space-size=4096 /tmp/.mount_WsScrclgObOd/usr/bin/dist/index.js".into(),
        };
        assert_eq!(stray_kill_targets(&[seed], 1000), Vec::<i32>::new());
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
        assert_eq!(
            parse_args(&with_data_root("/var/lib/ws-scrcpy-web/../../etc")),
            None
        );
        assert_eq!(parse_args(&with_data_root("--privileged")), None);
        assert_eq!(parse_args(&with_data_root("relative/WsScrcpyWeb")), None);
        assert_eq!(parse_args(&with_data_root("")), None);
    }

    #[test]
    fn no_plan_ever_pattern_kills() {
        // Regression (beta.140, qa-harness L1): a `pkill -f` over the app's names
        // matches this helper's own argv, and pkill spares only itself, so it
        // SIGKILLed the helper before any later step ran. No combination of
        // inputs may put one back in either group.
        for svc in [None, Some(Scope::User), Some(Scope::System)] {
            for mw in [false, true] {
                for keep in [false, true] {
                    let plan = app_uninstall_commands(
                        svc,
                        mw,
                        keep,
                        "/usr/bin",
                        DR_LOCAL,
                        Some("/run/user/1000"),
                    );
                    for c in joined(&plan.user_owned)
                        .iter()
                        .chain(joined(&plan.privileged).iter())
                    {
                        assert!(
                            !(c.contains("/pkill ") && c.contains(" -f ")),
                            "pattern kill in plan: {c}"
                        );
                    }
                }
            }
        }
    }

    fn pe(pid: i32, ppid: i32, cmdline: &str) -> ProcEntry {
        ProcEntry {
            pid,
            ppid,
            cmdline: cmdline.to_string(),
        }
    }

    /// The helper's real argv from the beta.140 journal (arc L1 run 2).
    const HELPER: &str = "/home/qa/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe --linux-app-uninstall --scope none --machine-wide 0 --wipe --data-root /home/qa/.local/share/WsScrcpyWeb --relaunch /home/qa/Downloads/WsScrcpyWeb-linux-beta.AppImage";

    #[test]
    fn stray_kill_spares_self_and_ancestors_but_kills_strays() {
        let procs = vec![
            pe(1, 0, "/sbin/init"),
            pe(900, 1, "/usr/lib/systemd/systemd --user"),
            // the helper, spawned by the user manager via systemd-run
            pe(1000, 900, HELPER),
            // a (hypothetical) wrapper ancestor whose argv also matches
            pe(950, 900, "/tmp/.mount_WsScrcpyWeb/AppRun"),
            pe(1001, 950, "sh -c WsScrcpyWeb"),
            // strays: the server's node, the tray, an escaped scrcpy-server
            pe(
                2000,
                900,
                "/tmp/.mount_WsScrcpyWebXYZ/usr/bin/node dist/index.js",
            ),
            pe(
                2001,
                900,
                "/home/qa/.local/share/WsScrcpyWeb/bin/ws-scrcpy-web-tray",
            ),
            pe(
                2002,
                2000,
                "app_process / com.genymobile.scrcpy.Server 4.1 scrcpy-server",
            ),
            // unrelated
            pe(3000, 900, "/usr/bin/gnome-shell"),
        ];
        let mut t = stray_kill_targets(&procs, 1000);
        t.sort();
        assert_eq!(t, vec![950, 1001, 2000, 2001, 2002]);
        // Now the helper is a child of 1001 -> 950: both ancestors are spared.
        let mut nested = procs.clone();
        nested[2] = pe(1000, 1001, HELPER);
        let mut t = stray_kill_targets(&nested, 1000);
        t.sort();
        assert_eq!(t, vec![2000, 2001, 2002]);
    }

    #[test]
    fn stray_kill_survives_a_cyclic_ppid_chain() {
        // A malformed snapshot must terminate, not loop.
        let procs = vec![pe(10, 11, HELPER), pe(11, 10, "WsScrcpyWeb")];
        assert_eq!(stray_kill_targets(&procs, 10), Vec::<i32>::new());
    }

    #[test]
    fn parse_stat_ppid_handles_parens_and_spaces_in_comm() {
        assert_eq!(parse_stat_ppid("1234 (node) S 900 1234 1234 0"), Some(900));
        assert_eq!(parse_stat_ppid("1234 (a) b) (c) R 77 1 1"), Some(77));
        assert_eq!(parse_stat_ppid("garbage"), None);
    }

    // ── D6: the whole-data-root wipe runs last, and nothing logs after it ──

    #[test]
    fn split_lifts_the_local_wipe_out_and_keeps_the_rest_in_order() {
        let plan = app_uninstall_commands(
            None,
            false,
            false,
            "/usr/bin",
            DR_LOCAL,
            Some("/run/user/1000"),
        );
        let (steps, wipe) = split_data_root_wipe(&plan.user_owned, DR_LOCAL);
        assert_eq!(
            wipe.map(|w| w.join(" ")).as_deref(),
            Some("/usr/bin/rm -rf /home/u/.local/share/WsScrcpyWeb")
        );
        assert_eq!(joined(&steps), joined(&plan.user_owned[..3]));
    }

    #[test]
    fn split_lifts_the_var_lib_wipe_out_of_the_privileged_group() {
        // The root-Direct sibling: /var/lib is wiped mid-group today, and the
        // .desktop / icon / semanage steps after it all log inside /var/lib.
        let dr = "/var/lib/ws-scrcpy-web";
        let plan = app_uninstall_commands(Some(Scope::System), true, false, "/usr/bin", dr, None);
        let (steps, wipe) = split_data_root_wipe(&plan.privileged, dr);
        assert_eq!(
            wipe.map(|w| w.join(" ")).as_deref(),
            Some("/usr/bin/rm -rf /var/lib/ws-scrcpy-web")
        );
        assert_eq!(steps.len(), plan.privileged.len() - 1);
        // /opt is still removed, in the ordinary group.
        assert!(
            joined(&steps)
                .iter()
                .any(|c| c.as_str() == "/usr/bin/rm -rf /opt/ws-scrcpy-web")
        );
    }

    #[test]
    fn keep_plans_have_nothing_to_lift() {
        // --keep deletes only deps/bin/control; logs/ is meant to survive.
        for (svc, dr) in [
            (None, DR_LOCAL),
            (Some(Scope::User), DR_LOCAL),
            (Some(Scope::System), "/var/lib/ws-scrcpy-web"),
        ] {
            let plan = app_uninstall_commands(svc, true, true, "/usr/bin", dr, None);
            for group in [&plan.user_owned, &plan.privileged] {
                let (steps, wipe) = split_data_root_wipe(group, dr);
                assert!(wipe.is_none(), "{svc:?}: keep must not lift a wipe");
                assert_eq!(joined(&steps), joined(group));
            }
        }
    }

    #[test]
    fn every_wipe_plan_defers_exactly_one_whole_root_rm() {
        // Across every scope / machine-wide combination, a --wipe plan holds the
        // whole-root rm exactly once, and after splitting no ordinary step is it.
        for svc in [None, Some(Scope::User), Some(Scope::System)] {
            for mw in [false, true] {
                let plan = app_uninstall_commands(svc, mw, false, "/usr/bin", DR_LOCAL, None);
                let (u_steps, u_wipe) = split_data_root_wipe(&plan.user_owned, DR_LOCAL);
                let (p_steps, p_wipe) = split_data_root_wipe(&plan.privileged, DR_LOCAL);
                assert_eq!(
                    usize::from(u_wipe.is_some()) + usize::from(p_wipe.is_some()),
                    1,
                    "{svc:?} mw={mw}"
                );
                let bare = format!("/usr/bin/rm -rf {DR_LOCAL}");
                assert!(
                    !joined(&u_steps)
                        .iter()
                        .chain(joined(&p_steps).iter())
                        .any(|c| *c == bare),
                    "{svc:?} mw={mw}: the wipe was left in an ordinary group"
                );
            }
        }
    }

    #[test]
    fn logs_inside_is_component_wise_and_fails_safe() {
        use std::path::Path;
        let dr = Path::new(DR_LOCAL);
        assert!(logs_inside(Some(dr), dr));
        assert!(logs_inside(Some(&dr.join("logs")), dr));
        // The pkexec child logs under /root, never inside /var/lib.
        assert!(!logs_inside(
            Some(Path::new("/root/.local/share/WsScrcpyWeb")),
            Path::new("/var/lib/ws-scrcpy-web")
        ));
        // A string prefix is not a path prefix.
        assert!(!logs_inside(
            Some(Path::new("/home/u/.local/share/WsScrcpyWebX")),
            dr
        ));
        // Unknown log root -> treat as inside (stay silent through the wipe).
        assert!(logs_inside(None, dr));
    }

    #[test]
    fn the_wipe_report_is_a_sibling_of_the_data_root_never_inside_it() {
        for (dr, want) in [
            (
                DR_LOCAL,
                "/home/u/.local/share/WsScrcpyWeb-uninstall-report.txt",
            ),
            (
                "/var/lib/ws-scrcpy-web",
                "/var/lib/ws-scrcpy-web-uninstall-report.txt",
            ),
        ] {
            let p = residue_report_path(dr).expect("data root has a parent");
            assert_eq!(p, std::path::PathBuf::from(want));
            assert!(!p.starts_with(dr));
        }
        assert!(residue_report_path("/").is_none());
    }

    #[test]
    fn a_clean_wipe_writes_no_report() {
        assert!(wipe_report_body("t", DR_LOCAL, None, None).is_none());
    }

    #[test]
    fn a_short_wipe_reports_the_failure_and_what_is_left() {
        let left = vec!["logs".to_string()];
        let body = wipe_report_body("t", DR_LOCAL, Some("exited Some(1)"), Some(&left)).unwrap();
        assert!(body.contains("(--wipe)"));
        assert!(body.contains(&format!("rm -rf {DR_LOCAL}: exited Some(1)")));
        assert!(body.contains("1 entry left in it:\n  logs\n"));

        // rm said 0 but something re-created the root: still worth a report.
        let body = wipe_report_body("t", DR_LOCAL, None, Some(&left)).unwrap();
        assert!(body.contains(": exited 0\n"));

        // rm failed but the root is gone anyway.
        let body = wipe_report_body("t", DR_LOCAL, Some("exited Some(1)"), None).unwrap();
        assert!(body.contains("is gone"));

        let many: Vec<String> = (0..45).map(|i| format!("e{i}")).collect();
        let body = wipe_report_body("t", DR_LOCAL, None, Some(&many)).unwrap();
        assert!(body.contains("45 entries"));
        assert!(body.contains("… and 5 more"));
        assert!(!body.contains("e44"));
    }

    // ── D7: the root-owned log root earlier pkexec'd runs left behind ──

    #[test]
    fn privileged_group_removes_the_root_stray_log_root() {
        let stray = "/usr/bin/rm -rf /root/.local/share/WsScrcpyWeb";
        for (svc, mw, dr) in [
            (None, true, DR_LOCAL),
            (Some(Scope::User), true, DR_LOCAL),
            (Some(Scope::System), true, "/var/lib/ws-scrcpy-web"),
            (Some(Scope::System), false, "/var/lib/ws-scrcpy-web"),
        ] {
            for keep in [false, true] {
                let plan = app_uninstall_commands(svc, mw, keep, "/usr/bin", dr, None);
                let p = joined(&plan.privileged);
                assert!(p.iter().any(|c| c == stray), "{svc:?} mw={mw} keep={keep}");
                assert!(!joined(&plan.user_owned).iter().any(|c| c == stray));
            }
        }
    }

    #[test]
    fn the_root_stray_is_never_removed_when_it_is_the_data_root() {
        // The app run AS root: /root/.local/share/WsScrcpyWeb is its real data
        // root, so --keep must keep it and --wipe removes it once, as the data root.
        let dr = "/root/.local/share/WsScrcpyWeb";
        let keep = app_uninstall_commands(None, true, true, "/usr/bin", dr, None);
        assert!(
            !joined(&keep.privileged)
                .iter()
                .chain(joined(&keep.user_owned).iter())
                .any(|c| c.as_str() == "/usr/bin/rm -rf /root/.local/share/WsScrcpyWeb")
        );
        let wipe = app_uninstall_commands(None, true, false, "/usr/bin", dr, None);
        let all: Vec<String> = joined(&wipe.privileged)
            .into_iter()
            .chain(joined(&wipe.user_owned))
            .collect();
        assert_eq!(
            all.iter()
                .filter(|c| c.as_str() == "/usr/bin/rm -rf /root/.local/share/WsScrcpyWeb")
                .count(),
            1
        );
    }

    #[test]
    fn a_local_uninstall_still_needs_no_elevation() {
        // The stray clean-up rides the privileged group; it must not create one.
        let plan = app_uninstall_commands(None, false, false, "/usr/bin", DR_LOCAL, None);
        assert!(plan.privileged.is_empty());
    }

    #[test]
    fn relayed_child_lines_are_marked_elevated() {
        assert_eq!(
            relayed_line("2026-09-29 13:27:56.016 [INFO] uninstall (root) ok: x"),
            "elevated: 2026-09-29 13:27:56.016 [INFO] uninstall (root) ok: x"
        );
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
