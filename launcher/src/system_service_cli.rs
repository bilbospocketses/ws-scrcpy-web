// System-service CLI dispatcher (Task 6 of the Linux system-service install redesign).
//
// Routes --install-system-service / --uninstall-system-service /
// --system-service-status by spawning `node dist/index.js <those flags>` in
// the FOREGROUND (inheriting stdio), then propagating node's exit code.
//
// This is what makes `sudo ./WsScrcpyWeb --install-system-service` (headless)
// and `pkexec ./WsScrcpyWeb --install-system-service` (desktop) work — the
// launcher, running as root, hands off to the Node one-shot which does the
// privileged work as root.
//
// Local-Dependencies-Only: node is resolved via `resolve_node_with` from the
// app's own `dependencies/node` or bundled `seed/node` — NEVER from PATH.

use crate::spawn::{resolve_node_with, resolve_server_entry_with};
use std::process::Command;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Op {
    Install,
    Uninstall,
    Status,
}

/// Detect which (if any) system-service CLI op is owned by this argv.
pub fn owned_op(args: &[String]) -> Option<Op> {
    if args.iter().any(|a| a == "--install-system-service") {
        Some(Op::Install)
    } else if args.iter().any(|a| a == "--uninstall-system-service") {
        Some(Op::Uninstall)
    } else if args.iter().any(|a| a == "--system-service-status") {
        Some(Op::Status)
    } else {
        None
    }
}

/// If this argv owns a system-service CLI op, resolve node, forward all flags
/// (skipping argv[0]), run node in the foreground inheriting stdio, and return
/// `Some(exit_code)`. Returns `None` when no op flag is present.
pub fn handle(args: &[String]) -> Option<i32> {
    // Early-return None if we don't own any flag.
    owned_op(args)?;

    let exe = std::env::current_exe().ok()?;
    let work_dir = exe.parent()?.to_path_buf();

    // Resolve node via the same path the production server-spawn uses:
    // Paths::from_env() → deps_path (honours DEPS_PATH env override, falling
    // back to data_root/dependencies) → resolve_node_with(Some(deps_path)).
    // This guarantees the binary comes from the app's own dependencies/ or
    // seed/ — never from the system PATH.
    let paths = crate::paths::Paths::from_env().ok()?;
    let node = resolve_node_with(paths.deps_path.to_str(), &work_dir).ok()?;
    let entry = resolve_server_entry_with(&work_dir).ok()?;

    // Forward everything past argv[0] verbatim to node (includes the
    // --install/uninstall/status flag and any extra flags such as --port).
    let forwarded: Vec<&String> = args.iter().skip(1).collect();

    let status = Command::new(&node)
        .arg(&entry)
        .args(&forwarded)
        .current_dir(&work_dir)
        .status();

    match status {
        Ok(s) => Some(s.code().unwrap_or(1)),
        Err(e) => {
            crate::log::error(&format!(
                "system-service-cli: spawn node failed: {e}"
            ));
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svec(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_install_uninstall_status() {
        assert_eq!(
            owned_op(&svec(&["--install-system-service", "--port", "9000"])),
            Some(Op::Install)
        );
        assert_eq!(
            owned_op(&svec(&["--uninstall-system-service", "--keep-state"])),
            Some(Op::Uninstall)
        );
        assert_eq!(
            owned_op(&svec(&["--system-service-status"])),
            Some(Op::Status)
        );
        assert_eq!(owned_op(&svec(&["ws-scrcpy-web-launcher"])), None);
    }
}
