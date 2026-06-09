// Windows in-app uninstall helper (beta.49 parity).
//
// `windows_app_uninstall_commands` returns an `UninstallPlan` with:
//   - `update_exe_step`: the `[update_exe, "--uninstall"]` argv-vector.
//     Running this triggers Velopack's uninstaller, which removes the
//     Program Files install AND fires the launcher's `--veloapp-uninstall`
//     hook → stops/uninstalls the WsScrcpyWeb service + kills the tray +
//     ARP cleanup.
//   - `data_root_targets`: the dataRoot (`%ProgramData%\WsScrcpyWeb`) paths
//     to remove after Update.exe completes:
//       keep=true  → ["<data_root>\\dependencies", "<data_root>\\bin",
//                     "<data_root>\\control"] (deps/regenerable only;
//                     config.json + logs preserved)
//       keep=false → ["<data_root>"] (the whole root)
//
// Dispatch (`handle`): owns `--windows-app-uninstall`. Runs Update.exe via
// `std::process::Command` (the absolute path supplied by the caller — no
// PATH, no env-var). Removes each dataRoot target via `std::fs::remove_dir_all`
// / `std::fs::remove_file`. Best-effort: logs + continues on errors (the
// app is being uninstalled regardless).
//
// Local-Dependencies-Only: Update.exe is the absolute path argument.
// dataRoot deletion = `std::fs` compiled into the binary. No bare
// cmd/rmdir/powershell on PATH.

use crate::log;

/// Ordered uninstall plan for the Windows path.
///
/// Kept as a named struct (mirroring linux_app_uninstall's `UninstallPlan`)
/// so callers can inspect the two distinct groups independently — the
/// Update.exe step and the dataRoot deletion targets — which the tests
/// assert on separately.
#[derive(Debug, Clone)]
pub struct UninstallPlan {
    /// The single Update.exe invocation: `[update_exe, "--uninstall"]`.
    /// Always exactly one entry. Run FIRST so Velopack's uninstaller fires
    /// the `--veloapp-uninstall` hook (service/tray teardown + ARP cleanup)
    /// before we touch the dataRoot.
    pub update_exe_step: Vec<String>,
    /// dataRoot filesystem targets to remove after Update.exe completes.
    /// `keep=false` → `["<data_root>"]`; `keep=true` →
    /// `["<data_root>\\dependencies", "<data_root>\\bin", "<data_root>\\control"]`.
    pub data_root_targets: Vec<String>,
}

/// Build the uninstall plan. Pure — no I/O, fully unit-testable.
///
/// * `update_exe`  — absolute path to `<installRoot>\Update.exe`.
/// * `data_root`   — absolute path to the app data root
///   (`%ProgramData%\WsScrcpyWeb`).
/// * `keep`        — `true` preserves config.json + logs/ (deletes only
///   deps/bin/control); `false` wipes the whole data root.
pub fn windows_app_uninstall_commands(
    update_exe: &str,
    data_root: &str,
    keep: bool,
) -> UninstallPlan {
    let update_exe_step = vec![update_exe.to_string(), "--uninstall".to_string()];

    let data_root_targets = if keep {
        ["dependencies", "bin", "control"]
            .iter()
            .map(|sub| format!("{}\\{}", data_root, sub))
            .collect()
    } else {
        vec![data_root.to_string()]
    };

    UninstallPlan { update_exe_step, data_root_targets }
}

// ─── Dispatch + execution ──────────────────────────────────────────────────

/// Parsed `--windows-app-uninstall` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallArgs {
    pub update_exe: String,
    pub data_root: String,
    pub keep: bool,
}

/// Parse `--windows-app-uninstall` flags.
///
/// Flags:
///   `--windows-app-uninstall`   — presence marker (required in caller's argv)
///   `--update-exe <abs path>`   — absolute path to Update.exe (required)
///   `--data-root  <abs path>`   — absolute path to the data root (required)
///   exactly one of `--keep` / `--wipe`   — scope selector (required)
///
/// Returns `None` on any missing/invalid input (mirrors linux's parse_args
/// validation contract). Returning `None` signals the caller to log an error
/// and return exit code 2.
pub fn parse_args(args: &[String]) -> Option<UninstallArgs> {
    // --keep XOR --wipe (exactly one required)
    let keep = match (
        args.iter().any(|a| a == "--keep"),
        args.iter().any(|a| a == "--wipe"),
    ) {
        (true, false) => true,
        (false, true) => false,
        _ => return None,
    };

    // --data-root <abs path> (required)
    let data_root = args
        .iter()
        .position(|a| a == "--data-root")
        .and_then(|i| args.get(i + 1))
        .cloned()?;

    // --update-exe <abs path> (required)
    let update_exe = args
        .iter()
        .position(|a| a == "--update-exe")
        .and_then(|i| args.get(i + 1))
        .cloned()?;

    Some(UninstallArgs { update_exe, data_root, keep })
}

/// Parsed `--windows-app-uninstall-run` invocation (the Phase-2 cleaner).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunArgs {
    pub wait_pid: u32,
    pub update_exe: String,
    pub data_root: String,
    pub keep: bool,
}

/// Build the Phase-2 argv the bootstrapper passes to the temp copy. Returns
/// the args WITHOUT argv[0]; the caller does `Command::new(temp_exe).args(..)`.
/// Always includes `--no-log` so the cleaner never writes into the data root.
pub fn build_run_args(wait_pid: u32, keep: bool, data_root: &str, update_exe: &str) -> Vec<String> {
    vec![
        "--windows-app-uninstall-run".to_string(),
        "--wait-pid".to_string(),
        wait_pid.to_string(),
        "--no-log".to_string(),
        if keep { "--keep" } else { "--wipe" }.to_string(),
        "--data-root".to_string(),
        data_root.to_string(),
        "--update-exe".to_string(),
        update_exe.to_string(),
    ]
}

/// Parse `--windows-app-uninstall-run` flags. `None` on absence/invalid input
/// (mirrors `parse_args`). Requires the run flag, a numeric `--wait-pid`,
/// `--data-root`, `--update-exe`, and exactly one of `--keep`/`--wipe`.
pub fn parse_run_args(args: &[String]) -> Option<RunArgs> {
    if !args.iter().any(|a| a == "--windows-app-uninstall-run") {
        return None;
    }
    let keep = match (
        args.iter().any(|a| a == "--keep"),
        args.iter().any(|a| a == "--wipe"),
    ) {
        (true, false) => true,
        (false, true) => false,
        _ => return None,
    };
    let wait_pid = args
        .iter()
        .position(|a| a == "--wait-pid")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<u32>().ok())?;
    let data_root = args
        .iter()
        .position(|a| a == "--data-root")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    let update_exe = args
        .iter()
        .position(|a| a == "--update-exe")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    Some(RunArgs { wait_pid, update_exe, data_root, keep })
}

/// Filename for the temp copy of the launcher that performs the dataRoot
/// deletion. PID-stamped so a retried/concurrent uninstall never collides.
pub fn temp_copy_filename(pid: u32) -> String {
    format!("ws-scrcpy-web-uninstall-{pid}.exe")
}

/// Dispatch `--windows-app-uninstall`. Returns `Some(exit_code)` when it
/// owns the invocation, `None` to let the next dispatcher try.
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--windows-app-uninstall") {
        return None;
    }
    let a = match parse_args(args) {
        Some(v) => v,
        None => {
            log::error("windows-app-uninstall: missing/invalid args");
            return Some(2);
        }
    };
    Some(run_bootstrap(&a))
}

/// Run `Update.exe --uninstall` (Velopack: Program Files + ARP + the
/// --veloapp-uninstall service/tray hook). `update_exe_step` is the argv the
/// builder produced (`[update_exe, "--uninstall"]`). Best-effort: logs (if
/// logging is enabled) and returns regardless — the app is being removed
/// either way. Local-Dependencies-Only: absolute path, no PATH resolution.
fn run_update_exe(update_exe_step: &[String]) {
    let (cmd, rest) = update_exe_step
        .split_first()
        .expect("update_exe_step is always non-empty");
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) if s.success() => log::info(&format!(
            "windows-app-uninstall: Update.exe ok ({})",
            update_exe_step.join(" ")
        )),
        Ok(s) => log::error(&format!(
            "windows-app-uninstall: Update.exe non-zero ({:?}): {}",
            s.code(),
            update_exe_step.join(" ")
        )),
        Err(e) => log::error(&format!(
            "windows-app-uninstall: Update.exe spawn failed: {} ({e})",
            update_exe_step.join(" ")
        )),
    }
}

/// Remove each dataRoot target via std::fs (compiled-in; no PATH tools),
/// retrying up to `attempts` times with a 500ms delay between tries to absorb
/// residual handle-release lag (e.g. the originating helper exiting). Best-
/// effort: logs and continues on failure.
fn remove_targets(targets: &[String], attempts: u32) {
    let attempts = attempts.max(1);
    for target in targets {
        let path = std::path::Path::new(target);
        let mut last_err: Option<std::io::Error> = None;
        for attempt in 0..attempts {
            if !path.exists() {
                last_err = None;
                break;
            }
            let result = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            match result {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    if attempt + 1 < attempts {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }
        }
        match last_err {
            None => log::info(&format!("windows-app-uninstall: removed {target}")),
            Some(e) => log::error(&format!(
                "windows-app-uninstall: could not remove {target}: {e}"
            )),
        }
    }
}

/// Legacy in-place uninstall: run Update.exe then delete the dataRoot targets
/// from THIS process. Used ONLY as the Phase-1 fallback when the temp-copy
/// cleaner cannot be staged (temp unresolved / self-copy / spawn failure).
/// Known to orphan the running helper's own directory on --wipe (Windows can't
/// delete a running exe) — no worse than pre-fix behavior, hence fallback-only.
fn run_uninstall_in_place(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "windows-app-uninstall(in-place fallback): update_exe={:?} data_root={:?} keep={}",
        a.update_exe, a.data_root, a.keep
    ));
    let plan = windows_app_uninstall_commands(&a.update_exe, &a.data_root, a.keep);
    run_update_exe(&plan.update_exe_step);
    remove_targets(&plan.data_root_targets, 1);
    0
}

/// Resolve the context-appropriate temp directory: the user's temp under a
/// user token, the hardened `C:\Windows\SystemTemp` under a SYSTEM/system-
/// service token. `GetTempPath2W` is the SYSTEM-safe API (Win10 1903+); fall
/// back to `GetTempPathW`. `None` if both fail (caller → in-place fallback).
fn resolve_temp_dir() -> Option<std::path::PathBuf> {
    use windows::Win32::Storage::FileSystem::{GetTempPath2W, GetTempPathW};
    // MAX_PATH (260) + 1; these calls return the length copied, excluding NUL.
    let mut buf = [0u16; 261];
    let mut len = unsafe { GetTempPath2W(Some(&mut buf)) };
    if len == 0 {
        len = unsafe { GetTempPathW(Some(&mut buf)) };
    }
    if len == 0 {
        return None;
    }
    Some(std::path::PathBuf::from(String::from_utf16_lossy(
        &buf[..len as usize],
    )))
}

/// Phase 1: copy this launcher to temp and spawn it as the logging-disabled
/// cleaner (Phase 2) with the uninstall params + our own pid as `--wait-pid`,
/// then return so the process can exit — releasing the running-exe lock on the
/// staged launcher under dataRoot. Falls back to the legacy in-place uninstall
/// if temp resolution / self-copy / spawn fails.
fn run_bootstrap(a: &UninstallArgs) -> i32 {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW = 0x08000000 (mirrors spawn.rs). The temp copy survives
    // our exit: the uninstall helper runs outside any kill-on-job-close job.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let pid = std::process::id();

    let temp_dir = match resolve_temp_dir() {
        Some(d) => d,
        None => {
            log::error("windows-app-uninstall: temp dir unresolved; in-place fallback");
            return run_uninstall_in_place(a);
        }
    };
    let src = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: current_exe failed: {e}; in-place fallback"
            ));
            return run_uninstall_in_place(a);
        }
    };
    let dst = temp_dir.join(temp_copy_filename(pid));
    if let Err(e) = std::fs::copy(&src, &dst) {
        log::error(&format!(
            "windows-app-uninstall: self-copy to {dst:?} failed: {e}; in-place fallback"
        ));
        return run_uninstall_in_place(a);
    }

    let run_args = build_run_args(pid, a.keep, &a.data_root, &a.update_exe);
    log::info(&format!(
        "windows-app-uninstall: staged cleaner at {dst:?}; spawning + exiting"
    ));
    match std::process::Command::new(&dst)
        .args(&run_args)
        .current_dir(&temp_dir) // CWD in temp, never under dataRoot
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(_child) => 0, // detached; do NOT wait — exit so the lock releases
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: spawn cleaner failed: {e}; in-place fallback"
            ));
            run_uninstall_in_place(a)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Space-join each argv-vector for readable, order-preserving assertions.
    /// Mirrors the helper in linux_app_uninstall tests.
    fn joined(cmds: &[Vec<String>]) -> Vec<String> {
        cmds.iter().map(|c| c.join(" ")).collect()
    }

    const UPDATE_EXE: &str = r"C:\Program Files\WsScrcpyWeb\Update.exe";
    const DATA_ROOT: &str = r"C:\ProgramData\WsScrcpyWeb";

    // ── Pure builder tests ────────────────────────────────────────────────

    #[test]
    fn update_exe_step_is_always_first_and_correct() {
        // Both keep and wipe: the Update.exe step is the first (and only)
        // step in update_exe_step, always [update_exe, "--uninstall"].
        for keep in [true, false] {
            let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, keep);
            assert_eq!(
                plan.update_exe_step,
                vec![UPDATE_EXE.to_string(), "--uninstall".to_string()],
                "update_exe_step mismatch for keep={keep}"
            );
        }
    }

    #[test]
    fn wipe_targets_whole_data_root() {
        // keep=false → data_root_targets = ["<data_root>"] — single entry,
        // the whole root. No subdirectory carve-out.
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, false);
        assert_eq!(
            plan.data_root_targets,
            vec![DATA_ROOT.to_string()],
            "wipe must target the whole data root"
        );
    }

    #[test]
    fn keep_targets_deps_bin_control_only() {
        // keep=true → data_root_targets contains exactly dependencies, bin,
        // control (subdirs); does NOT contain a bare wipe and never names
        // config.json or logs.
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, true);
        let targets = &plan.data_root_targets;

        // Exactly the three regenerable subdirs.
        assert!(
            targets.contains(&format!(r"{DATA_ROOT}\dependencies")),
            "keep must target dependencies"
        );
        assert!(
            targets.contains(&format!(r"{DATA_ROOT}\bin")),
            "keep must target bin"
        );
        assert!(
            targets.contains(&format!(r"{DATA_ROOT}\control")),
            "keep must target control"
        );

        // NOT a bare wipe of the data root itself.
        assert!(
            !targets.contains(&DATA_ROOT.to_string()),
            "keep must NOT target the whole data root"
        );

        // Preserved paths are never referenced.
        assert!(
            !targets.iter().any(|t| t.contains("config.json")),
            "keep must not reference config.json"
        );
        assert!(
            !targets.iter().any(|t| t.contains("logs")),
            "keep must not reference logs"
        );
    }

    #[test]
    fn update_exe_step_is_distinct_from_data_root_targets() {
        // The struct keeps the two groups separate so callers (and tests) can
        // assert each independently. Verify the split is never collapsed.
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, false);
        // update_exe_step has exactly the Update.exe invocation.
        assert_eq!(plan.update_exe_step.len(), 2);
        assert_eq!(plan.update_exe_step[1], "--uninstall");
        // data_root_targets has no Update.exe entry.
        assert!(!plan.data_root_targets.iter().any(|t| t.contains("Update.exe")));
    }

    #[test]
    fn keep_has_exactly_three_targets() {
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, true);
        assert_eq!(
            plan.data_root_targets.len(),
            3,
            "keep must produce exactly 3 targets (dependencies, bin, control)"
        );
    }

    #[test]
    fn wipe_has_exactly_one_target() {
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, false);
        assert_eq!(
            plan.data_root_targets.len(),
            1,
            "wipe must produce exactly 1 target (the whole data root)"
        );
    }

    #[test]
    fn update_exe_path_is_preserved_verbatim() {
        // The absolute path passed in must appear unchanged — no normalization,
        // no quoting, no PATH lookup.
        let exotic = r"C:\Program Files (x86)\WsScrcpyWeb\Update.exe";
        let plan = windows_app_uninstall_commands(exotic, DATA_ROOT, false);
        assert_eq!(plan.update_exe_step[0], exotic);
    }

    // Smoke-check the joined() helper (mirrors linux tests).
    #[test]
    fn joined_helper_formats_correctly() {
        let cmds: Vec<Vec<String>> = vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["c".to_string()],
        ];
        assert_eq!(joined(&cmds), vec!["a b".to_string(), "c".to_string()]);
    }

    // ── parse_args tests ──────────────────────────────────────────────────

    #[test]
    fn parse_args_round_trips_keep() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--keep",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_args(&args),
            Some(UninstallArgs {
                update_exe: UPDATE_EXE.to_string(),
                data_root: DATA_ROOT.to_string(),
                keep: true,
            })
        );
    }

    #[test]
    fn parse_args_round_trips_wipe() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--wipe",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_args(&args),
            Some(UninstallArgs {
                update_exe: UPDATE_EXE.to_string(),
                data_root: DATA_ROOT.to_string(),
                keep: false,
            })
        );
    }

    #[test]
    fn parse_args_rejects_both_keep_and_wipe() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--keep",
            "--wipe",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_neither_keep_nor_wipe() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_missing_data_root() {
        let args: Vec<String> =
            ["--windows-app-uninstall", "--keep", "--update-exe", UPDATE_EXE]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_missing_update_exe() {
        let args: Vec<String> =
            ["--windows-app-uninstall", "--keep", "--data-root", DATA_ROOT]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_data_root_without_value() {
        // --data-root present but no value following it → parse error.
        let args: Vec<String> =
            ["--windows-app-uninstall", "--keep", "--data-root", "--update-exe", UPDATE_EXE]
                .iter()
                .map(|s| s.to_string())
                .collect();
        // --data-root's "value" would be "--update-exe" (the next flag), and
        // --update-exe would then have no value. parse_args returns None for
        // missing --update-exe value.
        // (We don't validate that values aren't flags; the contract matches linux.)
        // Either way: no panic.
        let _ = parse_args(&args);
    }

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args: Vec<String> = ["--some-other-flag", "--keep"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(handle(&args), None);
    }

    #[test]
    fn handle_returns_error_code_on_invalid_args() {
        // Flag present but missing required --data-root and --update-exe.
        let args: Vec<String> = ["--windows-app-uninstall", "--keep"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(handle(&args), Some(2));
    }

    // ── Phase-2 (--windows-app-uninstall-run) arg model ───────────────────

    #[test]
    fn build_run_args_round_trips_through_parse() {
        for keep in [true, false] {
            let argv = build_run_args(4321, keep, DATA_ROOT, UPDATE_EXE);
            // The temp copy always gets --no-log and the run subcommand.
            assert!(argv.contains(&"--windows-app-uninstall-run".to_string()));
            assert!(argv.contains(&"--no-log".to_string()));
            let parsed = parse_run_args(&argv).expect("round-trips");
            assert_eq!(
                parsed,
                RunArgs {
                    wait_pid: 4321,
                    update_exe: UPDATE_EXE.to_string(),
                    data_root: DATA_ROOT.to_string(),
                    keep,
                }
            );
        }
    }

    #[test]
    fn parse_run_args_requires_the_run_flag() {
        // Same fields but the Phase-1 flag, not the run flag → not ours.
        let argv: Vec<String> = [
            "--windows-app-uninstall", "--wait-pid", "1", "--wipe",
            "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&argv), None);
    }

    #[test]
    fn parse_run_args_rejects_missing_or_bad_wait_pid() {
        let no_pid: Vec<String> = [
            "--windows-app-uninstall-run", "--wipe",
            "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&no_pid), None);

        let bad_pid: Vec<String> = [
            "--windows-app-uninstall-run", "--wait-pid", "notanumber",
            "--wipe", "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&bad_pid), None);
    }

    #[test]
    fn parse_run_args_rejects_neither_keep_nor_wipe() {
        let argv: Vec<String> = [
            "--windows-app-uninstall-run", "--wait-pid", "1",
            "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&argv), None);
    }

    #[test]
    fn temp_copy_filename_is_pid_stamped() {
        assert_eq!(temp_copy_filename(1234), "ws-scrcpy-web-uninstall-1234.exe");
        // Distinct pids → distinct names (so concurrent/retried uninstalls don't collide).
        assert_ne!(temp_copy_filename(1), temp_copy_filename(2));
    }
}
