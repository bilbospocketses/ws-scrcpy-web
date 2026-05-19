// Deferred servy-cli restart dispatch.
//
// Background — §32 follow-up (caught by v0.1.25-beta.10 smoke A.2):
// the `--veloapp-updated` hook calls `servy-cli restart` to bring the
// Windows service back up post-swap. With the synchronous-in-hook approach,
// Servy spawns the new SERVICE LAUNCHER while Update.exe is STILL ALIVE
// (Update.exe is the parent of the hook process — it waits for the hook
// to exit before completing its own cleanup + exit). Update.exe holds
// file handles on `<installRoot>\current\` during this window, and the
// new Node child (spawned by SERVICE LAUNCHER) dies silently — killed
// by some combination of file-sharing-violation on dist/index.js and/or
// Update.exe's post-apply cleanup pass — before it can run even the
// first Logger init line. Servy then waits ~60s for its recoveryDelay
// before restarting, by which point Update.exe is gone and the new
// launcher succeeds. Net effect for the user: ~75-second window where
// service appears Stopped and app is unreachable.
//
// Fix: the hook no longer calls servy-cli synchronously. Instead it
// spawns this subcommand DETACHED via `<launcher> --deferred-servy-restart
// <delay-ms> <service-name>` and exits immediately. Update.exe then sees
// the hook exit cleanly, completes its own cleanup, exits, and releases
// all file handles. Meanwhile this subcommand sleeps for `<delay-ms>`,
// THEN calls `servy-cli restart`. By the time Servy spawns the new
// SERVICE LAUNCHER, Update.exe is long gone — clean state, no race.
//
// Argv shape (invoked from hooks::on_updated):
//   ws-scrcpy-web-launcher --deferred-servy-restart <delay-ms> <service-name>
//
// Exit codes:
//   0 = success (servy-cli restart succeeded)
//   2 = malformed argv (missing/non-numeric delay, or missing service name)
//   3 = servy-cli.exe absent on disk
//   4 = servy-cli invocation failed (spawn error or non-zero exit)

use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::log;

/// Public entry: if argv contains `--deferred-servy-restart <delay-ms>
/// <service-name>`, handle it and return `Some(exit_code)`. Otherwise
/// return None (caller proceeds to normal launcher dispatch).
pub fn handle(args: &[String]) -> Option<i32> {
    let pos = args.iter().position(|a| a == "--deferred-servy-restart")?;
    let delay_arg = args.get(pos + 1);
    let service_arg = args.get(pos + 2);

    let (delay_ms, service_name) = match (delay_arg, service_arg) {
        (Some(d), Some(s)) => match d.parse::<u64>() {
            Ok(ms) => (ms, s.clone()),
            Err(e) => {
                log::error(&format!(
                    "deferred-servy-restart: delay {d:?} is not a valid u64 ms count: {e}"
                ));
                return Some(2);
            }
        },
        _ => {
            log::error(
                "deferred-servy-restart: malformed argv — expected --deferred-servy-restart <delay-ms> <service-name>",
            );
            return Some(2);
        }
    };

    let install_root = match resolve_install_root() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!("deferred-servy-restart: cannot resolve install root: {e}"));
            return Some(3);
        }
    };

    Some(deferred_restart_impl(&install_root, delay_ms, &service_name))
}

fn deferred_restart_impl(install_root: &std::path::Path, delay_ms: u64, service_name: &str) -> i32 {
    log::info(&format!(
        "deferred-servy-restart: sleeping {delay_ms}ms before invoking servy-cli restart for {service_name:?}"
    ));
    thread::sleep(Duration::from_millis(delay_ms));

    let servy = install_root.join("current").join("servy-cli.exe");
    if !servy.exists() {
        log::error(&format!(
            "deferred-servy-restart: servy-cli.exe absent at {servy:?}; cannot restart service"
        ));
        return 3;
    }

    log::info(&format!(
        "deferred-servy-restart: invoking {servy:?} restart --name {service_name}"
    ));
    match Command::new(&servy)
        .args(["restart", "--name", service_name])
        .status()
    {
        Ok(status) => {
            let code = status.code().unwrap_or(1);
            log::info(&format!("deferred-servy-restart: servy exited with {code}"));
            if code == 0 { 0 } else { 4 }
        }
        Err(e) => {
            log::error(&format!("deferred-servy-restart: failed to spawn servy: {e}"));
            4
        }
    }
}

fn resolve_install_root() -> anyhow::Result<PathBuf> {
    use anyhow::Context;
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    let install_root = exe_dir
        .parent()
        .context("exe_dir has no parent (cannot derive install_root)")?;
    Ok(install_root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_string()
    }

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args = vec![s("launcher.exe"), s("--unrelated")];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_returns_none_for_empty_args() {
        let args: Vec<String> = vec![];
        assert!(handle(&args).is_none());
    }

    #[test]
    fn handle_returns_2_when_delay_missing() {
        let args = vec![s("launcher.exe"), s("--deferred-servy-restart")];
        assert_eq!(handle(&args), Some(2));
    }

    #[test]
    fn handle_returns_2_when_service_missing() {
        let args = vec![
            s("launcher.exe"),
            s("--deferred-servy-restart"),
            s("5000"),
        ];
        assert_eq!(handle(&args), Some(2));
    }

    #[test]
    fn handle_returns_2_when_delay_not_numeric() {
        let args = vec![
            s("launcher.exe"),
            s("--deferred-servy-restart"),
            s("not-a-number"),
            s("WsScrcpyWeb"),
        ];
        assert_eq!(handle(&args), Some(2));
    }

    #[test]
    fn handle_recognizes_flag_at_any_position() {
        let args = vec![
            s("launcher.exe"),
            s("--unrelated"),
            s("--deferred-servy-restart"),
            s("0"),
            s("WsScrcpyWeb"),
        ];
        // delay=0 keeps the test fast; resolve_install_root succeeds under
        // cargo test (current_exe has a parent), so we proceed to the servy
        // existence check, which returns 3 when servy-cli.exe isn't present
        // (the typical state under cargo test). Anything other than None
        // confirms the flag was parsed correctly.
        let result = handle(&args);
        assert!(result.is_some(), "expected Some(exit_code), got None");
        // Under cargo test, install_root resolves to target/<profile> or its
        // parent; servy-cli.exe will not be present there → exit 3.
        // (The exact 3 vs 0 outcome is environment-dependent; we just need
        //  to confirm the parser dispatched the handler.)
        let code = result.expect("dispatched");
        assert!(
            code == 3 || code == 4,
            "expected exit 3 (servy absent) or 4 (spawn failed); got {code}"
        );
    }
}
