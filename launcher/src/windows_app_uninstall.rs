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
// PATH, no env-var). Removes each dataRoot target via `std::fs::remove_dir_all`
// / `std::fs::remove_file`. Best-effort: logs + continues on errors (the
// app is being uninstalled regardless).
//
// Local-Dependencies-Only: Update.exe is the absolute path argument.
// dataRoot deletion = `std::fs` compiled into the binary. No bare
// cmd/rmdir/powershell on PATH.

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
    format!("ws-scrcpy-web-uninstall-{pid}.exe")
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

/// Remove each dataRoot target via std::fs (compiled-in; no PATH tools),
/// retrying up to `attempts` times with a 500ms delay between tries to absorb
/// residual handle-release lag (e.g. the originating helper exiting). Best-
/// effort: logs and continues on failure.
fn remove_targets(targets: &[String], attempts: u32) {
    let attempts = attempts.max(1);
    for target in targets {
        let path = std::path::Path::new(target);
        // Ok(true) = we removed it; Ok(false) = it was already absent; Err = failed.
        let mut outcome: Result<bool, std::io::Error> = Ok(false);
        for attempt in 0..attempts {
            if !path.exists() {
                outcome = Ok(false);
                break;
            }
            let result = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            match result {
                Ok(()) => {
                    outcome = Ok(true);
                    break;
                }
                Err(e) => {
                    outcome = Err(e);
                    if attempt + 1 < attempts {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }
        }
        match outcome {
            Ok(true) => log::info(&format!("windows-app-uninstall: removed {target}")),
            Ok(false) => log::info(&format!(
                "windows-app-uninstall: {target} already absent — nothing to remove"
            )),
            Err(e) => log::error(&format!(
                "windows-app-uninstall: could not remove {target}: {e}"
            )),
        }
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
    remove_targets(&plan.data_root_targets, 1);
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
    // ~5s of retry (10 × 500ms) to absorb residual handle-release lag.
    remove_targets(&plan.data_root_targets, 10);

    // Settle pass. We wait on the Phase-1 helper's pid, but the LAUNCHER is a
    // different process with its own logging, and its exit line lands about a
    // second after the wipe — `create_dir_all(<dataRoot>\logs)` re-creating the
    // data root we just deleted, as a 74-byte launcher.log (#120). Rather than
    // plumb a second pid through every layer for one late writer, sweep once
    // more after the dust settles: it costs two seconds on a path that is
    // already tearing the app down, and it catches any late writer, not only
    // the one we happen to know about.
    std::thread::sleep(std::time::Duration::from_millis(2_000));
    remove_targets(&plan.data_root_targets, 2);
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
}
