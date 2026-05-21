// §32 Part 5 — launcher-owned tray lifecycle.
//
// Background: prior to Part 5, the standalone tray helper (`ws-scrcpy-web-tray.exe`)
// was registered under `HKLM\Software\Microsoft\Windows\CurrentVersion\Run`
// (`WsScrcpyWebTray` value) so each user got a tray icon at logon. This
// worked but had two limitations: (a) trays killed mid-session by Velopack's
// swap of `current/` didn't return until next logon, and (b) state was
// split between launcher (lifecycle) and Run registry (spawn).
//
// Part 5 consolidates ownership: the launcher (running as LocalSystem under
// Servy) polls every TRAY_POLL_INTERVAL_SECS, locates the active interactive
// user session, and spawns the tray helper there if it's not already
// running. The tray's per-session single-instance mutex (`Local\
// WsScrcpyWebTray-SingleInstance`) handles dedup safely — a spawn into a
// session that already has a tray is a no-op (the new instance exits
// silently before showing the balloon).
//
// Trade-offs accepted in this iteration:
//   - SINGLE active session only. WTSEnumerateSessionsW could return multiple
//     active sessions in RDP / fast-user-switching scenarios; we currently
//     only spawn into the FIRST active interactive session. Multi-session
//     support can be added later if needed.
//   - HKLM\Run removed at install time + cleanup on (re)install. Existing
//     beta.9-era installs still have the Run entry; the launcher's startup
//     spawn covers the post-upgrade case for them too, and the Run entry
//     remains as a fallback until the next service install.
//
// User-killed tray semantics:
//   - The tray helper does NOT have a "user-suppress" marker. If the user
//     kills the tray (e.g., via Task Manager), the launcher polls within
//     TRAY_POLL_INTERVAL_SECS and respawns it WITH the balloon notification
//     directing users to the tray's own exit menu. The tray is the only
//     user-facing handle on the launcher in both modes (service mode runs
//     windowless under Servy; local mode hides its console), so closing
//     it requires the explicit tray-menu exit path. Settings can uninstall
//     the service (which tears down both service and tray) but has no
//     "stop service" or "stop server" action.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use crate::log;
use crate::user_session_spawn::{spawn_in_active_user_session, SpawnUserLauncherArgs};

const TRAY_POLL_INTERVAL_SECS: u64 = 10;
const TRAY_PROCESS_NAME: &str = "ws-scrcpy-web-tray.exe";

/// Start a background thread that ensures a tray exists in the user
/// session at all times. Returns immediately. The thread runs for the
/// lifetime of the launcher process and ends when the process exits (no
/// explicit stop signal — `Arc<AtomicBool>` is exposed for future use if
/// we want a clean shutdown).
///
/// Mode-aware spawn:
///   - **Service mode** (`is_service_mode=true`): launcher is running as
///     LocalSystem in session 0. Cross-session WTS spawn into the active
///     interactive user session via `spawn_in_active_user_session`. Requires
///     SeTcbPrivilege + SeAssignPrimaryTokenPrivilege + SeIncreaseQuotaPrivilege
///     which LocalSystem has by default.
///   - **Local mode** (`is_service_mode=false`): launcher is already in
///     the user session. Simple `Command::new(tray).spawn()` with detached
///     + no-console flags. No privilege elevation needed.
pub fn start_background(install_root: &Path, is_service_mode: bool) -> Arc<AtomicBool> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();
    let install_root_clone = install_root.to_path_buf();

    thread::Builder::new()
        .name("ws-tray-supervisor".to_string())
        .spawn(move || {
            tray_supervisor_loop(install_root_clone, stop_flag_clone, is_service_mode);
        })
        .ok();
    stop_flag
}

fn tray_supervisor_loop(install_root: PathBuf, stop_flag: Arc<AtomicBool>, is_service_mode: bool) {
    log::info(&format!(
        "tray-supervisor: starting (poll every {TRAY_POLL_INTERVAL_SECS}s, mode={})",
        if is_service_mode { "service" } else { "local" },
    ));

    let tray_exe = install_root.join("current").join(TRAY_PROCESS_NAME);

    loop {
        if stop_flag.load(Ordering::SeqCst) {
            log::info("tray-supervisor: stop_flag observed; exiting");
            return;
        }

        if !tray_exe.exists() {
            // Tray binary not present (e.g., dev launcher, pre-install,
            // or a broken extract). Skip this iteration; check again
            // next cycle in case Velopack just finished extracting it.
            thread::sleep(Duration::from_secs(TRAY_POLL_INTERVAL_SECS));
            continue;
        }

        let outcome = if is_service_mode {
            ensure_tray_in_active_session(&tray_exe)
        } else {
            ensure_tray_in_current_session(&tray_exe)
        };

        match outcome {
            EnsureOutcome::AlreadyRunning => {
                // Common case after the first iteration. No log spam.
            }
            EnsureOutcome::Spawned { pid, session } => {
                log::info(&format!(
                    "tray-supervisor: spawned tray in session {session} (pid {pid})"
                ));
            }
            EnsureOutcome::NoActiveSession => {
                // No interactive user logged in (e.g., post-boot before
                // any logon). Quiet retry next iteration.
            }
            EnsureOutcome::SpawnFailed(msg) => {
                log::error(&format!(
                    "tray-supervisor: spawn failed (will retry): {msg}"
                ));
            }
        }

        thread::sleep(Duration::from_secs(TRAY_POLL_INTERVAL_SECS));
    }
}

enum EnsureOutcome {
    /// Tray process already exists in the active user session.
    AlreadyRunning,
    /// No active interactive user session found (e.g., headless boot).
    NoActiveSession,
    /// Tray was missing; spawned successfully.
    Spawned { pid: u32, session: u32 },
    /// Tray was missing; spawn attempt failed.
    SpawnFailed(String),
}

/// Service-mode path. LocalSystem launcher uses WTS to reach into the
/// active interactive user session.
fn ensure_tray_in_active_session(tray_exe: &Path) -> EnsureOutcome {
    // Find the active interactive session.
    let session_id = match find_active_user_session() {
        Some(id) => id,
        None => return EnsureOutcome::NoActiveSession,
    };

    // Check if tray is already running in that session.
    if is_tray_running_in_session(session_id) {
        return EnsureOutcome::AlreadyRunning;
    }

    let tray_path_str = match tray_exe.to_str() {
        Some(s) => s.to_string(),
        None => return EnsureOutcome::SpawnFailed("tray path not valid UTF-8".to_string()),
    };

    // Spawn with --launcher-spawn arg so the tray knows to show the
    // explanatory balloon. The arg is consumed by tray/src/main.rs at
    // startup.
    let result = spawn_in_active_user_session(&SpawnUserLauncherArgs {
        launcher_path: tray_path_str,
        launcher_args: vec!["--launcher-spawn".to_string()],
    });

    if result.ok {
        EnsureOutcome::Spawned {
            pid: result.pid,
            session: result.session_id,
        }
    } else {
        EnsureOutcome::SpawnFailed(result.error_message.unwrap_or_default())
    }
}

/// Local-mode path. Launcher is already in the user session — simple
/// `Command::new(tray)` spawn, no privilege elevation. Detached +
/// no-console so the tray survives launcher exit (matches service-mode
/// independence) and doesn't pop a console window.
fn ensure_tray_in_current_session(tray_exe: &Path) -> EnsureOutcome {
    let session_id = current_session_id();
    if is_tray_running_in_session(session_id) {
        return EnsureOutcome::AlreadyRunning;
    }

    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    // Same flag set as upgrade_server's spawn_detached_helper: child runs
    // detached from this process's console (DETACHED_PROCESS) and never
    // opens its own console window (CREATE_NO_WINDOW). Tray binary is
    // windows-subsystem so it'd be windowless either way, but the flags
    // also break the parent-process exit kill-chain for cleaner detach.
    const DETACHED_PROCESS: u32 = 0x00000008;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    match std::process::Command::new(tray_exe)
        .arg("--launcher-spawn")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(child) => EnsureOutcome::Spawned {
            pid: child.id(),
            session: session_id,
        },
        Err(e) => EnsureOutcome::SpawnFailed(format!("Command::new(tray).spawn(): {e}")),
    }
}

/// Resolve THIS process's WTS session id. Used by local-mode launcher to
/// confirm "is the tray already running in MY session?" without the WTS
/// session-enumeration that service-mode uses to cross sessions.
fn current_session_id() -> u32 {
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::GetCurrentProcessId;

    let pid = unsafe { GetCurrentProcessId() };
    let mut session_id: u32 = 0;
    // SAFETY: ProcessIdToSessionId has no preconditions other than a valid
    // process id; GetCurrentProcessId always returns our own valid pid.
    if unsafe { ProcessIdToSessionId(pid, &mut session_id) }.is_ok() {
        session_id
    } else {
        // Should never happen for the current process; fall back to 0
        // (which is the LocalSystem session — if `is_tray_running_in_session`
        // filters on that, no false-positives expected since the launcher
        // shouldn't be in session 0 when this branch is taken).
        log::error("tray-supervisor: ProcessIdToSessionId failed for own pid; using 0 as fallback");
        0
    }
}

/// Find the first active interactive user session (i.e., WTSActive +
/// non-empty username). Returns None if no such session exists.
///
/// Duplicates a subset of user_session_spawn::find_active_user_session_id
/// but uses windows-rs directly so we can check session presence without
/// triggering the full privilege-enable side-effects of the spawn path.
fn find_active_user_session() -> Option<u32> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::RemoteDesktop::{
        WTSActive, WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId,
        WTSQuerySessionInformationW, WTSUserName, WTS_SESSION_INFOW,
    };

    unsafe {
        let mut sessions_ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut count: u32 = 0;
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

        let console = WTSGetActiveConsoleSessionId();
        if console == 0xFFFF_FFFF {
            None
        } else {
            Some(console)
        }
    }
}

/// Check if `ws-scrcpy-web-tray.exe` is running in the given WTS session.
///
/// Uses `WTSEnumerateProcessesExW` (level WTS_PROCESS_INFO_LEVEL_0)
/// to walk all processes; filters on image name + session ID. Returns
/// false on any enumeration error (caller will then attempt spawn,
/// which mutex-dedups safely).
fn is_tray_running_in_session(session_id: u32) -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::RemoteDesktop::{
        WTSEnumerateProcessesExW, WTSFreeMemoryExW, WTSTypeProcessInfoLevel0,
        WTS_PROCESS_INFOW,
    };

    unsafe {
        let mut buffer: *mut u8 = std::ptr::null_mut();
        let mut count: u32 = 0;
        let mut level: u32 = 0; // WTS_PROCESS_INFO_LEVEL_0
        let ok = WTSEnumerateProcessesExW(
            HANDLE(std::ptr::null_mut()),
            &mut level,
            0xFFFFFFFF, // WTS_ANY_SESSION; we filter on session_id below
            &mut buffer as *mut *mut u8 as *mut windows::core::PWSTR,
            &mut count,
        )
        .is_ok();

        if !ok || buffer.is_null() {
            return false;
        }

        let processes = std::slice::from_raw_parts(
            buffer as *const WTS_PROCESS_INFOW,
            count as usize,
        );

        let mut found = false;
        for p in processes {
            if p.SessionId != session_id {
                continue;
            }
            if p.pProcessName.is_null() {
                continue;
            }
            // Walk the wide string to find the length.
            let mut len = 0usize;
            while *p.pProcessName.0.add(len) != 0 {
                len += 1;
                if len > 1024 {
                    break;
                }
            }
            let slice = std::slice::from_raw_parts(p.pProcessName.0, len);
            let name = OsString::from_wide(slice);
            if name.eq_ignore_ascii_case(TRAY_PROCESS_NAME) {
                found = true;
                break;
            }
        }

        let _ = WTSFreeMemoryExW(
            WTSTypeProcessInfoLevel0,
            buffer as *mut _,
            count,
        );

        found
    }
}
