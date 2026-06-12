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

/// If this argv owns a system-service CLI op, run it and return
/// `Some(exit_code)`. Returns `None` ONLY when no op flag is present (so the
/// caller in `main.rs` can fall through to the normal launcher path).
///
/// INVARIANT: once we own the op, this ALWAYS returns `Some` — every failure
/// (current_exe, parent, Paths::from_env, node/entry resolution, spawn) is
/// logged and surfaced as a non-zero exit. A `None` fall-through here would be
/// indistinguishable from "not a system-service invocation", causing the
/// launcher to start a root server in the foreground and hang the awaiting
/// `pkexec`/`sudo` forever instead of surfacing the failure (spec §10).
pub fn handle(args: &[String]) -> Option<i32> {
    let op = owned_op(args)?; // None => not ours; caller falls through (correct).
    Some(run_owned(op, args))
}

/// Execute an owned system-service op. ALWAYS returns an exit code — never
/// silently bails. Resolves node via the same path the production server-spawn
/// uses (Paths::from_env → deps_path, honouring the DEPS_PATH override and
/// falling back to data_root/dependencies), so the binary comes from the app's
/// own dependencies/ or seed/ — never the system PATH (Local-Dependencies-Only).
fn run_owned(_op: Op, args: &[String]) -> i32 {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            crate::log::error(&format!("system-service-cli: current_exe failed: {e}"));
            return 1;
        }
    };
    let Some(work_dir) = exe.parent().map(|p| p.to_path_buf()) else {
        crate::log::error("system-service-cli: exe has no parent dir");
        return 1;
    };
    let paths = match crate::paths::Paths::from_env() {
        Ok(p) => p,
        Err(e) => {
            crate::log::error(&format!("system-service-cli: Paths::from_env failed: {e}"));
            return 1;
        }
    };
    let node = match resolve_node_with(paths.deps_path.to_str(), &work_dir) {
        Ok(n) => n,
        Err(e) => {
            crate::log::error(&format!("system-service-cli: node not found: {e}"));
            return 1;
        }
    };
    let entry = match resolve_server_entry_with(&work_dir) {
        Ok(e) => e,
        Err(e) => {
            crate::log::error(&format!("system-service-cli: server entry not found: {e}"));
            return 1;
        }
    };

    // Forward everything past argv[0] verbatim to node (includes the
    // --install/uninstall/status flag and any extra flags such as --port).
    let forwarded: Vec<&String> = args.iter().skip(1).collect();

    match Command::new(&node)
        .arg(&entry)
        .args(&forwarded)
        .current_dir(&work_dir)
        .status()
    {
        Ok(s) => exit_code_of(&s),
        Err(e) => {
            crate::log::error(&format!("system-service-cli: spawn node failed: {e}"));
            1
        }
    }
}

/// Map node's exit status to a propagatable code. A normal exit forwards its
/// code verbatim; a signal-killed node (SIGKILL/SIGSEGV/etc.) is surfaced as
/// `128 + signal` (and logged) rather than masked as a plain 1 — important for
/// a root install CLI where signal-death vs. error-exit is a real diagnostic
/// distinction. Linux-gated module, so the unix ext is always available.
fn exit_code_of(s: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    if let Some(code) = s.code() {
        return code;
    }
    if let Some(sig) = s.signal() {
        crate::log::error(&format!("system-service-cli: node killed by signal {sig}"));
        return 128 + sig;
    }
    1
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
