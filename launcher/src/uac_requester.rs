// UAC-elevation requester (Windows-only).
//
// The Node server runs unelevated (Velopack installs us per-user, no admin
// needed for normal operation). When the user clicks "yes install service"
// in the welcome modal, the Node server needs to spawn this launcher binary
// elevated to do the Servy/SCM registration work.
//
// Pre-§30 the Node side invoked PowerShell with `Start-Process -Verb RunAs`
// to fire the UAC prompt. That worked but relied on `powershell.exe`
// resolving via system PATH — a violation of CLAUDE.md's
// Local-Dependencies-Only rule (PowerShell 5.1 is OS-bundled but the rule
// doesn't carve out OS-bundled binaries). The §30 replacement keeps the
// elevation entirely inside our own SHA-pinned-to-release launcher binary
// using Win32 ShellExecuteExW(verb="runas") directly.
//
// Argv shape (invoked from Node):
//   ws-scrcpy-web-launcher.exe --request-uac <command> <args-json-path> <result-json-path>
//
// where the three positional args are identical to what the eventual
// `--elevate-and-run` invocation receives. This module re-spawns this
// launcher binary elevated with those args.
//
// Exit codes:
//   0    = UAC accepted; elevated launcher is being spawned in the
//          background. Node's caller continues with result-file polling
//          as it always has.
//   1223 = UAC declined (Windows ERROR_CANCELLED). Node's caller maps this
//          to a user-friendly "user declined elevation" message — same
//          contract the PowerShell exit path previously surfaced.
//   2    = malformed argv (caller bug — should never happen in production).
//   3    = unexpected ShellExecuteExW failure (admin policy disabled, etc.).
//   99   = invoked on a non-Windows host (UAC is Windows-only).

use crate::log;

/// Public entry: if argv contains `--request-uac`, handle it and return
/// `Some(exit_code)`. Otherwise return None (caller proceeds to normal
/// launch / Velopack hooks).
pub fn handle(args: &[String]) -> Option<i32> {
    let pos = args.iter().position(|a| a == "--request-uac")?;
    let command = args.get(pos + 1)?;
    let args_path = args.get(pos + 2)?;
    let result_path = args.get(pos + 3)?;

    log::info(&format!(
        "request-uac: command={command} args_path={args_path} result_path={result_path}"
    ));

    Some(request_uac_impl(command, args_path, result_path))
}

#[cfg(windows)]
fn request_uac_impl(command: &str, args_path: &str, result_path: &str) -> i32 {
    use windows::Win32::UI::Shell::{SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows::core::PCWSTR;

    // HRESULT_FROM_WIN32(ERROR_CANCELLED) — surfaced by ShellExecuteExW when
    // the user clicks No on the UAC prompt. Same semantic the prior
    // PowerShell `Start-Process -Verb RunAs` non-zero exit signaled.
    const HRESULT_ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!("request-uac: could not resolve current_exe: {e}"));
            return 3;
        }
    };

    // Build the parameters string for the elevated re-spawn. ShellExecuteExW
    // passes lpParameters as the command line to the new process, which then
    // re-parses via CommandLineToArgvW — quoting each arg defends against
    // spaces in temp-dir paths.
    let parameters = format!(
        "--elevate-and-run \"{}\" \"{}\" \"{}\"",
        command, args_path, result_path
    );

    let verb = to_wide("runas");
    let file = to_wide(&exe.to_string_lossy());
    let params = to_wide(&parameters);

    // fMask=0 (default) — ShellExecuteExW is synchronous; it blocks until the
    // UAC dialog is dismissed regardless. We do NOT request NOCLOSEPROCESS
    // because we don't need a handle to the elevated child; Node polls the
    // result file as the source of truth (same pattern the prior PowerShell
    // -Wait-less path used).
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: 0,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: 0, // SW_HIDE — no flashing console window for the elevated child
        ..Default::default()
    };

    // SAFETY: SHELLEXECUTEINFOW is fully populated above, all PCWSTR pointers
    // outlive the call via the wide-string locals.
    match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => {
            log::info("request-uac: UAC accepted, elevated launcher spawn initiated");
            0
        }
        Err(e) if e.code().0 == HRESULT_ERROR_CANCELLED => {
            log::info("request-uac: UAC declined by user (ERROR_CANCELLED)");
            1223
        }
        Err(e) => {
            log::error(&format!("request-uac: ShellExecuteExW failed: {e}"));
            3
        }
    }
}

#[cfg(not(windows))]
fn request_uac_impl(_command: &str, _args_path: &str, _result_path: &str) -> i32 {
    // UAC + ShellExecuteExW are Windows-only. The Node-side caller is
    // already Windows-gated (the install/uninstall-service flows it triggers
    // only run on Windows). Surface a distinct exit code so a misrouted
    // invocation on Linux/macOS doesn't masquerade as either UAC-accepted
    // or UAC-declined.
    log::error("request-uac: invoked on non-Windows host — UAC is Windows-only");
    99
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args = vec!["launcher.exe".to_string(), "--unrelated".to_string()];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_returns_none_when_flag_absent_no_args() {
        let args = vec!["launcher.exe".to_string()];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_returns_none_when_args_missing_after_flag() {
        // --request-uac with too few positional args: handle() returns None
        // because the `?` early-exit on get(pos + 1) / +2 / +3 falls through.
        // Caller proceeds to the next branch (elevated_runner::handle), which
        // also won't match, and the launcher continues to normal startup —
        // which is the safest fallback for a malformed invocation.
        let args = vec!["launcher.exe".to_string(), "--request-uac".to_string()];
        assert!(handle(&args).is_none());

        let args = vec![
            "launcher.exe".to_string(),
            "--request-uac".to_string(),
            "install-service".to_string(),
        ];
        assert!(handle(&args).is_none());
    }

    #[cfg(not(windows))]
    #[test]
    fn handle_returns_99_on_non_windows() {
        let args = vec![
            "launcher.exe".to_string(),
            "--request-uac".to_string(),
            "install-service".to_string(),
            "/tmp/args.json".to_string(),
            "/tmp/result.json".to_string(),
        ];
        assert_eq!(handle(&args), Some(99));
    }
}
