// Servy crash recovery: the install flags that turn it on, and the repair a
// service installed before they existed gets when this build starts it.
//
// Servy 8.2 restarts a crashed child only when health monitoring is on.
// `Servy.Service/Service.cs` (v8.2) sets
//     _recoveryActionEnabled = EnableHealthMonitoring && HeartbeatInterval > 0
//                              && MaxFailedChecks > 0 && RecoveryAction != None
// and on a non-zero child exit without it logs "Process exited with code N and
// recovery is disabled." and stops the service. Up to 0.5.10 the install passed
// `--recoveryAction RestartProcess` but never `--enableHealth`, so a crashed
// Node left the service down (qa-harness row 4.8, 2026-10-24). In service mode
// the launcher deliberately leaves crash restarts to Servy (supervisor.rs,
// `LeaveToServiceManager`), so nothing else brought it back.
//
// Servy stores these settings once, in its own database, when the service is
// registered; an update replaces the app's files and never re-registers it.
// So the service-mode launcher repairs its own service at startup, on a
// background thread: `servy-cli export` the stored config, set the four
// recovery fields, `servy-cli import` it back. Import without `--install` only
// writes Servy's database, which is what the service host reads when it
// starts; it touches no SCM setting. That matters because export leaves out
// the account and password: an `--install` from the file would re-register the
// service as LocalSystem. The import does reset columns export never carries:
// the logon columns to LocalSystem's defaults (ours already is LocalSystem, and
// the SCM's logon account is not touched), and the row's run-time `Pid` and
// active stdout/stderr paths, which Servy Manager then lacks for the running
// host until the restart below.
//
// The running host read its options before the repair, so a repair is followed
// by ONE restart of the service (decided together, 2026-10-25), run from a
// detached SYSTEM scheduled task because stopping the service kills this
// process and everything it starts. The restart waits until the server answers
// on its port: Servy's stop is a hard kill, and a first start after an update
// may still be provisioning dependencies.
//
// Not in the `--veloapp-updated` hook: Velopack kills that hook after 15 s and
// then kills every process under the install root (`run_hook` ->
// `force_stop_package`, velopack 1.2.161), while the post-stop bat starts the
// service 12 s after the stop. A cold first `servy-cli` run as SYSTEM can take
// longer than both, and would take the freshly started launcher down with it.

// Only the install flags are used off Windows; the repair runs in the Windows
// service only.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

/// Seconds between Servy health checks. Recovery runs this long minus 5 s
/// after the child exits (`OnProcessExited` schedules it at
/// `max(HeartbeatInterval - 5 s, 5 s)`).
pub(crate) const HEARTBEAT_SECS: u32 = 30;

/// Failed checks before recovery. One: the check only asks whether the
/// process has exited, and an exit is not transient.
pub(crate) const MAX_FAILED_CHECKS: u32 = 1;

/// `RecoveryAction.RestartProcess` in Servy's enum
/// (None = 0, RestartService = 1, RestartProcess = 2, RestartComputer = 3).
const RECOVERY_RESTART_PROCESS: i64 = 2;

/// The flags appended to `servy-cli install`. `--recoveryAction` and
/// `--maxRestartAttempts` are passed beside them by the caller.
pub(crate) fn health_install_args() -> Vec<String> {
    vec![
        "--enableHealth".to_string(),
        "--heartbeatInterval".to_string(),
        HEARTBEAT_SECS.to_string(),
        "--maxFailedChecks".to_string(),
        MAX_FAILED_CHECKS.to_string(),
    ]
}

/// Pure: patch a `servy-cli export --config json` document so recovery is on.
/// `Ok(None)` when it already is (health on, both counts positive,
/// RestartProcess); `Ok(Some(json))` with the four fields set otherwise. Every
/// other field is left exactly as exported.
pub(crate) fn patch_exported_config(exported: &str) -> Result<Option<String>, String> {
    let mut doc: Value =
        serde_json::from_str(exported).map_err(|e| format!("export is not JSON: {e}"))?;
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| "export is not a JSON object".to_string())?;
    if obj
        .get("Name")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("export names no service".to_string());
    }
    let positive = |key: &str| obj.get(key).and_then(Value::as_i64).is_some_and(|v| v > 0);
    let enabled = obj.get("EnableHealthMonitoring").and_then(Value::as_bool) == Some(true)
        && positive("HeartbeatInterval")
        && positive("MaxFailedChecks")
        && obj.get("RecoveryAction").and_then(Value::as_i64) == Some(RECOVERY_RESTART_PROCESS);
    if enabled {
        return Ok(None);
    }
    obj.insert("EnableHealthMonitoring".to_string(), Value::Bool(true));
    obj.insert("HeartbeatInterval".to_string(), Value::from(HEARTBEAT_SECS));
    obj.insert(
        "MaxFailedChecks".to_string(),
        Value::from(MAX_FAILED_CHECKS),
    );
    obj.insert(
        "RecoveryAction".to_string(),
        Value::from(RECOVERY_RESTART_PROCESS),
    );
    serde_json::to_string_pretty(&doc)
        .map(Some)
        .map_err(|e| format!("could not serialize the patched config: {e}"))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RepairOutcome {
    AlreadyEnabled,
    Repaired,
    Failed(String),
}

/// Export `service`'s config through `run_servy`, patch it, import it back.
/// `scratch_dir` holds the exported file for the length of the call; it must
/// not be under `%windir%` or Program Files, which Servy's export refuses.
/// The file carries the service's environment variables in clear (export
/// decrypts them), so it is removed on every path. `run_servy` runs
/// servy-cli with the given args and returns whether it exited 0.
pub(crate) fn repair_existing_service(
    service: &str,
    scratch_dir: &Path,
    mut run_servy: impl FnMut(&[&str]) -> Result<bool, String>,
) -> RepairOutcome {
    if let Err(e) = std::fs::create_dir_all(scratch_dir) {
        return RepairOutcome::Failed(format!("could not create {scratch_dir:?}: {e}"));
    }
    let file = scratch_dir.join("WsScrcpyWeb-recovery-export.json");
    let _ = std::fs::remove_file(&file);
    let path = file.to_string_lossy().into_owned();
    let outcome = (|| {
        match run_servy(&[
            "export", "--name", service, "--config", "json", "--path", &path, "--quiet",
        ]) {
            Ok(true) => {}
            Ok(false) => return RepairOutcome::Failed("servy-cli export failed".to_string()),
            Err(e) => return RepairOutcome::Failed(e),
        }
        let exported = match std::fs::read_to_string(&file) {
            Ok(s) => s,
            Err(e) => return RepairOutcome::Failed(format!("could not read {file:?}: {e}")),
        };
        let patched = match patch_exported_config(&exported) {
            Ok(None) => return RepairOutcome::AlreadyEnabled,
            Ok(Some(p)) => p,
            Err(e) => return RepairOutcome::Failed(e),
        };
        if let Err(e) = std::fs::write(&file, patched) {
            return RepairOutcome::Failed(format!("could not write {file:?}: {e}"));
        }
        match run_servy(&["import", "--config", "json", "--path", &path, "--quiet"]) {
            Ok(true) => RepairOutcome::Repaired,
            Ok(false) => RepairOutcome::Failed("servy-cli import failed".to_string()),
            Err(e) => RepairOutcome::Failed(e),
        }
    })();
    let _ = std::fs::remove_file(&file);
    outcome
}

const SERVICE_NAME: &str = "WsScrcpyWeb";
const RESTART_TASK_NAME: &str = "WsScrcpyWebServyRecovery";

/// How long the restart waits for the server to answer before leaving the
/// repair to the service's next start.
const SERVER_READY_WAIT: Duration = Duration::from_secs(600);

/// How long the restart waits after the port first answers. The listener is
/// up before the startup dependency check (index.ts runs it in the background
/// after listen), and the restart's stop is a hard kill.
const SERVER_SETTLE: Duration = Duration::from_secs(30);

/// Present once a restart was scheduled to apply a repair, until a start finds
/// recovery on. A repair that does not stick must not restart the service on
/// every start.
fn restart_marker(data_root: &Path) -> PathBuf {
    data_root.join("control").join("servy-recovery-restarted")
}

/// Written the first time a start finds recovery on; later starts skip the
/// export entirely. So only a service that predates the install flags pays
/// for a check after its first start, and a deliberate change in Servy
/// Manager afterwards is left alone.
fn checked_stamp(data_root: &Path) -> PathBuf {
    data_root.join("control").join("servy-recovery-checked")
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartupAction {
    /// Recovery is on, or the repair failed: no restart.
    Nothing,
    /// The repair changed Servy's database: restart once so the host reads it.
    Restart,
    /// It had to change it again after a restart already ran for it: the
    /// import does not stick, and restarting again would loop.
    GiveUp,
}

/// Pure: what the service-mode launcher does with a startup repair's outcome.
pub(crate) fn startup_action(outcome: &RepairOutcome, restarted_before: bool) -> StartupAction {
    match outcome {
        RepairOutcome::Repaired if restarted_before => StartupAction::GiveUp,
        RepairOutcome::Repaired => StartupAction::Restart,
        RepairOutcome::AlreadyEnabled | RepairOutcome::Failed(_) => StartupAction::Nothing,
    }
}

/// Pure: the bat the scheduled task runs. It restarts the service through
/// servy-cli (stop, then start, so the new host reads the repaired config),
/// then deletes its task and itself. It skips the restart when an update or an
/// uninstall is under way (its marker in `control_dir`), since the restart's
/// stop would run the post-stop bat's branch for it; and it follows the
/// restart with `sc start`, a no-op when the service is running, because
/// servy-cli leaves it stopped when its start half fails.
pub(crate) fn restart_bat(servy: &str, log_dir: &str, control_dir: &str) -> String {
    format!(
        "@echo off\r\n\
         if exist \"{control}\\apply-update-pending\" goto skip\r\n\
         if exist \"{control}\\uninstall-pending\" goto skip\r\n\
         echo %date% %time% [servy-recovery] restarting {service} to turn crash recovery on >> \"{log}\\servy-recovery.log\"\r\n\
         \"{servy}\" restart --name {service} -q\r\n\
         echo %date% %time% [servy-recovery] restart exit=%errorlevel% >> \"{log}\\servy-recovery.log\"\r\n\
         sc start {service} >nul 2>&1\r\n\
         goto done\r\n\
         :skip\r\n\
         echo %date% %time% [servy-recovery] an update or uninstall is pending; restart skipped >> \"{log}\\servy-recovery.log\"\r\n\
         :done\r\n\
         schtasks /delete /tn \"{task}\" /f >nul 2>&1\r\n\
         del \"%~f0\"\r\n",
        service = SERVICE_NAME,
        servy = servy,
        log = log_dir,
        control = control_dir,
        task = RESTART_TASK_NAME,
    )
}

/// Service mode only: repair this service's Servy recovery on a background
/// thread, and restart the service once if the repair changed anything.
#[cfg(windows)]
pub(crate) fn spawn_startup_repair(install_root: &Path, data_root: &Path) {
    let install_root = install_root.to_path_buf();
    let data_root = data_root.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("servy-recovery".to_string())
        .spawn(move || startup_repair(&install_root, &data_root));
    if let Err(e) = spawned {
        crate::log::error(&format!("servy-recovery: could not start its thread: {e}"));
    }
}

#[cfg(windows)]
fn startup_repair(install_root: &Path, data_root: &Path) {
    use crate::log;

    let servy = install_root.join("current").join("servy-cli.exe");
    if !servy.exists() {
        log::info(&format!(
            "servy-recovery: servy-cli.exe absent at {servy:?}; not checked"
        ));
        return;
    }
    let stamp = checked_stamp(data_root);
    if stamp.exists() {
        log::info("servy-recovery: crash recovery was found on at an earlier start; not checked");
        return;
    }
    // The exported file is imported back as SYSTEM, so it lives
    // in Servy's own admin-only directory, not the user-writable data root
    // (and not under %windir%, which Servy's export refuses).
    let scratch = match std::env::var_os("ProgramData") {
        Some(pd) => PathBuf::from(pd).join("Servy"),
        None => {
            log::error("servy-recovery: %ProgramData% is not set; not checked");
            return;
        }
    };
    let outcome = repair_existing_service(SERVICE_NAME, &scratch, |args| {
        crate::elevated_runner::silent_command(&servy)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .map_err(|e| format!("failed to spawn servy-cli: {e}"))
    });
    let marker = restart_marker(data_root);
    match &outcome {
        RepairOutcome::AlreadyEnabled => {
            log::info("servy-recovery: crash recovery is on");
            let _ = std::fs::remove_file(&marker);
            if let Err(e) = std::fs::write(&stamp, b"") {
                log::warn(&format!(
                    "servy-recovery: could not write {stamp:?}: {e}; the next start checks again"
                ));
            }
        }
        RepairOutcome::Repaired => log::info(
            "servy-recovery: crash recovery was off; turned it on in servy's config (health on, RestartProcess)",
        ),
        RepairOutcome::Failed(e) => log::error(&format!(
            "servy-recovery: could not check or repair crash recovery: {e}; it is tried again at the service's next start"
        )),
    }
    match startup_action(&outcome, marker.exists()) {
        StartupAction::Nothing => {}
        StartupAction::GiveUp => log::error(
            "servy-recovery: crash recovery was off again after the restart that should have applied it; not restarting again",
        ),
        StartupAction::Restart => {
            if !wait_for_server(data_root, SERVER_READY_WAIT) {
                log::warn(
                    "servy-recovery: the server did not answer on its port; the repair applies from the service's next start",
                );
                return;
            }
            if let Err(e) = std::fs::write(&marker, b"") {
                log::error(&format!(
                    "servy-recovery: could not write {marker:?}: {e}; not restarting (it would be unguarded)"
                ));
                return;
            }
            match schedule_restart(&servy, data_root) {
                Ok(()) => log::info(
                    "servy-recovery: restarting the service once so servy reads the repaired config",
                ),
                Err(e) => {
                    let _ = std::fs::remove_file(&marker);
                    log::error(&format!(
                        "servy-recovery: could not schedule the restart: {e}; the repair applies from the service's next start"
                    ));
                }
            }
        }
    }
}

/// Poll the server's port until it accepts a connection, then let it settle
/// for `SERVER_SETTLE` and require it to answer again.
#[cfg(windows)]
fn wait_for_server(data_root: &Path, give_up_after: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < give_up_after {
        if server_answers(data_root) {
            std::thread::sleep(SERVER_SETTLE);
            return server_answers(data_root);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    false
}

/// The port is re-read from config.json each time: the service may have walked
/// off the configured one.
#[cfg(windows)]
fn server_answers(data_root: &Path) -> bool {
    let port = common::config::AppConfig::load(data_root)
        .web_port
        .unwrap_or(8000);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok()
}

#[cfg(windows)]
fn schedule_restart(servy: &Path, data_root: &Path) -> Result<(), String> {
    use crate::elevated_runner::{assert_safe_bat_token, silent_os_tool};

    let control = data_root.join("control");
    let log_dir = data_root.join("logs");
    let servy_str = servy.to_string_lossy();
    let log_str = log_dir.to_string_lossy();
    let control_str = control.to_string_lossy();
    let bat = control.join("servy-recovery-restart.bat");
    let bat_str = bat.to_string_lossy().into_owned();
    assert_safe_bat_token(&servy_str, "servy_path")?;
    assert_safe_bat_token(&log_str, "log_dir")?;
    assert_safe_bat_token(&control_str, "control_dir")?;
    assert_safe_bat_token(&bat_str, "bat_path")?;
    std::fs::write(&bat, restart_bat(&servy_str, &log_str, &control_str))
        .map_err(|e| format!("write {bat:?} failed: {e}"))?;

    let run = |args: &[&str]| -> Result<(), String> {
        let status = silent_os_tool("schtasks")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("schtasks {} spawn failed: {e}", args[0]))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("schtasks {} exited {:?}", args[0], status.code()))
        }
    };
    let task_cmd = format!("C:\\Windows\\System32\\cmd.exe /c \"{bat_str}\"");
    run(&[
        "/create",
        "/tn",
        RESTART_TASK_NAME,
        "/tr",
        &task_cmd,
        "/sc",
        "once",
        "/st",
        "00:00",
        "/rl",
        "highest",
        "/ru",
        "SYSTEM",
        "/f",
    ])?;
    run(&["/run", "/tn", RESTART_TASK_NAME])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// The shape of a 0.5.10 install's export (`Id` and `Pid` are
    /// `[JsonIgnore]` in Servy's `ServiceDto`, so an export never has them).
    /// The install stored the `--recoveryAction` it was given, RestartProcess
    /// (2), with health off; the host's "recoveryAction: None" comes from
    /// `StartOptionsParser`, which forces None while health is off.
    const EXPORT_0_5_10: &str = r#"{
  "Name": "WsScrcpyWeb",
  "DisplayName": "ws-scrcpy-web",
  "ExecutablePath": "C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe",
  "EnableHealthMonitoring": false,
  "HeartbeatInterval": 30,
  "MaxFailedChecks": 3,
  "RecoveryAction": 2,
  "MaxRestartAttempts": 3,
  "EnvironmentVariables": "WS_SCRCPY_SERVICE=1",
  "PostStopExecutablePath": "C:\\Windows\\System32\\cmd.exe"
}"#;

    fn field(json: &str, key: &str) -> Value {
        serde_json::from_str::<Value>(json).unwrap()[key].clone()
    }

    #[test]
    fn health_install_args_turn_health_on_with_one_failed_check() {
        assert_eq!(
            health_install_args(),
            [
                "--enableHealth",
                "--heartbeatInterval",
                "30",
                "--maxFailedChecks",
                "1"
            ]
        );
    }

    #[test]
    fn patch_turns_recovery_on_for_a_0_5_10_export() {
        let patched = patch_exported_config(EXPORT_0_5_10)
            .unwrap()
            .expect("patched");
        assert_eq!(field(&patched, "EnableHealthMonitoring"), Value::Bool(true));
        assert_eq!(field(&patched, "HeartbeatInterval"), Value::from(30));
        assert_eq!(field(&patched, "MaxFailedChecks"), Value::from(1));
        assert_eq!(field(&patched, "RecoveryAction"), Value::from(2));
    }

    #[test]
    fn patch_leaves_every_other_field_as_exported() {
        let patched = patch_exported_config(EXPORT_0_5_10)
            .unwrap()
            .expect("patched");
        let mut before: Value = serde_json::from_str(EXPORT_0_5_10).unwrap();
        let mut after: Value = serde_json::from_str(&patched).unwrap();
        for key in [
            "EnableHealthMonitoring",
            "HeartbeatInterval",
            "MaxFailedChecks",
            "RecoveryAction",
        ] {
            before.as_object_mut().unwrap().remove(key);
            after.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(before, after);
    }

    #[test]
    fn patch_is_a_no_op_once_recovery_is_on() {
        let patched = patch_exported_config(EXPORT_0_5_10)
            .unwrap()
            .expect("patched");
        assert_eq!(patch_exported_config(&patched), Ok(None));
    }

    #[test]
    fn patch_keeps_an_enabled_config_with_other_counts() {
        let json = EXPORT_0_5_10.replace(
            r#""EnableHealthMonitoring": false"#,
            r#""EnableHealthMonitoring": true"#,
        );
        assert_eq!(patch_exported_config(&json), Ok(None));
    }

    #[test]
    fn patch_repairs_health_on_with_recovery_none() {
        let json = EXPORT_0_5_10
            .replace(
                r#""EnableHealthMonitoring": false"#,
                r#""EnableHealthMonitoring": true"#,
            )
            .replace(r#""RecoveryAction": 2"#, r#""RecoveryAction": 0"#);
        let patched = patch_exported_config(&json).unwrap().expect("patched");
        assert_eq!(field(&patched, "RecoveryAction"), Value::from(2));
    }

    #[test]
    fn patch_refuses_what_is_not_a_service_export() {
        assert!(patch_exported_config("").is_err());
        assert!(patch_exported_config("[]").is_err());
        assert!(patch_exported_config(r#"{"Name": ""}"#).is_err());
    }

    /// A fake servy-cli: `export` writes `export_body` to the `--path` file,
    /// `import` records the file's content.
    struct FakeServy {
        export_body: Option<&'static str>,
        import_ok: bool,
        calls: Vec<Vec<String>>,
        imported: Option<String>,
    }

    impl FakeServy {
        fn new(export_body: Option<&'static str>) -> Self {
            Self {
                export_body,
                import_ok: true,
                calls: Vec::new(),
                imported: None,
            }
        }

        fn run(&mut self, args: &[&str]) -> Result<bool, String> {
            self.calls
                .push(args.iter().map(|a| a.to_string()).collect());
            let path = args[args.iter().position(|a| *a == "--path").unwrap() + 1];
            match args[0] {
                "export" => match self.export_body {
                    Some(body) => {
                        std::fs::write(path, body).unwrap();
                        Ok(true)
                    }
                    None => Ok(false),
                },
                "import" => {
                    self.imported = Some(std::fs::read_to_string(path).unwrap());
                    Ok(self.import_ok)
                }
                other => panic!("unexpected servy-cli {other}"),
            }
        }
    }

    #[test]
    fn repair_exports_patches_and_imports_without_install() {
        let dir = tempdir().unwrap();
        let mut fake = FakeServy::new(Some(EXPORT_0_5_10));
        let out = repair_existing_service("WsScrcpyWeb", dir.path(), |a| fake.run(a));
        assert_eq!(out, RepairOutcome::Repaired);
        assert_eq!(fake.calls.len(), 2);
        assert_eq!(&fake.calls[0][..3], ["export", "--name", "WsScrcpyWeb"]);
        assert_eq!(fake.calls[1][0], "import");
        assert!(!fake.calls[1].iter().any(|a| a == "--install" || a == "-i"));
        let imported = fake.imported.expect("imported");
        assert_eq!(
            field(&imported, "EnableHealthMonitoring"),
            Value::Bool(true)
        );
        assert_eq!(field(&imported, "RecoveryAction"), Value::from(2));
    }

    #[test]
    fn repair_skips_the_import_when_recovery_is_already_on() {
        let dir = tempdir().unwrap();
        let enabled: &'static str = Box::leak(
            patch_exported_config(EXPORT_0_5_10)
                .unwrap()
                .unwrap()
                .into_boxed_str(),
        );
        let mut fake = FakeServy::new(Some(enabled));
        let out = repair_existing_service("WsScrcpyWeb", dir.path(), |a| fake.run(a));
        assert_eq!(out, RepairOutcome::AlreadyEnabled);
        assert_eq!(fake.calls.len(), 1);
    }

    #[test]
    fn repair_reports_a_failed_export_and_imports_nothing() {
        let dir = tempdir().unwrap();
        let mut fake = FakeServy::new(None);
        let out = repair_existing_service("WsScrcpyWeb", dir.path(), |a| fake.run(a));
        assert!(matches!(out, RepairOutcome::Failed(_)));
        assert_eq!(fake.calls.len(), 1);
    }

    #[test]
    fn repair_reports_a_failed_import() {
        let dir = tempdir().unwrap();
        let mut fake = FakeServy::new(Some(EXPORT_0_5_10));
        fake.import_ok = false;
        let out = repair_existing_service("WsScrcpyWeb", dir.path(), |a| fake.run(a));
        assert_eq!(
            out,
            RepairOutcome::Failed("servy-cli import failed".to_string())
        );
    }

    #[test]
    fn startup_restarts_once_for_a_repair_and_never_loops() {
        assert_eq!(
            startup_action(&RepairOutcome::Repaired, false),
            StartupAction::Restart
        );
        assert_eq!(
            startup_action(&RepairOutcome::Repaired, true),
            StartupAction::GiveUp
        );
        for restarted_before in [false, true] {
            assert_eq!(
                startup_action(&RepairOutcome::AlreadyEnabled, restarted_before),
                StartupAction::Nothing
            );
            assert_eq!(
                startup_action(&RepairOutcome::Failed("x".to_string()), restarted_before),
                StartupAction::Nothing
            );
        }
    }

    #[test]
    fn restart_bat_restarts_the_service_then_removes_its_task_and_itself() {
        let bat = restart_bat(
            r"C:\Program Files\WsScrcpyWeb\current\servy-cli.exe",
            r"C:\ProgramData\WsScrcpyWeb\logs",
            r"C:\ProgramData\WsScrcpyWeb\control",
        );
        let lines: Vec<&str> = bat.split("\r\n").collect();
        let at = |line: &str| {
            lines
                .iter()
                .position(|l| *l == line)
                .unwrap_or_else(|| panic!("line {line:?} in {bat}"))
        };
        let skip_update =
            at(r#"if exist "C:\ProgramData\WsScrcpyWeb\control\apply-update-pending" goto skip"#);
        let skip_uninstall =
            at(r#"if exist "C:\ProgramData\WsScrcpyWeb\control\uninstall-pending" goto skip"#);
        let restart = at(
            r#""C:\Program Files\WsScrcpyWeb\current\servy-cli.exe" restart --name WsScrcpyWeb -q"#,
        );
        let sc_start = at("sc start WsScrcpyWeb >nul 2>&1");
        let skip_label = at(":skip");
        let done_label = at(":done");
        assert!(skip_update < restart && skip_uninstall < restart);
        assert!(restart < sc_start && sc_start < skip_label && skip_label < done_label);
        let delete_task = lines
            .iter()
            .position(|l| l.starts_with(r#"schtasks /delete /tn "WsScrcpyWebServyRecovery" /f"#))
            .expect("task delete line");
        let delete_self = lines
            .iter()
            .position(|l| *l == r#"del "%~f0""#)
            .expect("self delete line");
        assert!(done_label < delete_task && delete_task < delete_self);
        assert!(bat.contains(r"C:\ProgramData\WsScrcpyWeb\logs\servy-recovery.log"));
    }

    #[test]
    fn repair_removes_the_exported_file_on_every_path() {
        for body in [Some(EXPORT_0_5_10), None, Some("not json")] {
            let dir = tempdir().unwrap();
            let mut fake = FakeServy::new(body);
            let _ = repair_existing_service("WsScrcpyWeb", dir.path(), |a| fake.run(a));
            assert!(
                !dir.path().join("WsScrcpyWeb-recovery-export.json").exists(),
                "export file left behind for {body:?}"
            );
        }
    }
}
