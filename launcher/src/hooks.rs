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
use std::process::{Command, Stdio};

use common::config::AppConfig;

use crate::log;

const FLAG_INSTALL: &str = "--veloapp-install";
const FLAG_UPDATED: &str = "--veloapp-updated";
const FLAG_UNINSTALL: &str = "--veloapp-uninstall";

#[derive(Debug, PartialEq, Eq)]
pub enum HookKind {
    Install,
    Updated,
    Uninstall,
}

/// Pure: scan args for a hook flag. Returns the kind if matched.
pub fn parse_hook_flag(args: &[String]) -> Option<HookKind> {
    for a in args {
        match a.as_str() {
            FLAG_INSTALL => return Some(HookKind::Install),
            FLAG_UPDATED => return Some(HookKind::Updated),
            FLAG_UNINSTALL => return Some(HookKind::Uninstall),
            _ => {}
        }
    }
    None
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
        HookKind::Install => on_install(&data_root),
        HookKind::Updated => on_updated(&install_root, &data_root),
        HookKind::Uninstall => on_uninstall(&install_root, &data_root),
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

fn on_install(data_root: &Path) -> i32 {
    // Phase 4 of Program Files migration: at MSI install time we run
    // elevated (PerMachine MSI), so this hook is the right place to:
    //   1. Create <dataRoot> if missing
    //   2. Grant Authenticated Users:Modify (OI)(CI) on <dataRoot>
    //   3. Write skeleton config.json so the backend's first read
    //      finds a well-formed file
    //
    // Without step 2, the ProgramData root inherits Authenticated
    // Users:ReadAndExecute only — second-user logins can't write
    // config or downloaded deps. The grant uses the
    // Authenticated-Users SID (S-1-5-11) instead of the localized
    // group name so the command works regardless of system locale.
    if !data_root.exists() {
        if let Err(e) = std::fs::create_dir_all(data_root) {
            log::error(&format!("hook(install): could not create {data_root:?}: {e}"));
            return 0;
        }
    }
    grant_data_root_acl(data_root);

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
        // and stdout-captured CI logs.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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

fn on_updated(install_root: &Path, data_root: &Path) -> i32 {
    let cfg = AppConfig::load(data_root);
    if !cfg.is_service_mode() {
        log::info("hook(updated): not service mode; nothing to do");
        return 0;
    }
    run_servy(install_root, &["restart", "WsScrcpyWeb"], "updated")
}

fn on_uninstall(install_root: &Path, data_root: &Path) -> i32 {
    let cfg = AppConfig::load(data_root);
    if !cfg.is_service_mode() {
        log::info("hook(uninstall): not service mode; nothing to do");
        return 0;
    }
    // User data (config.json, dependencies/, logs/) is intentionally NOT
    // touched here.
    let stop_code = run_servy(install_root, &["stop", "WsScrcpyWeb"], "uninstall:stop");
    let uninstall_code = run_servy(
        install_root,
        &["uninstall", "WsScrcpyWeb"],
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
    fn install_writes_skeleton_when_absent() {
        let dir = tempdir().unwrap();
        let code = on_install(dir.path());
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

        let code = on_install(dir.path());
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
