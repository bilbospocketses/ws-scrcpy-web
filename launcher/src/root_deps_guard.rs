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
    if e.uid != owner_uid {
        return Some(format!(
            "{shown} is owned by uid {}, not {owner_uid}",
            e.uid
        ));
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
        assert!(dir.contains("uid 1000"), "{dir}");
        let node = unsafe_reason(
            &e(&format!("{ROOT}/node/bin/node"), 1000, 0o100755, None),
            r,
            0,
        );
        assert!(node.unwrap().contains("uid 1000"));
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

    #[test]
    fn normalize_resolves_dot_and_dotdot_lexically() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
        assert_eq!(normalize(Path::new("/a/../../b")), PathBuf::from("/b"));
    }
}
