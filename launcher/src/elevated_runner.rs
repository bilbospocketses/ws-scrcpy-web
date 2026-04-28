// Elevate-on-demand helper for service install / uninstall.
//
// The Node server runs unelevated (Velopack installs us per-user under
// %LocalAppData%, no admin needed for normal operation). But Servy's CLI
// needs admin to register a service with SCM, so when the user clicks
// "yes install service" the Node server spawns this launcher binary in
// `--elevate-and-run` mode via PowerShell `Start-Process -Verb RunAs`.
// PowerShell shows the UAC prompt; the user accepts; this helper runs
// elevated; it executes servy-cli + reg.exe + tray spawn directly; it
// writes a result JSON to a known temp path; it exits.
//
// Argv shape:
//   ws-scrcpy-web-launcher.exe --elevate-and-run <command> <args-json-path> <result-json-path>
//
// where:
//   <command>           = "install-service" | "uninstall-service"
//   <args-json-path>    = absolute path to a temp file containing
//                         JSON-encoded args (caller wrote it, helper reads it)
//   <result-json-path>  = absolute path the helper writes the structured
//                         result to before exit
//
// Result JSON shape:
//   {
//     "ok": bool,
//     "exitCode": int,         // overall helper exit code (0 on full success)
//     "stdout": string,        // captured servy-cli stdout
//     "stderr": string,        // captured servy-cli stderr
//     "errorMessage": string?  // present when ok=false; user-friendly summary
//   }
//
// Exit codes:
//   0  = full success (servy-cli + post-actions all succeeded)
//   2  = malformed argv (caller bug — should never happen in production)
//   3  = could not read args JSON
//   4  = servy-cli invocation failed (non-zero exit). Result JSON still
//        written with stderr captured. Caller decides what to surface.
//   5  = could not write result JSON (filesystem error in temp dir)
//
// A non-zero exit always still writes the result JSON if at all possible
// — the caller reads the JSON for user-facing error messages, regardless
// of exit code. The exit code is only consulted as a safety net when the
// result JSON is missing entirely.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::log;
#[cfg(windows)]
use crate::user_session_spawn::{spawn_in_active_user_session, SpawnUserLauncherArgs};

/// Args we accept from the Node caller. Each `command` has its own
/// expected schema; we deserialize as a generic JSON value first and then
/// branch.
#[derive(Debug, Deserialize)]
pub struct InstallServiceArgs {
    pub servy_path: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub bin_path: String,
    pub startup_dir: String,
    pub startup_type: String,
    pub max_restart_attempts: u32,
    /// Already formatted as KEY=VAL;KEY2=VAL2 by the caller — we don't
    /// parse + re-emit, since that's purely a Node-side concern.
    pub env_vars: String,
    pub log_path: String,
    /// Optional tray-helper path. If present and the file exists, we
    /// register the HKCU Run-key and spawn the tray detached.
    pub tray_helper_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UninstallServiceArgs {
    pub servy_path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Default)]
pub struct ElevatedResult {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub error_message: Option<String>,
}

/// Public entry: if argv contains the elevate-and-run flag, handle it and
/// return `Some(exit_code)`. Otherwise return None (caller proceeds to
/// normal launch).
pub fn handle(args: &[String]) -> Option<i32> {
    let pos = args.iter().position(|a| a == "--elevate-and-run")?;
    let command = args.get(pos + 1).map(String::as_str)?;
    let args_path = args.get(pos + 2)?;
    let result_path = args.get(pos + 3)?;

    log::info(&format!(
        "elevate-and-run: command={command} args_path={args_path} result_path={result_path}"
    ));

    let args_path = PathBuf::from(args_path);
    let result_path = PathBuf::from(result_path);

    let result = match command {
        "install-service" => match read_args::<InstallServiceArgs>(&args_path) {
            Ok(a) => install_service(&a),
            Err(e) => fail(3, &format!("could not read args JSON: {e}")),
        },
        "uninstall-service" => match read_args::<UninstallServiceArgs>(&args_path) {
            Ok(a) => uninstall_service(&a),
            Err(e) => fail(3, &format!("could not read args JSON: {e}")),
        },
        // Cross-session user-session spawn for the v0.1.8 uninstall
        // Path A flow. Caller is the SERVICE-instance Node process
        // (running as Local System), which has SE_TCB_NAME and so can
        // call WTSQueryUserToken. We bridge through this elevated-run
        // command so the WTS-API code lives in one Rust module and
        // the Node side has a uniform interface.
        #[cfg(windows)]
        "spawn-user-launcher" => match read_args::<SpawnUserLauncherArgs>(&args_path) {
            Ok(a) => spawn_user_launcher_command(&a),
            Err(e) => fail(3, &format!("could not read args JSON: {e}")),
        },
        unknown => fail(2, &format!("unknown elevate-and-run command: {unknown}")),
    };

    let final_code = result.exit_code;
    if let Err(e) = write_result(&result_path, &result) {
        log::error(&format!("could not write result JSON to {result_path:?}: {e}"));
        // Even a failed result-write doesn't change the exit code we
        // return; the caller will see "no result file present" and infer
        // that the helper itself died. Use exit code 5 only when result
        // was OK but write failed.
        if result.ok {
            return Some(5);
        }
    }

    Some(final_code)
}

fn read_args<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str::<T>(&raw).map_err(|e| e.to_string())
}

fn write_result(path: &Path, result: &ElevatedResult) -> Result<(), String> {
    let json = serde_json::to_string_pretty(result).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(path).map_err(|e| e.to_string())?;
    f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

fn fail(code: i32, msg: &str) -> ElevatedResult {
    ElevatedResult {
        ok: false,
        exit_code: code,
        stdout: String::new(),
        stderr: String::new(),
        error_message: Some(msg.to_string()),
    }
}

fn install_service(args: &InstallServiceArgs) -> ElevatedResult {
    log::info(&format!("install-service: name={}", args.name));

    let servy_args = vec![
        "install".to_string(),
        "--name".to_string(),
        args.name.clone(),
        "--displayName".to_string(),
        args.display_name.clone(),
        "--description".to_string(),
        args.description.clone(),
        "--path".to_string(),
        args.bin_path.clone(),
        "--startupDir".to_string(),
        args.startup_dir.clone(),
        "--startupType".to_string(),
        args.startup_type.clone(),
        "--recoveryAction".to_string(),
        "RestartProcess".to_string(),
        "--maxRestartAttempts".to_string(),
        args.max_restart_attempts.to_string(),
        "--envVars".to_string(),
        args.env_vars.clone(),
        "--stdout".to_string(),
        args.log_path.clone(),
        "--stderr".to_string(),
        args.log_path.clone(),
    ];

    let install_out = match run_capture(&args.servy_path, &servy_args) {
        Ok(out) => out,
        Err(e) => return fail(4, &format!("servy-cli install spawn failed: {e}")),
    };
    if !install_out.success {
        return ElevatedResult {
            ok: false,
            exit_code: 4,
            stdout: install_out.stdout,
            stderr: install_out.stderr,
            error_message: Some(format!(
                "servy-cli install exited with code {:?}",
                install_out.code
            )),
        };
    }

    // Auto-start: same try-best-effort semantics as the Node-side ServyClient
    // had in v0.1.6 — we capture but don't fail the overall install.
    let start_out = run_capture(&args.servy_path, &["start", "--name", &args.name])
        .unwrap_or_else(|e| CapturedOutput::error_only(&format!("servy-cli start spawn failed: {e}")));

    // Tray Run-key registration is also best-effort; failure here doesn't
    // void the install (the user gets a working service, just no tray icon
    // on next login).
    if let Some(tray) = &args.tray_helper_path {
        if std::path::Path::new(tray).exists() {
            let _ = register_tray_run_key(tray);
            // Spawn the tray detached so it survives our exit.
            let _ = Command::new(tray).spawn();
        }
    }

    let mut combined_stdout = install_out.stdout;
    combined_stdout.push_str("\n--- start ---\n");
    combined_stdout.push_str(&start_out.stdout);

    let mut combined_stderr = install_out.stderr;
    if !start_out.stderr.is_empty() {
        combined_stderr.push_str("\n--- start ---\n");
        combined_stderr.push_str(&start_out.stderr);
    }

    ElevatedResult {
        ok: true,
        exit_code: 0,
        stdout: combined_stdout,
        stderr: combined_stderr,
        error_message: None,
    }
}

#[cfg(windows)]
fn spawn_user_launcher_command(args: &SpawnUserLauncherArgs) -> ElevatedResult {
    let r = spawn_in_active_user_session(args);
    if r.ok {
        ElevatedResult {
            ok: true,
            exit_code: 0,
            stdout: format!("spawned pid {} in session {}", r.pid, r.session_id),
            stderr: String::new(),
            error_message: None,
        }
    } else {
        ElevatedResult {
            ok: false,
            exit_code: 4,
            stdout: String::new(),
            stderr: r.error_message.clone().unwrap_or_default(),
            error_message: r.error_message,
        }
    }
}

fn uninstall_service(args: &UninstallServiceArgs) -> ElevatedResult {
    log::info(&format!("uninstall-service: name={}", args.name));

    // Stop first (best-effort — service may already be stopped).
    let _ = run_capture(&args.servy_path, &["stop", "--name", &args.name]);

    let uninstall_out = match run_capture(&args.servy_path, &["uninstall", "--name", &args.name]) {
        Ok(out) => out,
        Err(e) => return fail(4, &format!("servy-cli uninstall spawn failed: {e}")),
    };
    if !uninstall_out.success {
        return ElevatedResult {
            ok: false,
            exit_code: 4,
            stdout: uninstall_out.stdout,
            stderr: uninstall_out.stderr,
            error_message: Some(format!(
                "servy-cli uninstall exited with code {:?}",
                uninstall_out.code
            )),
        };
    }

    // Tray Run-key cleanup — best-effort.
    let _ = unregister_tray_run_key();

    // v0.1.8: also kill the running tray helper process if any. The
    // Run-key removal above only prevents auto-start on next login;
    // the currently-running tray icon would otherwise sit there
    // pointing at a service that no longer exists. taskkill /F /IM
    // hits both elevated and non-elevated tray instances in the
    // current session. Best-effort — no tray process means no kill,
    // not an error.
    let _ = Command::new("taskkill")
        .args(["/F", "/IM", "ws-scrcpy-web-tray.exe"])
        .output();

    ElevatedResult {
        ok: true,
        exit_code: 0,
        stdout: uninstall_out.stdout,
        stderr: uninstall_out.stderr,
        error_message: None,
    }
}

struct CapturedOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl CapturedOutput {
    fn error_only(msg: &str) -> Self {
        Self {
            success: false,
            code: None,
            stdout: String::new(),
            stderr: msg.to_string(),
        }
    }
}

fn run_capture(exe: &str, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<CapturedOutput, String> {
    let output = Command::new(exe)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(CapturedOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

const TRAY_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const TRAY_RUN_VALUE: &str = "WsScrcpyWebTray";

fn register_tray_run_key(tray_path: &str) -> Result<(), String> {
    let out = Command::new("reg.exe")
        .args(["add", TRAY_RUN_KEY, "/v", TRAY_RUN_VALUE, "/t", "REG_SZ", "/d", tray_path, "/f"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

pub fn unregister_tray_run_key() -> Result<(), String> {
    let out = Command::new("reg.exe")
        .args(["delete", TRAY_RUN_KEY, "/v", TRAY_RUN_VALUE, "/f"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // "cannot find" is the desired post-state — value already absent.
        if stderr.to_lowercase().contains("cannot find")
            || stderr.to_lowercase().contains("system was unable to find")
        {
            return Ok(());
        }
        return Err(stderr.into_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::tempdir;

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args = vec!["launcher.exe".to_string(), "--unrelated".to_string()];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_returns_exit_code_2_for_unknown_command() {
        let dir = tempdir().unwrap();
        let args_path = dir.path().join("args.json");
        let result_path = dir.path().join("result.json");
        fs::write(&args_path, "{}").unwrap();

        let argv = vec![
            "launcher.exe".to_string(),
            "--elevate-and-run".to_string(),
            "bogus-command".to_string(),
            args_path.to_string_lossy().into_owned(),
            result_path.to_string_lossy().into_owned(),
        ];
        let exit = handle(&argv).expect("flag matched");
        assert_eq!(exit, 2);

        let mut json = String::new();
        fs::File::open(&result_path).unwrap().read_to_string(&mut json).unwrap();
        assert!(json.contains("unknown elevate-and-run command"));
        assert!(json.contains("\"ok\": false"));
    }

    #[test]
    fn handle_returns_exit_code_3_when_args_json_missing() {
        let dir = tempdir().unwrap();
        let result_path = dir.path().join("result.json");

        let argv = vec![
            "launcher.exe".to_string(),
            "--elevate-and-run".to_string(),
            "install-service".to_string(),
            dir.path().join("does-not-exist.json").to_string_lossy().into_owned(),
            result_path.to_string_lossy().into_owned(),
        ];
        let exit = handle(&argv).expect("flag matched");
        assert_eq!(exit, 3);

        let mut json = String::new();
        fs::File::open(&result_path).unwrap().read_to_string(&mut json).unwrap();
        assert!(json.contains("could not read args JSON"));
    }

    #[test]
    fn write_result_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("r.json");
        let r = ElevatedResult {
            ok: true,
            exit_code: 0,
            stdout: "out".to_string(),
            stderr: "err".to_string(),
            error_message: None,
        };
        write_result(&path, &r).unwrap();

        let mut s = String::new();
        fs::File::open(&path).unwrap().read_to_string(&mut s).unwrap();
        // Field name uses snake_case as serialized; consumers (Node) parse
        // these explicitly.
        assert!(s.contains("\"ok\": true"));
        assert!(s.contains("\"stdout\": \"out\""));
        assert!(s.contains("\"stderr\": \"err\""));
    }
}
