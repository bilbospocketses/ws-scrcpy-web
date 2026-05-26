// Node child-process spawn for the launcher.
//
// Resolves the Node executable using a best-effort priority chain:
//   1. `deps_path` parameter → `<deps_path>/node/node.exe` (preferred;
//      populated after first-run bootstrap installs Node into dependencies/).
//   2. `<exe_dir>/seed/node/node.exe` (bundled fallback for first-run
//      before dependencies/ is populated, or if deps node is missing).
//   3. Otherwise, error.
//
// Server entry is `<exe_dir>/dist/index.js`.

use anyhow::{Context, Result, bail};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

// CREATE_NO_WINDOW = 0x08000000. Defined here as a literal so we don't need
// to thread the windows crate through pure-logic functions / tests on
// non-Windows hosts (when those happen — e.g., CI matrix expansion).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Pure resolution: given an optional DEPS_PATH and an exe directory,
/// return the Node binary path or an error.
pub fn resolve_node_with(deps_path: Option<&str>, exe_dir: &Path) -> Result<PathBuf> {
    if let Some(deps) = deps_path {
        let candidate = Path::new(deps).join("node").join("node.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
        // deps_path set but node not there yet (first-run bootstrap) — fall
        // through to seed instead of hard-failing.
    }

    let seed = exe_dir.join("seed").join("node").join("node.exe");
    if seed.exists() {
        return Ok(seed);
    }

    bail!(
        "Node not found. Set DEPS_PATH or place a Node binary at {:?}",
        seed
    )
}

/// Resolve Node using process env + current exe path.
pub fn resolve_node() -> Result<PathBuf> {
    let deps = std::env::var("DEPS_PATH").ok();
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    resolve_node_with(deps.as_deref(), exe_dir)
}

/// Pure resolution for the server entry point.
pub fn resolve_server_entry_with(exe_dir: &Path) -> Result<PathBuf> {
    let entry = exe_dir.join("dist").join("index.js");
    if entry.exists() {
        Ok(entry)
    } else {
        bail!("Server entry not found at {:?}", entry)
    }
}

pub fn resolve_server_entry() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("could not determine current exe path")?;
    let exe_dir = exe.parent().context("exe has no parent dir")?;
    resolve_server_entry_with(exe_dir)
}

/// Open the server.log file in append mode for stdout/stderr redirection.
///
/// Without this redirection, the Node child's output goes to the void in
/// release builds (no attached console). Server-side crashes (e.g., port
/// already bound, native module load failures, unhandled rejections in
/// startup) become silent and undebuggable. The v0.1.6 "service runs but
/// app unreachable" + "no port bound, no idea why" debugging tonight was
/// only possible by manually running Node from PowerShell — now the same
/// information is captured automatically.
///
/// Returns `Ok(None)` if we couldn't open the log file (we still spawn the
/// child with stdio inherited so the user's terminal sees output if any).
///
/// v0.1.24-beta.3: server.log lives under `<dataRoot>/logs/server.log`
/// alongside launcher.log. Pre-beta.3 it was at `<deps_path>/server.log`
/// (i.e., `<dataRoot>/dependencies/server.log`); the move colocates
/// both files under one `logs/` folder.
fn open_server_log(data_root: &Path) -> Option<std::fs::File> {
    let log_path = data_root.join("logs").join("server.log");
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
}

/// Spawn the Node server with hidden console window.
///
/// `DEPS_PATH` is set on the CHILD's env (not the launcher's own env) so the
/// Node backend's DependencyManager knows where to install Node / ADB /
/// scrcpy-server. The Node server's `Config.resolveAdbPath` then computes
/// `<deps>/adb/adb[.exe]` itself — no env-var indirection, no system-PATH
/// fallback. If the file isn't there yet, autoInstallMissing fetches it.
///
/// Returns the child handle so the caller (supervisor) can wait on it.
#[cfg(windows)]
pub fn spawn_server(deps_path: &Path, data_root: &Path) -> Result<Child> {
    use std::os::windows::process::CommandExt;

    let exe = std::env::current_exe()?;
    let work_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();
    let deps_str = deps_path.to_str().context("deps_path is not valid UTF-8")?;
    let node = resolve_node_with(Some(deps_str), &work_dir)?;
    let entry = resolve_server_entry_with(&work_dir)?;

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path)
        .creation_flags(CREATE_NO_WINDOW);

    // Plumb the child's stdout AND stderr into <deps>/server.log so a
    // crashed startup leaves a forensic trail. Both go to the same file
    // (interleaved); separating them is rarely worth the duplicate I/O.
    if let Some(log) = open_server_log(data_root) {
        let log_clone = log.try_clone().ok();
        cmd.stdout(std::process::Stdio::from(log));
        if let Some(c) = log_clone {
            cmd.stderr(std::process::Stdio::from(c));
        }
    }

    let child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {:?} {:?}", node, entry))?;

    // Adopt the child into a process-wide Job Object with
    // KILL_ON_JOB_CLOSE so the Node grandchild + node-pty descendants are
    // terminated when the launcher exits. Failure here is non-fatal — we
    // log and continue with v0.1.21 behavior.
    if let Err(e) = crate::job_object::adopt(&child) {
        crate::log::error(&format!(
            "could not adopt Node child into Job Object (continuing without process-tree teardown guarantee): {e:#}"
        ));
    }

    Ok(child)
}

#[cfg(not(windows))]
pub fn spawn_server(deps_path: &Path, data_root: &Path) -> Result<Child> {
    let exe = std::env::current_exe()?;
    let work_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();
    let deps_str = deps_path.to_str().context("deps_path is not valid UTF-8")?;
    let node = resolve_node_with(Some(deps_str), &work_dir)?;
    let entry = resolve_server_entry_with(&work_dir)?;

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path);

    if let Some(log) = open_server_log(data_root) {
        let log_clone = log.try_clone().ok();
        cmd.stdout(std::process::Stdio::from(log));
        if let Some(c) = log_clone {
            cmd.stderr(std::process::Stdio::from(c));
        }
    }

    let child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {:?} {:?}", node, entry))?;

    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"stub").unwrap();
    }

    #[test]
    fn resolve_node_uses_deps_path_when_present() {
        let dir = tempdir().unwrap();
        let deps = dir.path().join("deps");
        let node = deps.join("node").join("node.exe");
        touch(&node);

        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let resolved = resolve_node_with(Some(deps.to_str().unwrap()), &exe_dir).unwrap();
        assert_eq!(resolved, node);
    }

    #[test]
    fn resolve_node_falls_back_to_seed_when_deps_path_set_but_node_missing() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        let seed = exe_dir.join("seed").join("node").join("node.exe");
        touch(&seed);

        // deps_path points to an empty directory — node binary not there yet.
        let bogus = dir.path().join("nope");
        fs::create_dir_all(&bogus).unwrap();
        let resolved =
            resolve_node_with(Some(bogus.to_str().unwrap()), &exe_dir).unwrap();
        assert_eq!(resolved, seed);
    }

    #[test]
    fn resolve_node_errors_when_deps_and_seed_both_missing() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let bogus = dir.path().join("nope");
        let err = resolve_node_with(Some(bogus.to_str().unwrap()), &exe_dir).unwrap_err();
        assert!(err.to_string().contains("Node not found"));
    }

    #[test]
    fn resolve_node_falls_back_to_seed_when_deps_path_unset() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        let seed = exe_dir.join("seed").join("node").join("node.exe");
        touch(&seed);

        let resolved = resolve_node_with(None, &exe_dir).unwrap();
        assert_eq!(resolved, seed);
    }

    #[test]
    fn resolve_node_errors_when_neither_present() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let err = resolve_node_with(None, &exe_dir).unwrap_err();
        assert!(err.to_string().contains("Node not found"));
    }

    #[test]
    fn resolve_server_entry_finds_dist_index_js() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        let entry = exe_dir.join("dist").join("index.js");
        touch(&entry);

        let resolved = resolve_server_entry_with(&exe_dir).unwrap();
        assert_eq!(resolved, entry);
    }

    #[test]
    fn resolve_server_entry_errors_when_missing() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let err = resolve_server_entry_with(&exe_dir).unwrap_err();
        assert!(err.to_string().contains("Server entry not found"));
    }

}
