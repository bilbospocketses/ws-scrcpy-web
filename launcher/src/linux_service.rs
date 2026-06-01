// §item32 — out-of-cgroup Linux service teardown. Launched via `systemd-run`
// from the Node server so it runs in its OWN transient unit, surviving the
// stop of the service unit it tears down (the service Node lives in that
// cgroup; calling systemctl stop from there kills itself mid-call — the
// root of item 32). Mirrors the Windows operation-server/post-stop handoff.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    System,
}

/// `--user` prefix tokens for user scope, empty for system scope.
fn scope_prefix(scope: Scope) -> Vec<String> {
    match scope {
        Scope::User => vec!["--user".to_string()],
        Scope::System => vec![],
    }
}

pub fn unit_path(scope: Scope, name: &str) -> PathBuf {
    match scope {
        Scope::User => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
            PathBuf::from(home)
                .join(".config/systemd/user")
                .join(format!("{name}.service"))
        }
        Scope::System => PathBuf::from("/etc/systemd/system").join(format!("{name}.service")),
    }
}

/// Derive the sbin dir from the bin dir (`/usr/bin` -> `/usr/sbin`, `/bin` -> `/sbin`).
/// semanage/restorecon live in sbin; everything else in bin.
fn sbindir_from(bindir: &str) -> String {
    bindir
        .strip_suffix("/bin")
        .map(|p| format!("{p}/sbin"))
        .unwrap_or_else(|| bindir.to_string())
}

/// Ordered command argv-vectors for the teardown. `bindir` is the resolved
/// absolute bin dir (e.g. "/usr/bin") so we never invoke tools by bare name
/// (Local-Dependencies-Only).
pub fn teardown_commands(scope: Scope, name: &str, bindir: &str) -> Vec<Vec<String>> {
    let systemctl = format!("{bindir}/systemctl");
    let rm = format!("{bindir}/rm");
    let pre = scope_prefix(scope);
    let unit = format!("{name}.service");
    let unit_file = unit_path(scope, name);

    let mut cmds: Vec<Vec<String>> = Vec::new();
    // stop (synchronous; reaps the in-cgroup launcher+Node+children), disable, reset-failed
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["stop".into(), unit.clone()]].concat());
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["disable".into(), unit.clone()]].concat());
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["reset-failed".into(), unit.clone()]].concat());
    // remove the unit file
    cmds.push(vec![rm.clone(), "-f".into(), unit_file.to_string_lossy().into_owned()]);
    // system scope also removes the /opt staging + the semanage fcontext rule
    if scope == Scope::System {
        let semanage = format!("{}/semanage", sbindir_from(bindir));
        cmds.push(vec![rm.clone(), "-rf".into(), "/opt/ws-scrcpy-web".into()]);
        cmds.push(vec![
            semanage,
            "fcontext".into(),
            "-d".into(),
            "/opt/ws-scrcpy-web(/.*)?".into(),
        ]);
    }
    // reload
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["daemon-reload".into()]].concat());
    cmds
}

/// Parse `--scope user|system` + `--unit <name>` from argv.
pub fn parse_args(args: &[String]) -> Option<(Scope, String)> {
    let scope = args
        .iter()
        .position(|a| a == "--scope")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| match s.as_str() {
            "user" => Some(Scope::User),
            "system" => Some(Scope::System),
            _ => None,
        })?;
    let unit = args
        .iter()
        .position(|a| a == "--unit")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    Some((scope, unit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_scope_teardown_sequence() {
        let cmds = teardown_commands(Scope::User, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert!(joined[0].contains("--user stop WsScrcpyWeb.service"));
        assert!(joined.iter().any(|c| c.contains("--user disable WsScrcpyWeb.service")));
        assert!(joined.iter().any(|c| c.contains("--user reset-failed WsScrcpyWeb.service")));
        assert!(joined.iter().any(|c| c.contains("--user daemon-reload")));
        // user scope does NOT touch /opt
        assert!(!joined.iter().any(|c| c.contains("/opt/ws-scrcpy-web")));
    }

    #[test]
    fn system_scope_teardown_removes_opt_and_fcontext() {
        let cmds = teardown_commands(Scope::System, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert!(joined.iter().any(|c| c.contains("stop WsScrcpyWeb.service") && !c.contains("--user")));
        assert!(joined.iter().any(|c| c.contains("rm") && c.contains("/opt/ws-scrcpy-web")));
        assert!(joined.iter().any(|c| c.contains("semanage fcontext -d")));
    }

    #[test]
    fn unit_path_is_scope_correct() {
        assert_eq!(
            unit_path(Scope::System, "WsScrcpyWeb"),
            PathBuf::from("/etc/systemd/system/WsScrcpyWeb.service")
        );
    }

    #[test]
    fn sbindir_derivation() {
        assert_eq!(sbindir_from("/usr/bin"), "/usr/sbin");
        assert_eq!(sbindir_from("/bin"), "/sbin");
    }
}
