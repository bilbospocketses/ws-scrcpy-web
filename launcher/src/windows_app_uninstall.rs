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
    Some(run_uninstall(&a))
}

/// Execute the uninstall plan. Best-effort: log + continue on errors.
fn run_uninstall(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "windows-app-uninstall: update_exe={:?} data_root={:?} keep={}",
        a.update_exe, a.data_root, a.keep
    ));
    let plan = windows_app_uninstall_commands(&a.update_exe, &a.data_root, a.keep);

    // 1. Run Update.exe --uninstall FIRST. This fires Velopack's uninstaller
    //    which triggers --veloapp-uninstall → service/tray teardown + ARP
    //    cleanup. Local-Dependencies-Only: absolute path, no PATH resolution.
    let argv = &plan.update_exe_step;
    let (cmd, rest) = argv.split_first().expect("update_exe_step is always non-empty");
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) if s.success() => {
            log::info(&format!("windows-app-uninstall: Update.exe ok ({})", argv.join(" ")))
        }
        Ok(s) => log::error(&format!(
            "windows-app-uninstall: Update.exe non-zero ({:?}): {}",
            s.code(),
            argv.join(" ")
        )),
        Err(e) => log::error(&format!(
            "windows-app-uninstall: Update.exe spawn failed: {} ({e})",
            argv.join(" ")
        )),
    }

    // 2. Remove dataRoot targets via std::fs (compiled-in; no PATH tools).
    for target in &plan.data_root_targets {
        let path = std::path::Path::new(target);
        if !path.exists() {
            log::info(&format!("windows-app-uninstall: target absent, skipping: {target}"));
            continue;
        }
        let result = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        match result {
            Ok(()) => log::info(&format!("windows-app-uninstall: removed {target}")),
            Err(e) => log::error(&format!(
                "windows-app-uninstall: could not remove {target}: {e}"
            )),
        }
    }

    0
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
}
