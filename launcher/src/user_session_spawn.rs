// Cross-session spawn helper for the v0.1.8 uninstall flow (Path A).
//
// The Windows service runs as Local System in session 0. The user's
// browser runs in their interactive session (session 1+). When the user
// clicks "uninstall service" in the service-hosted UI, the Node process
// handling that click is in session 0 — child processes it spawns
// inherit session 0 too, so a launcher spawned that way would be
// invisible to the user's interactive session.
//
// To spawn a launcher in the user's session FROM a service we use the
// WTS (Windows Terminal Services) APIs:
//   1. WTSGetActiveConsoleSessionId   — find which session the
//      interactive user is using
//   2. WTSQueryUserToken               — get a primary token for that
//      session's user (requires SE_TCB_NAME, which Local System has)
//   3. CreateProcessAsUserW            — spawn the new process with
//      that token, so it lands in the user's session with their token
//
// This module is invoked via the launcher's --elevate-and-run dispatch
// (new command: `spawn-user-launcher`). The Node service-instance
// triggers it; the Rust handler does the WTS dance and writes a result
// JSON the Node side reads back.
//
// IMPORTANT: This is admin-only. The caller (Node service process) is
// running as Local System, which holds SE_TCB_NAME ("Act as part of
// the operating system") in its token — but on modern Windows, even
// for LocalSystem, the privilege is often present-but-DISABLED in
// service tokens (especially when the service is hosted by a wrapper
// like Servy that uses minimal-privilege defaults). WTSQueryUserToken
// then returns ERROR_NO_TOKEN (HRESULT 0x800703F0) — a misleading
// error code that does NOT mean "no user is logged in," but rather
// "your token's SE_TCB_NAME is disabled."
//
// v0.1.24 §1c bug 1 fix (part 1): explicitly enable SE_TCB_NAME on
// our process token via AdjustTokenPrivileges before calling
// WTSQueryUserToken. Required for hardened service hosts (Servy,
// NSSM) where the privilege is present-but-disabled. Free no-op if
// already enabled.
//
// v0.1.24 §1c bug 1 fix (part 2): use WTSEnumerateSessionsW to find
// the active interactive session, NOT WTSGetActiveConsoleSessionId.
// The "active console session" is the physical console attached to
// the machine. On Hyper-V Enhanced Session Mode (RDP-like VM access),
// real RDP, or any VDI scenario, the user is in a different session
// while the physical console is empty (`Conn` state with no logged-in
// user). The v0.1.23 + v0.1.24-beta.1 code asked the empty console
// for a user token and got ERROR_NO_TOKEN. The robust pattern: walk
// all sessions, filter by State == WTSActive AND WTSUserName non-
// empty, return that session's ID. Falls back to console session if
// enumeration finds nothing (preserves existing behavior on bare-
// metal single-user installs).

#![cfg(windows)]

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::log;

/// Args for the `spawn-user-launcher` command.
#[derive(Debug, Deserialize)]
pub struct SpawnUserLauncherArgs {
    /// Absolute path to the launcher exe to spawn in the user's
    /// session. Caller resolves this to the same launcher binary
    /// they're running from (we use process.cwd() / launcher.exe).
    pub launcher_path: String,
    /// Optional argv to pass to the launcher (post-exe). Currently
    /// unused by the launcher's normal startup path; reserved for
    /// future "auto-resume" semantics.
    #[serde(default)]
    pub launcher_args: Vec<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct SpawnResult {
    pub ok: bool,
    pub pid: u32,
    pub session_id: u32,
    pub error_message: Option<String>,
}

/// Enable a single privilege on the current process token. Required
/// for various WTS / CreateProcessAsUserW APIs on hardened service
/// hosts (Servy, NSSM, etc.) where LocalSystem's token holds the
/// privilege but has it DISABLED. Returns Ok(()) when enabled (or
/// already enabled). Returns Err with a diagnostic when the privilege
/// is missing entirely or the calls failed — caller should log and
/// continue (the subsequent API call will surface the real failure).
fn enable_privilege(privilege: windows::core::PCWSTR, name_for_log: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LUID};
    use windows::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
        SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = HANDLE::default();
        if let Err(e) = OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        ) {
            return Err(format!("OpenProcessToken failed: {e:?}"));
        }

        let mut luid = LUID::default();
        let lookup = LookupPrivilegeValueW(windows::core::PCWSTR::null(), privilege, &mut luid);
        if let Err(e) = lookup {
            let _ = CloseHandle(token);
            return Err(format!(
                "LookupPrivilegeValueW({name_for_log}) failed: {e:?}"
            ));
        }

        let tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };

        let adjust = AdjustTokenPrivileges(token, false, Some(&tp), 0, None, None);
        // AdjustTokenPrivileges returns success even when not all
        // privileges were assigned — must check GetLastError for
        // ERROR_NOT_ALL_ASSIGNED (1300) explicitly.
        let last = GetLastError();
        let _ = CloseHandle(token);

        if let Err(e) = adjust {
            return Err(format!("AdjustTokenPrivileges({name_for_log}) failed: {e:?}"));
        }
        // 0x522 == ERROR_NOT_ALL_ASSIGNED
        if last.0 == 0x522 {
            return Err(format!(
                "{name_for_log} not present in process token (service host stripped it)"
            ));
        }
        Ok(())
    }
}

/// Enable SE_TCB_NAME, SE_ASSIGNPRIMARYTOKEN_NAME, and
/// SE_INCREASE_QUOTA_NAME on the current process token — the canonical
/// privilege set required to spawn a process across sessions via
/// WTSQueryUserToken + CreateProcessAsUserW. LocalSystem holds all
/// three by default, but Servy / NSSM / hardened service hosts often
/// keep them present-but-disabled. Logs each enable result; continues
/// on individual failures so the failing API call surfaces the real
/// error code.
fn enable_cross_session_spawn_privileges() {
    use windows::Win32::Security::{
        SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME, SE_TCB_NAME,
    };

    let privs: [(windows::core::PCWSTR, &str); 3] = [
        (SE_TCB_NAME, "SeTcbPrivilege"),
        (SE_ASSIGNPRIMARYTOKEN_NAME, "SeAssignPrimaryTokenPrivilege"),
        (SE_INCREASE_QUOTA_NAME, "SeIncreaseQuotaPrivilege"),
    ];
    for (priv_name, label) in privs {
        match enable_privilege(priv_name, label) {
            Ok(()) => log::info(&format!(
                "spawn-user-launcher: {label} enabled on process token"
            )),
            Err(msg) => log::info(&format!(
                "spawn-user-launcher: {label} enable skipped/failed: {msg}"
            )),
        }
    }
}

pub fn spawn_in_active_user_session(args: &SpawnUserLauncherArgs) -> SpawnResult {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Environment::{
        CreateEnvironmentBlock, DestroyEnvironmentBlock,
    };
    use windows::Win32::System::RemoteDesktop::WTSQueryUserToken;
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, CREATE_UNICODE_ENVIRONMENT, NORMAL_PRIORITY_CLASS,
        PROCESS_INFORMATION, STARTUPINFOW,
    };
    use windows::core::PWSTR;

    log::info(&format!(
        "spawn-user-launcher: target={} args={:?}",
        args.launcher_path, args.launcher_args
    ));

    if !Path::new(&args.launcher_path).exists() {
        return SpawnResult {
            ok: false,
            pid: 0,
            session_id: 0,
            error_message: Some(format!("launcher not found: {}", args.launcher_path)),
        };
    }

    // v0.1.24 §1c bug 1 fix: enable the full privilege set required
    // for cross-session spawn (SE_TCB_NAME for WTSQueryUserToken,
    // SE_ASSIGNPRIMARYTOKEN_NAME + SE_INCREASE_QUOTA_NAME for
    // CreateProcessAsUserW). v0.1.24-beta.1 enabled only SE_TCB_NAME;
    // v0.1.24-beta.2 VM smoke confirmed the WTS call then succeeded
    // but CreateProcessAsUserW failed with ERROR_ACCESS_DENIED — the
    // remaining two privileges were the cause. See module-level docs.
    enable_cross_session_spawn_privileges();

    let session_id = match common::session::active_interactive_session() {
        Some(id) => id,
        None => {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id: 0,
                error_message: Some(
                    "no active interactive user session found (WTSEnumerateSessions returned no Active session with a logged-on user, and WTSGetActiveConsoleSessionId fallback also failed)"
                        .to_string(),
                ),
            };
        }
    };
    log::info(&format!(
        "spawn-user-launcher: resolved active interactive session id={session_id}"
    ));

    unsafe {
        let mut user_token: HANDLE = HANDLE::default();
        if let Err(e) = WTSQueryUserToken(session_id, &mut user_token) {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id,
                error_message: Some(format!(
                    "WTSQueryUserToken failed (session {session_id}): {e:?}. SE_TCB_NAME enable was attempted; check launcher.log for the enable-step result."
                )),
            };
        }

        // Build the command line: "<launcher_path>" arg1 arg2 ...
        // CreateProcessAsUserW takes the command line as a writable
        // PWSTR (the API actually mutates it during parsing — Win32
        // history). We allocate an owned UTF-16 buffer and pass a
        // pointer.
        let mut cmd_line: Vec<u16> = OsStr::new(&format!("\"{}\"", args.launcher_path))
            .encode_wide()
            .collect();
        for a in &args.launcher_args {
            cmd_line.push(' ' as u16);
            for w in OsStr::new(a).encode_wide() {
                cmd_line.push(w);
            }
        }
        cmd_line.push(0); // null-terminator

        // v0.1.24-beta.3: explicitly target the user's interactive
        // window station + desktop. Without this, CreateProcessAsUserW
        // inherits the service's session-0 window station, which the
        // user token has no access to → ERROR_ACCESS_DENIED. The
        // canonical desktop name for the interactive user is
        // `winsta0\default`. PWSTR is a *mut u16 so we keep an owned
        // buffer alive for the duration of the call.
        let mut desktop: Vec<u16> = OsStr::new("winsta0\\default")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR::from_raw(desktop.as_mut_ptr()),
            ..Default::default()
        };
        let mut pi = PROCESS_INFORMATION::default();

        let cwd: Option<&str> = Path::new(&args.launcher_path)
            .parent()
            .and_then(|p| p.to_str());
        let cwd_wide: Option<Vec<u16>> = cwd.map(|s| {
            OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
        });
        // windows-rs 0.58 wants a concrete PCWSTR for lpCurrentDirectory,
        // not Option<PCWSTR>. PCWSTR::null() is the documented "no cwd"
        // sentinel — CreateProcessAsUserW will then use the parent's cwd.
        let cwd_pcwstr = match &cwd_wide {
            Some(v) => windows::core::PCWSTR::from_raw(v.as_ptr()),
            None => windows::core::PCWSTR::null(),
        };

        // v0.1.9: build the user's environment block instead of
        // inheriting our (Local System) env. Without this, the new
        // process gets %APPDATA% / %LOCALAPPDATA% / %USERPROFILE%
        // pointing at C:\Windows\system32\config\systemprofile\... —
        // Velopack init reads %APPDATA% for its update cache and
        // various launcher startup paths break with Local System's
        // environment. The v0.1.8 uninstall handoff would silently
        // fail at this stage: the launcher spawned, started up, but
        // exited before reaching its supervisor's HTTP listen because
        // Velopack or path resolution broke.
        let mut env_block: *mut std::ffi::c_void = std::ptr::null_mut();
        let env_built = CreateEnvironmentBlock(&mut env_block, user_token, false).is_ok();

        let create = CreateProcessAsUserW(
            user_token,
            None, // lpApplicationName — we put the exe in lpCommandLine instead
            PWSTR::from_raw(cmd_line.as_mut_ptr()),
            None, // lpProcessAttributes
            None, // lpThreadAttributes
            false,
            // CREATE_UNICODE_ENVIRONMENT is mandatory when
            // lpEnvironment is non-null AND came from
            // CreateEnvironmentBlock (which always returns UTF-16).
            // Without it, CreateProcessAsUserW would interpret the
            // block as ANSI and produce garbage env vars.
            NORMAL_PRIORITY_CLASS | CREATE_UNICODE_ENVIRONMENT,
            if env_built { Some(env_block) } else { None },
            cwd_pcwstr,
            &si,
            &mut pi,
        );

        if env_built {
            let _ = DestroyEnvironmentBlock(env_block);
        }
        let _ = CloseHandle(user_token);

        if let Err(e) = create {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id,
                error_message: Some(format!("CreateProcessAsUserW failed: {e:?}")),
            };
        }

        let pid = pi.dwProcessId;
        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(pi.hThread);

        log::info(&format!(
            "spawn-user-launcher: spawned pid {pid} in session {session_id}"
        ));

        SpawnResult {
            ok: true,
            pid,
            session_id,
            error_message: None,
        }
    }
}

/// Public entry: if argv contains `--spawn-user-launcher`, parse the
/// `--launcher-path <path>` argument and dispatch to
/// `spawn_in_active_user_session`. Returns `Some(exit_code)` if the flag
/// matched; `None` to let main.rs proceed to normal launch.
///
/// Argv shape:
///   ws-scrcpy-web-launcher.exe --spawn-user-launcher --launcher-path <abs-path>
///
/// Exit codes:
///   0 — spawn succeeded
///   2 — malformed argv (missing --launcher-path)
///   4 — spawn failed (WTS error, launcher binary not found, etc.)
///   5 — no active interactive session resolvable
///
/// Used by post-stop.bat after `servy-cli uninstall` completes, to drop a
/// fresh user-session launcher so the user lands on the local-mode UI
/// post-uninstall. See `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`
/// section "Cross-session user-session spawn (Q4)".
pub fn spawn_user_launcher_handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--spawn-user-launcher") {
        return None;
    }
    let launcher_path = match args
        .iter()
        .position(|a| a == "--launcher-path")
        .and_then(|i| args.get(i + 1))
    {
        Some(p) => p.clone(),
        None => {
            log::error("spawn-user-launcher: missing --launcher-path argument");
            return Some(2);
        }
    };

    let spawn_args = SpawnUserLauncherArgs {
        launcher_path: launcher_path.clone(),
        launcher_args: vec![],
    };
    let result = spawn_in_active_user_session(&spawn_args);
    if result.ok {
        log::info(&format!(
            "spawn-user-launcher: spawned pid {} in session {}",
            result.pid, result.session_id
        ));
        Some(0)
    } else {
        log::error(&format!(
            "spawn-user-launcher: spawn failed: {:?}",
            result.error_message
        ));
        // Distinguish "no active interactive session" (5) from other spawn
        // failures (4). Mode-string match against the canonical error
        // message from spawn_in_active_user_session; if that string ever
        // changes, this branch falls through to code 4 — that's an
        // acceptable degradation (post-stop.bat treats any non-zero as a
        // failed spawn and proceeds to exit).
        let is_no_session = result
            .error_message
            .as_deref()
            .map(|m| m.contains("no active") || m.contains("no interactive"))
            .unwrap_or(false);
        if is_no_session { Some(5) } else { Some(4) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_fails_for_nonexistent_launcher_path() {
        let args = SpawnUserLauncherArgs {
            launcher_path: r"C:\definitely\does\not\exist\launcher.exe".to_string(),
            launcher_args: vec![],
        };
        let r = spawn_in_active_user_session(&args);
        assert!(!r.ok);
        assert!(r.error_message.unwrap().contains("launcher not found"));
    }

    #[test]
    fn spawn_user_launcher_handle_returns_none_when_flag_absent() {
        let args = vec!["launcher.exe".to_string(), "--unrelated".to_string()];
        assert!(spawn_user_launcher_handle(&args).is_none());
    }

    #[test]
    fn spawn_user_launcher_handle_returns_exit_code_2_when_launcher_path_missing() {
        let args = vec![
            "launcher.exe".to_string(),
            "--spawn-user-launcher".to_string(),
        ];
        let result = spawn_user_launcher_handle(&args);
        assert!(result.is_some(), "flag matched");
        assert_eq!(result.unwrap(), 2, "missing --launcher-path → exit code 2");
    }

    #[test]
    fn spawn_user_launcher_handle_parses_launcher_path_arg() {
        let args = vec![
            "launcher.exe".to_string(),
            "--spawn-user-launcher".to_string(),
            "--launcher-path".to_string(),
            r"C:\nonexistent\launcher.exe".to_string(),
        ];
        let result = spawn_user_launcher_handle(&args);
        assert!(result.is_some(), "flag matched");
        // Path doesn't exist + no active interactive session in test env →
        // runtime spawn failure (code 4 or 5). Either is acceptable — assert
        // it's non-zero non-2 (so we got past argv parsing).
        let code = result.unwrap();
        assert!(code != 0 && code != 2, "expected runtime failure code (not argv error or success), got {code}");
    }
}
