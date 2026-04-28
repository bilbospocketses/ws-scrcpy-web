//! Read-only view of `<installRoot>/config.json`.
//!
//! Mirrors only the fields the Rust binaries (launcher + tray helper) need.
//! The TS source of truth is `src/server/Config.ts`.
//!
//! Two load entry points:
//!   - [`AppConfig::load`] — lenient: missing/malformed -> default. Never logs.
//!     Callers that want logging on the fallback path use `load_strict`.
//!   - [`AppConfig::load_strict`] — strict: missing -> Err, malformed -> Err.

use serde::Deserialize;
use std::fmt;
use std::path::{Path, PathBuf};

/// Pure resolver for the writable-state root on Windows. Mirrors
/// `resolveDataRoot` in `src/server/Config.ts` (Phase 1 of the Program
/// Files migration). Returns `<programdata>\WsScrcpyWeb`. The TS side
/// returns null on non-Windows; callers needing the cross-platform
/// "data root or install root fallback" semantic should compose this
/// with their install-root knowledge.
pub fn data_root_for_windows(programdata: Option<&str>) -> PathBuf {
    let pd = programdata
        .filter(|s| !s.is_empty())
        .unwrap_or("C:\\ProgramData");
    PathBuf::from(pd).join("WsScrcpyWeb")
}

/// Convenience wrapper around [`data_root_for_windows`] that reads
/// `PROGRAMDATA` from the process env. Returns `Some` on Windows, `None`
/// elsewhere — non-Windows callers should fall back to install-root for
/// data-root semantics until/unless a Linux migration target is defined.
pub fn data_root_from_env() -> Option<PathBuf> {
    if cfg!(windows) {
        let pd = std::env::var("PROGRAMDATA").ok();
        Some(data_root_for_windows(pd.as_deref()))
    } else {
        None
    }
}

#[derive(Debug, Deserialize, Default, PartialEq, Eq)]
#[serde(default)]
pub struct AppConfig {
    #[serde(rename = "installMode")]
    pub install_mode: Option<String>,
    #[serde(rename = "firstRunComplete")]
    pub first_run_complete: bool,
    #[serde(rename = "webPort")]
    pub web_port: Option<u16>,
}

/// Errors from [`AppConfig::load_strict`]. Lenient [`AppConfig::load`] never
/// returns errors — it always falls back to [`AppConfig::default`].
#[derive(Debug)]
pub enum ConfigError {
    /// `config.json` not present at the expected path.
    Missing,
    /// I/O failure while reading the file.
    Io(std::io::Error),
    /// JSON parse failure.
    Json(serde_json::Error),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Missing => write!(f, "config.json not found"),
            ConfigError::Io(e) => write!(f, "config.json read failed: {e}"),
            ConfigError::Json(e) => write!(f, "config.json parse failed: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConfigError::Missing => None,
            ConfigError::Io(e) => Some(e),
            ConfigError::Json(e) => Some(e),
        }
    }
}

impl AppConfig {
    /// `installMode` ends in `-service` (i.e., service-mode install).
    pub fn is_service_mode(&self) -> bool {
        self.install_mode
            .as_deref()
            .is_some_and(|m| m.ends_with("-service"))
    }

    /// Strict load from a specific path. Missing file or parse error -> Err.
    pub fn load_strict_from(path: &Path) -> Result<Self, ConfigError> {
        if !path.exists() {
            return Err(ConfigError::Missing);
        }
        let text = std::fs::read_to_string(path).map_err(ConfigError::Io)?;
        serde_json::from_str::<AppConfig>(&text).map_err(ConfigError::Json)
    }

    /// Strict load from `<install_root>/config.json`.
    pub fn load_strict(install_root: &Path) -> Result<Self, ConfigError> {
        Self::load_strict_from(&install_root.join("config.json"))
    }

    /// Lenient load from a specific path. Missing or malformed -> default.
    /// Never logs; callers that want feedback on the fallback path should
    /// use [`AppConfig::load_strict_from`] and log themselves.
    pub fn load_from(path: &Path) -> Self {
        Self::load_strict_from(path).unwrap_or_default()
    }

    /// Lenient load from `<install_root>/config.json`.
    pub fn load(install_root: &Path) -> Self {
        Self::load_strict(install_root).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn missing_file_returns_default() {
        let dir = tempdir().unwrap();
        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg, AppConfig::default());
        assert_eq!(cfg.install_mode, None);
        assert!(!cfg.first_run_complete);
        assert_eq!(cfg.web_port, None);
    }

    #[test]
    fn parses_well_formed_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{"installMode":"user-service","firstRunComplete":true,"webPort":8001}"#,
        )
        .unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg.install_mode.as_deref(), Some("user-service"));
        assert!(cfg.first_run_complete);
        assert_eq!(cfg.web_port, Some(8001));
        assert!(cfg.is_service_mode());
    }

    #[test]
    fn missing_fields_use_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, r#"{"webPort":9000}"#).unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg.install_mode, None);
        assert!(!cfg.first_run_complete);
        assert_eq!(cfg.web_port, Some(9000));
    }

    #[test]
    fn ignores_unknown_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{"installMode":"user","autoUpdate":true,"channel":"beta","githubOwner":"x"}"#,
        )
        .unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg.install_mode.as_deref(), Some("user"));
        assert!(!cfg.is_service_mode());
    }

    #[test]
    fn invalid_json_returns_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{not valid json").unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn empty_file_returns_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "").unwrap();

        let cfg = AppConfig::load(dir.path());
        assert_eq!(cfg, AppConfig::default());
    }

    // data_root_for_windows uses backslash-rooted Windows paths. PathBuf::join
    // on Linux converts those into forward-slash-separated paths because
    // the platform-native separator differs, which makes the asserted-against
    // string literals diverge. The function is only meaningfully called on
    // Windows (data_root_from_env returns None elsewhere), so gate the
    // assertions to Windows runners. Mirrors the existing gate on
    // launcher::paths::tests::compute_*_on_windows.

    #[test]
    #[cfg(windows)]
    fn data_root_for_windows_uses_programdata_when_set() {
        let result = data_root_for_windows(Some("C:\\ProgramData"));
        assert_eq!(result, PathBuf::from("C:\\ProgramData\\WsScrcpyWeb"));
    }

    #[test]
    #[cfg(windows)]
    fn data_root_for_windows_honors_custom_programdata() {
        let result = data_root_for_windows(Some("D:\\Custom\\ProgramData"));
        assert_eq!(result, PathBuf::from("D:\\Custom\\ProgramData\\WsScrcpyWeb"));
    }

    #[test]
    #[cfg(windows)]
    fn data_root_for_windows_falls_back_when_programdata_missing() {
        let result = data_root_for_windows(None);
        assert_eq!(result, PathBuf::from("C:\\ProgramData\\WsScrcpyWeb"));
    }

    #[test]
    #[cfg(windows)]
    fn data_root_for_windows_falls_back_on_empty_programdata() {
        let result = data_root_for_windows(Some(""));
        assert_eq!(result, PathBuf::from("C:\\ProgramData\\WsScrcpyWeb"));
    }

    #[test]
    fn is_service_mode_recognizes_both_service_variants() {
        let mk = |mode: Option<&str>| AppConfig {
            install_mode: mode.map(|s| s.to_string()),
            ..Default::default()
        };
        assert!(!mk(Some("user")).is_service_mode());
        assert!(mk(Some("user-service")).is_service_mode());
        assert!(mk(Some("system-service")).is_service_mode());
        assert!(!mk(Some("system")).is_service_mode());
        assert!(!mk(None).is_service_mode());
    }

    #[test]
    fn load_strict_returns_missing_for_absent_file() {
        let dir = tempdir().unwrap();
        let err = AppConfig::load_strict(dir.path()).unwrap_err();
        assert!(matches!(err, ConfigError::Missing));
    }

    #[test]
    fn load_strict_returns_json_err_for_malformed_file() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("config.json"), "{not valid").unwrap();
        let err = AppConfig::load_strict(dir.path()).unwrap_err();
        assert!(matches!(err, ConfigError::Json(_)));
    }

    #[test]
    fn load_strict_succeeds_for_valid_file() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("config.json"),
            r#"{"installMode":"user-service"}"#,
        )
        .unwrap();
        let cfg = AppConfig::load_strict(dir.path()).unwrap();
        assert!(cfg.is_service_mode());
    }
}
