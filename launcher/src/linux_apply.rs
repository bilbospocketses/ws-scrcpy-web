// §41 — Linux local-mode in-app update apply. Velopack 1.0.1's UpdateNix apply
// fails on our AppImage (it re-derives a locator from `--root <appimage>` and
// fails the UpdateExePath check). Instead the Node server downloads + verifies
// the new AppImage, then spawns THIS helper (the launcher copy staged in
// dataRoot, outside the mount) to swap $APPIMAGE + relaunch.
// See docs/specs/2026-06-01-linux-appimage-self-update-design.md.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::linux_service::{self, Scope};
use crate::log;

/// Dispatch: if argv contains `--linux-apply`, handle it and return Some(exit_code).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-apply") {
        return None;
    }
    Some(run(args))
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
}

fn run(args: &[String]) -> i32 {
    let target = match arg_value(args, "--target") {
        Some(s) => PathBuf::from(s),
        None => {
            log::error("linux-apply: missing --target");
            return 2;
        }
    };

    // Service-mode apply (Phase 2): if --service-restart is present, the helper
    // stops the unit (synchronous, reaps the in-cgroup app), settles for the
    // FUSE unmount, swaps, relabels (system scope), and starts the unit — no
    // --wait-pid, no bare relaunch. Reached for user-service (user manager,
    // home $APPIMAGE) and system-service (system manager, root, /opt + bin_t).
    // It swaps the binary, so it requires --staged.
    if let Some((scope, unit, relabel)) = parse_service_restart(args) {
        let staged = match arg_value(args, "--staged") {
            Some(s) => PathBuf::from(s),
            None => {
                log::error("linux-apply(service): --service-restart requires --staged");
                return 2;
            }
        };
        return run_service_restart(&staged, &target, scope, &unit, relabel);
    }

    let wait_pid = arg_value(args, "--wait-pid").and_then(|s| s.parse::<u32>().ok());

    // Relaunch-only apply (Phase 3, machine-wide-no-service): --staged is ABSENT.
    // The user runs the root-owned /opt AppImage directly, so the Node server has
    // ALREADY done the privileged RENAME-swap of the /opt binary under one pkexec
    // (a `cp` would ETXTBSY the running file; the per-user flock blocks a fresh
    // /opt instance until the old one exits). This helper therefore only waits for
    // the app's pid to exit (releasing the flock) and relaunches the swapped /opt
    // copy — no swap, no staged cleanup. The relaunch must NOT be elevated, which
    // is why it runs here (as the user) rather than inside the pkexec script.
    if !should_swap(args) {
        log::info(&format!(
            "linux-apply(relaunch-only): target={target:?} wait_pid={wait_pid:?}"
        ));
        if let Some(pid) = wait_pid {
            wait_for_pid_exit(pid, Duration::from_secs(60));
        }
        relaunch(&target);
        return 0;
    }

    // Local-mode apply (unchanged #27 path): wait for the app pid, swap, relaunch.
    // should_swap(args) == true above guarantees --staged is present.
    let staged = PathBuf::from(
        arg_value(args, "--staged").expect("should_swap() == true guarantees --staged present"),
    );
    log::info(&format!(
        "linux-apply(local): staged={staged:?} target={target:?} wait_pid={wait_pid:?}"
    ));

    if let Some(pid) = wait_pid {
        wait_for_pid_exit(pid, Duration::from_secs(60));
    }

    let code = match swap_appimage(&staged, &target) {
        Ok(()) => {
            log::info("linux-apply: swap ok, relaunching");
            relaunch(&target);
            0
        }
        Err(e) => {
            log::error(&format!("linux-apply: swap failed: {e}"));
            1
        }
    };
    // Best-effort cleanup so a completed OR failed apply leaves no cruft (#27):
    // the staged .new (consumed on success, orphaned on failure) and the
    // apply-update-pending marker (UpdateService writes it; it has no Linux
    // consumer — Windows-only — so clearing it just keeps dataRoot tidy).
    cleanup_apply_artifacts(&staged);
    code
}

/// Service-mode apply: stop the unit (synchronous, reaps the in-cgroup app +
/// unmounts the AppImage), settle until the file is swappable, swap, relabel
/// (system scope), start the unit. No bare relaunch — the unit start brings the
/// app back. Runs from inside a `systemd-run` transient unit (own cgroup), so it
/// survives stopping the service unit. Exec orchestration over the pure builders
/// (those are unit-tested; this path is Fedora-verified per the Phase 2 spec).
fn run_service_restart(
    staged: &Path,
    target: &Path,
    scope: Scope,
    unit: &str,
    relabel: bool,
) -> i32 {
    let bindir = linux_service::tool_dir("systemctl");
    log::info(&format!(
        "linux-apply(service): scope={scope:?} unit={unit} target={target:?} relabel={relabel}"
    ));

    // 1. Stop the unit (synchronous): reaps the in-cgroup launcher+Node+children
    //    and unmounts the running AppImage so its file becomes swappable.
    run_cmd(&service_unit_command(scope, "stop", unit, &bindir));

    // 2. Settle: retry the swap until it succeeds (the FUSE unmount can lag the
    //    stop). swap_appimage is self-healing on failure (restores the .bak), so
    //    retrying is safe. Give up after 15s rather than start a stale version.
    let start = Instant::now();
    loop {
        match swap_appimage(staged, target) {
            Ok(()) => break,
            Err(e) => {
                if start.elapsed() >= Duration::from_secs(15) {
                    log::error(&format!(
                        "linux-apply(service): swap failed after settle: {e}"
                    ));
                    cleanup_apply_artifacts(staged);
                    // Do NOT start into a broken binary; swap_appimage left the old one in place.
                    return 1;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    // 3. System scope only: re-apply the bin_t label so init_t may exec the
    //    swapped /opt copy. restorecon (persistent rule) preferred, else chcon.
    let restorecon = format!("{}/restorecon", linux_service::sbindir_from(&bindir));
    let restorecon_present = Path::new(&restorecon).exists();
    let selinux = selinux_active();
    if relabel {
        match relabel_command(target, &bindir, restorecon_present, selinux) {
            Some(argv) => run_cmd(&argv),
            None => log::info("linux-apply(service): SELinux is not active; no label to apply"),
        }
    }

    // 3b. System scope only: drop the WS_SCRCPY_WEB_PORT pin a unit installed
    //     before 2026-10-04 carries, while the unit is stopped, so the start
    //     below reads config.json's port and a Settings change sticks.
    if scope == Scope::System {
        unpin_system_unit(
            &linux_service::unit_path(scope, unit),
            &bindir,
            restorecon_present,
            selinux,
        );
    }

    // 4. Start the unit on the new version (rebinds the same web port).
    run_cmd(&service_unit_command(scope, "start", unit, &bindir));
    cleanup_apply_artifacts(staged);
    0
}

/// The pin line `--install-system-service` wrote into the system unit before
/// 2026-10-04. It forced the install port on every start, so a Settings port
/// change came back on the install port (user decision 2026-10-04: the port
/// lives in config.json only).
const WEB_PORT_PIN: &str = "Environment=WS_SCRCPY_WEB_PORT=";

/// `unit` without its WS_SCRCPY_WEB_PORT pin line, or None when it has none
/// (nothing to rewrite). Every other line is kept byte for byte. Pure.
pub fn strip_web_port_pin(unit: &str) -> Option<String> {
    let lines: Vec<&str> = unit.split_inclusive('\n').collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| !l.trim_start().starts_with(WEB_PORT_PIN))
        .collect();
    (kept.len() != lines.len()).then(|| kept.concat())
}

/// `restorecon` for the rewritten system unit, or None. The rewrite is a new
/// inode, so it carries the label its creation gave it, not the old file's;
/// `restorecon` puts the policy's label back. Only with SELinux active and
/// `restorecon` present: there is no `chcon` fallback, because the policy's
/// default is the label a unit file should have. Pure.
pub fn unit_restorecon_command(
    unit_file: &Path,
    bindir: &str,
    restorecon_present: bool,
    selinux_active: bool,
) -> Option<Vec<String>> {
    if !(selinux_active && restorecon_present) {
        return None;
    }
    Some(vec![
        format!("{}/restorecon", linux_service::sbindir_from(bindir)),
        "-v".into(),
        unit_file.to_string_lossy().into_owned(),
    ])
}

/// Rewrite the stopped system unit without its pin (a fresh 0644 file, synced,
/// renamed over it), restore its SELinux label where `unit_restorecon_command`
/// says so, then `daemon-reload` so the next start reads it. Best-effort: a
/// failure is logged and the unit starts as it was. A symlinked unit is left
/// alone; `--install-system-service` writes a regular file.
fn unpin_system_unit(unit_file: &Path, bindir: &str, restorecon_present: bool, selinux: bool) {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    match std::fs::symlink_metadata(unit_file) {
        Ok(m) if m.is_file() => {}
        _ => return,
    }
    let Some(text) = std::fs::read_to_string(unit_file)
        .ok()
        .and_then(|t| strip_web_port_pin(&t))
    else {
        return;
    };
    let mut tmp = unit_file.as_os_str().to_owned();
    tmp.push(".new");
    let tmp = PathBuf::from(tmp);
    // Synced before the rename, so a crash after it cannot leave the unit's name
    // on an empty or partial file.
    let written = std::fs::File::create(&tmp)
        .and_then(|mut f| {
            f.write_all(text.as_bytes())?;
            f.set_permissions(std::fs::Permissions::from_mode(0o644))?;
            f.sync_all()
        })
        .and_then(|()| std::fs::rename(&tmp, unit_file));
    match written {
        Ok(()) => {
            log::info(&format!(
                "linux-apply(service): removed the WS_SCRCPY_WEB_PORT pin from {unit_file:?}"
            ));
            let relabel = unit_restorecon_command(unit_file, bindir, restorecon_present, selinux);
            if let Some(argv) = relabel {
                run_cmd(&argv);
            }
            run_cmd(&[format!("{bindir}/systemctl"), "daemon-reload".to_string()]);
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            log::error(&format!(
                "linux-apply(service): could not remove the WS_SCRCPY_WEB_PORT pin from {unit_file:?} ({e})"
            ));
        }
    }
}

/// Run one argv vector, logging the outcome (best-effort). Shared by the service path.
fn run_cmd(argv: &[String]) {
    let (cmd, rest) = match argv.split_first() {
        Some(v) => v,
        None => return,
    };
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) if s.success() => log::info(&format!("linux-apply(service) ok: {}", argv.join(" "))),
        Ok(s) => log::error(&format!(
            "linux-apply(service) non-zero ({:?}): {}",
            s.code(),
            argv.join(" ")
        )),
        Err(e) => log::error(&format!(
            "linux-apply(service) spawn failed: {} ({e})",
            argv.join(" ")
        )),
    }
}

/// `<target>.bak`
pub fn backup_path(target: &Path) -> PathBuf {
    let mut s = target.as_os_str().to_os_string();
    s.push(".bak");
    PathBuf::from(s)
}

/// Back up `target` -> `<target>.bak`, move `staged` over `target`, chmod 0755.
/// On a move failure after backup, restore the backup. Pure file ops — unit-tested.
pub fn swap_appimage(staged: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if !staged.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "staged file missing",
        ));
    }
    let backup = backup_path(target);
    if target.exists() {
        // rename within-fs; fall back to copy for cross-fs.
        std::fs::rename(target, &backup).or_else(|_| std::fs::copy(target, &backup).map(|_| ()))?;
    }
    let moved = std::fs::rename(staged, target).or_else(|_| {
        std::fs::copy(staged, target)
            .and_then(|_| std::fs::remove_file(staged))
            .map(|_| ())
    });
    if let Err(e) = moved {
        if backup.exists() {
            let _ = std::fs::rename(&backup, target);
        }
        return Err(e);
    }
    std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

/// Poll until `/proc/<pid>` disappears or `timeout` elapses. No libc dependency.
fn wait_for_pid_exit(pid: u32, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    log::error(&format!(
        "linux-apply: pid {pid} still alive after {timeout:?}; proceeding anyway"
    ));
}

/// Relaunch the new AppImage so it OUTLIVES this helper. When this helper itself
/// runs inside a systemd transient unit (launched via `systemd-run --collect`,
/// which sets INVOCATION_ID), the relaunched app must run in its OWN
/// `systemd-run --user --collect` transient unit (user-manager-owned, separate
/// cgroup) so it survives this helper's exit (mirrors linux_service.rs). On a
/// non-systemd host the helper is its own session leader, so a detached spawn
/// survives. Argv built by `relaunch_command`.
fn relaunch(target: &Path) {
    let systemd_run = format!(
        "{}/systemd-run",
        crate::linux_service::tool_dir("systemd-run")
    );
    let use_systemd = under_systemd() && Path::new(&systemd_run).exists();
    let argv = relaunch_command(target, use_systemd, &systemd_run);
    let (cmd, rest) = argv.split_first().expect("non-empty argv");
    let mut command = std::process::Command::new(cmd);
    command
        .args(rest)
        // G1: suppress the browser-open on relaunch (the direct-exec path; the
        // systemd-run path carries it via --setenv in relaunch_command).
        .env("WS_SCRCPY_NO_BROWSER", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if use_systemd {
        // MUST WAIT (.status), not .spawn: this helper runs in its OWN
        // `systemd-run --collect` unit, so the instant we exit systemd reaps our
        // cgroup. A .spawn'd `systemd-run` child would be killed mid-registration
        // and the relaunch unit would never start — beta.33's bug (swap ok, but
        // the app never came back). `systemd-run` returns promptly once the unit
        // is registered+started; the unit is user-manager-owned (its own cgroup)
        // so it outlives us. Same pattern as linux_service.rs's teardown relaunch.
        match command.status() {
            Ok(s) => log::info(&format!(
                "linux-apply: relaunched via `{}` (systemd-run exit {:?})",
                argv.join(" "),
                s.code()
            )),
            Err(e) => log::error(&format!(
                "linux-apply: relaunch failed (`{}`): {e}",
                argv.join(" ")
            )),
        }
    } else {
        // Non-systemd: we're a session leader; detached spawn, app reparents to init.
        match command.spawn() {
            Ok(child) => log::info(&format!(
                "linux-apply: relaunched `{}` (pid {})",
                argv.join(" "),
                child.id()
            )),
            Err(e) => log::error(&format!(
                "linux-apply: relaunch failed (`{}`): {e}",
                argv.join(" ")
            )),
        }
    }
}

/// True when running inside a systemd unit — `systemd-run` sets `INVOCATION_ID`
/// for the processes it starts. Drives the relaunch escape strategy.
fn under_systemd() -> bool {
    std::env::var("INVOCATION_ID")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// argv for relaunching `target`. Under systemd → its OWN `systemd-run --user
/// --collect` transient unit (survives this helper's exit); otherwise a bare
/// exec (the caller detaches via stdio-null). Pure — unit-tested.
pub fn relaunch_command(target: &Path, under_systemd: bool, systemd_run: &str) -> Vec<String> {
    let t = target.to_string_lossy().into_owned();
    if under_systemd {
        // G1: suppress the browser-open on relaunch — the user already has a tab
        // that reconnects, so the relaunched instance must not pop a new one.
        // §71: shared user-relaunch builder (--user --collect [setenv] <target>).
        crate::linux_service::user_relaunch_command(
            systemd_run,
            &["--setenv=WS_SCRCPY_NO_BROWSER=1"],
            &t,
        )
    } else {
        // Direct exec — relaunch() sets WS_SCRCPY_NO_BROWSER on the Command.
        vec![t]
    }
}

/// `systemctl [--user] <action> <unit>.service` — `--user` for user scope, the
/// system manager for system scope. Absolute systemctl path, never PATH. Pure.
pub fn service_unit_command(scope: Scope, action: &str, unit: &str, bindir: &str) -> Vec<String> {
    let systemctl = format!("{bindir}/systemctl");
    let pre = linux_service::scope_prefix(scope);
    [
        vec![systemctl],
        pre,
        vec![action.to_string(), format!("{unit}.service")],
    ]
    .concat()
}

/// Re-apply the `bin_t` SELinux label to the system-staged target after a swap,
/// so `init_t` may exec it. `restorecon` (sbin) re-applies the persistent
/// fcontext rule set at install; when absent, fall back to `chcon -t bin_t`
/// (bin). `restorecon_present` is the availability the caller probed. `None`
/// when SELinux is not active: there is no label to apply, and `chcon` on an
/// unlabeled file only logs an error (Ubuntu, qa-harness T13 row 6.6). Pure.
pub fn relabel_command(
    target: &Path,
    bindir: &str,
    restorecon_present: bool,
    selinux_active: bool,
) -> Option<Vec<String>> {
    if !selinux_active {
        return None;
    }
    let t = target.to_string_lossy().into_owned();
    Some(if restorecon_present {
        let sbindir = linux_service::sbindir_from(bindir);
        vec![format!("{sbindir}/restorecon"), "-v".into(), t]
    } else {
        vec![format!("{bindir}/chcon"), "-t".into(), "bin_t".into(), t]
    })
}

/// Whether SELinux is active on this host: selinuxfs is mounted only when it
/// is enabled (the check libselinux's `is_selinux_enabled` makes).
fn selinux_active() -> bool {
    Path::new("/sys/fs/selinux/enforce").exists()
}

/// Parse `--service-restart <user|system> --unit <name> [--relabel]`. Returns
/// None when `--service-restart` is absent (the local-mode apply path). Pure.
pub fn parse_service_restart(args: &[String]) -> Option<(Scope, String, bool)> {
    let scope = arg_value(args, "--service-restart").and_then(|s| match s {
        "user" => Some(Scope::User),
        "system" => Some(Scope::System),
        _ => None,
    })?;
    let unit = arg_value(args, "--unit")?.to_string();
    let relabel = args.iter().any(|a| a == "--relabel");
    Some((scope, unit, relabel))
}

/// Whether the apply must SWAP the binary (true) or is relaunch-only (false).
/// Local + service applies pass `--staged` and swap it in. Phase 3 machine-wide-
/// no-service applies OMIT `--staged` — the elevated pkexec RENAME-swap of the
/// root-owned /opt binary already ran in the Node server — so the helper only
/// waits-for-pid + relaunches the swapped /opt copy. Pure — unit-tested.
pub fn should_swap(args: &[String]) -> bool {
    arg_value(args, "--staged").is_some()
}

/// `<data_root>/control/apply-update-pending` — the apply marker path. Pure.
pub fn apply_marker_path(data_root: &Path) -> PathBuf {
    data_root.join("control").join("apply-update-pending")
}

/// Best-effort removal of the staged `.new` + the apply-update-pending marker.
/// Never fails the apply — a cleanup error is irrelevant to the swap outcome.
fn cleanup_apply_artifacts(staged: &Path) {
    let _ = std::fs::remove_file(staged);
    if let Some(data_root) = common::config::data_root_from_env() {
        let _ = std::fs::remove_file(apply_marker_path(&data_root));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_replaces_target_and_backs_up_old() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("App.AppImage");
        let staged = tmp.path().join("App.AppImage.new");
        std::fs::write(&target, b"OLD").unwrap();
        std::fs::write(&staged, b"NEW").unwrap();

        swap_appimage(&staged, &target).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"NEW");
        assert_eq!(std::fs::read(backup_path(&target)).unwrap(), b"OLD");
        assert!(!staged.exists(), "staged file consumed");
    }

    /// A system unit as `--install-system-service` rendered it before 2026-10-04
    /// (SystemdClient.renderUnitFile, system scope), pin included.
    const PINNED_UNIT: &str = "[Unit]\nDescription=ws-scrcpy-web\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=10\n\n[Service]\nType=simple\nExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage\nWorkingDirectory=/opt/ws-scrcpy-web\nRestart=on-failure\nRestartSec=2\nLimitNOFILE=65536\nEnvironment=DATA_ROOT=/var/lib/ws-scrcpy-web\nEnvironment=DEPS_PATH=/opt/ws-scrcpy-web/dependencies\nEnvironment=WS_SCRCPY_SERVICE=1\nEnvironment=WS_SCRCPY_WEB_PORT=8123\nStandardOutput=append:/var/lib/ws-scrcpy-web/logs/service.log\nStandardError=append:/var/lib/ws-scrcpy-web/logs/service.log\n\n[Install]\nWantedBy=multi-user.target\n";

    #[test]
    fn strip_web_port_pin_drops_only_the_pin_line() {
        let stripped = strip_web_port_pin(PINNED_UNIT).expect("the pinned unit has a pin");
        assert!(!stripped.contains("WS_SCRCPY_WEB_PORT"), "{stripped}");
        assert_eq!(
            stripped,
            PINNED_UNIT.replace("Environment=WS_SCRCPY_WEB_PORT=8123\n", "")
        );
        // Nothing to rewrite in a unit installed without the pin.
        assert_eq!(strip_web_port_pin(&stripped), None);
    }

    #[test]
    fn unpin_system_unit_rewrites_the_file_without_the_pin() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let unit = tmp.path().join("WsScrcpyWeb.service");
        std::fs::write(&unit, PINNED_UNIT).unwrap();
        // The tools dir holds no restorecon or systemctl: the relabel and the
        // daemon-reload only log their spawn failures.
        unpin_system_unit(&unit, tmp.path().to_str().unwrap(), true, true);
        let after = std::fs::read_to_string(&unit).unwrap();
        assert_eq!(
            after,
            PINNED_UNIT.replace("Environment=WS_SCRCPY_WEB_PORT=8123\n", "")
        );
        assert_eq!(
            std::fs::metadata(&unit).unwrap().permissions().mode() & 0o7777,
            0o644
        );
        assert!(!tmp.path().join("WsScrcpyWeb.service.new").exists());
    }

    #[test]
    fn unit_restorecon_command_needs_selinux_and_restorecon() {
        let unit = Path::new("/etc/systemd/system/WsScrcpyWeb.service");
        assert_eq!(
            unit_restorecon_command(unit, "/usr/bin", true, true),
            Some(
                [
                    "/usr/sbin/restorecon",
                    "-v",
                    "/etc/systemd/system/WsScrcpyWeb.service"
                ]
                .map(String::from)
                .to_vec()
            )
        );
        // No chcon fallback for the unit: without restorecon, or without
        // SELinux, nothing runs.
        for (present, selinux) in [(false, true), (true, false), (false, false)] {
            assert_eq!(
                unit_restorecon_command(unit, "/usr/bin", present, selinux),
                None
            );
        }
    }

    #[test]
    fn unpin_system_unit_leaves_an_unpinned_unit_and_a_symlink_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let clean = PINNED_UNIT.replace("Environment=WS_SCRCPY_WEB_PORT=8123\n", "");
        let unit = tmp.path().join("WsScrcpyWeb.service");
        std::fs::write(&unit, &clean).unwrap();
        let before = std::fs::metadata(&unit).unwrap().modified().unwrap();
        unpin_system_unit(&unit, "/nonexistent", false, false);
        assert_eq!(std::fs::read_to_string(&unit).unwrap(), clean);
        assert_eq!(
            std::fs::metadata(&unit).unwrap().modified().unwrap(),
            before
        );

        let target = tmp.path().join("elsewhere.service");
        std::fs::write(&target, PINNED_UNIT).unwrap();
        let link = tmp.path().join("Linked.service");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        unpin_system_unit(&link, "/nonexistent", false, false);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), PINNED_UNIT);
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn swap_errors_and_preserves_target_when_staged_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("App.AppImage");
        std::fs::write(&target, b"OLD").unwrap();
        let staged = tmp.path().join("does-not-exist.new");

        assert!(swap_appimage(&staged, &target).is_err());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"OLD",
            "target untouched on error"
        );
    }

    #[test]
    fn arg_value_reads_following_token() {
        let args = vec!["x".to_string(), "--target".to_string(), "/a/b".to_string()];
        assert_eq!(arg_value(&args, "--target"), Some("/a/b"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn relaunch_uses_own_systemd_unit_under_systemd() {
        // #27: under systemd the new app must run in its OWN --collect unit so it
        // survives this helper's exit (not in this helper's reaped cgroup).
        assert_eq!(
            relaunch_command(
                Path::new("/home/u/App.AppImage"),
                true,
                "/usr/bin/systemd-run"
            ),
            vec![
                "/usr/bin/systemd-run",
                "--user",
                "--collect",
                "--setenv=WS_SCRCPY_NO_BROWSER=1",
                "/home/u/App.AppImage"
            ]
        );
    }

    #[test]
    fn relaunch_is_direct_when_not_under_systemd() {
        // Non-systemd host: helper is its own session leader, plain exec survives.
        assert_eq!(
            relaunch_command(
                Path::new("/home/u/App.AppImage"),
                false,
                "/usr/bin/systemd-run"
            ),
            vec!["/home/u/App.AppImage"]
        );
    }

    #[test]
    fn apply_marker_path_is_under_control() {
        assert_eq!(
            apply_marker_path(Path::new("/d")),
            PathBuf::from("/d/control/apply-update-pending")
        );
    }

    #[test]
    fn service_unit_command_user_scope() {
        assert_eq!(
            service_unit_command(
                linux_service::Scope::User,
                "stop",
                "WsScrcpyWeb",
                "/usr/bin"
            ),
            vec![
                "/usr/bin/systemctl",
                "--user",
                "stop",
                "WsScrcpyWeb.service"
            ]
        );
        assert_eq!(
            service_unit_command(
                linux_service::Scope::User,
                "start",
                "WsScrcpyWeb",
                "/usr/bin"
            ),
            vec![
                "/usr/bin/systemctl",
                "--user",
                "start",
                "WsScrcpyWeb.service"
            ]
        );
    }

    #[test]
    fn service_unit_command_system_scope_has_no_user_flag() {
        assert_eq!(
            service_unit_command(
                linux_service::Scope::System,
                "stop",
                "WsScrcpyWeb",
                "/usr/bin"
            ),
            vec!["/usr/bin/systemctl", "stop", "WsScrcpyWeb.service"]
        );
    }

    #[test]
    fn relabel_command_prefers_restorecon_then_chcon() {
        // restorecon present -> use it (re-applies the persistent fcontext rule).
        assert_eq!(
            relabel_command(
                Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"),
                "/usr/bin",
                true,
                true
            ),
            Some(
                [
                    "/usr/sbin/restorecon",
                    "-v",
                    "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"
                ]
                .map(String::from)
                .to_vec()
            )
        );
        // restorecon absent -> chcon -t bin_t fallback (bin dir).
        assert_eq!(
            relabel_command(
                Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"),
                "/usr/bin",
                false,
                true
            ),
            Some(
                [
                    "/usr/bin/chcon",
                    "-t",
                    "bin_t",
                    "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"
                ]
                .map(String::from)
                .to_vec()
            )
        );
    }

    #[test]
    fn relabel_command_is_nothing_without_selinux() {
        // qa-harness T13 row 6.6 on Ubuntu 26.04 (no SELinux, no restorecon): the
        // chcon fallback logged "Applying partial security context to unlabeled
        // file failed". There is no label to apply, so nothing runs.
        for restorecon in [true, false] {
            assert_eq!(
                relabel_command(
                    Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"),
                    "/usr/bin",
                    restorecon,
                    false
                ),
                None
            );
        }
    }

    #[test]
    fn parse_service_restart_reads_scope_unit_relabel() {
        let args: Vec<String> = [
            "--linux-apply",
            "--service-restart",
            "system",
            "--unit",
            "WsScrcpyWeb",
            "--relabel",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_service_restart(&args),
            Some((
                linux_service::Scope::System,
                "WsScrcpyWeb".to_string(),
                true
            ))
        );

        let user: Vec<String> = [
            "--linux-apply",
            "--service-restart",
            "user",
            "--unit",
            "WsScrcpyWeb",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_service_restart(&user),
            Some((linux_service::Scope::User, "WsScrcpyWeb".to_string(), false))
        );

        // absent -> None (the local-mode path)
        let local: Vec<String> = ["--linux-apply", "--staged", "/a", "--target", "/b"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(parse_service_restart(&local), None);
    }

    #[test]
    fn should_swap_false_for_relaunch_only_missing_staged() {
        // Phase 3 machine-wide-no-service: the helper is invoked WITHOUT --staged
        // (the elevated pkexec rename-swap of the /opt binary already ran in the
        // Node server). run() must then SKIP swap_appimage and only wait-for-pid +
        // relaunch the freshly-swapped /opt copy.
        let relaunch_only: Vec<String> = [
            "--linux-apply",
            "--target",
            "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage",
            "--wait-pid",
            "4321",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(
            !should_swap(&relaunch_only),
            "no --staged means relaunch-only (skip swap)"
        );

        // Local + service applies carry --staged and DO swap the binary in place.
        let local: Vec<String> = [
            "--linux-apply",
            "--staged",
            "/d/App.new",
            "--target",
            "/home/u/App.AppImage",
            "--wait-pid",
            "4321",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(
            should_swap(&local),
            "--staged present means swap then relaunch"
        );
    }
}
