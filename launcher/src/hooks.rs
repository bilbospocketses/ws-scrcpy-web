// Velopack hook arg dispatch for the Rust launcher.
//
// Per SP3 P2 Contract 4 — the Rust velopack crate (0.0.1298) does NOT expose
// fast-callback builder methods (those are C# only). We parse hook flags
// ourselves BEFORE calling `VelopackApp::build().run()`, run the side effect
// synchronously, and exit.
//
// Contract:
//   --veloapp-install   <ver>  -> write skeleton config.json if absent
//   --veloapp-updated   <ver>  -> if service mode: servy-cli restart; else noop
//   --veloapp-uninstall <ver>  -> if service mode: servy stop + uninstall;
//                                 always preserve user data (config / deps / logs)
//
// In P2, servy-cli.exe is not yet bundled (P3). If it's absent on disk, we
// log a warning and return 0 — failing the Velopack lifecycle event over
// missing servy-cli would block the update from completing.

use std::path::{Path, PathBuf};
use std::process::Command;

use common::config::AppConfig;

use crate::log;

const FLAG_INSTALL: &str = "--veloapp-install";
const FLAG_UPDATED: &str = "--veloapp-updated";
const FLAG_UNINSTALL: &str = "--veloapp-uninstall";
const FLAG_OBSOLETE: &str = "--veloapp-obsolete";
const FLAG_PREFIX: &str = "--veloapp-";

#[derive(Debug, PartialEq, Eq)]
pub enum HookKind {
    Install,
    Updated,
    Uninstall,
    /// Velopack invokes the OLD launcher with `--veloapp-obsolete <old-version>`
    /// immediately before swapping `current\` to the new version. The hook
    /// is a chance to clean up state specific to the old version (running
    /// tray helper, supervised processes). v0.1.23-beta.5 → beta.6 VM
    /// testing first surfaced this flag — beta.1's catch-all handled it
    /// (logged + exit 0), and beta.7 promotes it to a proper handler so it
    /// stops appearing as "unknown velopack flag" in the launcher log.
    Obsolete,
    /// Any `--veloapp-*` flag we don't explicitly handle. v0.1.22 ship surfaced
    /// the in-app updater spawn-loop where Update.exe respawns the launcher
    /// indefinitely after passing some velopack lifecycle flag that
    /// VelopackApp::build().run() consumes silently. Catching the flag here
    /// (BEFORE VelopackApp::run()) lets us log it loudly and exit cleanly
    /// with code 0 so Update.exe sees success and stops retrying. The
    /// captured flag string lets us add a real handler in the next release.
    Unknown(String),
}

/// Pure: scan args for a hook flag. Returns the kind if matched. Recognized
/// flags take precedence over Unknown — we never catch-all over a known flag.
pub fn parse_hook_flag(args: &[String]) -> Option<HookKind> {
    let mut unknown: Option<String> = None;
    for a in args {
        match a.as_str() {
            FLAG_INSTALL => return Some(HookKind::Install),
            FLAG_UPDATED => return Some(HookKind::Updated),
            FLAG_UNINSTALL => return Some(HookKind::Uninstall),
            FLAG_OBSOLETE => return Some(HookKind::Obsolete),
            other if other.starts_with(FLAG_PREFIX) && unknown.is_none() => {
                unknown = Some(other.to_string());
            }
            _ => {}
        }
    }
    unknown.map(HookKind::Unknown)
}

/// Public entry: if argv contains a Velopack hook flag, handle it and return
/// `Some(exit_code)`. Otherwise return None (caller proceeds to normal launch).
pub fn handle_velopack_hook(args: &[String]) -> Option<i32> {
    let kind = parse_hook_flag(args)?;
    log::info(&format!("hook: dispatching {:?}", kind));

    let install_root = match resolve_install_root() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!("hook: could not resolve install root: {e}"));
            return Some(0);
        }
    };

    // Phase 1: writable state (config.json) lives at <dataRoot>. servy-cli
    // and other binaries continue to resolve from <installRoot>.
    let data_root = common::config::data_root_from_env().unwrap_or_else(|| install_root.clone());

    let code = match kind {
        HookKind::Install => on_install(&install_root, &data_root),
        HookKind::Updated => on_updated(&install_root, &data_root),
        HookKind::Uninstall => on_uninstall(&install_root, &data_root),
        HookKind::Obsolete => on_obsolete(),
        HookKind::Unknown(flag) => on_unknown(&flag),
    };
    Some(code)
}

fn resolve_install_root() -> anyhow::Result<PathBuf> {
    use anyhow::Context;
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    let install_root = exe_dir
        .parent()
        .context("exe_dir has no parent (cannot derive install_root)")?;
    Ok(install_root.to_path_buf())
}

/// Default skeleton config matching SP3 P2 Contract 1 defaults.
fn default_config_json() -> String {
    // Mirrors the TS defaults; the backend is the schema source of truth and
    // will fill in any keys we omit on first read. We keep this minimal so a
    // backend-side schema bump doesn't strand us with a stale skeleton.
    let v = serde_json::json!({
        "installMode": null,
        "firstRunComplete": false,
        "autoUpdate": true,
        "updateCheckIntervalMinutes": 60,
        "channel": "stable",
        "githubOwner": "bilbospocketses",
        "webPort": 8000
    });
    let mut s = serde_json::to_string_pretty(&v).expect("serde_json on a static value");
    s.push('\n');
    s
}

/// `--veloapp-obsolete <old-version>` fires on the OLD launcher binary
/// immediately before Velopack swaps `current\` to the new version. The
/// Job Object on the supervisor's Node child (v0.1.22+) already takes
/// care of process-tree cleanup when the supervisor exits; this hook
/// just needs to exit cleanly so Update.exe can proceed with the swap.
/// Returns 0 unconditionally — the swap MUST NOT be blocked here.
fn on_obsolete() -> i32 {
    log::info("hook(obsolete): exiting cleanly so Update.exe can swap current\\");
    0
}

/// Catch-all for unknown `--veloapp-*` flags. Logs the flag (via
/// `log::error` so it stands out in the launcher log) and returns 0.
/// Without this, Velopack's Rust SDK consumes the flag inside
/// `VelopackApp::build().run()` and exits the process silently, which
/// causes Update.exe to enter a respawn-retry loop (observed in v0.1.22
/// VM testing — 286 launcher spawns over 15 minutes with no progress).
fn on_unknown(flag: &str) -> i32 {
    log::error(&format!(
        "hook: unknown velopack flag {flag:?} — exiting 0 to avoid Update.exe respawn loop. \
         Add a handler in launcher/src/hooks.rs and ship a fix."
    ));
    0
}

fn on_install(install_root: &Path, data_root: &Path) -> i32 {
    // Phase 4 of Program Files migration: at MSI install time we run
    // elevated (PerMachine MSI), so this hook is the right place to:
    //   1. Create <dataRoot> if missing
    //   2. Grant Authenticated Users:Modify (OI)(CI) on <dataRoot>
    //   3. Grant Authenticated Users:Modify (OI)(CI) on <installRoot>  ← v0.1.23-beta.5
    //   4. Write skeleton config.json so the backend's first read
    //      finds a well-formed file
    //
    // Without step 2, the ProgramData root inherits Authenticated
    // Users:ReadAndExecute only — second-user logins can't write
    // config or downloaded deps.
    //
    // Without step 3, Velopack's writability self-test on the install
    // root fails (the user-mode running app can't write to Program
    // Files), Velopack falls back to LocalAppData for state, and the
    // in-app updater's elevated Update.exe re-launch silently fails
    // during the swap step (observed in v0.1.23-beta.3 → beta.4 VM
    // testing — "Re-launching as administrator" log line followed by
    // zero further log entries from the elevated process). Granting
    // user-Modify on the install root makes Velopack's self-test pass,
    // which short-circuits the entire elevation pathway and makes the
    // swap a regular file rename the running user can do directly.
    //
    // Trade-off: any logged-in user can modify the app binaries at
    // C:\Program Files\WsScrcpyWeb\. For a personal-tooling app this
    // is acceptable; multi-tenant deployments would need to revisit
    // (the Phase 6 ACL-tightening item in section 1d of the project
    // TODO file is the natural lever).
    //
    // The grant uses the Authenticated-Users SID (S-1-5-11) instead
    // of the localized group name so the command works regardless of
    // system locale.
    if !data_root.exists() {
        if let Err(e) = std::fs::create_dir_all(data_root) {
            log::error(&format!("hook(install): could not create {data_root:?}: {e}"));
            return 0;
        }
    }
    grant_data_root_acl(data_root);
    grant_install_root_acl(install_root);

    let cfg_path = data_root.join("config.json");
    if cfg_path.exists() {
        log::info(&format!("hook(install): {cfg_path:?} already present; leaving as-is"));
        return 0;
    }
    match std::fs::write(&cfg_path, default_config_json()) {
        Ok(()) => {
            log::info(&format!("hook(install): wrote skeleton {cfg_path:?}"));
            0
        }
        Err(e) => {
            // Don't fail the install over a config write — backend will
            // recreate on first server boot if necessary.
            log::error(&format!("hook(install): failed to write {cfg_path:?}: {e}"));
            0
        }
    }
}

/// Grant `Authenticated Users` Modify access (with object + container
/// inheritance) to the data root via `icacls`. Best-effort — failures
/// are logged but never block the install. Idempotent: re-running just
/// re-grants the same ACE.
///
/// Windows-only because `icacls` doesn't exist elsewhere; on non-Windows
/// the data root collapses to the install root and Linux ACL semantics
/// are managed elsewhere (a future concern).
#[cfg(windows)]
fn grant_data_root_acl(data_root: &Path) {
    // SID *S-1-5-11 = NT AUTHORITY\Authenticated Users (all locales).
    // (OI)(CI)M = Object Inheritance + Container Inheritance + Modify.
    // /T = recurse to existing items (fresh dir = no-op).
    // /C = continue on per-file errors (defensive).
    // /Q = suppress success spam.
    let target = data_root.as_os_str();
    let result = Command::new("icacls")
        .arg(target)
        .args(["/grant", "*S-1-5-11:(OI)(CI)M", "/T", "/C", "/Q"])
        // Suppress icacls's "Successfully processed N files" chatter —
        // we already log success/failure ourselves via the launcher
        // log file. Without this, the chatter leaks into test runners
        // and stdout-captured CI logs. Qualified rather than imported
        // so the unused-import lint doesn't fire on non-Windows builds
        // where this whole function is a no-op stub.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match result {
        Ok(status) if status.success() => {
            log::info(&format!(
                "hook(install): granted Authenticated Users:Modify (OI)(CI) on {data_root:?}"
            ));
        }
        Ok(status) => {
            log::error(&format!(
                "hook(install): icacls returned {} for {data_root:?}",
                status.code().unwrap_or(-1)
            ));
        }
        Err(e) => {
            log::error(&format!(
                "hook(install): could not invoke icacls on {data_root:?}: {e}"
            ));
        }
    }
}

#[cfg(not(windows))]
fn grant_data_root_acl(_data_root: &Path) {
    // Linux/macOS: data_root collapses to install_root; ACL handling
    // is out of scope for this hook on non-Windows hosts.
}

/// Grant `Authenticated Users` Modify on the INSTALL root via `icacls`.
/// See the long-form rationale on `on_install`. Best-effort: a failure
/// here means the in-app updater will fall back to the elevated-Update
/// flow, which is the v0.1.23-beta.4-and-earlier behavior we're trying
/// to leave behind. We log loudly but don't fail the install, since the
/// app itself still works without this grant — only the auto-updater is
/// degraded.
#[cfg(windows)]
fn grant_install_root_acl(install_root: &Path) {
    let target = install_root.as_os_str();
    let result = Command::new("icacls")
        .arg(target)
        .args(["/grant", "*S-1-5-11:(OI)(CI)M", "/T", "/C", "/Q"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match result {
        Ok(status) if status.success() => {
            log::info(&format!(
                "hook(install): granted Authenticated Users:Modify (OI)(CI) on {install_root:?}"
            ));
        }
        Ok(status) => {
            log::error(&format!(
                "hook(install): icacls returned {} for {install_root:?} — in-app updater will degrade to elevated-Update.exe path",
                status.code().unwrap_or(-1)
            ));
        }
        Err(e) => {
            log::error(&format!(
                "hook(install): could not invoke icacls on {install_root:?}: {e} — in-app updater will degrade to elevated-Update.exe path"
            ));
        }
    }
}

#[cfg(not(windows))]
fn grant_install_root_acl(_install_root: &Path) {
    // Linux/macOS: AppImage is single-file + writable to its owner;
    // the per-machine writability concern is Windows-specific.
}

fn on_updated(install_root: &Path, data_root: &Path) -> i32 {
    let cfg = AppConfig::load(data_root);
    if !cfg.is_service_mode() {
        log::info("hook(updated): not service mode; nothing to do");
        return 0;
    }

    // §32 follow-up — calling servy-cli synchronously here had Servy spawn
    // the new SERVICE LAUNCHER while Update.exe was still alive (Update.exe
    // is the parent of this hook process — it waits for the hook to exit
    // before completing its own cleanup + exit). The new Node child was
    // killed by file-sharing-violation on `<installRoot>\current\dist\`
    // before reaching even Logger init. v0.1.25-beta.10 smoke A.2 caught
    // this; ~75-second window where service appeared Stopped + app
    // unreachable until Servy's recoveryDelay timed out.
    //
    // Fix: spawn the launcher's --deferred-servy-restart subcommand
    // DETACHED. The hook returns 0 immediately so Update.exe can exit and
    // release file handles on current/. The detached subcommand sleeps
    // for DEFERRED_RESTART_DELAY_MS, then invokes `servy-cli restart`.
    let servy = install_root.join("current").join("servy-cli.exe");
    if !servy.exists() {
        log::info(&format!(
            "hook(updated): servy-cli.exe absent at {servy:?}; skipping (P2 OK)"
        ));
        return 0;
    }

    spawn_deferred_servy_restart(install_root)
}

/// 8 seconds: empirical buffer above the observed Update.exe lifetime.
/// v0.1.25-beta.10 smoke A.2 showed Update.exe still holding file handles
/// on current/ during the synchronous-hook window. 8s gives Update.exe
/// time to exit + release handles, while keeping the user-visible
/// "applying update" window short.
///
/// Gated on `cfg(windows)` because only the Windows arm of
/// `spawn_deferred_servy_restart` consumes it (Linux/macOS service mode
/// doesn't exist; the non-Windows arm falls back to synchronous
/// `run_servy`). Without the gate, clippy's `-D warnings` job on Linux
/// flags this as dead code.
#[cfg(windows)]
const DEFERRED_RESTART_DELAY_MS: &str = "8000";
const DEFERRED_RESTART_SERVICE: &str = "WsScrcpyWeb";

#[cfg(windows)]
fn spawn_deferred_servy_restart(install_root: &Path) -> i32 {
    use std::os::windows::process::CommandExt;

    // DETACHED_PROCESS = 0x00000008 — child has no inherited console.
    // CREATE_NEW_PROCESS_GROUP = 0x00000200 — child becomes its own process
    //   group leader, severing console-Ctrl signal propagation from the
    //   hook (and from Update.exe, the hook's parent). A stray Ctrl in the
    //   parent chain must not kill our deferred-restart helper.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const DETACHED_PROCESS: u32 = 0x00000008;

    let launcher = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!(
                "hook(updated): cannot resolve current_exe for deferred-restart spawn: {e} — falling back to synchronous run_servy"
            ));
            return run_servy(
                install_root,
                &["restart", "--name", DEFERRED_RESTART_SERVICE],
                "updated-fallback",
            );
        }
    };

    let spawn_result = Command::new(&launcher)
        .args([
            "--deferred-servy-restart",
            DEFERRED_RESTART_DELAY_MS,
            DEFERRED_RESTART_SERVICE,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
        .spawn();

    match spawn_result {
        Ok(child) => {
            log::info(&format!(
                "hook(updated): scheduled deferred servy-restart (child pid {}, delay {DEFERRED_RESTART_DELAY_MS}ms)",
                child.id()
            ));
            // Drop the child handle without wait()-ing — the child is
            // detached and will run independently of our process tree.
            std::mem::drop(child);
            0
        }
        Err(e) => {
            log::error(&format!(
                "hook(updated): failed to spawn deferred-servy-restart: {e} — falling back to synchronous run_servy"
            ));
            run_servy(
                install_root,
                &["restart", "--name", DEFERRED_RESTART_SERVICE],
                "updated-fallback",
            )
        }
    }
}

#[cfg(not(windows))]
fn spawn_deferred_servy_restart(install_root: &Path) -> i32 {
    // Service-mode is Windows-only; this branch should never execute on
    // non-Windows in production. Keep the pre-fix synchronous behavior
    // so unit tests + any unforeseen non-Windows service mode keep
    // working.
    run_servy(
        install_root,
        &["restart", "--name", DEFERRED_RESTART_SERVICE],
        "updated-fallback",
    )
}

fn on_uninstall(install_root: &Path, data_root: &Path) -> i32 {
    let cfg = AppConfig::load(data_root);
    if !cfg.is_service_mode() {
        log::info("hook(uninstall): not service mode; nothing to do");
        return 0;
    }
    // User data (config.json, dependencies/, logs/) is intentionally NOT
    // touched here.
    // Servy 8.2 CLI expects `--name <NAME>` for service-targeting commands
    // (matches the elevated_runner uninstall path); positional args don't
    // address any service. Pre-v0.1.21 these calls used positional args, so
    // servy-cli ran but the SCM entry survived MSI uninstall + reboot —
    // hooks::run_servy was missed during the v0.1.5 Servy-8.2 flag migration.
    let stop_code = run_servy(install_root, &["stop", "--name", "WsScrcpyWeb"], "uninstall:stop");
    let uninstall_code = run_servy(
        install_root,
        &["uninstall", "--name", "WsScrcpyWeb"],
        "uninstall:uninstall",
    );
    if stop_code != 0 {
        log::error(&format!("hook(uninstall): servy stop returned {stop_code}"));
    }
    if uninstall_code != 0 {
        log::error(&format!(
            "hook(uninstall): servy uninstall returned {uninstall_code}"
        ));
    }

    // v0.1.21: kill the standalone tray helper and remove its HKCU Run-key
    // entry. Mirrors the in-app uninstall path in elevated_runner. Without
    // these two steps an MSI uninstall:
    //   - leaves the tray icon resident (its exe is still loaded; MSI
    //     can't delete the on-disk binary while the process holds it,
    //     so MSI renames it to C:\Config.Msi\<id>.rbf and schedules
    //     delete-on-reboot — leaving a zombie tray pointing at a
    //     renamed file).
    //   - leaves an HKCU\...\Run\WsScrcpyWebTray entry pointing at a
    //     non-existent path, which is benign on next login but messy.
    // Best-effort, unconditional within service mode (the only path that
    // ever registered a standalone tray helper in the first place).
    if let Err(e) = crate::elevated_runner::unregister_tray_run_key() {
        log::error(&format!("hook(uninstall): tray Run-key cleanup: {e}"));
    } else {
        log::info("hook(uninstall): tray Run-key cleared");
    }
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "ws-scrcpy-web-tray.exe"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    // Always exit 0 — uninstall must not be blocked by a flaky service teardown.
    0
}

/// Locate `current/servy-cli.exe`, run it with the given args, return its
/// exit code (or 0 if absent — Contract 4 fault tolerance). Logs everything.
fn run_servy(install_root: &Path, args: &[&str], tag: &str) -> i32 {
    let servy = install_root.join("current").join("servy-cli.exe");
    if !servy.exists() {
        log::info(&format!(
            "hook({tag}): servy-cli.exe absent at {servy:?}; skipping (P2 OK)"
        ));
        return 0;
    }
    log::info(&format!("hook({tag}): invoking {servy:?} {args:?}"));
    match Command::new(&servy).args(args).status() {
        Ok(status) => {
            let code = status.code().unwrap_or(1);
            log::info(&format!("hook({tag}): servy exited with {code}"));
            code
        }
        Err(e) => {
            log::error(&format!("hook({tag}): failed to spawn servy: {e}"));
            // Spawn failure during a hook should not block update lifecycle.
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn s(v: &str) -> String {
        v.to_string()
    }

    #[test]
    fn parse_returns_none_for_unrelated_args() {
        let args = vec![s("foo"), s("--bar"), s("baz")];
        assert_eq!(parse_hook_flag(&args), None);
    }

    #[test]
    fn parse_returns_none_for_empty_args() {
        assert_eq!(parse_hook_flag(&[]), None);
    }

    #[test]
    fn parse_recognizes_install_flag() {
        let args = vec![s("--veloapp-install"), s("1.0.0")];
        assert_eq!(parse_hook_flag(&args), Some(HookKind::Install));
    }

    #[test]
    fn parse_recognizes_updated_flag() {
        let args = vec![s("--veloapp-updated"), s("1.1.0")];
        assert_eq!(parse_hook_flag(&args), Some(HookKind::Updated));
    }

    #[test]
    fn parse_recognizes_uninstall_flag() {
        let args = vec![s("--veloapp-uninstall"), s("1.0.0")];
        assert_eq!(parse_hook_flag(&args), Some(HookKind::Uninstall));
    }

    #[test]
    fn parse_recognizes_flag_in_any_position() {
        let args = vec![s("/foo/bar"), s("ignored"), s("--veloapp-updated")];
        assert_eq!(parse_hook_flag(&args), Some(HookKind::Updated));
    }

    #[test]
    fn parse_takes_first_match_when_multiple() {
        let args = vec![s("--veloapp-install"), s("--veloapp-uninstall")];
        assert_eq!(parse_hook_flag(&args), Some(HookKind::Install));
    }

    #[test]
    fn parse_recognizes_obsolete_flag() {
        let args = vec![s("--veloapp-obsolete"), s("0.1.23-beta.5")];
        assert_eq!(parse_hook_flag(&args), Some(HookKind::Obsolete));
    }

    #[test]
    fn on_obsolete_returns_zero() {
        assert_eq!(on_obsolete(), 0);
    }

    #[test]
    fn parse_recognizes_unknown_velopack_flag() {
        let args = vec![s("foo"), s("--veloapp-firstrun"), s("1.0.0")];
        assert_eq!(
            parse_hook_flag(&args),
            Some(HookKind::Unknown("--veloapp-firstrun".to_string()))
        );
    }

    #[test]
    fn parse_known_flag_wins_over_unknown_regardless_of_order() {
        let a = vec![s("--veloapp-firstrun"), s("--veloapp-install")];
        assert_eq!(parse_hook_flag(&a), Some(HookKind::Install));
        let b = vec![s("--veloapp-install"), s("--veloapp-firstrun")];
        assert_eq!(parse_hook_flag(&b), Some(HookKind::Install));
    }

    #[test]
    fn parse_first_unknown_wins_when_multiple_unknown() {
        let args = vec![s("--veloapp-foo"), s("--veloapp-bar")];
        assert_eq!(
            parse_hook_flag(&args),
            Some(HookKind::Unknown("--veloapp-foo".to_string()))
        );
    }

    #[test]
    fn on_unknown_returns_zero() {
        assert_eq!(on_unknown("--veloapp-firstrun"), 0);
    }

    #[test]
    fn install_writes_skeleton_when_absent() {
        let dir = tempdir().unwrap();
        // install_root and data_root collapse to the same dir in this test —
        // the icacls grants are best-effort and tolerated to fail under
        // tempdir paths, which is fine for unit testing the file-write path.
        let code = on_install(dir.path(), dir.path());
        assert_eq!(code, 0);
        let cfg = dir.path().join("config.json");
        assert!(cfg.exists());
        let body = fs::read_to_string(&cfg).unwrap();
        assert!(body.contains("\"firstRunComplete\""));
        assert!(body.contains("\"webPort\""));
        assert!(body.contains("\"channel\""));
        // Round-trip: AppConfig reader should parse it without error.
        let parsed = AppConfig::load(dir.path());
        assert!(!parsed.first_run_complete);
        assert_eq!(parsed.web_port, Some(8000));
    }

    #[test]
    fn install_leaves_existing_config_untouched() {
        let dir = tempdir().unwrap();
        let cfg = dir.path().join("config.json");
        let original = r#"{"installMode":"user-service","firstRunComplete":true,"webPort":8042}"#;
        fs::write(&cfg, original).unwrap();

        let code = on_install(dir.path(), dir.path());
        assert_eq!(code, 0);
        let after = fs::read_to_string(&cfg).unwrap();
        assert_eq!(after, original);
    }

    #[test]
    fn updated_noop_when_not_service_mode() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("config.json"),
            r#"{"installMode":"user","firstRunComplete":true}"#,
        )
        .unwrap();
        // No `current/servy-cli.exe` either way; this should still exit 0
        // because we short-circuit before looking for servy.
        // install_root and data_root collapse to the same dir in this test.
        assert_eq!(on_updated(dir.path(), dir.path()), 0);
    }

    #[test]
    fn updated_tolerates_absent_servy_in_service_mode() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("current")).unwrap();
        fs::write(
            dir.path().join("config.json"),
            r#"{"installMode":"user-service","firstRunComplete":true}"#,
        )
        .unwrap();
        // No servy-cli.exe placed -> P2 must log+exit 0, not fail.
        assert_eq!(on_updated(dir.path(), dir.path()), 0);
    }

    #[test]
    fn uninstall_noop_when_not_service_mode() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("config.json"),
            r#"{"installMode":null,"firstRunComplete":false}"#,
        )
        .unwrap();
        assert_eq!(on_uninstall(dir.path(), dir.path()), 0);
    }

    #[test]
    fn uninstall_tolerates_absent_servy_in_service_mode() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("current")).unwrap();
        fs::write(
            dir.path().join("config.json"),
            r#"{"installMode":"system-service","firstRunComplete":true}"#,
        )
        .unwrap();
        assert_eq!(on_uninstall(dir.path(), dir.path()), 0);
    }

    #[test]
    fn uninstall_preserves_user_data() {
        let dir = tempdir().unwrap();
        let cfg = dir.path().join("config.json");
        let deps = dir.path().join("dependencies");
        let logs = dir.path().join("logs");
        fs::create_dir_all(&deps).unwrap();
        fs::create_dir_all(&logs).unwrap();
        fs::write(deps.join("marker.txt"), "keep me").unwrap();
        fs::write(logs.join("server.log"), "keep me").unwrap();
        fs::write(&cfg, r#"{"installMode":"user-service"}"#).unwrap();

        on_uninstall(dir.path(), dir.path());

        assert!(cfg.exists(), "config.json must be preserved");
        assert!(deps.join("marker.txt").exists(), "deps must be preserved");
        assert!(logs.join("server.log").exists(), "logs must be preserved");
    }

    #[test]
    fn default_config_json_is_valid_and_parses_to_expected_defaults() {
        let body = default_config_json();
        let parsed: AppConfig = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed.install_mode, None);
        assert!(!parsed.first_run_complete);
        assert_eq!(parsed.web_port, Some(8000));
        // Pretty-printed and trailing-newline (Contract 1 persistence semantics).
        assert!(body.ends_with('\n'));
        assert!(body.contains("\n  "));
    }
}
