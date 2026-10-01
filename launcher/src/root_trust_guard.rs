// D14: a root launcher never runs a dependencies tree another user can change.
//
// The system service runs as root and execs `<DEPS_PATH>/node/bin/node` (and,
// through Node, adb and scrcpy-server). beta.145's system install staged the
// desktop user's own dependencies into `/opt/ws-scrcpy-web/dependencies` with
// `cp -a`, which kept that user's ownership: the user could replace `node`, and
// the next service start ran it as root (qa-harness arc L3 on beta.145). The
// install no longer stages anything, but a machine installed on 145 still has
// that tree, and the running service updates itself in place without a
// reinstall. So before choosing which node to run, a root launcher checks the
// tree and, if anything in it is not exclusively root's, deletes the whole tree
// and lets the service provision it again, as root.
//
// "Exclusively root's": every entry owned by uid 0; no directory or file
// writable by group or others; no symlink whose target leaves the tree. A walk
// that fails counts as unsafe: when we cannot tell, the tree goes.
//
// D14b, the same class one file over: the ExecStart binary itself. Before its
// fix, the machine-wide update `mv`'d the user's own download into
// `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage`, keeping the user as its owner, and
// nothing reset it. `guard_opt_install` replaces a non-root-owned or
// group/other-writable `/opt` AppImage with a FRESH root-owned 0755 copy (a
// chown would leave any fd the user already holds writable) and resets VERSION.
//
// It also keeps VERSION truthful: a VERSION that names another version than the
// running `/opt` binary is rewritten to it (the system-service update swapped
// the binary without touching VERSION). A missing VERSION is left missing.
use crate::log;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

/// What the check needs to know about one entry. Built from `symlink_metadata`,
/// so a symlink is described, never followed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryMeta {
    pub path: PathBuf,
    pub uid: u32,
    pub mode: u32,
    /// The link's target as written, when the entry is a symlink.
    pub link_target: Option<PathBuf>,
}

/// Lexically normalise `p` (resolve `.` and `..` without touching the disk).
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Why `e` makes the tree under `root` unsafe for a process running as
/// `owner_uid`, or `None`. Pure. Every symlink in the tree is checked on its
/// own, so checking each one's written target lexically covers a chain.
pub fn unsafe_reason(e: &EntryMeta, root: &Path, owner_uid: u32) -> Option<String> {
    let shown = e.path.display();
    // The reason names the path, not the uid: the path is what an admin acts on.
    if e.uid != owner_uid {
        return Some(format!("{shown} has the wrong owner"));
    }
    match &e.link_target {
        Some(target) => {
            if e.path == root {
                return Some(format!("{shown} is itself a symlink"));
            }
            let base = e.path.parent().unwrap_or(root);
            let resolved = normalize(&base.join(target));
            if !resolved.starts_with(normalize(root)) {
                return Some(format!(
                    "{shown} is a symlink out of the tree, to {}",
                    target.display()
                ));
            }
            None
        }
        None if e.mode & 0o022 != 0 => Some(format!(
            "{shown} is group- or other-writable (mode {:o})",
            e.mode & 0o7777
        )),
        None => None,
    }
}

fn meta_of(path: &Path) -> std::io::Result<EntryMeta> {
    let m = std::fs::symlink_metadata(path)?;
    let link_target = if m.file_type().is_symlink() {
        Some(std::fs::read_link(path)?)
    } else {
        None
    };
    Ok(EntryMeta {
        path: path.to_path_buf(),
        uid: m.uid(),
        mode: m.mode(),
        link_target,
    })
}

/// The first reason the tree at `root` is unsafe, or `None`. Walks without
/// following symlinks. An I/O error mid-walk is returned as `Err`; the caller
/// treats it as unsafe.
pub fn find_unsafe(root: &Path, owner_uid: u32) -> std::io::Result<Option<String>> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        let e = meta_of(&path)?;
        if let Some(reason) = unsafe_reason(&e, root, owner_uid) {
            return Ok(Some(reason));
        }
        if e.link_target.is_none() && std::fs::symlink_metadata(&path)?.is_dir() {
            for child in std::fs::read_dir(&path)? {
                stack.push(child?.path());
            }
        }
    }
    Ok(None)
}

/// Run as root: delete `deps_path` when anything in it is not exclusively
/// root's, so the service re-provisions it. No-op for any other uid, and when
/// the tree does not exist. `remove_dir_all` does not follow symlinks.
pub fn guard(deps_path: &Path) {
    if !rustix::process::geteuid().is_root() {
        return;
    }
    if std::fs::symlink_metadata(deps_path).is_err() {
        return;
    }
    let reason = match find_unsafe(deps_path, 0) {
        Ok(None) => return,
        Ok(Some(r)) => r,
        Err(e) => format!("could not check {} ({e})", deps_path.display()),
    };
    log::warn(&format!(
        "root-deps-guard: removing {} before running anything from it: {reason} (D14)",
        deps_path.display()
    ));
    let removed = if std::fs::symlink_metadata(deps_path)
        .map(|m| m.file_type().is_symlink() || !m.is_dir())
        .unwrap_or(false)
    {
        std::fs::remove_file(deps_path)
    } else {
        std::fs::remove_dir_all(deps_path)
    };
    match removed {
        Ok(()) => {
            log::info("root-deps-guard: removed; the service will provision its dependencies again")
        }
        Err(e) => log::error(&format!(
            "root-deps-guard: could not remove {} ({e}); refusing to trust it",
            deps_path.display()
        )),
    }
}

/// The machine-wide install directory: the only place `guard_opt_install`
/// will ever rewrite a file. A root launcher running from anywhere else (a
/// developer build, a home AppImage under sudo) is left alone.
const OPT_DIR: &str = "/opt/ws-scrcpy-web";

/// The `/opt` AppImage this process runs from, when that is where it runs from:
/// `$APPIMAGE` exactly `/opt/ws-scrcpy-web/<name>.AppImage`, lexically
/// normalised, no deeper. Pure.
fn opt_appimage(appimage_env: Option<&str>) -> Option<PathBuf> {
    let p = normalize(Path::new(appimage_env?));
    let is_appimage = p
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("AppImage"));
    (p.parent() == Some(Path::new(OPT_DIR)) && is_appimage).then_some(p)
}

/// Replace the file at `path` with a fresh copy of its own bytes: a NEW inode
/// created by this process (so owned by its uid) with `mode`, fsynced, then
/// renamed over `path`. A running process keeps the old inode, as with every
/// other swap of the running AppImage. The temp file sits beside `path` so the
/// rename is atomic and stays in the same labelled directory.
fn replace_with_fresh_copy(path: &Path, mode: u32) -> std::io::Result<()> {
    let bytes = std::fs::read(path)?;
    write_fresh(path, &bytes, mode)
}

/// Write `bytes` to `path` as a NEW inode owned by this process, with `mode`:
/// a temp file beside it, fsynced, then renamed over it.
fn write_fresh(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".root-repair");
    let tmp = PathBuf::from(tmp);
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    // `mode` passed to open() is filtered by the umask; set it exactly.
    std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(mode))?;
    std::fs::rename(&tmp, path)
}

/// Run as root, from the `/opt` AppImage: if that binary (the system unit's
/// ExecStart) or `/opt/ws-scrcpy-web/VERSION` is not exclusively root's,
/// repair it (D14b). No-op for any other uid or install location.
pub fn guard_opt_install() {
    if !rustix::process::geteuid().is_root() {
        return;
    }
    let Some(bin) = opt_appimage(std::env::var("APPIMAGE").ok().as_deref()) else {
        return;
    };
    let opt = Path::new(OPT_DIR);
    match meta_of(&bin) {
        Ok(m) if m.link_target.is_some() => log::error(&format!(
            "root-trust-guard: {} is a symlink; not following it (D14b)",
            bin.display()
        )),
        Ok(m) => {
            if let Some(reason) = unsafe_reason(&m, opt, 0) {
                log::warn(&format!(
                    "root-trust-guard: replacing {} with a root-owned copy: {reason} (D14b)",
                    bin.display()
                ));
                match replace_with_fresh_copy(&bin, 0o755) {
                    Ok(()) => log::info(
                        "root-trust-guard: replaced; the next start runs the root-owned copy",
                    ),
                    Err(e) => log::error(&format!(
                        "root-trust-guard: could not replace {} ({e})",
                        bin.display()
                    )),
                }
            }
        }
        Err(e) => log::error(&format!(
            "root-trust-guard: could not check {} ({e})",
            bin.display()
        )),
    }
    // VERSION is data, not code: reset its owner and mode in place.
    let version = opt.join("VERSION");
    if let Ok(m) = meta_of(&version) {
        if m.link_target.is_none() && unsafe_reason(&m, opt, 0).is_some() {
            let owner = rustix::fs::chown(
                &version,
                Some(rustix::process::Uid::ROOT),
                Some(rustix::process::Gid::ROOT),
            );
            let mode = std::fs::set_permissions(
                &version,
                std::os::unix::fs::PermissionsExt::from_mode(0o644),
            );
            match (owner, mode) {
                (Ok(()), Ok(())) => {
                    log::info("root-trust-guard: reset VERSION to root:root 0644 (D14b)")
                }
                (o, p) => log::error(&format!(
                    "root-trust-guard: could not reset VERSION (chown {o:?}, chmod {p:?})"
                )),
            }
        }
        if m.link_target.is_none() {
            let recorded = std::fs::read_to_string(&version).ok();
            if let Some(v) = version_rewrite(recorded.as_deref(), env!("CARGO_PKG_VERSION")) {
                match write_fresh(&version, v.as_bytes(), 0o644) {
                    Ok(()) => log::info(&format!(
                        "root-trust-guard: VERSION read {:?}, the /opt binary is {v}; rewrote it",
                        recorded.as_deref().unwrap_or("").trim()
                    )),
                    Err(e) => log::error(&format!(
                        "root-trust-guard: could not rewrite VERSION to {v} ({e})"
                    )),
                }
            }
        }
    }
}

/// What `/opt/ws-scrcpy-web/VERSION` should be rewritten to, or `None` to leave
/// it. Called only from the `/opt` binary running as root, which is by
/// definition what `/opt` holds. Pure.
///
/// The in-app update of a system service swaps the `/opt` binary and never
/// wrote VERSION, so after one it still named the version installed before.
/// The bootstrapper (`linux_service::bootstrap_decision`) compares a home
/// AppImage against it: a home build newer than the stale VERSION but older
/// than the real binary was offered as an `/opt` update, which is a downgrade.
///
/// A missing VERSION stays missing, and so does an empty one, which the
/// bootstrapper reads as missing. A headless system install never writes one
/// and the bootstrapper then always runs the `/opt` copy; creating the file
/// here would start offering home builds as `/opt` updates on hosts that never
/// had a machine-wide desktop install.
fn version_rewrite(recorded: Option<&str>, running: &str) -> Option<String> {
    let r = recorded?.trim();
    (!r.is_empty() && r != running).then(|| running.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(path: &str, uid: u32, mode: u32, link: Option<&str>) -> EntryMeta {
        EntryMeta {
            path: PathBuf::from(path),
            uid,
            mode,
            link_target: link.map(PathBuf::from),
        }
    }

    const ROOT: &str = "/opt/ws-scrcpy-web/dependencies";

    #[test]
    fn root_owned_and_not_writable_by_others_is_safe() {
        let r = Path::new(ROOT);
        assert_eq!(unsafe_reason(&e(ROOT, 0, 0o40755, None), r, 0), None);
        assert_eq!(
            unsafe_reason(
                &e(&format!("{ROOT}/node/bin/node"), 0, 0o100755, None),
                r,
                0
            ),
            None
        );
    }

    #[test]
    fn the_beta_145_tree_is_unsafe() {
        // Measured by qa-harness: qa:qa 775 on the dir, qa:qa 755 on node.
        let r = Path::new(ROOT);
        let dir = unsafe_reason(&e(ROOT, 1000, 0o40775, None), r, 0).unwrap();
        assert!(dir.contains("wrong owner"), "{dir}");
        let node = unsafe_reason(
            &e(&format!("{ROOT}/node/bin/node"), 1000, 0o100755, None),
            r,
            0,
        );
        assert!(node.unwrap().contains("wrong owner"));
    }

    #[test]
    fn group_or_other_writable_is_unsafe_even_when_root_owned() {
        let r = Path::new(ROOT);
        for mode in [0o40775, 0o40757, 0o100664, 0o100646] {
            let why = unsafe_reason(&e(&format!("{ROOT}/x"), 0, mode, None), r, 0);
            assert!(why.unwrap().contains("writable"), "mode {mode:o}");
        }
    }

    #[test]
    fn symlinks_inside_the_tree_are_fine_and_ones_that_leave_it_are_not() {
        let r = Path::new(ROOT);
        // node's own npm link: bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js
        let npm = e(
            &format!("{ROOT}/node/bin/npm"),
            0,
            0o120777,
            Some("../lib/node_modules/npm/bin/npm-cli.js"),
        );
        assert_eq!(unsafe_reason(&npm, r, 0), None);
        for out in ["/home/qa/evil", "../../../../home/qa/evil", "../../../bin"] {
            let l = e(&format!("{ROOT}/node/bin/x"), 0, 0o120777, Some(out));
            assert!(
                unsafe_reason(&l, r, 0).unwrap().contains("out of the tree"),
                "{out}"
            );
        }
        // A symlink's own mode (0777 on Linux) is not "writable by others".
        assert_eq!(
            unsafe_reason(&e(&format!("{ROOT}/a"), 0, 0o120777, Some("b")), r, 0),
            None
        );
    }

    #[test]
    fn the_tree_root_itself_being_a_symlink_is_unsafe() {
        let r = Path::new(ROOT);
        let why = unsafe_reason(&e(ROOT, 0, 0o120777, Some("/home/qa/deps")), r, 0);
        assert!(why.unwrap().contains("itself a symlink"));
    }

    #[test]
    fn find_unsafe_walks_a_real_tree_without_following_links() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let me = rustix::process::geteuid().as_raw();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("dependencies");
        std::fs::create_dir_all(root.join("node/bin")).unwrap();
        for d in [&root, &root.join("node"), &root.join("node/bin")] {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let node = root.join("node/bin/node");
        std::fs::write(&node, b"x").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink("node", root.join("node/bin/nodejs")).unwrap();
        assert_eq!(find_unsafe(&root, me).unwrap(), None);

        // One group-writable file anywhere in the tree is enough.
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(
            find_unsafe(&root, me)
                .unwrap()
                .unwrap()
                .contains("writable")
        );
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();

        // A link out of the tree is caught, and its target is never walked.
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o777)).unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        assert!(
            find_unsafe(&root, me)
                .unwrap()
                .unwrap()
                .contains("out of the tree")
        );
    }

    // ── D14b ──

    #[test]
    fn only_the_opt_appimage_is_ever_a_repair_target() {
        assert_eq!(
            opt_appimage(Some("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage")),
            Some(PathBuf::from("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"))
        );
        for not_ours in [
            "/home/qa/Downloads/WsScrcpyWeb-linux-beta.AppImage",
            "/opt/ws-scrcpy-web/sub/WsScrcpyWeb.AppImage",
            "/opt/ws-scrcpy-web/../../etc/passwd.AppImage",
            "/opt/ws-scrcpy-web/VERSION",
            "/opt/other/WsScrcpyWeb.AppImage",
        ] {
            assert_eq!(opt_appimage(Some(not_ours)), None, "{not_ours}");
        }
        assert_eq!(opt_appimage(None), None);
    }

    #[test]
    fn the_measured_d14b_binary_is_unsafe() {
        // qa-harness L3 run 2: `-rwxr-xr-x qa qa WsScrcpyWeb.AppImage` in /opt.
        let opt = Path::new(OPT_DIR);
        let bin = e(
            "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage",
            1000,
            0o100755,
            None,
        );
        assert!(unsafe_reason(&bin, opt, 0).unwrap().contains("wrong owner"));
        let version = e("/opt/ws-scrcpy-web/VERSION", 0, 0o100664, None);
        assert!(
            unsafe_reason(&version, opt, 0)
                .unwrap()
                .contains("writable")
        );
    }

    #[test]
    fn replace_with_fresh_copy_makes_a_new_inode_with_the_same_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("WsScrcpyWeb.AppImage");
        std::fs::write(&bin, b"\x7fELF app bytes").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o775)).unwrap();
        // A writer that already holds the old file open must not reach the new one.
        let mut held = std::fs::OpenOptions::new().write(true).open(&bin).unwrap();
        let before = std::fs::metadata(&bin).unwrap().ino();

        replace_with_fresh_copy(&bin, 0o755).unwrap();

        let after = std::fs::metadata(&bin).unwrap();
        assert_ne!(
            after.ino(),
            before,
            "must be a fresh inode, not a chmod in place"
        );
        assert_eq!(after.mode() & 0o7777, 0o755);
        assert_eq!(std::fs::read(&bin).unwrap(), b"\x7fELF app bytes");
        use std::io::Write;
        held.write_all(b"EVIL").unwrap();
        assert_eq!(std::fs::read(&bin).unwrap(), b"\x7fELF app bytes");
        assert!(!dir.path().join("WsScrcpyWeb.AppImage.root-repair").exists());
    }

    // ── VERSION kept truthful ──

    #[test]
    fn a_stale_version_is_rewritten_to_the_running_opt_binary() {
        // A machine-wide install at 147, then the system service updated itself to 162.
        assert_eq!(
            version_rewrite(Some("0.1.30-beta.147"), "0.1.30-beta.162"),
            Some("0.1.30-beta.162".to_string())
        );
        // The machine-wide scripts write it with no newline; tolerate one anyway.
        assert_eq!(
            version_rewrite(Some("0.1.30-beta.162\n"), "0.1.30-beta.162"),
            None
        );
        assert_eq!(
            version_rewrite(Some("0.1.30-beta.162"), "0.1.30-beta.162"),
            None
        );
    }

    #[test]
    fn a_missing_or_empty_version_stays_that_way() {
        // A headless system install writes none; the bootstrapper then always
        // runs /opt, and creating the file would change that.
        assert_eq!(version_rewrite(None, "0.1.30-beta.162"), None);
        assert_eq!(version_rewrite(Some(""), "0.1.30-beta.162"), None);
        assert_eq!(version_rewrite(Some(" \n"), "0.1.30-beta.162"), None);
    }

    #[test]
    fn the_stale_version_offered_a_downgrade_and_the_rewrite_stops_it() {
        use crate::linux_service::{BootstrapAction, bootstrap_decision};
        let home = Some("/home/qa/Downloads/WsScrcpyWeb-linux-beta.AppImage");
        // /opt really holds 162; VERSION still says 147; the user runs a 150 home build.
        assert_eq!(
            bootstrap_decision(true, home, "0.1.30-beta.150", Some("0.1.30-beta.147")),
            BootstrapAction::RunHomeOfferUpdate,
            "the defect: 150 is offered as an /opt update over 162"
        );
        let fixed = version_rewrite(Some("0.1.30-beta.147"), "0.1.30-beta.162");
        assert!(matches!(
            bootstrap_decision(true, home, "0.1.30-beta.150", fixed.as_deref()),
            BootstrapAction::ExecOpt(_)
        ));
    }

    #[test]
    fn write_fresh_replaces_version_with_a_new_0644_inode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let version = dir.path().join("VERSION");
        std::fs::write(&version, b"0.1.30-beta.147").unwrap();
        std::fs::set_permissions(&version, std::fs::Permissions::from_mode(0o664)).unwrap();
        let before = std::fs::metadata(&version).unwrap().ino();

        write_fresh(&version, b"0.1.30-beta.162", 0o644).unwrap();

        let after = std::fs::metadata(&version).unwrap();
        assert_ne!(after.ino(), before);
        assert_eq!(after.mode() & 0o7777, 0o644);
        assert_eq!(std::fs::read(&version).unwrap(), b"0.1.30-beta.162");
        assert!(!dir.path().join("VERSION.root-repair").exists());
    }

    #[test]
    fn normalize_resolves_dot_and_dotdot_lexically() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(normalize(Path::new("/a/../../b")), PathBuf::from("/b"));
    }
}
