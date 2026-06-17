// Node child-process spawn for the launcher.
//
// Resolves the Node executable using a best-effort priority chain:
//   1. `deps_path` parameter → `<deps_path>/node/<node-binary>` (preferred;
//      populated after first-run bootstrap installs Node into dependencies/).
//   2. `<exe_dir>/seed/node/<node-binary>` (bundled fallback for first-run
//      before dependencies/ is populated, or if deps node is missing).
//
// Binary name is platform-conditional: `node.exe` on Windows, `node` on Linux.
//   3. Otherwise, error.
//
// Server entry is `<exe_dir>/dist/index.js`.

use anyhow::{Context, Result, bail};
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

#[cfg(windows)]
use crate::win_util::CREATE_NO_WINDOW;

/// Pure resolution: given an optional DEPS_PATH and an exe directory,
/// return the Node binary path or an error.
pub fn resolve_node_with(deps_path: Option<&str>, exe_dir: &Path) -> Result<PathBuf> {
    if let Some(deps) = deps_path {
        // Linux tarball extracts with bin/ subdirectory; Windows zip is flat.
        let candidate = Path::new(deps).join("node").join("bin").join(NODE_BIN);
        if candidate.exists() {
            return Ok(candidate);
        }
        let candidate = Path::new(deps).join("node").join(NODE_BIN);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let seed = exe_dir.join("seed").join("node").join("bin").join(NODE_BIN);
    if seed.exists() {
        return Ok(seed);
    }
    let seed = exe_dir.join("seed").join("node").join(NODE_BIN);
    if seed.exists() {
        return Ok(seed);
    }

    bail!(
        "Node not found. Set DEPS_PATH or place a Node binary at {:?}",
        seed
    )
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

/// Open the server.log file in append mode for stdout/stderr redirection.
///
/// server.log is a THIN crash-catcher: the launcher still plumbs the Node
/// child's stdout/stderr here so raw crashes / native output are preserved,
/// but `Logger` no longer echoes its lines to the console under the launcher
/// (gated on `process.stdout/stderr.isTTY`). Normal application output lives
/// exclusively in `ws-scrcpy-web.log`; server.log only fills on unhandled
/// panics, port-already-bound errors, native module failures, etc.
///
/// The file is rename-rotated at open (10 MB) — safe because the prior Node
/// child has released its fd between spawns.
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
    // Rotate at 10 MB. server.log is free between spawns (the prior Node child
    // released its fd), so a rename is safe here. It is now a thin crash-catcher
    // (Logger no longer echoes to console under the launcher), so this cadence
    // is ample.
    crate::log::rotate_by_rename_if_large(&log_path, 10 * 1024 * 1024);
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
pub fn spawn_server(deps_path: &Path, data_root: &Path, open_browser: bool) -> Result<Child> {
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
        .env("DATA_ROOT", data_root)
        .creation_flags(CREATE_NO_WINDOW);

    // D4: like the non-Windows path, the launcher's FIRST Node spawn of a fresh
    // user launch tells Node to open a browser tab. A Velopack update-relaunch is
    // suppressed Node-side (the post-update suppress-browser-open marker), since
    // Velopack owns that relaunch and we can't set WS_SCRCPY_NO_BROWSER on it the
    // way linux_apply does.
    if open_browser {
        cmd.env("WS_SCRCPY_OPEN_BROWSER", "1");
    }

    // Plumb the child's stdout AND stderr into server.log (thin crash-catcher).
    // Logger no longer echoes normal lines here, so this only fills on raw
    // crashes/native failures. Both streams go to the same file (interleaved).
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
pub fn spawn_server(deps_path: &Path, data_root: &Path, open_browser: bool) -> Result<Child> {
    let exe = std::env::current_exe()?;
    let work_dir = exe.parent().context("exe has no parent dir")?.to_path_buf();
    let deps_str = deps_path.to_str().context("deps_path is not valid UTF-8")?;
    let node = resolve_node_with(Some(deps_str), &work_dir)?;
    let entry = resolve_server_entry_with(&work_dir)?;

    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path)
        .env("DATA_ROOT", data_root);

    // D1: on the launcher's FIRST spawn of a fresh user launch, tell the Node
    // server to open a browser tab once it is listening (the launcher can't open
    // it itself — Node isn't bound yet). Supervisor restarts pass false, so a
    // webPort-change / crash restart doesn't re-pop a tab. A relaunch's
    // WS_SCRCPY_NO_BROWSER (set by linux_apply) overrides this on the Node side.
    if open_browser {
        cmd.env("WS_SCRCPY_OPEN_BROWSER", "1");
    }

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
        let node = deps.join("node").join(NODE_BIN);
        touch(&node);

        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let resolved = resolve_node_with(Some(deps.to_str().unwrap()), &exe_dir).unwrap();
        assert_eq!(resolved, node);
    }

    #[test]
    fn resolve_node_prefers_bin_subdirectory() {
        let dir = tempdir().unwrap();
        let deps = dir.path().join("deps");
        let bin_node = deps.join("node").join("bin").join(NODE_BIN);
        let flat_node = deps.join("node").join(NODE_BIN);
        touch(&bin_node);
        touch(&flat_node);

        let exe_dir = dir.path().join("exe");
        fs::create_dir_all(&exe_dir).unwrap();

        let resolved = resolve_node_with(Some(deps.to_str().unwrap()), &exe_dir).unwrap();
        assert_eq!(resolved, bin_node);
    }

    #[test]
    fn resolve_node_falls_back_to_seed_when_deps_path_set_but_node_missing() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("exe");
        let seed = exe_dir.join("seed").join("node").join(NODE_BIN);
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
        let seed = exe_dir.join("seed").join("node").join(NODE_BIN);
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

    #[test]
    fn open_server_log_rotates_when_oversized() {
        let dir = tempdir().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        let server_log = logs.join("server.log");
        // Write 10 MB + 1 so it's at/over threshold.
        fs::write(&server_log, vec![0u8; 10 * 1024 * 1024 + 1]).unwrap();
        let _f = open_server_log(dir.path());
        assert!(logs.join("server.log.1").exists(), "oversized server.log rotated to .1");
    }

}
