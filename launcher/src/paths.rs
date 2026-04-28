// Canonical path resolution for the install layout.
//
// Production layout (Phase 1 of Program Files migration):
//   <installRoot>/                        (binaries; admin-write only after Phase 4)
//     ws-scrcpy-web.exe                   (Velopack stub)
//     Update.exe                          (Velopack updater)
//     current/                            (Velopack-managed; wiped on update)
//       ws-scrcpy-web-launcher.exe        <-- exe_dir
//       dist/, seed/, ...
//
//   <dataRoot>/                           (writable state; Authenticated Users:Modify)
//     config.json                         (was at install_root pre-Phase-1)
//     ws-scrcpy-web-launcher.log
//     dependencies/                       (DEPS_PATH target — was at install_root pre-Phase-1)
//
// On Windows, dataRoot defaults to %PROGRAMDATA%\WsScrcpyWeb. On non-Windows
// (Linux AppImage), dataRoot collapses to install_root for now — there is no
// migration target until/unless a Linux Program-Files-equivalent flow is
// designed. The DEPS_PATH env var continues to override deps_path absolutely
// when set (used by tests, shared-deps installs, and the service-install
// envVars block in ServiceApi.handleInstall).
//
// Dev layout (target/debug or target/release):
//   target/debug/ws-scrcpy-web-launcher.exe    <-- exe_dir
//   <project>/                                 <-- exe_dir.parent().parent()

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub struct Paths {
    pub install_root: PathBuf,
    /// Writable state root — `<PROGRAMDATA>\WsScrcpyWeb` on Windows,
    /// equal to `install_root` on non-Windows (no migration there).
    pub data_root: PathBuf,
    pub deps_path: PathBuf,
    pub restart_marker: PathBuf,
    pub old_node: PathBuf,
}

impl Paths {
    /// Compute paths from a known exe directory plus optional DEPS_PATH and
    /// PROGRAMDATA overrides. `deps_override` matches the resolution priority
    /// in `spawn::resolve_node`. `programdata_override` lets tests inject the
    /// Windows ProgramData path without mutating process env.
    ///
    /// On non-Windows hosts the `programdata_override` is ignored and
    /// `data_root` collapses to `install_root` — Phase 1 doesn't migrate
    /// Linux paths.
    pub fn compute(
        exe_dir: &Path,
        deps_override: Option<&str>,
        programdata_override: Option<&str>,
    ) -> Result<Self> {
        let install_root = exe_dir
            .parent()
            .context("exe_dir has no parent (cannot derive install_root)")?
            .to_path_buf();

        let data_root = if cfg!(windows) {
            common::config::data_root_for_windows(programdata_override)
        } else {
            install_root.clone()
        };

        let deps_path = match deps_override {
            Some(p) => PathBuf::from(p),
            None => data_root.join("dependencies"),
        };

        let restart_marker = data_root.join(".restart");
        let old_node = deps_path.join("node").join("node.exe.old");

        Ok(Self {
            install_root,
            data_root,
            deps_path,
            restart_marker,
            old_node,
        })
    }

    /// Compute paths from process state.
    pub fn from_env() -> Result<Self> {
        let exe = std::env::current_exe().context("could not determine current exe path")?;
        let exe_dir = exe
            .parent()
            .context("exe has no parent dir")?
            .to_path_buf();
        let deps_override = std::env::var("DEPS_PATH").ok();
        let programdata = std::env::var("PROGRAMDATA").ok();
        Self::compute(&exe_dir, deps_override.as_deref(), programdata.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    #[cfg(windows)]
    fn compute_uses_data_root_for_default_deps_path_on_windows() {
        let dir = tempdir().unwrap();
        let install_root = dir.path();
        let exe_dir = install_root.join("current");
        std::fs::create_dir_all(&exe_dir).unwrap();

        // Use a tempdir as fake-programdata so the test doesn't touch real
        // C:\ProgramData. The data_root sits under it.
        let fake_pd = dir.path().join("FakeProgramData");
        let paths = Paths::compute(&exe_dir, None, Some(fake_pd.to_str().unwrap())).unwrap();

        assert_eq!(paths.install_root, install_root);
        assert_eq!(paths.data_root, fake_pd.join("WsScrcpyWeb"));
        assert_eq!(paths.deps_path, fake_pd.join("WsScrcpyWeb").join("dependencies"));
        assert_eq!(
            paths.restart_marker,
            fake_pd.join("WsScrcpyWeb").join(".restart")
        );
        assert_eq!(
            paths.old_node,
            fake_pd
                .join("WsScrcpyWeb")
                .join("dependencies")
                .join("node")
                .join("node.exe.old")
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn compute_collapses_data_root_to_install_root_on_non_windows() {
        let dir = tempdir().unwrap();
        let install_root = dir.path();
        let exe_dir = install_root.join("current");
        std::fs::create_dir_all(&exe_dir).unwrap();

        let paths = Paths::compute(&exe_dir, None, None).unwrap();
        assert_eq!(paths.install_root, install_root);
        assert_eq!(paths.data_root, install_root);
        assert_eq!(paths.deps_path, install_root.join("dependencies"));
        assert_eq!(
            paths.restart_marker,
            install_root.join(".restart")
        );
    }

    #[test]
    fn compute_respects_deps_override() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("current");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let custom = dir.path().join("custom-deps");

        let paths = Paths::compute(&exe_dir, Some(custom.to_str().unwrap()), None).unwrap();
        assert_eq!(paths.deps_path, custom);
        // restart_marker is data_root-derived, NOT deps_path-derived — it
        // does NOT pick up the DEPS_PATH override.
    }

    #[test]
    #[cfg(windows)]
    fn compute_falls_back_when_programdata_override_is_none() {
        let dir = tempdir().unwrap();
        let exe_dir = dir.path().join("current");
        std::fs::create_dir_all(&exe_dir).unwrap();

        let paths = Paths::compute(&exe_dir, None, None).unwrap();
        // Falls back to C:\ProgramData\WsScrcpyWeb per data_root_for_windows.
        assert_eq!(paths.data_root, PathBuf::from("C:\\ProgramData\\WsScrcpyWeb"));
    }
}
