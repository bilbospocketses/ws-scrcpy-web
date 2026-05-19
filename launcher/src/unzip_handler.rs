// Unzip dispatch for dependency-archive extraction.
//
// The Node server's DependencyManager.installNodejs path needs to extract
// downloaded archives (Node.js + ADB platform-tools ship as zips on
// Windows and Linux). Pre-this-fix it shelled out to `powershell.exe`
// (Expand-Archive) on win32 and `unzip` on linux. Both resolved via
// system PATH — a CLAUDE.md Local-Dependencies-Only violation that §30
// missed because §30 only scrubbed the elevation path.
//
// This module replaces that with a launcher subcommand: Node spawns
// `<launcher> --unzip <src.zip> <dest-dir>`. The launcher binary is
// SHA-pinned-to-release and ships in `current/` alongside the Node
// process — same compliance posture as the §30 `--request-uac` path.
//
// Argv shape (invoked from Node):
//   ws-scrcpy-web-launcher --unzip <src-zip-path> <dest-dir>
//
// Exit codes:
//   0 = success (extraction complete)
//   2 = malformed argv (missing positional args — caller bug)
//   3 = filesystem error (source not readable, dest not creatable,
//       per-entry write failed)
//   4 = zip parse error (corrupt archive, unsupported compression)
//
// Cross-platform via the `zip` crate (pure Rust, no native deps). Default
// features dropped; only `deflate` enabled — covers every archive Node
// and the ADB platform-tools download distribute. Bzip2/lzma/zstd codecs
// excluded to keep the launcher binary small.

use std::fs::{self, File};
use std::io;
use std::path::Path;

use crate::log;

/// Public entry: if argv contains `--unzip <src> <dest>`, handle it and
/// return `Some(exit_code)`. Otherwise return None (caller proceeds to
/// normal launcher dispatch).
pub fn handle(args: &[String]) -> Option<i32> {
    let pos = args.iter().position(|a| a == "--unzip")?;
    let src = args.get(pos + 1);
    let dest = args.get(pos + 2);

    let (src, dest) = match (src, dest) {
        (Some(s), Some(d)) => (s, d),
        _ => {
            log::error("unzip: malformed argv — expected --unzip <src> <dest>");
            return Some(2);
        }
    };

    log::info(&format!("unzip: src={src} dest={dest}"));
    Some(unzip_impl(Path::new(src), Path::new(dest)))
}

fn unzip_impl(src: &Path, dest: &Path) -> i32 {
    if let Err(e) = fs::create_dir_all(dest) {
        log::error(&format!(
            "unzip: create dest dir {} failed: {e}",
            dest.display()
        ));
        return 3;
    }

    let file = match File::open(src) {
        Ok(f) => f,
        Err(e) => {
            log::error(&format!("unzip: open source {} failed: {e}", src.display()));
            return 3;
        }
    };

    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            log::error(&format!("unzip: parse archive failed: {e}"));
            return 4;
        }
    };

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                log::error(&format!("unzip: read entry {i} failed: {e}"));
                return 4;
            }
        };

        // Zip-slip defense: enclosed_name() returns None for paths that
        // would escape the destination (absolute, drive prefix, or any
        // `..` traversal). Skip those silently so a malicious archive
        // can't write outside dest.
        let rel_path = match entry.enclosed_name() {
            Some(p) => p,
            None => {
                log::error(&format!(
                    "unzip: skipping unsafe entry name: {}",
                    entry.name()
                ));
                continue;
            }
        };

        let out_path = dest.join(&rel_path);

        if entry.is_dir() {
            if let Err(e) = fs::create_dir_all(&out_path) {
                log::error(&format!(
                    "unzip: mkdir {} failed: {e}",
                    out_path.display()
                ));
                return 3;
            }
        } else {
            if let Some(parent) = out_path.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    log::error(&format!(
                        "unzip: mkdir-parent {} failed: {e}",
                        parent.display()
                    ));
                    return 3;
                }
            }
            let mut out_file = match File::create(&out_path) {
                Ok(f) => f,
                Err(e) => {
                    log::error(&format!(
                        "unzip: create {} failed: {e}",
                        out_path.display()
                    ));
                    return 3;
                }
            };
            if let Err(e) = io::copy(&mut entry, &mut out_file) {
                log::error(&format!(
                    "unzip: write {} failed: {e}",
                    out_path.display()
                ));
                return 3;
            }
        }

        // Preserve Unix executable bit. ADB platform-tools on Linux
        // ships with `adb` marked +x in the zip; without this the
        // extracted binary won't run.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(mode));
            }
        }
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args = vec!["launcher.exe".to_string()];
        assert_eq!(handle(&args), None);
    }

    #[test]
    fn handle_returns_2_when_args_missing_after_flag() {
        let args = vec!["launcher.exe".to_string(), "--unzip".to_string()];
        assert_eq!(handle(&args), Some(2));
    }

    #[test]
    fn handle_returns_2_when_only_src_given() {
        let args = vec![
            "launcher.exe".to_string(),
            "--unzip".to_string(),
            "src.zip".to_string(),
        ];
        assert_eq!(handle(&args), Some(2));
    }

    #[test]
    fn handle_returns_3_when_source_does_not_exist() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("nonexistent.zip");
        let dest = tmp.path().join("out");
        let args = vec![
            "launcher.exe".to_string(),
            "--unzip".to_string(),
            src.to_string_lossy().to_string(),
            dest.to_string_lossy().to_string(),
        ];
        // dispatch fires, file-open fails → exit 3
        assert_eq!(handle(&args), Some(3));
    }
}
