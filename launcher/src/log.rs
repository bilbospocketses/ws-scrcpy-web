// Minimal file logger for the Rust launcher.
//
// Release builds use `windows_subsystem = "windows"` and have no attached
// console, so stderr/stdout from `eprintln!` is invisible. We always also
// write to a launcher log file so failures during install/update/run can
// be diagnosed.
//
// Phase 1 of the Program Files migration: the log lives under `<dataRoot>`
// (`%PROGRAMDATA%\WsScrcpyWeb\ws-scrcpy-web-launcher.log`) on Windows, so
// it remains writable after Phase 4 when the install root becomes
// `C:\Program Files\WsScrcpyWeb\` (read-only for non-admin user-mode
// launchers). On non-Windows, falls back to `<exe_dir>/launcher.log` —
// the pre-Phase-1 location.
//
// Every line is prefixed with a UTC timestamp in
// `YYYY-MM-DD HH:MM:SS.fff` format. Without this, an after-the-fact log
// review can't tell whether two adjacent entries were a few seconds apart
// or hours — which made the v0.1.6 service-mode debugging slower than it
// should have been.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn log_path() -> Option<PathBuf> {
    if let Some(data_root) = common::config::data_root_from_env() {
        // Best-effort directory create — if we can't create it (e.g.
        // ACL not yet set on a fresh Phase-4 install), fall back to
        // exe_dir below so we still get *some* logging.
        if !data_root.exists() {
            let _ = fs::create_dir_all(&data_root);
        }
        if data_root.exists() {
            return Some(data_root.join("ws-scrcpy-web-launcher.log"));
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("launcher.log"))
}

/// Format the current SystemTime as `YYYY-MM-DD HH:MM:SS.fff` (UTC).
///
/// We do the date math by hand instead of pulling in `chrono` or `time`
/// because the launcher is meant to stay tiny and dependency-light. UTC
/// epoch seconds → calendar date is a closed-form computation; civil_from_days
/// is the standard algorithm (Howard Hinnant). Tested against several known
/// timestamps in the unit tests.
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
    let ts = format_timestamp_utc(SystemTime::now());
    if let Some(path) = log_path() {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{ts} [{prefix}] {msg}");
        }
    }
    eprintln!("{ts} [{prefix}] {msg}");
}

pub fn info(msg: &str) {
    append("INFO", msg);
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
}
