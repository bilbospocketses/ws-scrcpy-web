// Servy crash recovery: the install flags that turn it on, and the repair an
// update applies to a service installed before they existed.
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
// So `--veloapp-updated` repairs an existing service: `servy-cli export` its
// stored config, set the four recovery fields, `servy-cli import` it back.
// Import without `--install` only writes Servy's database, which is what the
// service host reads when it starts; it touches no SCM setting. That matters
// because export leaves out the account and password: an `--install` from the
// file would re-register the service as LocalSystem. Ours already is
// LocalSystem, and the SCM's logon account is not touched here either way.

use std::path::Path;

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
    let file = scratch_dir.join("servy-recovery-export.json");
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// The recovery block of a real 0.5.10 install's export: what Servy
    /// stored for `servy-cli install` without `--enableHealth`.
    const EXPORT_0_5_10: &str = r#"{
  "Id": 1,
  "Pid": null,
  "Name": "WsScrcpyWeb",
  "DisplayName": "ws-scrcpy-web",
  "ExecutablePath": "C:\\Program Files\\WsScrcpyWeb\\current\\ws-scrcpy-web-launcher.exe",
  "EnableHealthMonitoring": false,
  "HeartbeatInterval": 30,
  "MaxFailedChecks": 3,
  "RecoveryAction": 0,
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
        let json = EXPORT_0_5_10
            .replace(
                r#""EnableHealthMonitoring": false"#,
                r#""EnableHealthMonitoring": true"#,
            )
            .replace(r#""RecoveryAction": 0"#, r#""RecoveryAction": 2"#);
        assert_eq!(patch_exported_config(&json), Ok(None));
    }

    #[test]
    fn patch_repairs_health_on_with_recovery_none() {
        let json = EXPORT_0_5_10.replace(
            r#""EnableHealthMonitoring": false"#,
            r#""EnableHealthMonitoring": true"#,
        );
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
    fn repair_removes_the_exported_file_on_every_path() {
        for body in [Some(EXPORT_0_5_10), None, Some("not json")] {
            let dir = tempdir().unwrap();
            let mut fake = FakeServy::new(body);
            let _ = repair_existing_service("WsScrcpyWeb", dir.path(), |a| fake.run(a));
            assert!(
                !dir.path().join("servy-recovery-export.json").exists(),
                "export file left behind for {body:?}"
            );
        }
    }
}
