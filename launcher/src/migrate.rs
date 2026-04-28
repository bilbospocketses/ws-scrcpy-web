// One-shot migration of pre-Phase-1 user state from <install_root> to
// <data_root>. Runs at every launcher startup but is idempotent: once
// <data_root>/config.json exists, the shim never copies again.
//
// Why this exists:
//   v0.1.x stored config.json at <install_root>/config.json (per-user
//   %LocalAppData%\WsScrcpyWeb\config.json). v0.1.21 moves the writable-
//   state root to <data_root> = %PROGRAMDATA%\WsScrcpyWeb. When a user
//   upgrades from v0.1.20 -> v0.1.21 in place (Velopack auto-update),
//   their existing config.json would be ignored without this shim and
//   they'd hit first-run setup again. Phase 4 will move the install
//   root to Program Files; the shim continues to be safe (it only fires
//   when source exists AND target doesn't).
//
// Scope: config.json only. We deliberately do NOT migrate
// dependencies/ — those are large (~30 MB) and the dep manager re-
// downloads from network on first start, which is acceptable for a
// single-time upgrade.

use std::fs;
use std::path::Path;

use crate::log;

/// If `<install_root>/config.json` exists AND `<data_root>/config.json`
/// does NOT exist, copy the former to the latter. No-op when either
/// condition fails OR when the two roots are identical (e.g. on
/// non-Windows where data_root collapses to install_root).
pub fn migrate_legacy_config(install_root: &Path, data_root: &Path) {
    if install_root == data_root {
        return;
    }
    let src = install_root.join("config.json");
    let dst = data_root.join("config.json");
    if !src.exists() {
        return;
    }
    if dst.exists() {
        return;
    }
    if !data_root.exists() {
        if let Err(e) = fs::create_dir_all(data_root) {
            log::error(&format!("migrate: could not create {data_root:?}: {e}"));
            return;
        }
    }
    match fs::copy(&src, &dst) {
        Ok(_) => log::info(&format!(
            "migrate: copied legacy config {src:?} -> {dst:?}"
        )),
        Err(e) => log::error(&format!(
            "migrate: copy {src:?} -> {dst:?} failed: {e}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn copies_when_target_absent() {
        let dir = tempdir().unwrap();
        let install = dir.path().join("install");
        let data = dir.path().join("data");
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("config.json"), r#"{"webPort":8042}"#).unwrap();

        migrate_legacy_config(&install, &data);

        let dst = data.join("config.json");
        assert!(dst.exists(), "data_root config should exist after migration");
        let body = fs::read_to_string(&dst).unwrap();
        assert!(body.contains("8042"), "migrated content should match source");
    }

    #[test]
    fn creates_data_root_dir_when_missing() {
        let dir = tempdir().unwrap();
        let install = dir.path().join("install");
        let data = dir.path().join("nested").join("data"); // doesn't exist
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("config.json"), r#"{"webPort":1}"#).unwrap();

        migrate_legacy_config(&install, &data);

        assert!(data.exists(), "data_root dir created");
        assert!(data.join("config.json").exists(), "config copied into new dir");
    }

    #[test]
    fn noop_when_target_exists_preserves_newer_config() {
        let dir = tempdir().unwrap();
        let install = dir.path().join("install");
        let data = dir.path().join("data");
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(install.join("config.json"), r#"{"webPort":1}"#).unwrap();
        fs::write(data.join("config.json"), r#"{"webPort":2}"#).unwrap();

        migrate_legacy_config(&install, &data);

        let body = fs::read_to_string(data.join("config.json")).unwrap();
        assert!(
            body.contains("\"webPort\":2"),
            "user's newer config must be preserved across launcher restarts"
        );
    }

    #[test]
    fn noop_when_source_absent() {
        let dir = tempdir().unwrap();
        let install = dir.path().join("install");
        let data = dir.path().join("data");
        fs::create_dir_all(&install).unwrap();

        migrate_legacy_config(&install, &data);

        assert!(
            !data.join("config.json").exists(),
            "no source -> no target created"
        );
    }

    #[test]
    fn noop_when_roots_are_identical() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("config.json"), r#"{"a":1}"#).unwrap();

        migrate_legacy_config(dir.path(), dir.path());

        let body = fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert_eq!(body, r#"{"a":1}"#, "self-copy must not corrupt the file");
    }
}
