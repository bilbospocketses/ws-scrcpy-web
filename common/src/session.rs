//! Session-resolution helper used by both launcher and tray.
//!
//! "Which session is the user in?" sounds like a one-line Win32 call, but
//! the obvious API — `WTSGetActiveConsoleSessionId()` — is wrong for our
//! purpose. It returns the *physical console* session, which on RDP / VDI
//! / Hyper-V Enhanced Session / VMConnect environments is NOT the user's
//! interactive session (often it's an empty `Conn` state with no logged-in
//! user, or it's a stale value after screen lock / idle). Pre-2026-05-22
//! we used `WTSGetActiveConsoleSessionId` here AND in the launcher's
//! `--print-active-session` handler AND in the tray's own_session check,
//! producing inconsistent session IDs across the marker-writer and
//! marker-reader sides of the uninstall handoff — see todo `§33 Bug B`.
//!
//! The correct API: walk `WTSEnumerateSessionsW`, filter for `WTSActive`
//! state AND non-empty username, return that session's ID. This is the
//! pattern that v0.1.24 §1c bug 1 fix (part 2) introduced for the
//! `spawn_in_active_user_session` path — now generalized for all callers.
//! Falls back to `WTSGetActiveConsoleSessionId` only when enumeration
//! finds nothing (preserves bare-metal single-user behavior).
//!
//! Cross-platform shape: the Windows implementation lives in a
//! `#[cfg(windows)]` block; non-Windows returns `None` (services are
//! Windows-only in this app, so callers should treat `None` as
//! "no session resolvable, skip the session-dependent logic").

/// Resolve the active interactive user session ID.
///
/// On Windows: walks WTS sessions for `WTSActive` + non-empty username;
/// falls back to `WTSGetActiveConsoleSessionId` only if the enumeration
/// finds no matching session. Returns `None` if both strategies fail
/// (e.g., post-boot before any logon, or fully headless installs).
///
/// On non-Windows: always returns `None`.
#[cfg(windows)]
pub fn active_interactive_session() -> Option<u32> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::RemoteDesktop::{
        WTSActive, WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId,
        WTSQuerySessionInformationW, WTSUserName, WTS_SESSION_INFOW,
    };

    // SAFETY: all WTS API calls below have no preconditions beyond the
    // shapes documented in the SDK. WTSEnumerateSessionsW allocates a
    // buffer that we free with WTSFreeMemory; same pattern for
    // WTSQuerySessionInformationW. All pointer derefs are gated on
    // success + non-null checks.
    unsafe {
        let mut sessions_ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut count: u32 = 0;
        // First arg HANDLE(null) == WTS_CURRENT_SERVER_HANDLE (local machine).
        let enum_ok = WTSEnumerateSessionsW(
            HANDLE(std::ptr::null_mut()),
            0,
            1,
            &mut sessions_ptr,
            &mut count,
        )
        .is_ok();

        let mut found: Option<u32> = None;
        if enum_ok && !sessions_ptr.is_null() {
            let sessions = std::slice::from_raw_parts(sessions_ptr, count as usize);
            for s in sessions {
                if s.State != WTSActive {
                    continue;
                }
                // Query the session's username. WTSUserName returns a
                // PWSTR (UTF-16) that must be freed with WTSFreeMemory.
                // An empty username means no logged-on user (services
                // session, RDP listener, etc.) — skip.
                let mut buf_ptr: windows::core::PWSTR = windows::core::PWSTR::null();
                let mut bytes: u32 = 0;
                let q = WTSQuerySessionInformationW(
                    HANDLE(std::ptr::null_mut()),
                    s.SessionId,
                    WTSUserName,
                    &mut buf_ptr,
                    &mut bytes,
                );
                if q.is_err() || buf_ptr.is_null() {
                    continue;
                }
                // bytes includes the null terminator; convert to UTF-16
                // char count.
                let username_len = (bytes as usize / 2).saturating_sub(1);
                if username_len > 0 {
                    found = Some(s.SessionId);
                    WTSFreeMemory(buf_ptr.as_ptr() as *mut _);
                    break;
                }
                WTSFreeMemory(buf_ptr.as_ptr() as *mut _);
            }
            WTSFreeMemory(sessions_ptr as *mut _);
        }

        if found.is_some() {
            return found;
        }

        // Fallback: bare-metal single-user case. On a non-RDP / non-
        // Enhanced-Session machine the console IS the user session.
        // We still avoid this path as primary because it returns the
        // *physical console* session ID which on VM / RDP scenarios
        // diverges from the actual user session.
        let console = WTSGetActiveConsoleSessionId();
        if console == 0xFFFF_FFFF {
            None
        } else {
            Some(console)
        }
    }
}

#[cfg(not(windows))]
pub fn active_interactive_session() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_some_or_none_smoke() {
        // Pure smoke: the function must always return a value (never
        // panic, never deadlock). The actual session ID depends on the
        // test environment so we don't assert a specific value.
        let _ = active_interactive_session();
    }
}
