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
// v0.1.24 §1c bug 1 fix: explicitly enable SE_TCB_NAME on our process
// token via AdjustTokenPrivileges before calling WTSQueryUserToken.
// If the privilege was already enabled this is a free no-op; if it
// was present-but-disabled (the actual case observed on the v0.1.23
// VM, Servy 8.2 / Windows 11), the enable flips the bit and the WTS
// call succeeds. If the privilege isn't present at all (would imply
// the host stripped it via SERVICE_REQUIRED_PRIVILEGES_INFO), we log
// loudly and let WTSQueryUserToken fail with the original error.

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

/// Enable SE_TCB_NAME on the current process token. Required before
/// WTSQueryUserToken on hardened service hosts (Servy, NSSM, etc.)
/// where LocalSystem's token has the privilege present-but-disabled.
/// Returns Ok(()) when enabled (or already enabled). Returns Err with
/// a diagnostic when the privilege is missing entirely or the calls
/// failed — caller should log and continue (the subsequent WTS call
/// will surface the real failure mode).
fn enable_se_tcb_privilege() -> Result<(), String> {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, LUID};
    use windows::Win32::Security::{
        AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES,
        SE_PRIVILEGE_ENABLED, SE_TCB_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
        TOKEN_QUERY,
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
        let lookup = LookupPrivilegeValueW(
            windows::core::PCWSTR::null(),
            SE_TCB_NAME,
            &mut luid,
        );
        if let Err(e) = lookup {
            let _ = CloseHandle(token);
            return Err(format!("LookupPrivilegeValueW(SeTcbPrivilege) failed: {e:?}"));
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
            return Err(format!("AdjustTokenPrivileges failed: {e:?}"));
        }
        // 0x522 == ERROR_NOT_ALL_ASSIGNED
        if last.0 == 0x522 {
            return Err(
                "SeTcbPrivilege not present in process token (service host stripped it)"
                    .to_string(),
            );
        }
        Ok(())
    }
}

pub fn spawn_in_active_user_session(args: &SpawnUserLauncherArgs) -> SpawnResult {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Environment::{
        CreateEnvironmentBlock, DestroyEnvironmentBlock,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSGetActiveConsoleSessionId, WTSQueryUserToken,
    };
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

    // v0.1.24 §1c bug 1 fix: enable SE_TCB_NAME before WTSQueryUserToken.
    // See module-level docs for rationale. We log the result either way
    // for diagnostic purposes — if the privilege flip fails AND the
    // subsequent WTS call also fails, the combined log makes the root
    // cause obvious.
    match enable_se_tcb_privilege() {
        Ok(()) => log::info("spawn-user-launcher: SeTcbPrivilege enabled on process token"),
        Err(msg) => log::info(&format!(
            "spawn-user-launcher: SeTcbPrivilege enable skipped/failed: {msg} (continuing; WTSQueryUserToken will surface the real error)"
        )),
    }

    unsafe {
        let session_id = WTSGetActiveConsoleSessionId();
        if session_id == 0xFFFF_FFFF {
            return SpawnResult {
                ok: false,
                pid: 0,
                session_id: 0,
                error_message: Some(
                    "no active console session (WTSGetActiveConsoleSessionId returned -1)"
                        .to_string(),
                ),
            };
        }

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

        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
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
}
