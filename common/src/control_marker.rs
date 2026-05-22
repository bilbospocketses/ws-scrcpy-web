use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// Read the marker file from `<data_root>/control/uninstall-handoff.json`.
/// Returns:
///   - `Ok(Some(marker))` if the file exists and parses
///   - `Ok(None)` if the file is absent OR present-but-corrupt
///   - `Err(_)` only on unexpected IO errors (permission denied, etc.)
pub fn read(data_root: &Path) -> io::Result<Option<Marker>> {
    let path = data_root.join(CONTROL_DIR).join(UNINSTALL_HANDOFF_FILENAME);
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(serde_json::from_str(&body).ok())
}

/// Delete the marker file. Idempotent — absent file is not an error.
pub fn delete(data_root: &Path) -> io::Result<()> {
    let path = data_root.join(CONTROL_DIR).join(UNINSTALL_HANDOFF_FILENAME);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// If a marker is present and its `writtenAt` is older than `max_age` from
/// `now`, delete it. Failures are logged-and-ignored (poller continues).
/// Used at tray helper startup to clear leftovers from a crashed previous
/// session.
pub fn cleanup_stale(data_root: &Path, now: DateTime<Utc>, max_age: Duration) {
    let Ok(Some(marker)) = read(data_root) else { return };
    let Ok(written) = DateTime::parse_from_rfc3339(&marker.written_at) else {
        // Unparseable timestamp -> treat as stale (overwrites a malformed marker).
        let _ = delete(data_root);
        return;
    };
    let age = now.signed_duration_since(written.with_timezone(&Utc));
    if age.to_std().map(|d| d > max_age).unwrap_or(false) {
        let _ = delete(data_root);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollOutcome {
    /// No marker present.
    Idle,
    /// Marker present but `targetSessionId` doesn't match this tray helper's
    /// session. Marker is left alone so the right tray helper can pick it up.
    WrongSession,
    /// Marker matched, spawn was invoked, marker deleted.
    Spawned,
    /// Spawn returned an error. Marker is NOT deleted so a future tick can
    /// retry (for transient failures like file-locked-by-AV).
    SpawnFailed,
}

/// Run one poll iteration. Returns the outcome. Splitting this out from
/// `poll_for_handoff` makes the loop body unit-testable.
///
/// `spawn` takes `(launcher_path, launcher_args)` and returns Ok(()) on
/// successful spawn (the launcher started; we don't wait for it to bind).
pub fn poll_once<F>(
    data_root: &Path,
    own_session: u32,
    spawn: &mut F,
) -> PollOutcome
where
    F: FnMut(&Path, &[String]) -> io::Result<()>,
{
    let Ok(Some(marker)) = read(data_root) else { return PollOutcome::Idle };
    // §33 beta.38 diagnostic logging — every non-Idle outcome (marker
    // present) is logged so we can correlate tray-side handoff decisions
    // with the service-Node's "marker written" and "did not become
    // reachable" log lines. Idle is intentionally NOT logged (750ms
    // cadence = spam).
    if let Some(target) = marker.target_session_id {
        if target != own_session {
            crate::log::info(&format!(
                "control_marker::poll_once: WrongSession marker_target={target} own_session={own_session} (marker left for the right tray)"
            ));
            return PollOutcome::WrongSession;
        }
    }
    // Convert Vec<String> args into &[String] for the spawn callback.
    crate::log::info(&format!(
        "control_marker::poll_once: marker matched, invoking spawn launcher_path={:?} launcher_args={:?} verb={:?}",
        marker.launcher_path, marker.launcher_args, marker.verb
    ));
    match spawn(&marker.launcher_path, &marker.launcher_args) {
        Ok(()) => {
            let _ = delete(data_root);
            crate::log::info(
                "control_marker::poll_once: Spawned — marker deleted, child detached (returning success without waiting for bind)",
            );
            PollOutcome::Spawned
        }
        Err(e) => {
            crate::log::error(&format!(
                "control_marker::poll_once: SpawnFailed — marker NOT deleted (next tick retries): {e:?}"
            ));
            PollOutcome::SpawnFailed
        }
    }
}

/// Production poll loop. Sleeps `cadence` between ticks and spawns
/// processes via `std::process::Command`. Runs forever. Intended to be
/// invoked on a dedicated thread; thread death is caller's problem.
///
/// On entry, calls `cleanup_stale` once with a 60s threshold to clear any
/// leftover marker from a crashed previous tray-helper run.
pub fn poll_for_handoff(data_root: &Path, own_session: u32, cadence: Duration) {
    cleanup_stale(data_root, Utc::now(), Duration::from_secs(60));
    loop {
        let mut spawn = |path: &Path, args: &[String]| -> io::Result<()> {
            std::process::Command::new(path).args(args).spawn().map(|_| ())
        };
        let _ = poll_once(data_root, own_session, &mut spawn);
        std::thread::sleep(cadence);
    }
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

    #[test]
    fn read_returns_none_when_marker_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let result = read(tmp.path()).expect("read does not error on missing");
        assert!(result.is_none());
    }

    #[test]
    fn read_returns_marker_when_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let got = read(tmp.path()).expect("read").expect("present");
        assert_eq!(got, m);
    }

    #[test]
    fn read_returns_none_on_corrupt_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("uninstall-handoff.json"), b"not json").expect("write");
        // Corrupt content is reported as None, not an error — log+ignore is the
        // caller's preference (poller continues on next tick).
        let result = read(tmp.path()).expect("read does not error on corrupt");
        assert!(result.is_none());
    }

    #[test]
    fn delete_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Delete on absent should be Ok
        delete(tmp.path()).expect("delete absent ok");
        // Write + delete + delete-again
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        delete(tmp.path()).expect("delete present ok");
        delete(tmp.path()).expect("second delete ok");
        assert!(read(tmp.path()).expect("read").is_none());
    }

    #[test]
    fn cleanup_stale_removes_old_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let old = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            // 5 minutes ago
            written_at: "2026-04-29T23:25:00Z".to_string(),
        };
        write(tmp.path(), &old).expect("write");
        // Pretend "now" is 5 minutes after the marker's written_at
        let now = chrono::DateTime::parse_from_rfc3339("2026-04-29T23:30:00Z").unwrap();
        cleanup_stale(tmp.path(), now.into(), std::time::Duration::from_secs(60));
        assert!(read(tmp.path()).expect("read").is_none());
    }

    #[test]
    fn cleanup_stale_keeps_fresh_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fresh = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:29:30Z".to_string(),
        };
        write(tmp.path(), &fresh).expect("write");
        let now = chrono::DateTime::parse_from_rfc3339("2026-04-29T23:30:00Z").unwrap();
        cleanup_stale(tmp.path(), now.into(), std::time::Duration::from_secs(60));
        assert!(read(tmp.path()).expect("read").is_some());
    }

    #[test]
    fn cleanup_stale_removes_marker_with_unparseable_timestamp() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let bad = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "not-a-date".to_string(),
        };
        write(tmp.path(), &bad).expect("write");
        let now = chrono::DateTime::parse_from_rfc3339("2026-04-29T23:30:00Z").unwrap();
        cleanup_stale(tmp.path(), now.into(), std::time::Duration::from_secs(60));
        assert!(read(tmp.path()).expect("read").is_none(), "unparseable timestamp should be reaped");
    }

    #[test]
    fn poll_once_session_match_spawns_and_deletes() {
        // We don't actually exec a real binary in unit test land. Use a
        // fake spawn closure to validate the contract: marker present +
        // session matches -> spawn called with (path, args) -> marker
        // deleted.
        let tmp = tempfile::tempdir().expect("tempdir");
        let target_exe = PathBuf::from("nonexistent-launcher.exe");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: target_exe.clone(),
            launcher_args: vec!["--local-takeover".to_string()],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");

        let spawn_log = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(PathBuf, Vec<String>)>::new()));
        let log_clone = spawn_log.clone();
        let outcome = poll_once(
            tmp.path(),
            1,
            &mut |path, args| { log_clone.lock().unwrap().push((path.to_path_buf(), args.to_vec())); Ok(()) },
        );
        assert_eq!(outcome, PollOutcome::Spawned);
        let log = spawn_log.lock().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].0, target_exe);
        assert_eq!(log[0].1, vec!["--local-takeover"]);
        assert!(read(tmp.path()).expect("read").is_none(), "marker deleted after spawn");
    }

    #[test]
    fn poll_once_session_mismatch_ignores() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(2),  // for a different session
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let outcome = poll_once(tmp.path(), 1, &mut |_, _| panic!("must not spawn"));
        assert_eq!(outcome, PollOutcome::WrongSession);
        assert!(read(tmp.path()).expect("read").is_some(), "marker preserved for other tray helper");
    }

    #[test]
    fn poll_once_no_marker_returns_idle() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let outcome = poll_once(tmp.path(), 1, &mut |_, _| panic!("must not spawn"));
        assert_eq!(outcome, PollOutcome::Idle);
    }

    #[test]
    fn poll_once_null_target_session_spawns_for_any() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: None,
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let mut spawned = false;
        let outcome = poll_once(tmp.path(), 99, &mut |_, _| { spawned = true; Ok(()) });
        assert_eq!(outcome, PollOutcome::Spawned);
        assert!(spawned);
    }

    #[test]
    fn poll_once_spawn_failed_preserves_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let m = Marker {
            verb: "uninstall-service".to_string(),
            target_session_id: Some(1),
            launcher_path: PathBuf::from("a.exe"),
            launcher_args: vec![],
            written_at: "2026-04-29T23:30:00Z".to_string(),
        };
        write(tmp.path(), &m).expect("write");
        let outcome = poll_once(
            tmp.path(),
            1,
            &mut |_, _| Err(std::io::Error::other("boom")),
        );
        assert_eq!(outcome, PollOutcome::SpawnFailed);
        assert!(read(tmp.path()).expect("read").is_some(), "marker preserved for retry");
    }
}
