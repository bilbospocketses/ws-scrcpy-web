// Windows in-app uninstall helper (beta.49 parity).
//
// `windows_app_uninstall_commands` returns an `UninstallPlan` with:
//   - `update_exe_step`: the `[update_exe, "--uninstall"]` argv-vector.
//     Running this triggers Velopack's uninstaller, which removes the
//     Program Files install AND fires the launcher's `--veloapp-uninstall`
//     hook → stops/uninstalls the WsScrcpyWeb service + kills the tray +
//     ARP cleanup.
//   - `data_root_targets`: the dataRoot (`%ProgramData%\WsScrcpyWeb`) paths
//     to remove after Update.exe completes:
//       keep=true  → ["<data_root>\\dependencies", "<data_root>\\bin",
//                     "<data_root>\\control"] (deps/regenerable only;
//                     config.json + logs preserved)
//       keep=false → ["<data_root>"] (the whole root)
//
// Dispatch (`handle`): owns `--windows-app-uninstall`. Runs Update.exe via
// `std::process::Command` (the absolute path supplied by the caller — no
// PATH, no env-var). Removes each dataRoot target with `remove_tree_collecting`,
// a depth-first walk that CONTINUES past failures and reports what it could not
// remove. Best-effort: logs + continues on errors (the app is being uninstalled
// regardless).
//
// Items 131 + 130 (the residue path). The delete used to be
// `std::fs::remove_dir_all`, which aborts on the first error, so one running
// `adb.exe` — true for anyone who has connected a device this session — left
// 2315 files behind, `logs\` and `wsscrcpy.db*` among them, and the app still
// reported a clean wipe. The cleaner now: reaps the bundled adb first, deletes
// what it can, registers whatever still survives for delete-on-reboot, writes a
// residue report NEXT TO (never inside) the data root, and finally registers its
// own staged temp copy the same way — Windows cannot delete a running image, and
// nothing else was ever going to remove it.
//
// Local-Dependencies-Only: Update.exe is the absolute path argument, adb is the
// copy bundled under dataRoot, and dataRoot deletion + delete-on-reboot are
// `std::fs` and Win32 compiled into the binary. No bare cmd/rmdir/powershell on
// PATH — notably NOT the usual `cmd /c del` self-delete trick, which would
// resolve a binary off PATH.

use crate::log;

/// Ordered uninstall plan for the Windows path.
///
/// Kept as a named struct (mirroring linux_app_uninstall's `UninstallPlan`)
/// so callers can inspect the two distinct groups independently — the
/// Update.exe step and the dataRoot deletion targets — which the tests
/// assert on separately.
#[derive(Debug, Clone)]
pub struct UninstallPlan {
    /// The single Update.exe invocation: `[update_exe, "--uninstall"]`.
    /// Always exactly one entry. Run FIRST so Velopack's uninstaller fires
    /// the `--veloapp-uninstall` hook (service/tray teardown + ARP cleanup)
    /// before we touch the dataRoot.
    pub update_exe_step: Vec<String>,
    /// dataRoot filesystem targets to remove after Update.exe completes.
    /// `keep=false` → `["<data_root>"]`; `keep=true` →
    /// `["<data_root>\\dependencies", "<data_root>\\bin", "<data_root>\\control"]`.
    pub data_root_targets: Vec<String>,
}

/// Build the uninstall plan. Pure — no I/O, fully unit-testable.
///
/// * `update_exe`  — absolute path to `<installRoot>\Update.exe`.
/// * `data_root`   — absolute path to the app data root
///   (`%ProgramData%\WsScrcpyWeb`).
/// * `keep`        — `true` preserves config.json + logs/ (deletes only
///   deps/bin/control); `false` wipes the whole data root.
pub fn windows_app_uninstall_commands(
    update_exe: &str,
    data_root: &str,
    keep: bool,
) -> UninstallPlan {
    let update_exe_step = vec![update_exe.to_string(), "--uninstall".to_string()];

    let data_root_targets = if keep {
        ["dependencies", "bin", "control"]
            .iter()
            .map(|sub| format!("{}\\{}", data_root, sub))
            .collect()
    } else {
        vec![data_root.to_string()]
    };

    UninstallPlan { update_exe_step, data_root_targets }
}

// ─── MSI uninstall (#120) ──────────────────────────────────────────────────
//
// Every Windows install of this app is the MSI, and Velopack 1.2.0 REFUSES to
// uninstall one: `Update.exe --uninstall` writes "Uninstall error: MSI
// installation detected. Uninstall should be performed via msiexec, not
// Update.exe." to its own log and exits, having removed nothing. Measured
// 2026-09-09 by qa-harness Arc 4 on two fresh Windows 11 guests. Because the
// old code treated that step as best-effort and deleted the dataRoot anyway,
// the user was left with the app still installed and its dependencies (keep)
// or its whole configuration (wipe) gone.
//
// So on an MSI install we uninstall the way Windows itself would: msiexec with
// the ProductCode. Local-Dependencies-Only: absolute path, never PATH.

/// `msiexec.exe` by absolute path. Same reasoning, and same literal shape, as
/// the `C:\Windows\System32\cmd.exe` this repo already pins in
/// `elevated_runner.rs` — OS-stable, and an env var would be a forbidden
/// resolution path under the same rule.
pub const MSIEXEC_PATH: &str = r"C:\Windows\System32\msiexec.exe";

/// Does this ARP entry look like the product we are uninstalling?
///
/// Matched on DisplayName, case-insensitively, allowing the optional hyphens
/// the name is written with in different places (`ws-scrcpy-web`,
/// `WsScrcpyWeb`) — the same `^ws-?scrcpy-?web` shape the QA suite matches on.
/// Deliberately NOT matched on the key name: see
/// `product_code_from_uninstall_string`.
pub fn arp_display_name_matches(display_name: &str) -> bool {
    let squashed: String = display_name
        .chars()
        .filter(|c| *c != '-' && *c != '_' && *c != ' ')
        .flat_map(char::to_lowercase)
        .collect();
    squashed.starts_with("wsscrcpyweb")
}

/// Pull the MSI ProductCode out of an ARP `UninstallString`.
///
/// **The GUID comes from the UninstallString, not from the key name.** Measured
/// 2026-09-08: this app's ARP key is literally `MSI:WsScrcpyWeb` (Velopack names
/// it that), while the product code lives inside
/// `msiexec.exe /x {EF20C75C-…}`. Reading the key leaf is the same class of
/// mistake as hardcoding an install path — it assumes a shape the artifact is
/// free to change. The UninstallString is what Windows itself runs, so it is the
/// authoritative source; `product_code_from_key_leaf` is the fallback for
/// installers that DO name the key after the product code.
pub fn product_code_from_uninstall_string(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let open = bytes.iter().position(|b| *b == b'{')?;
    let close = open + 1 + bytes[open + 1..].iter().position(|b| *b == b'}')?;
    let candidate = &s[open..=close];
    if is_product_code(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// Fallback: the ARP key's own leaf, when the installer named it after the
/// product code. Returns None for a leaf like `MSI:WsScrcpyWeb`.
pub fn product_code_from_key_leaf(leaf: &str) -> Option<String> {
    if is_product_code(leaf) {
        Some(leaf.to_string())
    } else {
        None
    }
}

/// `{8-4-4-4-12}` hex with braces — the Windows Installer ProductCode shape.
fn is_product_code(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 38 || b[0] != b'{' || b[37] != b'}' {
        return false;
    }
    for (i, ch) in s[1..37].bytes().enumerate() {
        let expect_dash = matches!(i, 8 | 13 | 18 | 23);
        if expect_dash {
            if ch != b'-' {
                return false;
            }
        } else if !ch.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// The msiexec argv that removes `product_code` without UI.
///
/// `/qn` because the user already confirmed in the app's own modal, and this
/// runs after the server has answered and exited — there is no window left to
/// host an installer UI. `/norestart` because an uninstall must never reboot
/// the machine out from under the user.
pub fn msi_uninstall_step(product_code: &str) -> Vec<String> {
    vec![
        MSIEXEC_PATH.to_string(),
        "/x".to_string(),
        product_code.to_string(),
        "/qn".to_string(),
        "/norestart".to_string(),
    ]
}

/// Which msiexec exit codes mean the product was removed.
///
/// Not just 0. `3010` is "success, a reboot is required" and `1641` is
/// "success, a reboot was initiated" — both mean the uninstall itself
/// succeeded, and treating them as failure would leave the dataRoot behind on a
/// machine where the app is already gone.
pub fn msiexec_exit_is_success(code: i32) -> bool {
    matches!(code, 0 | 3010 | 1641)
}

/// Find this app's MSI ProductCode by walking the Add/Remove Programs entries.
///
/// DISCOVERED, NOT HARDCODED — the same rule the QA suite records for the same
/// reason: a lookup that hardcodes what the artifact should be cannot notice the
/// artifact moving. (#610 is the local precedent: the MSI silently moved to the
/// drive root and the path table was "fixed" to match the wrong location.) So we
/// search all three ARP views for an entry whose DisplayName is ours AND which
/// is a Windows Installer product, then take the GUID out of its
/// `UninstallString`.
///
/// Returns None when there is no MSI entry — a from-source or non-MSI install —
/// and the caller then falls back to `Update.exe --uninstall`, which is correct
/// for exactly that case.
#[cfg(windows)]
pub fn find_msi_product_code() -> Option<String> {
    use windows::Win32::System::Registry::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    };

    const ARP_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    // Both machine views matter: which one carries the entry depends on the
    // package's bitness, not ours. HKCU last — a per-user install is the least
    // likely shape for this app, which installs per-machine.
    let roots = [
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY.0),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY.0),
        (HKEY_CURRENT_USER, 0u32),
    ];

    for (root, view) in roots {
        let Some(arp) = reg_open(root, ARP_SUBKEY, view) else {
            continue;
        };
        for leaf in reg_enum_subkeys(&arp) {
            // Relative to the ARP key we already hold, not the full path again.
            let Some(entry) = reg_open(arp.0, &leaf, view) else {
                continue;
            };
            let display = reg_read_string(&entry, "DisplayName").unwrap_or_default();
            if !arp_display_name_matches(&display) {
                continue;
            }
            let uninstall_string = reg_read_string(&entry, "UninstallString").unwrap_or_default();
            // "Is this an MSI product?" — either the string invokes msiexec, or
            // the entry carries the WindowsInstaller flag. Velopack writes BOTH
            // an MSI entry and its own; only the MSI one can be msiexec'd.
            let is_msi = uninstall_string.to_ascii_lowercase().contains("msiexec")
                || reg_read_string(&entry, "WindowsInstaller").as_deref() == Some("1");
            if !is_msi {
                continue;
            }
            if let Some(code) = product_code_from_uninstall_string(&uninstall_string)
                .or_else(|| product_code_from_key_leaf(&leaf))
            {
                log::info(&format!(
                    "windows-app-uninstall: MSI product {code} from ARP entry {leaf:?} ({display:?})"
                ));
                return Some(code);
            }
        }
    }
    None
}

/// An owned registry handle that closes itself.
#[cfg(windows)]
struct RegKey(windows::Win32::System::Registry::HKEY);

#[cfg(windows)]
impl Drop for RegKey {
    fn drop(&mut self) {
        // SAFETY: self.0 came from a successful RegOpenKeyExW and is closed once.
        unsafe {
            let _ = windows::Win32::System::Registry::RegCloseKey(self.0);
        }
    }
}

#[cfg(windows)]
fn reg_open(root: windows::Win32::System::Registry::HKEY, subkey: &str, view: u32) -> Option<RegKey> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegOpenKeyExW, HKEY, KEY_READ, REG_SAM_FLAGS};

    let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out = HKEY::default();
    // SAFETY: `wide` is NUL-terminated and outlives the call; `out` is a valid
    // out-param. Read-only access, so nothing is mutated in the registry.
    let rc = unsafe {
        RegOpenKeyExW(
            root,
            PCWSTR(wide.as_ptr()),
            0,
            REG_SAM_FLAGS(KEY_READ.0 | view),
            &mut out,
        )
    };
    (rc == ERROR_SUCCESS).then_some(RegKey(out))
}

/// Names of the immediate subkeys of `key`.
#[cfg(windows)]
fn reg_enum_subkeys(key: &RegKey) -> Vec<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::RegEnumKeyExW;

    let mut names = Vec::new();
    // 256 is the documented maximum registry key-name length; +1 for the NUL.
    let mut buf = [0u16; 257];
    for index in 0.. {
        let mut len = buf.len() as u32;
        // SAFETY: buf/len describe the same buffer, and len is reset every
        // iteration because RegEnumKeyExW overwrites it with the name length.
        let rc = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
                None,
                PWSTR::null(),
                None,
                None,
            )
        };
        if rc != ERROR_SUCCESS {
            break; // ERROR_NO_MORE_ITEMS, or anything else — stop either way.
        }
        names.push(String::from_utf16_lossy(&buf[..len as usize]));
    }
    names
}

/// Read a value as a string. `REG_DWORD` is rendered as its decimal digits so
/// callers can compare `WindowsInstaller` against "1" without a second reader.
#[cfg(windows)]
fn reg_read_string(key: &RegKey, value: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegQueryValueExW, REG_DWORD, REG_VALUE_TYPE};

    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut kind = REG_VALUE_TYPE::default();
    let mut size: u32 = 0;
    // First call sizes the buffer.
    // SAFETY: passing None for the data pointer with a live size out-param is
    // the documented way to ask RegQueryValueExW how many bytes it needs.
    let rc = unsafe {
        RegQueryValueExW(key.0, PCWSTR(wide.as_ptr()), None, Some(&mut kind), None, Some(&mut size))
    };
    if rc != ERROR_SUCCESS || size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    // SAFETY: `data` is exactly `size` bytes, which is what the sizing call asked for.
    let rc = unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(data.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    if kind == REG_DWORD {
        if data.len() < 4 {
            return None;
        }
        let n = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        return Some(n.to_string());
    }
    // REG_SZ / REG_EXPAND_SZ: UTF-16, possibly NUL-terminated.
    let units: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .take_while(|u| *u != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

// ─── Dispatch + execution ──────────────────────────────────────────────────

/// Parsed `--windows-app-uninstall` invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallArgs {
    pub update_exe: String,
    pub data_root: String,
    pub keep: bool,
}

/// Parse `--windows-app-uninstall` flags.
///
/// Flags:
///   `--windows-app-uninstall`   — presence marker (required in caller's argv)
///   `--update-exe <abs path>`   — absolute path to Update.exe (required)
///   `--data-root  <abs path>`   — absolute path to the data root (required)
///   exactly one of `--keep` / `--wipe`   — scope selector (required)
///
/// Returns `None` on any missing/invalid input (mirrors linux's parse_args
/// validation contract). Returning `None` signals the caller to log an error
/// and return exit code 2.
pub fn parse_args(args: &[String]) -> Option<UninstallArgs> {
    let keep = parse_keep_flag(args)?;
    let data_root = flag_value(args, "--data-root")?;
    let update_exe = flag_value(args, "--update-exe")?;

    Some(UninstallArgs { update_exe, data_root, keep })
}

/// Exactly one of `--keep` / `--wipe`. `Some(true)` = keep, `Some(false)` =
/// wipe, `None` if neither or both are present (invalid).
fn parse_keep_flag(args: &[String]) -> Option<bool> {
    match (
        args.iter().any(|a| a == "--keep"),
        args.iter().any(|a| a == "--wipe"),
    ) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        _ => None,
    }
}

/// Value following `flag` in `args` (e.g. the path after `--data-root`).
/// `None` if the flag is absent or has no following value.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// Parsed `--windows-app-uninstall-run` invocation (the Phase-2 cleaner).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunArgs {
    pub wait_pid: u32,
    pub update_exe: String,
    pub data_root: String,
    pub keep: bool,
}

/// Build the Phase-2 argv the bootstrapper passes to the temp copy. Returns
/// the args WITHOUT argv[0]; the caller does `Command::new(temp_exe).args(..)`.
/// Always includes `--no-log` so the cleaner never writes into the data root.
pub fn build_run_args(wait_pid: u32, keep: bool, data_root: &str, update_exe: &str) -> Vec<String> {
    vec![
        "--windows-app-uninstall-run".to_string(),
        "--wait-pid".to_string(),
        wait_pid.to_string(),
        "--no-log".to_string(),
        if keep { "--keep" } else { "--wipe" }.to_string(),
        "--data-root".to_string(),
        data_root.to_string(),
        "--update-exe".to_string(),
        update_exe.to_string(),
    ]
}

/// Parse `--windows-app-uninstall-run` flags. `None` on absence/invalid input
/// (mirrors `parse_args`). Requires the run flag, a numeric `--wait-pid`,
/// `--data-root`, `--update-exe`, and exactly one of `--keep`/`--wipe`.
pub fn parse_run_args(args: &[String]) -> Option<RunArgs> {
    if !args.iter().any(|a| a == "--windows-app-uninstall-run") {
        return None;
    }
    let keep = parse_keep_flag(args)?;
    let wait_pid = flag_value(args, "--wait-pid").and_then(|s| s.parse::<u32>().ok())?;
    let data_root = flag_value(args, "--data-root")?;
    let update_exe = flag_value(args, "--update-exe")?;
    Some(RunArgs { wait_pid, update_exe, data_root, keep })
}

/// Filename for the temp copy of the launcher that performs the dataRoot
/// deletion. PID-stamped so a retried/concurrent uninstall never collides.
pub fn temp_copy_filename(pid: u32) -> String {
    format!("{TEMP_COPY_PREFIX}{pid}.exe")
}

/// Shared by `temp_copy_filename` and `is_staged_copy` so the name we stage and
/// the name we later schedule for deletion can never drift apart.
const TEMP_COPY_PREFIX: &str = "ws-scrcpy-web-uninstall-";

/// Is `exe` a cleaner copy WE staged?
///
/// Item 130 registers the running cleaner for delete-on-reboot, and
/// `--windows-app-uninstall-run` is a public flag — run it by hand from the
/// install tree without this guard and a perfectly good launcher gets scheduled
/// for deletion at the next boot. The installed binary is
/// `ws-scrcpy-web-launcher.exe` and never carries this prefix.
///
/// Matched on the filename WE stamp, not on the directory. The staging directory
/// is whatever `GetTempPath2W` returned and `current_exe()` reports whatever
/// casing the loader resolved; comparing those two with `Path`'s case-sensitive
/// equality would be a coin-flip whose only symptom is item 130 quietly staying
/// broken. The name is the half we control.
fn is_staged_copy(exe: &std::path::Path) -> bool {
    exe.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| {
            n.to_ascii_lowercase()
                .starts_with(&TEMP_COPY_PREFIX.to_ascii_lowercase())
        })
}

/// Does the staged cleaner need an elevated token?
///
/// Removing a per-machine MSI requires one. Without it `msiexec /x` answers
/// *"Error 1730. You must be an Administrator to remove this application."* and
/// the in-app uninstall silently does nothing — which is what it had been doing
/// on every Windows install of this app (item 128; qa-harness Arc 4 measured it
/// on beta.119, twice, the second run on an idle host to rule out contention).
///
/// Both guards matter. A non-MSI install is Velopack's per-user layout under
/// `%LocalAppData%`, where `Update.exe` needs no admin, so prompting would be a
/// UAC dialog asking for nothing. And a process that is ALREADY elevated must
/// not be sent through UAC a second time.
pub fn cleaner_needs_elevation(is_msi_install: bool, already_elevated: bool) -> bool {
    is_msi_install && !already_elevated
}

/// Build the single command line `ShellExecuteExW` hands to the child.
///
/// Unlike `Command::args`, which passes an argv vector, ShellExecuteExW takes
/// one string that the child re-parses with `CommandLineToArgvW`. Every
/// argument is therefore quoted: the real ones are paths like
/// `C:\Program Files\WsScrcpyWeb\Update.exe` and `C:\ProgramData\WsScrcpyWeb`,
/// and an unquoted join would split one argument into several — the cleaner
/// would then fail `parse_run_args` and exit 2 having removed nothing.
///
/// Embedded double quotes are escaped. Nothing we build contains one today
/// (they are our own flags plus OS paths), but a malformed command line is
/// exactly the class of defect that only ever shows up on someone else's
/// machine.
pub fn shell_execute_parameters(args: &[String]) -> String {
    args.iter()
        .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// How the elevated hand-off ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElevationResult {
    /// UAC accepted; the elevated cleaner is running and owns the outcome.
    Started,
    /// The user clicked No. Nothing was uninstalled and nothing was deleted.
    Declined,
    /// ShellExecuteExW failed for another reason (admin-approval mode off,
    /// policy, a broken association). Caller falls back to the in-place path,
    /// which fails safely and says so.
    Failed,
}

/// `ERROR_CANCELLED` as an exit code — what a declined UAC prompt reports.
///
/// The same number Windows itself uses, so an operator reading the log can look
/// it up. Deliberately NOT 0: nothing was uninstalled, and a bootstrap that
/// reported success here would be telling the caller the app is gone while it is
/// still installed — the exact class of lie item 120 was filed for.
pub const EXIT_UAC_DECLINED: i32 = 1223;

/// Exit code for a bootstrap whose elevation attempt ended this way.
///
/// `Failed` is absent by design: the caller routes it to the in-place fallback
/// rather than returning a code here, so its exit is that path's verdict.
pub fn bootstrap_exit_for(result: ElevationResult) -> i32 {
    match result {
        ElevationResult::Started => 0,
        ElevationResult::Declined => EXIT_UAC_DECLINED,
        ElevationResult::Failed => 1,
    }
}

/// Is THIS process running with an elevated token?
///
/// Fails closed to `false`, which means "assume we need to ask". That is the
/// safe direction: a redundant `runas` from an already-elevated process simply
/// runs the child with no prompt, whereas skipping a needed elevation is the
/// bug this whole change exists to fix.
#[cfg(windows)]
fn is_process_elevated() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = Default::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

/// Spawn the staged cleaner WITH an elevated token, via the same
/// `ShellExecuteExW(verb="runas")` mechanism `uac_requester.rs` already uses for
/// the service install/uninstall flow (§30 chose it over
/// `powershell.exe Start-Process -Verb RunAs` for Local-Dependencies-Only
/// compliance; reusing it inherits that rather than opening a new hole).
///
/// The prompt fires HERE, in phase 1, while the app the user just clicked is
/// still alive — not from a detached temp binary after it has vanished, which is
/// what a user would reasonably read as malware.
///
/// Considered and rejected: elevating `msiexec.exe` alone. Its UAC dialog would
/// name Microsoft's binary, which looks more trustworthy, but the exit code then
/// has to be plumbed back across the elevation boundary, and the data-root
/// deletion would stay on the unelevated token. Elevating the cleaner keeps one
/// process owning the whole sequence. Item 128 records the choice.
#[cfg(windows)]
fn spawn_cleaner_elevated(
    exe: &std::path::Path,
    run_args: &[String],
    working_dir: &std::path::Path,
) -> ElevationResult {
    use windows::Win32::UI::Shell::{SHELLEXECUTEINFOW, ShellExecuteExW};
    use windows::core::PCWSTR;

    // HRESULT_FROM_WIN32(ERROR_CANCELLED) — what ShellExecuteExW surfaces when
    // the user clicks No on the prompt.
    const HRESULT_ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;

    let verb = crate::win_util::to_wide("runas");
    let file = crate::win_util::to_wide(&exe.to_string_lossy());
    let params = crate::win_util::to_wide(&shell_execute_parameters(run_args));
    // CWD in temp, never under the data root — the property the unelevated
    // spawn already had via `.current_dir()`, preserved here through
    // lpDirectory. A CWD under the data root would hold a handle on the very
    // tree the cleaner is about to delete.
    let dir = crate::win_util::to_wide(&working_dir.to_string_lossy());

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: 0,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        lpDirectory: PCWSTR(dir.as_ptr()),
        nShow: 0, // SW_HIDE — no console flash for the elevated child
        ..Default::default()
    };

    // SAFETY: SHELLEXECUTEINFOW is fully populated above and every PCWSTR
    // points at a wide-string local that outlives the call.
    match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => ElevationResult::Started,
        Err(e) if e.code().0 == HRESULT_ERROR_CANCELLED => ElevationResult::Declined,
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: elevated spawn failed: {e}"
            ));
            ElevationResult::Failed
        }
    }
}

/// Dispatch `--windows-app-uninstall`. Returns `Some(exit_code)` when it
/// owns the invocation, `None` to let the next dispatcher try.
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--windows-app-uninstall") {
        return None;
    }
    let a = match parse_args(args) {
        Some(v) => v,
        None => {
            log::error("windows-app-uninstall: missing/invalid args");
            return Some(2);
        }
    };
    Some(run_bootstrap(&a))
}

/// Run `Update.exe --uninstall` (Velopack: Program Files + ARP + the
/// --veloapp-uninstall service/tray hook). `update_exe_step` is the argv the
/// builder produced (`[update_exe, "--uninstall"]`). Best-effort: logs (if
/// logging is enabled) and returns regardless — the app is being removed
/// either way. Local-Dependencies-Only: absolute path, no PATH resolution.
fn run_update_exe(update_exe_step: &[String]) -> bool {
    let (cmd, rest) = update_exe_step
        .split_first()
        .expect("update_exe_step is always non-empty");
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) if s.success() => {
            log::info(&format!(
                "windows-app-uninstall: Update.exe ok ({})",
                update_exe_step.join(" ")
            ));
            true
        }
        Ok(s) => {
            log::error(&format!(
                "windows-app-uninstall: Update.exe non-zero ({:?}): {}",
                s.code(),
                update_exe_step.join(" ")
            ));
            false
        }
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: Update.exe spawn failed: {} ({e})",
                update_exe_step.join(" ")
            ));
            false
        }
    }
}

/// Run msiexec and judge the result by Windows Installer's own success codes.
fn run_msiexec(step: &[String]) -> bool {
    let (cmd, rest) = step.split_first().expect("msi step is always non-empty");
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) => {
            let code = s.code().unwrap_or(-1);
            if msiexec_exit_is_success(code) {
                log::info(&format!(
                    "windows-app-uninstall: msiexec ok (exit {code}): {}",
                    step.join(" ")
                ));
                true
            } else {
                log::error(&format!(
                    "windows-app-uninstall: msiexec FAILED (exit {code}): {}",
                    step.join(" ")
                ));
                false
            }
        }
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: msiexec spawn failed: {} ({e})",
                step.join(" ")
            ));
            false
        }
    }
}

/// Remove the installed application, and report whether it actually went.
///
/// MSI first, because every Windows install of this app is one and Velopack
/// refuses to uninstall those (#120). `Update.exe --uninstall` remains the path
/// for a non-MSI install, which is what an absent ARP entry means.
///
/// The return value is the whole point: the caller must not delete anything
/// when this is false. Before #120 this was best-effort on the premise that
/// "the app is being removed regardless" — a premise that had been false on
/// every Windows install since the MSI-only artifact landed.
#[cfg(windows)]
fn perform_uninstall(update_exe_step: &[String]) -> bool {
    match find_msi_product_code() {
        Some(code) => run_msiexec(&msi_uninstall_step(&code)),
        None => {
            log::info("windows-app-uninstall: no MSI ARP entry; falling back to Update.exe");
            run_update_exe(update_exe_step)
        }
    }
}

#[cfg(not(windows))]
fn perform_uninstall(update_exe_step: &[String]) -> bool {
    run_update_exe(update_exe_step)
}

/// Depth-first removal that CONTINUES past failures, pushing every path it
/// could not remove onto `failures` — children before their parents.
///
/// That order is not cosmetic. `MoveFileEx` delete-on-reboot processes its queue
/// in order and cannot remove a directory that still has contents, so listing a
/// parent before its children would leave the parent behind forever.
///
/// Item 131: this replaces `std::fs::remove_dir_all`, which aborts on the FIRST
/// error. One running `adb.exe` therefore cost the entire tree — 2315 files,
/// including `logs\` and `wsscrcpy.db*`, which nothing was holding.
fn remove_tree_collecting(path: &std::path::Path, failures: &mut Vec<String>) {
    // symlink_metadata does not follow links, so a symlinked directory lands in
    // the file branch below and is removed as a LINK. Following it would delete
    // a tree we were never asked to touch.
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        // Already gone: nothing to remove, and nothing to report.
        Err(_) => return,
    };

    if meta.is_dir() {
        // An unreadable directory still gets its removal attempted below; the
        // remove_dir is what decides whether it becomes a survivor.
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                remove_tree_collecting(&entry.path(), failures);
            }
        }
        if std::fs::remove_dir(path).is_err() {
            failures.push(path.to_string_lossy().into_owned());
        }
        return;
    }

    if std::fs::remove_file(path).is_err() {
        // A symlink pointing at a directory needs remove_dir on Windows.
        if std::fs::remove_dir(path).is_err() {
            failures.push(path.to_string_lossy().into_owned());
        }
    }
}

/// Remove each dataRoot target via std::fs (compiled-in; no PATH tools),
/// retrying up to `attempts` times with a 500ms delay between tries to absorb
/// residual handle-release lag (e.g. the originating helper exiting).
///
/// Returns every path it could not remove, children before parents. Best-effort
/// throughout: it logs and continues, and an empty return means the targets are
/// genuinely gone — which is what lets the caller stop asserting a wipe it did
/// not perform (item 131, item 120's class).
fn remove_targets(targets: &[String], attempts: u32) -> Vec<String> {
    let attempts = attempts.max(1);
    let mut survivors: Vec<String> = Vec::new();
    for target in targets {
        let path = std::path::Path::new(target);
        let mut failures: Vec<String> = Vec::new();
        let mut existed = false;
        for attempt in 0..attempts {
            failures.clear();
            if !path.exists() {
                break;
            }
            existed = true;
            remove_tree_collecting(path, &mut failures);
            if failures.is_empty() {
                break;
            }
            if attempt + 1 < attempts {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
        if failures.is_empty() {
            if existed {
                log::info(&format!("windows-app-uninstall: removed {target}"));
            } else {
                log::info(&format!(
                    "windows-app-uninstall: {target} already absent — nothing to remove"
                ));
            }
        } else {
            log::error(&format!(
                "windows-app-uninstall: {} path(s) under {target} could not be removed",
                failures.len()
            ));
            survivors.append(&mut failures);
        }
    }
    survivors
}

/// What the pre-delete adb reap did. Recorded verbatim in the residue report:
/// for anyone reading it, "we never even tried" and "we tried and something
/// else holds the tree" are different problems.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdbReap {
    /// No bundled adb on disk — nothing to reap.
    Absent,
    /// `adb kill-server` ran and reported success.
    Reaped,
    /// `adb kill-server` could not be run, or exited non-zero.
    Failed,
}

impl AdbReap {
    fn describe(self) -> &'static str {
        match self {
            AdbReap::Absent => "no bundled adb on disk — nothing to reap",
            AdbReap::Reaped => "kill-server ok",
            AdbReap::Failed => "kill-server failed — the data root may still be locked",
        }
    }
}

/// The bundled adb, inside the tree we are about to delete.
///
/// Local-Dependencies-Only: never a PATH lookup. A system-installed adb is a
/// different binary holding none of our files, and reaping it would stop a
/// server this app never started.
fn bundled_adb_path(data_root: &str) -> std::path::PathBuf {
    std::path::Path::new(data_root)
        .join("dependencies")
        .join("adb")
        .join("adb.exe")
}

/// Where the residue report goes: a SIBLING of the data root, e.g.
/// `C:\ProgramData\WsScrcpyWeb-uninstall-report.txt`.
///
/// Never inside the data root. Writing there would re-create the tree we just
/// wiped — which is exactly how #120 resurrected a 74-byte `launcher.log`.
/// `None` when the data root has no parent or no name to build from.
fn residue_report_path(data_root: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(data_root);
    let name = path.file_name()?;
    let parent = path.parent()?;
    let mut filename = name.to_os_string();
    filename.push("-uninstall-report.txt");
    Some(parent.join(filename))
}

/// Filename used when the sibling path cannot be written (see `write_residue_report`).
const RESIDUE_REPORT_FALLBACK_NAME: &str = "ws-scrcpy-web-uninstall-report.txt";

/// How many survivor paths the report lists before truncating. The measured
/// real number is 2315; a report nobody opens is no better than no report.
const RESIDUE_REPORT_MAX_LISTED: usize = 40;

/// The residue report body. Pure — the caller supplies the timestamp.
fn format_residue_report(
    timestamp: &str,
    keep: bool,
    reap: AdbReap,
    survivors: &[String],
) -> String {
    let scope = if keep { "--keep" } else { "--wipe" };
    let mut out = format!("ws-scrcpy-web uninstall {timestamp} UTC ({scope})\n");
    out.push_str(&format!("adb reap: {}\n", reap.describe()));
    out.push_str(&format!(
        "could not remove {} path(s); each is registered for deletion at the next reboot:\n",
        survivors.len()
    ));
    for path in survivors.iter().take(RESIDUE_REPORT_MAX_LISTED) {
        out.push_str(&format!("  {path}\n"));
    }
    if let Some(extra) = survivors.len().checked_sub(RESIDUE_REPORT_MAX_LISTED) {
        if extra > 0 {
            out.push_str(&format!("  … and {extra} more\n"));
        }
    }
    out
}

/// The report body, or `None` when nothing survived.
///
/// The file's PRESENCE is the signal. Writing "nothing survived" after every
/// clean uninstall would leave litter of its own — item 130's whole complaint.
fn residue_report_body(
    timestamp: &str,
    keep: bool,
    reap: AdbReap,
    survivors: &[String],
) -> Option<String> {
    if survivors.is_empty() {
        return None;
    }
    Some(format_residue_report(timestamp, keep, reap, survivors))
}

/// Register `path` for deletion at the next boot.
///
/// `MoveFileExW` with a NULL destination and `MOVEFILE_DELAY_UNTIL_REBOOT` is
/// the documented way to remove a file that is still open — here, files another
/// process holds, and (item 130) the cleaner itself. Pure Win32 through the
/// `windows` crate already in the dependency tree, so it stays
/// Local-Dependencies-Only clean; the common `cmd /c del` trick would resolve a
/// binary off PATH and is the wrong answer in this repo regardless.
///
/// Best-effort by design. The registration writes `PendingFileRenameOperations`
/// under HKLM, which needs administrator rights — the cleaner HAS them on the
/// MSI path, but the per-user Velopack path may not, and a failure there must
/// never abort an otherwise successful uninstall. It also returns immediately:
/// the cleaner's last act is exiting so its own image lock releases, and
/// nothing here may delay that.
#[cfg(windows)]
fn delete_on_reboot(path: &std::path::Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            MOVEFILE_DELAY_UNTIL_REBOOT,
        )
        .is_ok()
    }
}

/// Stop the bundled adb server before deleting the tree it lives in (item 131,
/// fix direction 1).
///
/// This mirrors `linux_service.rs`, which has reaped adb on teardown all along
/// for exactly this reason — the Windows uninstall path simply never picked it
/// up. `kill-server` talks to the daemon over its loopback socket rather than
/// terminating a process, so it works from the elevated cleaner against a server
/// the user's own medium-integrity session started.
#[cfg(windows)]
fn reap_bundled_adb(data_root: &str) -> AdbReap {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    let adb = bundled_adb_path(data_root);
    if !adb.exists() {
        return AdbReap::Absent;
    }
    match std::process::Command::new(&adb)
        .arg("kill-server")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(crate::win_util::CREATE_NO_WINDOW)
        .status()
    {
        Ok(status) if status.success() => AdbReap::Reaped,
        _ => AdbReap::Failed,
    }
}

/// Write the residue report, so a wipe that did not fully happen leaves a
/// durable, truthful record (item 131, fix direction 2).
///
/// There is nowhere else for it to go: `ServerShutdownApi` answered HTTP 200
/// before this process even started, the app has exited, and logging is disabled
/// because `log::append` would `create_dir_all(<dataRoot>/logs)` and resurrect
/// the tree we just deleted (#120).
///
/// The sibling path can be refused — `C:\ProgramData`'s own ACL does not
/// guarantee a non-elevated process may create files there — so fall back to the
/// temp directory, where the cleaner itself already lives and can certainly
/// write. The fallback copy is deliberately NOT registered for delete-on-reboot:
/// a report that deletes itself before anyone reads it is no report at all.
#[cfg(windows)]
fn write_residue_report(data_root: &str, keep: bool, reap: AdbReap, survivors: &[String]) {
    let timestamp = log::format_timestamp_utc(std::time::SystemTime::now());
    let Some(body) = residue_report_body(&timestamp, keep, reap, survivors) else {
        return;
    };
    if let Some(path) = residue_report_path(data_root) {
        if std::fs::write(&path, &body).is_ok() {
            return;
        }
    }
    if let Some(dir) = resolve_temp_dir() {
        let _ = std::fs::write(dir.join(RESIDUE_REPORT_FALLBACK_NAME), &body);
    }
}

/// Legacy in-place uninstall: run Update.exe then delete the dataRoot targets
/// from THIS process. Used ONLY as the Phase-1 fallback when the temp-copy
/// cleaner cannot be staged (temp unresolved / self-copy / spawn failure).
/// Known to orphan the running helper's own directory on --wipe (Windows can't
/// delete a running exe) — no worse than pre-fix behavior, hence fallback-only.
fn run_uninstall_in_place(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "windows-app-uninstall(in-place fallback): update_exe={:?} data_root={:?} keep={}",
        a.update_exe, a.data_root, a.keep
    ));
    let plan = windows_app_uninstall_commands(&a.update_exe, &a.data_root, a.keep);
    if !perform_uninstall(&plan.update_exe_step) {
        log::error(
            "windows-app-uninstall(in-place fallback): the app was NOT uninstalled; \
             leaving the data root untouched",
        );
        return 1;
    }
    // Survivors are ignored on this path: it runs from the process whose own
    // image lives under dataRoot, so leftovers are expected and already
    // documented as the reason this path is fallback-only.
    let _ = remove_targets(&plan.data_root_targets, 1);
    0
}

/// Decode a temp-dir path from a UTF-16 buffer and the length reported by
/// `GetTempPath2W`/`GetTempPathW`. Returns `None` for a zero length (API
/// failure) or a length that reaches or exceeds the buffer.
///
/// §55: on success these APIs return the count of chars copied EXCLUDING the
/// NUL terminator, so a valid result always leaves room for the NUL and is
/// strictly `< buf.len()`. A `len >= buf.len()` can't be a real success (it
/// would mean the buffer was too small — the API returns the required size
/// instead), so reject it rather than slicing to the brim of an undocumented
/// MAX_PATH cap. Not exploitable as written (the W variants cap at MAX_PATH),
/// but fail closed.
fn temp_path_from_buf(buf: &[u16], len: usize) -> Option<std::path::PathBuf> {
    if len == 0 || len >= buf.len() {
        return None;
    }
    Some(std::path::PathBuf::from(String::from_utf16_lossy(&buf[..len])))
}

/// Resolve the context-appropriate temp directory: the user's temp under a
/// user token, the hardened `C:\Windows\SystemTemp` under a SYSTEM/system-
/// service token. `GetTempPath2W` is the SYSTEM-safe API (Win10 1903+); fall
/// back to `GetTempPathW`. `None` if both fail (caller → in-place fallback).
fn resolve_temp_dir() -> Option<std::path::PathBuf> {
    use windows::Win32::Storage::FileSystem::{GetTempPath2W, GetTempPathW};
    // Buffer is MAX_PATH (260) + 1. On success these return the length copied
    // (excluding NUL); if the buffer were too small they'd instead return the
    // REQUIRED size WITHOUT filling it. The W variants cap the path at MAX_PATH
    // so that can't happen here — but temp_path_from_buf fails closed rather
    // than slice out of bounds (panic=abort would kill the cleaner before it
    // deletes) or read an unfilled buffer.
    let mut buf = [0u16; 261];
    let mut len = unsafe { GetTempPath2W(Some(&mut buf)) } as usize;
    if len == 0 {
        len = unsafe { GetTempPathW(Some(&mut buf)) } as usize;
    }
    temp_path_from_buf(&buf, len)
}

/// Phase 1: copy this launcher to temp and spawn it as the logging-disabled
/// cleaner (Phase 2) with the uninstall params + our own pid as `--wait-pid`,
/// then return so the process can exit — releasing the running-exe lock on the
/// staged launcher under dataRoot. Falls back to the legacy in-place uninstall
/// if temp resolution / self-copy / spawn fails.
fn run_bootstrap(a: &UninstallArgs) -> i32 {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    // Mirror the proven detached-survival idiom (tray_supervisor / operation_server):
    // DETACHED_PROCESS breaks the parent-exit kill-chain + console inheritance,
    // CREATE_NO_WINDOW gives no console window, and null stdio severs inherited
    // handles. The cleaner MUST outlive our std::process::exit(0) below; the
    // uninstall helper also runs outside any kill-on-job-close job.
    use crate::win_util::{CREATE_NO_WINDOW, DETACHED_PROCESS};

    let pid = std::process::id();

    let temp_dir = match resolve_temp_dir() {
        Some(d) => d,
        None => {
            log::error("windows-app-uninstall: temp dir unresolved; in-place fallback");
            return run_uninstall_in_place(a);
        }
    };
    let src = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: current_exe failed: {e}; in-place fallback"
            ));
            return run_uninstall_in_place(a);
        }
    };
    let dst = temp_dir.join(temp_copy_filename(pid));
    if let Err(e) = std::fs::copy(&src, &dst) {
        log::error(&format!(
            "windows-app-uninstall: self-copy to {dst:?} failed: {e}; in-place fallback"
        ));
        return run_uninstall_in_place(a);
    }

    let run_args = build_run_args(pid, a.keep, &a.data_root, &a.update_exe);

    // Item 128. Removing a per-machine MSI needs an elevated token; without one
    // msiexec answers Error 1730 and the uninstall silently does nothing. Decide
    // here, in phase 1, while the app the user just clicked is still alive — a
    // UAC prompt raised later by a detached temp binary is what a user would
    // reasonably read as malware.
    //
    // `find_msi_product_code` is a plain registry read and works unelevated, so
    // asking the question costs nothing on the non-MSI path.
    let needs_elevation =
        cleaner_needs_elevation(find_msi_product_code().is_some(), is_process_elevated());

    if needs_elevation {
        log::info(&format!(
            "windows-app-uninstall: staged cleaner at {dst:?}; requesting elevation (MSI install)"
        ));
        return match spawn_cleaner_elevated(&dst, &run_args, &temp_dir) {
            ElevationResult::Started => {
                log::info("windows-app-uninstall: elevation accepted; elevated cleaner spawned");
                bootstrap_exit_for(ElevationResult::Started)
            }
            ElevationResult::Declined => {
                // Nothing has been touched yet — the cleaner never ran. Say so
                // in the same plain terms the refusal path uses, because from
                // the user's side this looks identical to a failure.
                log::error(
                    "windows-app-uninstall: elevation was declined, so the app was NOT \
                     uninstalled; leaving the install and data root untouched. The app is \
                     still installed and can be removed from Add/Remove Programs.",
                );
                bootstrap_exit_for(ElevationResult::Declined)
            }
            ElevationResult::Failed => {
                // Elevation is unavailable (admin-approval mode off, policy, a
                // broken association). The in-place path cannot succeed either
                // — it is the same unelevated token — but it fails SAFELY and
                // logs why, which beats exiting with an unexplained code.
                log::error("windows-app-uninstall: could not request elevation; in-place fallback");
                run_uninstall_in_place(a)
            }
        };
    }

    log::info(&format!(
        "windows-app-uninstall: staged cleaner at {dst:?}; spawning + exiting"
    ));
    match std::process::Command::new(&dst)
        .args(&run_args)
        .current_dir(&temp_dir) // CWD in temp, never under dataRoot
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(_child) => 0, // detached; do NOT wait — exit so the lock releases
        Err(e) => {
            log::error(&format!(
                "windows-app-uninstall: spawn cleaner failed: {e}; in-place fallback"
            ));
            run_uninstall_in_place(a)
        }
    }
}

/// Best-effort wait for process `pid` to exit, up to `timeout_ms`. Opens the
/// process for SYNCHRONIZE and waits on its handle. If the handle can't be
/// opened (already exited, or PID reused), returns immediately — the caller's
/// delete-retry is the actual guarantee that the lock has cleared.
fn wait_for_pid(pid: u32, timeout_ms: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            let _ = WaitForSingleObject(handle, timeout_ms);
            let _ = CloseHandle(handle);
        }
    }
}

/// Phase 2 (runs from the temp copy, logging disabled, CWD in temp): wait for
/// the originating helper to exit, run Update.exe --uninstall, then delete the
/// dataRoot targets with a bounded retry. The copy then exits and remains in
/// temp (self-managing). Returns 0 (best-effort throughout).
fn run_cleaner(a: &RunArgs) -> i32 {
    // No logging: append() would create_dir_all(<dataRoot>/logs) and resurrect
    // the data root after the wipe. Must be the first thing we do.
    log::disable();

    // Wait for the originating helper (its exe lives under dataRoot\control) to
    // exit so its image lock releases. 30s cap; the delete-retry below is the
    // real guarantee, so a timeout or PID-reuse mismatch is non-fatal.
    wait_for_pid(a.wait_pid, 30_000);

    let plan = windows_app_uninstall_commands(&a.update_exe, &a.data_root, a.keep);
    if !perform_uninstall(&plan.update_exe_step) {
        // Nothing is being wiped, so there is no data root to protect from
        // `create_dir_all(<dataRoot>/logs)` — turn logging back on and say why
        // we stopped. Silence here is what let a refused uninstall look like a
        // successful one for every Windows install of this app (#120).
        log::enable();
        log::error(
            "windows-app-uninstall: the app was NOT uninstalled; leaving the install and \
             data root untouched. The app is still installed and can be removed from \
             Add/Remove Programs.",
        );
        return 1;
    }
    // Item 131, fix direction 1 — the actual fix for the common case. The
    // recursive delete below reaches `dependencies\adb\adb.exe`, and Windows
    // will not delete a running executable's image. Stop our own adb server
    // first; anyone who has connected a device this session has one running,
    // which is the product's primary use, not an edge case.
    let reap = reap_bundled_adb(&a.data_root);

    // ~5s of retry (10 × 500ms) to absorb residual handle-release lag, which
    // now also covers the adb daemon taking a moment to go away.
    let _ = remove_targets(&plan.data_root_targets, 10);

    // Settle pass. We wait on the Phase-1 helper's pid, but the LAUNCHER is a
    // different process with its own logging, and its exit line lands about a
    // second after the wipe — `create_dir_all(<dataRoot>\logs)` re-creating the
    // data root we just deleted, as a 74-byte launcher.log (#120). Rather than
    // plumb a second pid through every layer for one late writer, sweep once
    // more after the dust settles: it costs two seconds on a path that is
    // already tearing the app down, and it catches any late writer, not only
    // the one we happen to know about.
    std::thread::sleep(std::time::Duration::from_millis(2_000));
    // The settle pass is authoritative: anything it still cannot remove is what
    // genuinely survived this uninstall.
    let survivors = remove_targets(&plan.data_root_targets, 2);

    if !survivors.is_empty() {
        // Children before parents (the order remove_targets returns), which is
        // what lets the queue actually clear a whole tree at the next boot —
        // MoveFileEx cannot remove a directory that still has contents.
        for path in &survivors {
            delete_on_reboot(std::path::Path::new(path));
        }
        write_residue_report(&a.data_root, a.keep, reap, &survivors);
    }

    // Item 130. Windows cannot delete a running executable, and this staged copy
    // is the last process standing — `windows_app_uninstall.rs` used to call it
    // "self-managing", which was generous: nothing managed it, so one full copy
    // of the launcher accumulated in temp per uninstall on any machine that
    // never runs Disk Cleanup. Registering the path costs nothing and does not
    // delay the exit that releases our own lock.
    if let Ok(exe) = std::env::current_exe() {
        if is_staged_copy(&exe) {
            delete_on_reboot(&exe);
        }
    }
    0
}

/// Dispatch `--windows-app-uninstall-run` (the Phase-2 cleaner, the temp copy).
/// Returns `Some(exit_code)` when it owns the invocation, `None` otherwise.
pub fn handle_run(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--windows-app-uninstall-run") {
        return None;
    }
    match parse_run_args(args) {
        Some(a) => Some(run_cleaner(&a)),
        None => Some(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Space-join each argv-vector for readable, order-preserving assertions.
    /// Mirrors the helper in linux_app_uninstall tests.
    fn joined(cmds: &[Vec<String>]) -> Vec<String> {
        cmds.iter().map(|c| c.join(" ")).collect()
    }

    const UPDATE_EXE: &str = r"C:\Program Files\WsScrcpyWeb\Update.exe";
    const DATA_ROOT: &str = r"C:\ProgramData\WsScrcpyWeb";

    // ── §55: temp-path buffer bound ───────────────────────────────────────

    #[test]
    fn temp_path_from_buf_rejects_zero_and_out_of_bounds_lengths() {
        let buf = [0u16; 8];
        assert!(temp_path_from_buf(&buf, 0).is_none(), "zero length (API failure) -> None");
        assert!(temp_path_from_buf(&buf, 9).is_none(), "len > buf.len() -> None");
        // §55: a successful GetTempPath*W leaves room for the NUL terminator,
        // so len == buf.len() can't be a valid result -- reject it too (>=),
        // rather than slicing to the brim of an undocumented cap.
        assert!(temp_path_from_buf(&buf, 8).is_none(), "len == buf.len() -> None");
    }

    #[test]
    fn temp_path_from_buf_decodes_valid_utf16() {
        let mut buf = [0u16; 16];
        let s: Vec<u16> = r"C:\Temp".encode_utf16().collect();
        buf[..s.len()].copy_from_slice(&s);
        let p = temp_path_from_buf(&buf, s.len()).expect("valid length must decode");
        assert_eq!(p.to_string_lossy(), r"C:\Temp");
    }

    // ── Pure builder tests ────────────────────────────────────────────────

    #[test]
    fn update_exe_step_is_always_first_and_correct() {
        // Both keep and wipe: the Update.exe step is the first (and only)
        // step in update_exe_step, always [update_exe, "--uninstall"].
        for keep in [true, false] {
            let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, keep);
            assert_eq!(
                plan.update_exe_step,
                vec![UPDATE_EXE.to_string(), "--uninstall".to_string()],
                "update_exe_step mismatch for keep={keep}"
            );
        }
    }

    #[test]
    fn wipe_targets_whole_data_root() {
        // keep=false → data_root_targets = ["<data_root>"] — single entry,
        // the whole root. No subdirectory carve-out.
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, false);
        assert_eq!(
            plan.data_root_targets,
            vec![DATA_ROOT.to_string()],
            "wipe must target the whole data root"
        );
    }

    #[test]
    fn keep_targets_deps_bin_control_only() {
        // keep=true → data_root_targets contains exactly dependencies, bin,
        // control (subdirs); does NOT contain a bare wipe and never names
        // config.json or logs.
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, true);
        let targets = &plan.data_root_targets;

        // Exactly the three regenerable subdirs.
        assert!(
            targets.contains(&format!(r"{DATA_ROOT}\dependencies")),
            "keep must target dependencies"
        );
        assert!(
            targets.contains(&format!(r"{DATA_ROOT}\bin")),
            "keep must target bin"
        );
        assert!(
            targets.contains(&format!(r"{DATA_ROOT}\control")),
            "keep must target control"
        );

        // NOT a bare wipe of the data root itself.
        assert!(
            !targets.contains(&DATA_ROOT.to_string()),
            "keep must NOT target the whole data root"
        );

        // Preserved paths are never referenced.
        assert!(
            !targets.iter().any(|t| t.contains("config.json")),
            "keep must not reference config.json"
        );
        assert!(
            !targets.iter().any(|t| t.contains("logs")),
            "keep must not reference logs"
        );
    }

    #[test]
    fn update_exe_step_is_distinct_from_data_root_targets() {
        // The struct keeps the two groups separate so callers (and tests) can
        // assert each independently. Verify the split is never collapsed.
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, false);
        // update_exe_step has exactly the Update.exe invocation.
        assert_eq!(plan.update_exe_step.len(), 2);
        assert_eq!(plan.update_exe_step[1], "--uninstall");
        // data_root_targets has no Update.exe entry.
        assert!(!plan.data_root_targets.iter().any(|t| t.contains("Update.exe")));
    }

    #[test]
    fn keep_has_exactly_three_targets() {
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, true);
        assert_eq!(
            plan.data_root_targets.len(),
            3,
            "keep must produce exactly 3 targets (dependencies, bin, control)"
        );
    }

    #[test]
    fn wipe_has_exactly_one_target() {
        let plan = windows_app_uninstall_commands(UPDATE_EXE, DATA_ROOT, false);
        assert_eq!(
            plan.data_root_targets.len(),
            1,
            "wipe must produce exactly 1 target (the whole data root)"
        );
    }

    #[test]
    fn update_exe_path_is_preserved_verbatim() {
        // The absolute path passed in must appear unchanged — no normalization,
        // no quoting, no PATH lookup.
        let exotic = r"C:\Program Files (x86)\WsScrcpyWeb\Update.exe";
        let plan = windows_app_uninstall_commands(exotic, DATA_ROOT, false);
        assert_eq!(plan.update_exe_step[0], exotic);
    }

    // Smoke-check the joined() helper (mirrors linux tests).
    #[test]
    fn joined_helper_formats_correctly() {
        let cmds: Vec<Vec<String>> = vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["c".to_string()],
        ];
        assert_eq!(joined(&cmds), vec!["a b".to_string(), "c".to_string()]);
    }

    // ── parse_args tests ──────────────────────────────────────────────────

    #[test]
    fn parse_args_round_trips_keep() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--keep",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_args(&args),
            Some(UninstallArgs {
                update_exe: UPDATE_EXE.to_string(),
                data_root: DATA_ROOT.to_string(),
                keep: true,
            })
        );
    }

    #[test]
    fn parse_args_round_trips_wipe() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--wipe",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            parse_args(&args),
            Some(UninstallArgs {
                update_exe: UPDATE_EXE.to_string(),
                data_root: DATA_ROOT.to_string(),
                keep: false,
            })
        );
    }

    #[test]
    fn parse_args_rejects_both_keep_and_wipe() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--keep",
            "--wipe",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_neither_keep_nor_wipe() {
        let args: Vec<String> = [
            "--windows-app-uninstall",
            "--data-root",
            DATA_ROOT,
            "--update-exe",
            UPDATE_EXE,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_missing_data_root() {
        let args: Vec<String> =
            ["--windows-app-uninstall", "--keep", "--update-exe", UPDATE_EXE]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_missing_update_exe() {
        let args: Vec<String> =
            ["--windows-app-uninstall", "--keep", "--data-root", DATA_ROOT]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(parse_args(&args), None);
    }

    #[test]
    fn parse_args_rejects_data_root_without_value() {
        // --data-root present but no value following it → parse error.
        let args: Vec<String> =
            ["--windows-app-uninstall", "--keep", "--data-root", "--update-exe", UPDATE_EXE]
                .iter()
                .map(|s| s.to_string())
                .collect();
        // --data-root's "value" would be "--update-exe" (the next flag), and
        // --update-exe would then have no value. parse_args returns None for
        // missing --update-exe value.
        // (We don't validate that values aren't flags; the contract matches linux.)
        // Either way: no panic.
        let _ = parse_args(&args);
    }

    #[test]
    fn handle_returns_none_when_flag_absent() {
        let args: Vec<String> = ["--some-other-flag", "--keep"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(handle(&args), None);
    }

    #[test]
    fn handle_returns_error_code_on_invalid_args() {
        // Flag present but missing required --data-root and --update-exe.
        let args: Vec<String> = ["--windows-app-uninstall", "--keep"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(handle(&args), Some(2));
    }

    // ── Phase-2 (--windows-app-uninstall-run) arg model ───────────────────

    #[test]
    fn build_run_args_round_trips_through_parse() {
        for keep in [true, false] {
            let argv = build_run_args(4321, keep, DATA_ROOT, UPDATE_EXE);
            // The temp copy always gets --no-log and the run subcommand.
            assert!(argv.contains(&"--windows-app-uninstall-run".to_string()));
            assert!(argv.contains(&"--no-log".to_string()));
            let parsed = parse_run_args(&argv).expect("round-trips");
            assert_eq!(
                parsed,
                RunArgs {
                    wait_pid: 4321,
                    update_exe: UPDATE_EXE.to_string(),
                    data_root: DATA_ROOT.to_string(),
                    keep,
                }
            );
        }
    }

    #[test]
    fn parse_run_args_requires_the_run_flag() {
        // Same fields but the Phase-1 flag, not the run flag → not ours.
        let argv: Vec<String> = [
            "--windows-app-uninstall", "--wait-pid", "1", "--wipe",
            "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&argv), None);
    }

    #[test]
    fn parse_run_args_rejects_missing_or_bad_wait_pid() {
        let no_pid: Vec<String> = [
            "--windows-app-uninstall-run", "--wipe",
            "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&no_pid), None);

        let bad_pid: Vec<String> = [
            "--windows-app-uninstall-run", "--wait-pid", "notanumber",
            "--wipe", "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&bad_pid), None);
    }

    #[test]
    fn parse_run_args_rejects_neither_keep_nor_wipe() {
        let argv: Vec<String> = [
            "--windows-app-uninstall-run", "--wait-pid", "1",
            "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE,
        ]
        .iter().map(|s| s.to_string()).collect();
        assert_eq!(parse_run_args(&argv), None);
    }

    #[test]
    fn temp_copy_filename_is_pid_stamped() {
        assert_eq!(temp_copy_filename(1234), "ws-scrcpy-web-uninstall-1234.exe");
        // Distinct pids → distinct names (so concurrent/retried uninstalls don't collide).
        assert_ne!(temp_copy_filename(1), temp_copy_filename(2));
    }

    #[test]
    fn handle_run_returns_none_when_flag_absent() {
        let args: Vec<String> = ["--some-other-flag", "--wipe"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(handle_run(&args), None);
    }

    #[test]
    fn handle_run_returns_error_code_on_invalid_args() {
        // Run flag present but missing --wait-pid / --data-root / --update-exe
        // and no keep/wipe → parse_run_args None → exit code 2 (never reaches
        // run_cleaner, so no I/O).
        let args: Vec<String> = ["--windows-app-uninstall-run"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(handle_run(&args), Some(2));
    }

    // ─── #120: the MSI uninstall path ──────────────────────────────────────
    //
    // Velopack 1.2.0 refuses `Update.exe --uninstall` on an MSI install, and
    // every Windows install of this app is one — so that step removed nothing
    // while the cleaner deleted the data root anyway. These pin the pieces the
    // msiexec replacement is built from.

    /// The exact string Velopack writes for this app, measured 2026-09-08.
    /// The key is named `MSI:WsScrcpyWeb`; the GUID is only in here.
    const REAL_UNINSTALL_STRING: &str = "msiexec.exe /x {EF20C75C-1234-4ABC-9DEF-0123456789AB}";

    #[test]
    fn product_code_comes_from_the_uninstall_string() {
        assert_eq!(
            product_code_from_uninstall_string(REAL_UNINSTALL_STRING).as_deref(),
            Some("{EF20C75C-1234-4ABC-9DEF-0123456789AB}")
        );
        // Uppercase /X and no space, as some writers emit it.
        assert_eq!(
            product_code_from_uninstall_string("MsiExec.exe /X{EF20C75C-1234-4ABC-9DEF-0123456789AB}")
                .as_deref(),
            Some("{EF20C75C-1234-4ABC-9DEF-0123456789AB}")
        );
    }

    #[test]
    fn product_code_rejects_anything_that_is_not_a_guid() {
        assert_eq!(product_code_from_uninstall_string("Update.exe --uninstall"), None);
        assert_eq!(product_code_from_uninstall_string("msiexec.exe /x {not-a-guid}"), None);
        assert_eq!(product_code_from_uninstall_string(""), None);
        // Right length, wrong contents — a non-hex character must not pass.
        assert_eq!(
            product_code_from_uninstall_string("/x {ZZ20C75C-1234-4ABC-9DEF-0123456789AB}"),
            None
        );
    }

    #[test]
    fn key_leaf_is_only_a_fallback_and_rejects_velopacks_name() {
        // This is the real key name, and reading it as a product code is the
        // mistake the UninstallString exists to avoid.
        assert_eq!(product_code_from_key_leaf("MSI:WsScrcpyWeb"), None);
        assert_eq!(
            product_code_from_key_leaf("{EF20C75C-1234-4ABC-9DEF-0123456789AB}").as_deref(),
            Some("{EF20C75C-1234-4ABC-9DEF-0123456789AB}")
        );
    }

    #[test]
    fn msiexec_success_is_not_just_zero() {
        // 3010 = success, reboot required. 1641 = success, reboot initiated.
        // Calling either a failure would leave the data root behind on a
        // machine where the app is already gone.
        assert!(msiexec_exit_is_success(0));
        assert!(msiexec_exit_is_success(3010));
        assert!(msiexec_exit_is_success(1641));

        assert!(!msiexec_exit_is_success(1603)); // fatal error during install
        assert!(!msiexec_exit_is_success(1605)); // product not installed
        assert!(!msiexec_exit_is_success(1)); // generic failure
        assert!(!msiexec_exit_is_success(-1)); // no exit code (killed)
    }

    #[test]
    fn msi_step_is_silent_no_reboot_and_absolutely_pathed() {
        let step = msi_uninstall_step("{EF20C75C-1234-4ABC-9DEF-0123456789AB}");
        assert_eq!(
            step,
            vec![
                r"C:\Windows\System32\msiexec.exe".to_string(),
                "/x".to_string(),
                "{EF20C75C-1234-4ABC-9DEF-0123456789AB}".to_string(),
                "/qn".to_string(),
                "/norestart".to_string(),
            ]
        );
        // Local-Dependencies-Only: never a bare `msiexec`.
        assert!(step[0].starts_with(r"C:\"));
    }

    #[test]
    fn arp_display_name_matches_the_names_this_app_is_written_under() {
        assert!(arp_display_name_matches("ws-scrcpy-web"));
        assert!(arp_display_name_matches("WsScrcpyWeb"));
        assert!(arp_display_name_matches("wsscrcpyweb"));
        assert!(arp_display_name_matches("WsScrcpyWeb 0.1.30-beta.115"));

        assert!(!arp_display_name_matches("scrcpy"));
        assert!(!arp_display_name_matches("Microsoft Edge"));
        assert!(!arp_display_name_matches(""));
    }

    // ── Item 128: the cleaner must run elevated ────────────────────────────
    //
    // Removing a per-machine MSI needs an elevated token. The cleaner was
    // spawned with plain CreateProcess, inheriting the launcher's medium
    // integrity, so msiexec answered `Error 1730. You must be an Administrator
    // to remove this application.` and the in-app uninstall never worked on
    // Windows at all (qa-harness Arc 4 on beta.119, confirmed on two runs).

    #[test]
    fn an_msi_install_from_a_medium_process_needs_elevation() {
        assert!(cleaner_needs_elevation(true, false));
    }

    #[test]
    fn an_already_elevated_process_does_not_prompt_again() {
        assert!(!cleaner_needs_elevation(true, true));
    }

    #[test]
    fn a_non_msi_install_never_needs_elevation() {
        // Velopack installs per-user under %LocalAppData%, so Update.exe needs
        // no admin. Prompting there would be a UAC dialog for nothing.
        assert!(!cleaner_needs_elevation(false, false));
        assert!(!cleaner_needs_elevation(false, true));
    }

    // ShellExecuteExW takes ONE command line, which the child re-parses via
    // CommandLineToArgvW. Every real path here contains spaces
    // (`C:\Program Files\...`), so an unquoted join silently splits one
    // argument into several and the cleaner parses garbage.

    #[test]
    fn shell_execute_parameters_quotes_each_argument() {
        let args = vec![
            "--windows-app-uninstall-run".to_string(),
            "--data-root".to_string(),
            r"C:\ProgramData\WsScrcpyWeb".to_string(),
        ];
        assert_eq!(
            shell_execute_parameters(&args),
            r#""--windows-app-uninstall-run" "--data-root" "C:\ProgramData\WsScrcpyWeb""#
        );
    }

    #[test]
    fn shell_execute_parameters_keeps_a_path_with_spaces_as_one_argument() {
        let args = vec![
            "--update-exe".to_string(),
            r"C:\Program Files\WsScrcpyWeb\Update.exe".to_string(),
        ];
        assert_eq!(
            shell_execute_parameters(&args),
            r#""--update-exe" "C:\Program Files\WsScrcpyWeb\Update.exe""#
        );
    }

    #[test]
    fn shell_execute_parameters_is_empty_for_no_arguments() {
        assert_eq!(shell_execute_parameters(&[]), "");
    }

    #[test]
    fn a_declined_uac_prompt_never_reports_success() {
        // The user said no. Nothing was uninstalled and nothing was deleted, so
        // reporting 0 would tell the caller the app is gone when it is still
        // installed -- the exact class of lie item 120 was filed for.
        assert_eq!(bootstrap_exit_for(ElevationResult::Declined), 1223);
        assert_ne!(bootstrap_exit_for(ElevationResult::Declined), 0);
    }

    #[test]
    fn an_accepted_uac_prompt_reports_success() {
        // The elevated cleaner is detached and owns the outcome from here; the
        // bootstrap's job was only to hand off, and it did.
        assert_eq!(bootstrap_exit_for(ElevationResult::Started), 0);
    }

    // ── items 131 + 130: adb reap, continue-on-error delete, residue report ──

    /// Hold `path` open with NO sharing, so a delete fails with a sharing
    /// violation — which is precisely what a running executable's mapped image
    /// does, and precisely what `adb.exe` was doing.
    ///
    /// The read-only attribute is NOT a substitute: Rust's `remove_file` clears
    /// it and deletes the file anyway, so a read-only "lock" proves nothing.
    /// Dropping the returned handle releases the lock, which is why it must
    /// outlive the call under test but die before the tempdir cleans up.
    #[cfg(windows)]
    #[must_use]
    fn hold_exclusively(path: &std::path::Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .expect("open the stand-in with no sharing")
    }

    #[test]
    fn the_adb_we_reap_is_the_one_bundled_under_the_data_root() {
        // Local-Dependencies-Only: the adb holding the lock is OUR adb, inside
        // the tree we are about to delete. Never a PATH lookup — a system adb is
        // a different process holding nothing of ours.
        assert_eq!(
            bundled_adb_path(DATA_ROOT),
            std::path::PathBuf::from(r"C:\ProgramData\WsScrcpyWeb\dependencies\adb\adb.exe")
        );
    }

    #[test]
    fn the_residue_report_is_a_sibling_of_the_data_root_never_inside_it() {
        // Writing it INSIDE the data root would re-create the tree we just
        // wiped — #120's 74-byte launcher.log, exactly.
        let report = residue_report_path(DATA_ROOT).expect("data root has a parent");
        assert_eq!(
            report,
            std::path::PathBuf::from(r"C:\ProgramData\WsScrcpyWeb-uninstall-report.txt")
        );
        assert!(
            !report.starts_with(DATA_ROOT),
            "{report:?} must not live under the data root"
        );
    }

    #[test]
    fn residue_report_path_is_none_when_the_data_root_has_no_parent() {
        assert!(residue_report_path(r"C:\").is_none());
    }

    #[test]
    #[cfg(windows)]
    fn one_undeletable_file_does_not_cost_its_siblings() {
        // THE BUG (item 131). std::fs::remove_dir_all aborts on the first Err, so
        // a single locked adb.exe left 2315 files behind — including logs\ and
        // wsscrcpy.db*, which nothing was holding.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("dataroot");
        std::fs::create_dir_all(root.join("dependencies").join("adb")).unwrap();
        std::fs::create_dir_all(root.join("logs")).unwrap();

        let locked = root.join("dependencies").join("adb").join("adb.exe");
        std::fs::write(&locked, b"stand-in for a running image").unwrap();
        let innocent = root.join("logs").join("launcher.log");
        std::fs::write(&innocent, b"nothing holds this").unwrap();
        let _lock = hold_exclusively(&locked);

        let survivors = remove_targets(&[root.to_string_lossy().into_owned()], 1);

        assert!(
            !innocent.exists(),
            "the unlocked sibling must be deleted even though adb.exe could not be"
        );
        assert!(locked.exists(), "the locked file itself is expected to survive");
        assert!(
            survivors.iter().any(|s| s.as_str() == locked.to_string_lossy()),
            "the locked file must be reported: {survivors:?}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn survivors_are_listed_children_before_parents() {
        // Delete-on-reboot processes its queue in order, and MoveFileEx cannot
        // remove a directory that still has contents. Children first is what
        // makes the tree actually go away at the next boot.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("dataroot");
        let nested = root.join("dependencies").join("adb");
        std::fs::create_dir_all(&nested).unwrap();
        let locked = nested.join("adb.exe");
        std::fs::write(&locked, b"x").unwrap();
        let _lock = hold_exclusively(&locked);

        let survivors = remove_targets(&[root.to_string_lossy().into_owned()], 1);

        let pos = |p: &std::path::Path| {
            survivors
                .iter()
                .position(|s| s.as_str() == p.to_string_lossy())
                .unwrap_or_else(|| panic!("{p:?} missing from {survivors:?}"))
        };
        assert!(pos(&locked) < pos(&nested), "file before its directory");
        assert!(pos(&nested) < pos(&root), "directory before its parent");
    }

    #[test]
    fn a_clean_wipe_reports_no_survivors() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("dataroot");
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(root.join("logs").join("launcher.log"), b"x").unwrap();

        let survivors = remove_targets(&[root.to_string_lossy().into_owned()], 1);

        assert!(!root.exists());
        assert!(survivors.is_empty(), "expected nothing left: {survivors:?}");
    }

    #[test]
    fn an_absent_target_is_not_a_survivor() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("never-existed");
        assert!(remove_targets(&[missing.to_string_lossy().into_owned()], 1).is_empty());
    }

    #[test]
    fn the_report_names_every_survivor_and_says_when_they_go() {
        let body = format_residue_report(
            "2026-09-12 18:04:11.000",
            false,
            AdbReap::Reaped,
            &[r"C:\ProgramData\WsScrcpyWeb\dependencies\adb\adb.exe".to_string()],
        );
        assert!(body.contains("2026-09-12 18:04:11.000"), "{body}");
        assert!(body.contains("--wipe"), "{body}");
        assert!(body.contains(r"dependencies\adb\adb.exe"), "{body}");
        assert!(body.contains("next reboot"), "{body}");
    }

    #[test]
    fn the_report_records_what_the_adb_reap_did() {
        // If the reap failed, that is the first thing a reader needs — it is the
        // difference between "a stray handle" and "we never even tried".
        let failed = format_residue_report("t", false, AdbReap::Failed, &["p".into()]);
        assert!(failed.contains("adb"), "{failed}");
        assert!(failed.contains("failed"), "{failed}");

        let absent = format_residue_report("t", false, AdbReap::Absent, &["p".into()]);
        assert!(absent.contains("adb"), "{absent}");
        assert!(!absent.contains("failed"), "absent is not a failure: {absent}");
    }

    #[test]
    fn the_report_distinguishes_a_keep_uninstall_from_a_wipe() {
        let keep = format_residue_report("t", true, AdbReap::Reaped, &["p".into()]);
        assert!(keep.contains("--keep"), "{keep}");
        assert!(!keep.contains("--wipe"), "{keep}");
    }

    #[test]
    fn a_huge_survivor_list_is_capped_but_still_states_the_true_total() {
        // 2315 paths is the measured real number. A report nobody opens is no
        // better than no report — but the COUNT must never be trimmed.
        let many: Vec<String> = (0..2315).map(|i| format!(r"C:\x\{i}")).collect();
        let body = format_residue_report("t", false, AdbReap::Failed, &many);

        assert!(body.contains("2315"), "the true total must appear: {body}");
        assert!(
            body.lines().count() < 100,
            "report should be readable, got {} lines",
            body.lines().count()
        );
        assert!(body.contains("more"), "must say the list was truncated: {body}");
    }

    #[test]
    fn only_the_staged_temp_copy_may_register_itself_for_deletion() {
        // Item 130 deletes the cleaner at next boot because Windows will not let
        // it delete itself now. The guard matters because `--windows-app-uninstall-run`
        // is a public flag: run it by hand from the install tree and an
        // unguarded registration would schedule a WORKING launcher for deletion
        // at the next reboot.
        let temp = std::path::Path::new(r"C:\Users\me\AppData\Local\Temp");
        assert!(is_staged_copy(&temp.join(temp_copy_filename(1234))));
        assert!(
            !is_staged_copy(std::path::Path::new(
                r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe"
            )),
            "the installed launcher must never be scheduled for deletion"
        );
        assert!(
            !is_staged_copy(&temp.join("something-else.exe")),
            "only our own staged filename counts, even inside temp"
        );
    }

    #[test]
    fn the_staged_copy_is_recognised_whatever_case_the_path_arrives_in() {
        // Windows paths are case-insensitive but Rust's Path comparison is not,
        // and `current_exe()` reports whatever casing the loader resolved. A
        // case-sensitive check here would silently skip the registration and
        // quietly un-fix item 130 — a failure with no symptom until temp fills.
        assert!(is_staged_copy(std::path::Path::new(
            r"C:\Users\me\AppData\Local\TEMP\WS-SCRCPY-WEB-UNINSTALL-1234.EXE"
        )));
    }

    #[test]
    fn no_survivors_means_no_report_at_all() {
        // The file's presence IS the signal. Writing "nothing survived" on every
        // clean uninstall leaves litter of its own — item 130's own complaint.
        assert!(residue_report_body("t", false, AdbReap::Reaped, &[]).is_none());
        assert!(residue_report_body("t", false, AdbReap::Reaped, &["p".into()]).is_some());
    }
}
