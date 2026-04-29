// Install-root ACL grant for the running user (Windows-only).
//
// v0.1.23 in-app updater investigation found that Velopack's PerMachine
// install model only works if the install root has Authenticated
// Users:Modify — without it, Velopack's writability self-test fails,
// falls back to LocalAppData for state, and the elevated Update.exe
// re-launch silently dies during the swap step.
//
// Granting the ACL during the `--veloapp-install` hook (added in
// v0.1.23-beta.5) doesn't survive the MSI's component-permission step
// (which runs AFTER our hook and resets the explicit DACL on
// Program Files\WsScrcpyWeb to inherited-only). Manual icacls grant
// after the install completes persists across reboot, and tested
// successfully end-to-end with the in-app updater (v0.1.23-beta.5 →
// beta.6 swapped on 2026-04-29 02:26).
//
// Solution: defer the grant to first non-hook launcher start. If the
// install root isn't user-writable, ShellExecuteEx an elevated icacls
// invocation (one-time UAC prompt). Once granted, all subsequent
// launches find the install root writable and skip the elevation
// entirely. Same approach handles migrations from v0.1.21 / v0.1.22 /
// v0.1.23-beta.{1..6} → beta.7+ (those installs didn't have the
// grant either; first launch under beta.7 catches them).

use anyhow::{Context, Result, bail};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject};
use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::core::PCWSTR;

const SENTINEL_FILE_NAME: &str = ".ws-scrcpy-write-test";
const ACL_SID_AUTH_USERS: &str = "*S-1-5-11";

/// Test whether the running user can write to `path`. Creates and deletes
/// a sentinel file. Velopack uses a similar test internally
/// (`<root>/.velopack_dir_test`) — we use a distinct filename so concurrent
/// self-tests don't race.
pub fn is_writable(path: &Path) -> bool {
    let test_path = path.join(SENTINEL_FILE_NAME);
    match std::fs::write(&test_path, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&test_path);
            true
        }
        Err(_) => false,
    }
}

/// Ensure the install root has `Authenticated Users:Modify (OI)(CI)` so
/// the Velopack updater can swap `current\` without elevation.
///
/// If `install_root` is already writable to the running user, returns
/// `Ok(())` without prompting. Otherwise:
///   1. Invokes `icacls.exe <root> /grant *S-1-5-11:(OI)(CI)M /T /C /Q`
///      with `ShellExecuteExW(verb="runas")`. UAC prompt fires.
///   2. Waits for the elevated icacls process to exit.
///   3. Re-tests writability. Returns `Ok(())` on success, `Err` on
///      failure (UAC dismissed, icacls failed, etc.).
///
/// Caller is expected to log the failure and continue — the app works
/// without this grant; only the in-app updater is degraded.
pub fn ensure_writable(install_root: &Path) -> Result<()> {
    if is_writable(install_root) {
        return Ok(());
    }

    crate::log::info(
        "install-root not writable to current user; \
         requesting elevation to grant Authenticated Users:Modify (one-time UAC)",
    );

    let exit_code = run_icacls_elevated(install_root)?;
    if exit_code != 0 {
        bail!("elevated icacls exited with code {exit_code}");
    }

    if !is_writable(install_root) {
        bail!("icacls reported success but install-root still not writable to running user");
    }

    crate::log::info(&format!(
        "install-root grant applied on {install_root:?}; in-app updater should now function"
    ));
    Ok(())
}

fn run_icacls_elevated(install_root: &Path) -> Result<i32> {
    let install_root_str = install_root.to_string_lossy();
    // icacls needs the path quoted because it can contain spaces (e.g.
    // "C:\Program Files\WsScrcpyWeb"). The (OI)(CI)M means object +
    // container inheritance + Modify perm; /T recurses to existing
    // children; /C continues on per-file errors; /Q suppresses success
    // chatter (irrelevant for our hidden invocation but matches the
    // hook-side grant style).
    let parameters = format!(
        "\"{}\" /grant {}:(OI)(CI)M /T /C /Q",
        install_root_str, ACL_SID_AUTH_USERS
    );

    let verb = to_wide("runas");
    let file = to_wide("icacls.exe");
    let params = to_wide(&parameters);

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: 0, // SW_HIDE — don't flash an icacls console window
        ..Default::default()
    };

    unsafe {
        ShellExecuteExW(&mut info)
            .context("ShellExecuteExW failed (UAC declined or admin not available?)")?;
    }

    if info.hProcess.is_invalid() {
        bail!("ShellExecuteExW returned no process handle");
    }

    let proc = info.hProcess;
    unsafe {
        WaitForSingleObject(proc, INFINITE);
        let mut code: u32 = 1;
        let result = GetExitCodeProcess(proc, &mut code);
        let _ = CloseHandle(proc);
        result.context("GetExitCodeProcess failed")?;
        Ok(code as i32)
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn is_writable_returns_true_for_user_owned_tempdir() {
        let dir = tempdir().unwrap();
        assert!(is_writable(dir.path()));
    }

    #[test]
    fn is_writable_does_not_leave_sentinel_behind() {
        let dir = tempdir().unwrap();
        is_writable(dir.path());
        let sentinel = dir.path().join(SENTINEL_FILE_NAME);
        assert!(!sentinel.exists(), "sentinel file should be cleaned up");
    }

    #[test]
    fn is_writable_returns_false_for_nonexistent_path() {
        let dir = tempdir().unwrap();
        let nonexistent = dir.path().join("does-not-exist");
        assert!(!is_writable(&nonexistent));
    }
}
