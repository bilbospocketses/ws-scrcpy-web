// Per-session single-instance guard for the standalone tray helper.
//
// The tray helper can be spawned at logon by both HKLM\...\Run and
// HKCU\...\Run entries (transitional state during the v0.1.24 → v0.1.25
// migration where both registry values may exist for the installing
// admin). Without a single-instance gate, two tray icons appear in the
// same session.
//
// We use a Windows named mutex in the `Local\` namespace so the gate is
// auto-scoped per logon session: User A and User B logged in concurrently
// each have their own mutex and don't fight each other.
//
// Implementation mirrors `launcher/src/single_instance.rs` but is simpler:
// no User/Admin suffix, since there is no "elevated tray" workflow that
// the launcher's elevation segregation supports.

#[cfg(windows)]
mod imp {
    use anyhow::Result;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// RAII handle that releases the named mutex on drop.
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

    /// Try to acquire the per-session mutex. Returns:
    ///   - Ok(Some(guard)) when this process is the first / only instance.
    ///   - Ok(None) when another instance already holds the mutex; caller
    ///     should exit silently with status 0.
    ///   - Err(e) on rare CreateMutexW failure; caller should log + proceed
    ///     without the guard rather than fail startup.
    pub fn acquire(name: &str) -> Result<Option<InstanceGuard>> {
        use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        use windows::Win32::System::Threading::CreateMutexW;
        use windows::core::PCWSTR;

        let wide = to_wide(name);
        // bInitialOwner=false: don't acquire the mutex in a signaled-owned
        // state at creation. We use the mutex only as a "does another
        // instance hold it" gate (via ERROR_ALREADY_EXISTS), not as a
        // synchronization primitive that callers Wait on. Setting true
        // would prevent any future WaitForSingleObject pattern from
        // working correctly. Mirrors the launcher's single_instance.rs
        // pattern exactly.
        let handle = unsafe { CreateMutexW(None, false, PCWSTR::from_raw(wide.as_ptr()))? };
        let last = unsafe { GetLastError() };
        if last == ERROR_ALREADY_EXISTS {
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

    /// Stub on non-Windows. The standalone tray helper is Windows-only
    /// today (service mode is Windows-only); this stub keeps the call
    /// site's signature stable on Linux builds.
    pub struct InstanceGuard;

    pub fn acquire(_name: &str) -> Result<Option<InstanceGuard>> {
        Ok(Some(InstanceGuard))
    }
}

#[allow(unused_imports)]
pub use imp::InstanceGuard;
pub use imp::acquire;

/// Canonical mutex name. `Local\` prefix auto-scopes per logon session.
pub const MUTEX_NAME: &str = r"Local\WsScrcpyWebTray-SingleInstance";

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn unique_name() -> String {
        format!(
            r"Local\WsScrcpyWebTray-Test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn acquire_grants_first_caller() {
        let name = unique_name();
        let guard = acquire(&name).unwrap();
        assert!(guard.is_some(), "first acquire should succeed");
    }

    #[test]
    fn acquire_denies_second_caller_while_first_is_held() {
        let name = unique_name();
        let first = acquire(&name).unwrap().expect("first acquire");
        let second = acquire(&name).unwrap();
        assert!(
            second.is_none(),
            "second acquire should see ERROR_ALREADY_EXISTS"
        );
        drop(first);
    }

    #[test]
    fn acquire_succeeds_again_after_first_drops() {
        let name = unique_name();
        {
            let _g = acquire(&name).unwrap().expect("first acquire");
        }
        let again = acquire(&name).unwrap();
        assert!(again.is_some(), "acquire after drop should succeed");
    }
}
