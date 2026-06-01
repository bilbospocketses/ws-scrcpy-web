// §41 — Linux local-mode in-app update apply. Velopack 1.0.1's UpdateNix apply
// fails on our AppImage (it re-derives a locator from `--root <appimage>` and
// fails the UpdateExePath check). Instead the Node server downloads + verifies
// the new AppImage, then spawns THIS helper (the launcher copy staged in
// dataRoot, outside the mount) to swap $APPIMAGE + relaunch.
// See docs/specs/2026-06-01-linux-appimage-self-update-design.md.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::log;

/// Dispatch: if argv contains `--linux-apply`, handle it and return Some(exit_code).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-apply") {
        return None;
    }
    Some(run(args))
}

fn arg_value<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter().position(|a| a == key).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
}

fn run(args: &[String]) -> i32 {
    let staged = match arg_value(args, "--staged") {
        Some(s) => PathBuf::from(s),
        None => {
            log::error("linux-apply: missing --staged");
            return 2;
        }
    };
    let target = match arg_value(args, "--target") {
        Some(s) => PathBuf::from(s),
        None => {
            log::error("linux-apply: missing --target");
            return 2;
        }
    };
    let wait_pid = arg_value(args, "--wait-pid").and_then(|s| s.parse::<u32>().ok());
    log::info(&format!("linux-apply: staged={staged:?} target={target:?} wait_pid={wait_pid:?}"));

    if let Some(pid) = wait_pid {
        wait_for_pid_exit(pid, Duration::from_secs(60));
    }

    match swap_appimage(&staged, &target) {
        Ok(()) => {
            log::info("linux-apply: swap ok, relaunching");
            relaunch(&target);
            0
        }
        Err(e) => {
            log::error(&format!("linux-apply: swap failed: {e}"));
            1
        }
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
        return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "staged file missing"));
    }
    let backup = backup_path(target);
    if target.exists() {
        // rename within-fs; fall back to copy for cross-fs.
        std::fs::rename(target, &backup).or_else(|_| std::fs::copy(target, &backup).map(|_| ()))?;
    }
    let moved = std::fs::rename(staged, target)
        .or_else(|_| std::fs::copy(staged, target).and_then(|_| std::fs::remove_file(staged)).map(|_| ()));
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
    log::error(&format!("linux-apply: pid {pid} still alive after {timeout:?}; proceeding anyway"));
}

/// Spawn the new AppImage detached; the helper then exits.
fn relaunch(target: &Path) {
    match std::process::Command::new(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => log::info(&format!("linux-apply: relaunched {target:?} (pid {})", child.id())),
        Err(e) => log::error(&format!("linux-apply: relaunch failed: {e}")),
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

    #[test]
    fn swap_errors_and_preserves_target_when_staged_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("App.AppImage");
        std::fs::write(&target, b"OLD").unwrap();
        let staged = tmp.path().join("does-not-exist.new");

        assert!(swap_appimage(&staged, &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"OLD", "target untouched on error");
    }

    #[test]
    fn arg_value_reads_following_token() {
        let args = vec!["x".to_string(), "--target".to_string(), "/a/b".to_string()];
        assert_eq!(arg_value(&args, "--target"), Some("/a/b"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }
}
