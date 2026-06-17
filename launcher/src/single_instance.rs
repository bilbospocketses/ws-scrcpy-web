// Single-instance guard for the launcher.
//
// Without this guard, double-clicking the launcher (or running it twice
// from any source) would spawn parallel servers + tray icons. The second
// server hits port-collision auto-shift and binds 8001, the user has two
// tray icons with no way to tell which is which, and Velopack's
// "apply-update-on-restart" assumption (single instance owns the install
// dir) breaks down. See TODO #4b for the full motivation.
//
// Implementation: a Windows named mutex in the Local namespace, suffixed
// with the current process's token elevation. So we get TWO mutex names:
//   Local\WsScrcpyWeb-SingleInstance-User    (medium integrity)
//   Local\WsScrcpyWeb-SingleInstance-Admin   (high integrity)
//
// This intentionally allows ONE non-elevated instance and ONE elevated
// instance to coexist. The legitimate use case: a user has the normal
// app running (non-elevated, tray-icon, browsing devices), and wants to
// uninstall the service. They right-click → Run as administrator to get
// a second instance with elevated privileges, do the service uninstall,
// then exit the admin instance. If the guard blocked all duplicates,
// that workflow would be impossible.
//
// Same-integrity duplicates are still blocked — two non-elevated
// instances can't both run, two elevated instances can't either.
//
// We do NOT try to focus or message the existing instance — that's a
// separate UX concern (and would require a window-message channel that
// our hidden-console launcher doesn't have today). The user gets a
// no-op exit; the existing instance keeps running with its tray icon.
//
// IMPORTANT: This guard only applies to the NORMAL launcher launch.
// Velopack lifecycle hooks (--veloapp-install / --veloapp-updated /
// --veloapp-uninstall) and elevate-and-run helpers must skip the guard
// because they can legitimately race with a running instance — the hook
// runs alongside, the elevated helper runs alongside. main() handles
// these branches BEFORE acquiring the guard.

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use crate::win_util::to_wide;

    /// Returns true when the current process has an elevated token (i.e.
    /// "Run as administrator" was used). Internally queries the process
    /// token via OpenProcessToken + GetTokenInformation(TokenElevation).
    /// Returns false on any error path — we'd rather under-segregate the
    /// mutex namespace than panic on startup.
    pub fn is_elevated() -> bool {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Security::{
            GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token: HANDLE = HANDLE::default();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION::default();
            let mut size = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut size,
            );
            let _ = CloseHandle(token);
            if ok.is_err() {
                return false;
            }
            elevation.TokenIsElevated != 0
        }
    }

    /// Holds the OS handle to the named mutex. On Drop the handle is
    /// closed; once all handles to a named mutex close, Windows removes
    /// it automatically. So a normal process exit cleans up correctly,
    /// and a process kill / crash also releases the mutex (Windows
    /// destroys all handles when a process terminates).
    pub struct InstanceGuard {
        handle: windows::Win32::Foundation::HANDLE,
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }

    /// Try to acquire the single-instance guard. Returns:
    ///   - Ok(Some(guard)): we are the first / only instance; hold the
    ///     guard for the launcher's lifetime.
    ///   - Ok(None): another instance is already running; caller should
    ///     exit cleanly with status 0.
    ///   - Err(e): something unexpected went wrong creating the mutex
    ///     (very rare — system resource exhaustion, security descriptor
    ///     issue, etc.). Caller should log and proceed without the
    ///     guard rather than block startup.
    pub fn acquire(name: &str) -> Result<Option<InstanceGuard>> {
        use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::PCWSTR;

        let wide = to_wide(name);
        let handle = unsafe {
            CreateMutexW(None, false, PCWSTR::from_raw(wide.as_ptr()))?
        };
        // CreateMutexW returns a valid handle EVEN when the mutex
        // already existed; GetLastError tells us which case we're in.
        let last = unsafe { GetLastError() };
        if last == ERROR_ALREADY_EXISTS {
            // Close our handle so we don't keep the mutex alive past
            // our exit and force-cascade-cleanup the original holder.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(InstanceGuard { handle }))
    }
}

#[cfg(not(windows))]
mod imp {
    use anyhow::Result;
    use std::fs::{File, OpenOptions};
    use std::path::{Path, PathBuf};
    use rustix::fs::{flock, FlockOperation};

    /// Holds the open file descriptor for the lock file.
    /// Drop closes the fd, which releases the flock automatically.
    pub struct InstanceGuard {
        _file: File,
    }

    /// Compute the path to the per-user instance lock file.
    ///
    /// Prefers `$XDG_RUNTIME_DIR` (e.g. `/run/user/1000`) because it is
    /// uid-scoped and wiped on logout — perfect lifetime semantics.
    /// Falls back to `<dataRoot>/control/instance.lock` when XDG is absent.
    pub fn lock_path(xdg_runtime_dir: Option<&str>, data_root: Option<&str>) -> PathBuf {
        if let Some(x) = xdg_runtime_dir.filter(|s| !s.is_empty()) {
            return PathBuf::from(x).join("ws-scrcpy-web.lock");
        }
        PathBuf::from(data_root.unwrap_or("/tmp"))
            .join("control")
            .join("instance.lock")
    }

    /// Try to acquire an exclusive non-blocking flock on `path`.
    ///
    /// Returns:
    /// - `Ok(Some(guard))` — lock acquired; we are the sole instance.
    /// - `Ok(None)` — another instance already holds the lock; caller should exit.
    /// - `Err(e)` — unexpected I/O error.
    pub fn acquire_at(path: &Path) -> Result<Option<InstanceGuard>> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)?;
        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Some(InstanceGuard { _file: file })),
            Err(e) if e == rustix::io::Errno::WOULDBLOCK => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Public entry point called from `main()`.
    ///
    /// Resolves the lock path from environment and acquires it.
    pub fn acquire(_name: &str) -> Result<Option<InstanceGuard>> {
        let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
        let dr = common::config::data_root_from_env()
            .map(|p| p.to_string_lossy().into_owned());
        acquire_at(&lock_path(xdg.as_deref(), dr.as_deref()))
    }

    /// Always false on non-Windows (no elevation concept).
    pub fn is_elevated() -> bool {
        false
    }
}

pub use imp::acquire;
#[allow(unused_imports)]
pub use imp::InstanceGuard;

const MUTEX_BASE: &str = r"Local\WsScrcpyWeb-SingleInstance";

/// Build the canonical mutex name for THIS process's elevation level.
/// Two distinct names — `-User` and `-Admin` — let one non-elevated and
/// one elevated instance coexist (legitimate workflow: admin instance
/// for service install/uninstall while normal instance keeps running).
/// Same-integrity duplicates are still blocked because both contenders
/// would try to acquire the same suffixed name.
pub fn current_mutex_name() -> String {
    let suffix = if imp::is_elevated() { "Admin" } else { "User" };
    format!("{MUTEX_BASE}-{suffix}")
}

#[cfg(all(test, not(windows)))]
mod linux_tests {
    use super::imp::{acquire_at, lock_path};
    use std::path::PathBuf;

    #[test]
    fn lock_path_prefers_xdg_runtime_dir() {
        assert_eq!(
            lock_path(Some("/run/user/1000"), Some("/home/u/.local/share/WsScrcpyWeb")),
            PathBuf::from("/run/user/1000/ws-scrcpy-web.lock")
        );
        assert_eq!(
            lock_path(None, Some("/home/u/.local/share/WsScrcpyWeb")),
            PathBuf::from("/home/u/.local/share/WsScrcpyWeb/control/instance.lock")
        );
    }

    #[test]
    fn flock_blocks_same_user_second_launch() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("instance.lock");
        let first = acquire_at(&p).unwrap();
        assert!(first.is_some(), "first acquire holds the lock");
        assert!(
            acquire_at(&p).unwrap().is_none(),
            "second acquire on a held flock returns None"
        );
        drop(first);
        assert!(
            acquire_at(&p).unwrap().is_some(),
            "after drop, re-acquire succeeds"
        );
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn acquire_grants_first_caller() {
        // Use a unique mutex name to avoid colliding with any real
        // instance running on the test box.
        let name = format!(r"Local\WsScrcpyWeb-Test-{}", uuid_like());
        let guard = acquire(&name).unwrap();
        assert!(guard.is_some(), "first acquire should succeed");
    }

    #[test]
    fn acquire_denies_second_caller_while_first_is_held() {
        let name = format!(r"Local\WsScrcpyWeb-Test-{}", uuid_like());
        let first = acquire(&name).unwrap().expect("first acquire");
        let second = acquire(&name).unwrap();
        assert!(second.is_none(), "second acquire should see ERROR_ALREADY_EXISTS");
        drop(first);
    }

    #[test]
    fn acquire_succeeds_again_after_first_drops() {
        let name = format!(r"Local\WsScrcpyWeb-Test-{}", uuid_like());
        {
            let _g = acquire(&name).unwrap().expect("first acquire");
        }
        // The mutex's last handle was just closed; a new acquire should
        // succeed.
        let again = acquire(&name).unwrap();
        assert!(again.is_some(), "acquire after drop should succeed");
    }

    fn uuid_like() -> String {
        // Cheap unique-enough id for test mutex names — full UUID isn't
        // worth the dep.
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }
}
