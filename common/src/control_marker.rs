use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Marker {
    pub verb: String,
    #[serde(rename = "targetSessionId")]
    pub target_session_id: Option<u32>,
    #[serde(rename = "launcherPath")]
    pub launcher_path: PathBuf,
    #[serde(rename = "launcherArgs")]
    pub launcher_args: Vec<String>,
    #[serde(rename = "writtenAt")]
    pub written_at: String,
}

pub const CONTROL_DIR: &str = "control";
pub const UNINSTALL_HANDOFF_FILENAME: &str = "uninstall-handoff.json";

/// Write a marker atomically under `<data_root>/control/`. The directory
/// is created if missing. Existing markers are overwritten.
pub fn write(data_root: &Path, marker: &Marker) -> io::Result<()> {
    let dir = data_root.join(CONTROL_DIR);
    fs::create_dir_all(&dir)?;
    let final_path = dir.join(UNINSTALL_HANDOFF_FILENAME);
    let tmp_path = dir.join(format!("{}.tmp", UNINSTALL_HANDOFF_FILENAME));
    let json = serde_json::to_vec_pretty(marker)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&tmp_path, &json)?;
    // fs::rename on Windows replaces an existing file when destination is on
    // the same volume — which it always is here (both inside <data_root>).
    fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips_through_json() {
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from(r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe"),
            launcher_args: vec!["--local-takeover".to_string()],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        let json = serde_json::to_string(&m).expect("serialize");
        let back: Marker = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(m, back);
    }

    #[test]
    fn write_creates_file_atomically_under_control_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_root = tmp.path();
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(data_root, &m).expect("write succeeds");
        let target = data_root.join("control").join("uninstall-handoff.json");
        assert!(target.exists(), "marker file exists after write");
        let body = std::fs::read_to_string(&target).expect("readable");
        let parsed: Marker = serde_json::from_str(&body).expect("valid json");
        assert_eq!(parsed, m);
    }

    #[test]
    fn write_overwrites_existing_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_root = tmp.path();
        let mk = |session| Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(session),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(data_root, &mk(1)).expect("first write");
        write(data_root, &mk(2)).expect("second write");
        let target = data_root.join("control").join("uninstall-handoff.json");
        let body = std::fs::read_to_string(&target).expect("readable");
        let parsed: Marker = serde_json::from_str(&body).expect("valid json");
        assert_eq!(parsed.target_session_id, Some(2));
    }
}
