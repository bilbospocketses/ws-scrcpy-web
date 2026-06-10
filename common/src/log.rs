//! Minimal file logger shared by all ws-scrcpy-web Rust binaries.
//!
//! Promoted from `launcher/src/log.rs` 2026-05-22 (todo §33 beta.38
//! diagnostic-logging cut) so the `tray` crate + the `common` crate
//! itself (notably `control_marker::poll_once`) can write to disk too.
//! Pre-promotion the tray's `eprintln!` calls went to NUL because the
//! tray runs `windows_subsystem = "windows"` (no attached console),
//! making tray-side diagnostics invisible. Same problem for
//! `poll_for_handoff` running on the tray thread.
//!
//! ## Per-binary log file naming
//!
//! Each binary should call [`init`] once at startup with its name —
//! "launcher", "tray", etc. The logger writes to
//! `<dataRoot>/logs/<name>.log` (Windows) or `<exe_dir>/<name>.log`
//! (non-Windows / pre-dataRoot-init fallback). If [`init`] is never
//! called the default name is "launcher" for backward compatibility
//! with the pre-promotion launcher.log path (so all existing
//! `crate::log::info(...)` call sites in the launcher continue
//! writing to the same file as before).
//!
//! ## Timestamp format
//!
//! Every line is prefixed with a UTC timestamp in
//! `YYYY-MM-DD HH:MM:SS.fff` format. Without this, after-the-fact log
//! review can't tell whether two adjacent entries were a few seconds
//! apart or hours — which made v0.1.6 service-mode debugging slower
//! than it should have been.

use std::fs::{self, OpenOptions};
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_NAME: OnceLock<String> = OnceLock::new();
static LOG_DISABLED: AtomicBool = AtomicBool::new(false);

const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024; // 10MB

/// Turn off all logging (file + stderr) for this process. Used by the
/// Windows in-app uninstall cleaner: every `append()` calls
/// `create_dir_all(<dataRoot>/logs)`, which would resurrect the data root
/// after a `--wipe`. The cleaner calls this once at startup so deletion is
/// final. Idempotent; intentionally no re-enable.
pub fn disable() {
    LOG_DISABLED.store(true, Ordering::Relaxed);
}

/// True once `disable()` has been called in this process.
pub fn is_disabled() -> bool {
    LOG_DISABLED.load(Ordering::Relaxed)
}

/// Whether the launcher/tray should echo a log line to stderr. True only when
/// stderr is a terminal. Under a service the service manager redirects stderr
/// to a file (service.log) — not a terminal — so we skip the echo, which would
/// only duplicate launcher.log into service.log. Keyed on the OS truth, never
/// an env var.
pub fn should_echo_stderr(is_terminal: bool) -> bool {
    is_terminal
}

/// Set the log file basename for this process. Should be called once
/// at startup, before any [`info`]/[`error`] calls, with the binary's
/// short name (e.g., "launcher", "tray"). The resulting log path is
/// `<dataRoot>/logs/<name>.log`.
///
/// Idempotent — second call is silently ignored (OnceLock semantics).
/// If never called, the default name is "launcher" for backward
/// compatibility with the pre-promotion launcher.log path.
pub fn init(name: &str) {
    let _ = LOG_NAME.set(name.to_string());
}

fn log_basename() -> &'static str {
    LOG_NAME.get().map(|s| s.as_str()).unwrap_or("launcher")
}

fn log_path() -> Option<PathBuf> {
    let filename = format!("{}.log", log_basename());
    if let Some(data_root) = crate::config::data_root_from_env() {
        let logs_dir = data_root.join("logs");
        // Best-effort directory create — if we can't create it (e.g.
        // ACL not yet set on a fresh install), fall back to exe_dir
        // below so we still get *some* logging.
        let _ = fs::create_dir_all(&logs_dir);
        if logs_dir.exists() {
            return Some(logs_dir.join(&filename));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join(&filename))
}

/// Format the current SystemTime as `YYYY-MM-DD HH:MM:SS.fff` (UTC).
///
/// Date math done by hand instead of via `chrono`/`time` to keep the
/// crate dependency-light. UTC epoch seconds → calendar date is a
/// closed-form computation; civil_from_days is the standard algorithm
/// (Howard Hinnant). Tested against several known timestamps below.
pub fn format_timestamp_utc(now: SystemTime) -> String {
    let dur = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();

    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let hour = (secs_of_day / 3_600) as u32;
    let minute = ((secs_of_day % 3_600) / 60) as u32;
    let second = (secs_of_day % 60) as u32;

    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{millis:03}"
    )
}

/// Howard Hinnant's algorithm: convert days-since-1970-01-01 to (year, month, day).
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i32 + (era as i32) * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

fn append(prefix: &str, msg: &str) {
    if is_disabled() {
        return;
    }
    let ts = format_timestamp_utc(SystemTime::now());
    if let Some(path) = log_path() {
        rotate_by_rename_if_large(&path, MAX_LOG_SIZE);
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{ts} [{prefix}] {msg}");
        }
    }
    if should_echo_stderr(std::io::stderr().is_terminal()) {
        eprintln!("{ts} [{prefix}] {msg}");
    }
}

/// Append ".1" to a path's full filename (so `launcher.log` -> `launcher.log.1`,
/// not `Path::with_extension`'s `launcher.1`).
fn dot_one(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".1");
    PathBuf::from(s)
}

/// Rotate by RENAME when `path` is at/over `max_bytes`. Safe only for files
/// WE open per-write (no persistent fd) — launcher.log / tray.log / server.log
/// between spawns. Best-effort; never panics.
pub fn rotate_by_rename_if_large(path: &Path, max_bytes: u64) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= max_bytes {
            let backup = dot_one(path);
            let _ = fs::remove_file(&backup); // Windows rename won't replace
            let _ = fs::rename(path, &backup);
        }
    }
}

/// Rotate by COPY-TRUNCATE when `path` is at/over `max_bytes`. The logrotate
/// `copytruncate` technique: copy -> `.1`, then truncate the original in place.
/// Required for files an EXTERNAL writer holds open in append mode (systemd
/// service.log) — a rename would orphan that fd. Best-effort; never panics.
pub fn copy_truncate_if_large(path: &Path, max_bytes: u64) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= max_bytes {
            let _ = fs::copy(path, dot_one(path));
            let _ = OpenOptions::new().write(true).truncate(true).open(path);
        }
    }
}

pub fn info(msg: &str) {
    append("INFO", msg);
}

pub fn warn(msg: &str) {
    append("WARN", msg);
}

pub fn error(msg: &str) {
    append("ERROR", msg);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamp_format_for_known_epoch() {
        // 0 unix epoch = 1970-01-01 00:00:00.000
        let t = UNIX_EPOCH;
        assert_eq!(format_timestamp_utc(t), "1970-01-01 00:00:00.000");
    }

    #[test]
    fn timestamp_format_for_y2k() {
        // 2000-01-01 00:00:00 UTC = 946684800 unix
        let t = UNIX_EPOCH + Duration::from_secs(946_684_800);
        assert_eq!(format_timestamp_utc(t), "2000-01-01 00:00:00.000");
    }

    #[test]
    fn timestamp_includes_milliseconds() {
        let t = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert!(format_timestamp_utc(t).ends_with(".123"));
    }

    #[test]
    fn civil_from_days_round_trip_known_dates() {
        // Days from 1970-01-01:
        //   2024-02-29 = 19782 (leap day)
        //   2026-04-28 = 20571
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(20_571), (2026, 4, 28));
    }

    #[test]
    fn log_basename_defaults_to_launcher_when_init_not_called() {
        // OnceLock starts unset in a fresh test invocation. Note: this
        // test must run before any init() in the same test binary; the
        // common test process never calls init() so this is safe.
        assert_eq!(log_basename(), "launcher");
    }

    #[test]
    fn disable_silences_logging() {
        // The Windows uninstall cleaner must be able to turn off all logging so
        // that append()'s create_dir_all(<dataRoot>/logs) never resurrects the
        // data root after a wipe. disable() is process-global and irreversible;
        // no other common-crate test reads is_disabled(), so ordering is safe.
        assert!(!is_disabled(), "logging starts enabled");
        disable();
        assert!(is_disabled(), "disable() must set the gate");
    }

    #[test]
    fn should_echo_stderr_follows_is_terminal() {
        assert!(super::should_echo_stderr(true));
        assert!(!super::should_echo_stderr(false));
    }

    #[test]
    fn rename_rotation_moves_oversized_file_to_dot_one() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("launcher.log");
        std::fs::write(&f, vec![0u8; 11]).unwrap();
        super::rotate_by_rename_if_large(&f, 10);
        assert!(dir.path().join("launcher.log.1").exists());
        assert!(!f.exists(), "original renamed away; next append recreates it");
    }

    #[test]
    fn rename_rotation_leaves_small_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("launcher.log");
        std::fs::write(&f, vec![0u8; 5]).unwrap();
        super::rotate_by_rename_if_large(&f, 10);
        assert!(!dir.path().join("launcher.log.1").exists());
        assert!(f.exists());
    }

    #[test]
    fn copy_truncate_preserves_inode_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("service.log");
        std::fs::write(&f, vec![b'x'; 11]).unwrap();
        super::copy_truncate_if_large(&f, 10);
        assert_eq!(std::fs::read(dir.path().join("service.log.1")).unwrap().len(), 11);
        assert_eq!(std::fs::metadata(&f).unwrap().len(), 0);
    }
}
