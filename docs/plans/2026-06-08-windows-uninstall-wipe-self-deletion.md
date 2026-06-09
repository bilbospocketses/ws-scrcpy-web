# Windows Uninstall Wipe Self-Deletion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows in-app uninstall fully remove the dataRoot on `--wipe` (and `control/` on `--keep`) by delegating the dataRoot deletion to a logging-disabled copy of the launcher running from the OS temp dir, after the original helper exits.

**Architecture:** Two-phase split inside `launcher/src/windows_app_uninstall.rs`. Phase 1 (the helper the Node server already spawns, running from `dataRoot\control\operation-server\`) copies itself to the context-appropriate temp dir, spawns that copy detached with `--wait-pid`/`--no-log` + the uninstall params, and exits. Phase 2 (the temp copy, logging disabled, CWD in temp) waits for the original to exit, runs `Update.exe --uninstall`, then deletes the dataRoot targets with a bounded retry. `ServiceApi.ts` is unchanged. See spec: `docs/specs/2026-06-08-windows-uninstall-wipe-self-deletion-design.md`.

**Tech Stack:** Rust (the `ws-scrcpy-web-launcher` + `ws-scrcpy-web-common` crates), the `windows` 0.58 crate (already a launcher dependency), `cargo test`/`cargo clippy` (Windows host — `windows_app_uninstall` is `#[cfg(windows)]`), CI `cross` for the Linux leg.

**Verification commands (Windows dev host):**
- Common crate: `cargo test -p ws-scrcpy-web-common`
- Launcher crate: `cargo test -p ws-scrcpy-web-launcher`
- Lint: `cargo clippy -p ws-scrcpy-web-launcher -p ws-scrcpy-web-common -- -D warnings`
- (Linux leg is covered by CI `cross`; this fix only adds Windows-gated code paths, so it cannot regress Linux compilation, but a `cargo build` on the host confirms the cross-platform crates still build.)

> **Note on FFI signatures:** the Win32 calls (`GetTempPath2W`, `GetTempPathW`, `OpenProcess`, `WaitForSingleObject`, `CloseHandle`) are written below against the `windows` 0.58 API as best-known. If a signature mismatch surfaces at `cargo build`, confirm the exact form against the installed `windows` 0.58 crate and adjust — the surrounding logic does not change. This is expected for FFI and is resolved by the compile step in each task.

---

## File Structure

- `common/src/log.rs` — add a process-global `disable()` switch + an `is_disabled()` reader; `append()` early-returns when disabled. (Cross-platform; the cleaner uses it.)
- `launcher/src/windows_app_uninstall.rs` — the two-phase split. Keep the existing pure builders/tests; add the Phase-2 arg model (`RunArgs`/`build_run_args`/`parse_run_args`), `temp_copy_filename`, the extracted `run_update_exe`/`remove_targets` helpers, the renamed legacy `run_uninstall_in_place`, and the `#[cfg(windows)]` `run_bootstrap`/`resolve_temp_dir`/`run_cleaner`/`wait_for_pid` + `handle_run`.
- `launcher/src/main.rs` — add the `windows_app_uninstall::handle_run(&args)` dispatch entry beside the existing `handle`.
- `Cargo.toml` (workspace) — add `Win32_Storage_FileSystem` to the `windows` crate features.
- `CHANGELOG.md` — a `Fixed` entry.
- `docs/smoke-tests/smoke-checklist.md`, `docs/smoke-tests/smoke-full.md` — smoke-target tag → beta.52; add the Windows in-app-uninstall batch to the checklist.

---

## Task 1: `log::disable()` gate in the common crate

**Files:**
- Modify: `common/src/log.rs` (add `disable()`/`is_disabled()`, gate `append()`)
- Test: `common/src/log.rs` (inline `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `common/src/log.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ws-scrcpy-web-common disable_silences_logging`
Expected: FAIL — `cannot find function 'disable'` / `'is_disabled'`.

- [ ] **Step 3: Write minimal implementation**

In `common/src/log.rs`, add the import and the gate near the top (after the existing `use` lines and the `LOG_NAME` static):

```rust
use std::sync::atomic::{AtomicBool, Ordering};

static LOG_DISABLED: AtomicBool = AtomicBool::new(false);

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
```

Then add the early-return as the first line of `append()`:

```rust
fn append(prefix: &str, msg: &str) {
    if is_disabled() {
        return;
    }
    let ts = format_timestamp_utc(SystemTime::now());
    // ... unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p ws-scrcpy-web-common`
Expected: PASS — `disable_silences_logging` plus all existing log tests green.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/src/log.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(common): add log::disable() process-global gate"
```

---

## Task 2: Phase-2 argument model (pure)

**Files:**
- Modify: `launcher/src/windows_app_uninstall.rs` (add `RunArgs`, `build_run_args`, `parse_run_args`)
- Test: `launcher/src/windows_app_uninstall.rs` (inline tests)

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module:

```rust
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
    let argv: Vec<String> = ["--windows-app-uninstall", "--wait-pid", "1", "--wipe",
        "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE]
        .iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_run_args(&argv), None);
}

#[test]
fn parse_run_args_rejects_missing_or_bad_wait_pid() {
    let no_pid: Vec<String> = ["--windows-app-uninstall-run", "--wipe",
        "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE]
        .iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_run_args(&no_pid), None);

    let bad_pid: Vec<String> = ["--windows-app-uninstall-run", "--wait-pid", "notanumber",
        "--wipe", "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE]
        .iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_run_args(&bad_pid), None);
}

#[test]
fn parse_run_args_rejects_neither_keep_nor_wipe() {
    let argv: Vec<String> = ["--windows-app-uninstall-run", "--wait-pid", "1",
        "--data-root", DATA_ROOT, "--update-exe", UPDATE_EXE]
        .iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_run_args(&argv), None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p ws-scrcpy-web-launcher build_run_args_round_trips_through_parse`
Expected: FAIL — `cannot find function 'build_run_args'` / `'parse_run_args'` / type `RunArgs`.

- [ ] **Step 3: Write minimal implementation**

Add to `launcher/src/windows_app_uninstall.rs` (after the existing `UninstallArgs`/`parse_args`):

```rust
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
    let keep = match (
        args.iter().any(|a| a == "--keep"),
        args.iter().any(|a| a == "--wipe"),
    ) {
        (true, false) => true,
        (false, true) => false,
        _ => return None,
    };
    let wait_pid = args
        .iter()
        .position(|a| a == "--wait-pid")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<u32>().ok())?;
    let data_root = args
        .iter()
        .position(|a| a == "--data-root")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    let update_exe = args
        .iter()
        .position(|a| a == "--update-exe")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    Some(RunArgs { wait_pid, update_exe, data_root, keep })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p ws-scrcpy-web-launcher`
Expected: PASS — the four new tests plus all existing `windows_app_uninstall` tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/windows_app_uninstall.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): Phase-2 uninstall arg model (RunArgs/build/parse)"
```

---

## Task 3: `temp_copy_filename` helper + enable the `Win32_Storage_FileSystem` feature

**Files:**
- Modify: `launcher/src/windows_app_uninstall.rs` (add `temp_copy_filename`)
- Modify: `Cargo.toml` (workspace — add the windows feature)
- Test: `launcher/src/windows_app_uninstall.rs` (inline test)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn temp_copy_filename_is_pid_stamped() {
    assert_eq!(temp_copy_filename(1234), "ws-scrcpy-web-uninstall-1234.exe");
    // Distinct pids → distinct names (so concurrent/retried uninstalls don't collide).
    assert_ne!(temp_copy_filename(1), temp_copy_filename(2));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p ws-scrcpy-web-launcher temp_copy_filename_is_pid_stamped`
Expected: FAIL — `cannot find function 'temp_copy_filename'`.

- [ ] **Step 3: Write minimal implementation**

Add to `launcher/src/windows_app_uninstall.rs`:

```rust
/// Filename for the temp copy of the launcher that performs the dataRoot
/// deletion. PID-stamped so a retried/concurrent uninstall never collides.
pub fn temp_copy_filename(pid: u32) -> String {
    format!("ws-scrcpy-web-uninstall-{pid}.exe")
}
```

Then add `"Win32_Storage_FileSystem",` to the `windows` features array in the workspace `Cargo.toml` (needed for `GetTempPath2W`/`GetTempPathW` in Task 5):

```toml
windows = { version = "0.58", features = [
    "Win32_Foundation",
    "Win32_Graphics_Gdi",
    "Win32_Security",
    "Win32_Storage_FileSystem",
    "Win32_System_Console",
    "Win32_System_Environment",
    "Win32_System_JobObjects",
    "Win32_System_LibraryLoader",
    "Win32_System_Registry",
    "Win32_System_RemoteDesktop",
    "Win32_System_Threading",
    "Win32_UI_Shell",
    "Win32_UI_WindowsAndMessaging",
] }
```

- [ ] **Step 4: Run test + build to verify**

Run: `cargo test -p ws-scrcpy-web-launcher temp_copy_filename_is_pid_stamped`
Expected: PASS.
Run: `cargo build -p ws-scrcpy-web-launcher`
Expected: builds clean (the new feature compiles; nothing uses it yet).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/windows_app_uninstall.rs Cargo.toml
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): temp_copy_filename + enable Win32_Storage_FileSystem"
```

---

## Task 4: Extract `run_update_exe` + `remove_targets`; rename legacy `run_uninstall` → `run_uninstall_in_place`

This is a pure refactor of the existing `run_uninstall` to share code between the legacy fallback (Phase 1) and the new cleaner (Phase 2). Behavior is unchanged; existing tests stay green.

**Files:**
- Modify: `launcher/src/windows_app_uninstall.rs`

- [ ] **Step 1: Refactor — extract the two helpers and rename**

Replace the existing `fn run_uninstall(a: &UninstallArgs) -> i32 { ... }` with:

```rust
/// Run `Update.exe --uninstall` (Velopack: Program Files + ARP + the
/// --veloapp-uninstall service/tray hook). Best-effort; logs (if logging is
/// enabled) and returns regardless — the app is being removed either way.
fn run_update_exe(update_exe: &str) {
    let argv = vec![update_exe.to_string(), "--uninstall".to_string()];
    let (cmd, rest) = argv.split_first().expect("update_exe_step is always non-empty");
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) if s.success() => {
            log::info(&format!("windows-app-uninstall: Update.exe ok ({})", argv.join(" ")))
        }
        Ok(s) => log::error(&format!(
            "windows-app-uninstall: Update.exe non-zero ({:?}): {}",
            s.code(),
            argv.join(" ")
        )),
        Err(e) => log::error(&format!(
            "windows-app-uninstall: Update.exe spawn failed: {} ({e})",
            argv.join(" ")
        )),
    }
}

/// Remove each dataRoot target, retrying up to `attempts` times with a short
/// delay between tries to absorb residual handle-release lag (e.g. the
/// originating helper exiting). Best-effort: logs and continues on failure.
fn remove_targets(targets: &[String], attempts: u32) {
    for target in targets {
        let path = std::path::Path::new(target);
        let mut last_err: Option<std::io::Error> = None;
        for attempt in 0..attempts.max(1) {
            if !path.exists() {
                last_err = None;
                break;
            }
            let result = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
            match result {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    if attempt + 1 < attempts.max(1) {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
            }
        }
        match last_err {
            None => log::info(&format!("windows-app-uninstall: removed {target}")),
            Some(e) => log::error(&format!(
                "windows-app-uninstall: could not remove {target}: {e}"
            )),
        }
    }
}

/// Legacy in-place uninstall: run Update.exe then delete the dataRoot targets
/// from THIS process. Used only as the Phase-1 fallback when the temp-copy
/// cleaner cannot be staged (copy/spawn failure). Known to orphan the
/// running-helper's own directory on --wipe — no worse than pre-fix behavior.
fn run_uninstall_in_place(a: &UninstallArgs) -> i32 {
    log::info(&format!(
        "windows-app-uninstall(in-place fallback): update_exe={:?} data_root={:?} keep={}",
        a.update_exe, a.data_root, a.keep
    ));
    let plan = windows_app_uninstall_commands(&a.update_exe, &a.data_root, a.keep);
    run_update_exe(&a.update_exe);
    remove_targets(&plan.data_root_targets, 1);
    0
}
```

> Note: `update_exe_step` from `UninstallPlan` is no longer consumed by the runtime path (the builder + its tests stay — `run_update_exe` builds the same argv). Leave `UninstallPlan.update_exe_step` and its tests in place; they document the contract.

- [ ] **Step 2: Update `handle()` to call the fallback name for now**

In `handle()`, change the dispatch target from `run_uninstall(&a)` to `run_uninstall_in_place(&a)` (Task 5 re-points it to `run_bootstrap`):

```rust
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
    Some(run_uninstall_in_place(&a))
}
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `cargo test -p ws-scrcpy-web-launcher`
Expected: PASS — all existing tests (builders, `parse_args`, `handle_*`) plus Tasks 2-3 tests green. (`handle_returns_error_code_on_invalid_args` still returns `Some(2)`; `handle_returns_none_when_flag_absent` still `None`.)

- [ ] **Step 4: Lint**

Run: `cargo clippy -p ws-scrcpy-web-launcher -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/windows_app_uninstall.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "refactor(launcher): extract run_update_exe/remove_targets; rename legacy in-place uninstall"
```

---

## Task 5: Phase 1 — `resolve_temp_dir` + `run_bootstrap`; re-point `handle()`

This is `#[cfg(windows)]` Win32 orchestration. The testable logic (arg vector, temp filename) is already covered in Tasks 2-3; this task wires the I/O and is verified by `cargo build` + `clippy` + the VM smoke (15.2).

**Files:**
- Modify: `launcher/src/windows_app_uninstall.rs`

- [ ] **Step 1: Add `resolve_temp_dir` (Win32)**

```rust
/// Resolve the context-appropriate temp directory: the user's temp under a
/// user token, `C:\Windows\SystemTemp` (hardened) under a SYSTEM/system-service
/// token. `GetTempPath2W` is the SYSTEM-safe API (Win10 1903+); fall back to
/// `GetTempPathW`. Returns `None` if both fail (caller falls back to in-place).
#[cfg(windows)]
fn resolve_temp_dir() -> Option<std::path::PathBuf> {
    use windows::Win32::Storage::FileSystem::{GetTempPath2W, GetTempPathW};
    // MAX_PATH (260) + 1, per the Win32 contract for these calls.
    let mut buf = [0u16; 261];
    // Returns the length (excluding NUL) on success, 0 on failure.
    let mut len = unsafe { GetTempPath2W(Some(&mut buf)) };
    if len == 0 {
        len = unsafe { GetTempPathW(Some(&mut buf)) };
    }
    if len == 0 {
        return None;
    }
    let s = String::from_utf16_lossy(&buf[..len as usize]);
    Some(std::path::PathBuf::from(s))
}
```

> If `cargo build` reports a signature mismatch for `GetTempPath2W`/`GetTempPathW` in windows 0.58 (e.g. it wants `(u32, PWSTR)` instead of `Option<&mut [u16]>`), adapt to the crate's actual signature — allocate the `[u16; 261]` buffer and pass it per that form. The logic (try 2W, fall back to W, UTF-16→PathBuf) is unchanged.

- [ ] **Step 2: Add `run_bootstrap` (Win32)**

```rust
/// Phase 1: copy this launcher to temp and spawn it as the logging-disabled
/// cleaner (Phase 2) with the uninstall params + our own pid as --wait-pid,
/// then return so the process can exit (releasing the running-exe lock on the
/// staged launcher under dataRoot). Falls back to the legacy in-place
/// uninstall if temp resolution / self-copy / spawn fails.
#[cfg(windows)]
fn run_bootstrap(a: &UninstallArgs) -> i32 {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW = 0x08000000 (mirrors spawn.rs). The temp copy survives
    // our exit: the uninstall helper runs outside any kill-on-job-close job.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let pid = std::process::id();

    let temp_dir = match resolve_temp_dir() {
        Some(d) => d,
        None => {
            log::error("windows-app-uninstall: temp dir unresolved; falling back to in-place");
            return run_uninstall_in_place(a);
        }
    };
    let src = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::error(&format!("windows-app-uninstall: current_exe failed: {e}; in-place fallback"));
            return run_uninstall_in_place(a);
        }
    };
    let dst = temp_dir.join(temp_copy_filename(pid));
    if let Err(e) = std::fs::copy(&src, &dst) {
        log::error(&format!("windows-app-uninstall: self-copy to {dst:?} failed: {e}; in-place fallback"));
        return run_uninstall_in_place(a);
    }

    let run_args = build_run_args(pid, a.keep, &a.data_root, &a.update_exe);
    log::info(&format!("windows-app-uninstall: staged cleaner at {dst:?}; spawning + exiting"));
    match std::process::Command::new(&dst)
        .args(&run_args)
        .current_dir(&temp_dir) // CWD in temp, never under dataRoot
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(_child) => 0, // detached; do NOT wait — exit so the lock releases
        Err(e) => {
            log::error(&format!("windows-app-uninstall: spawn cleaner failed: {e}; in-place fallback"));
            run_uninstall_in_place(a)
        }
    }
}
```

- [ ] **Step 3: Re-point `handle()` to `run_bootstrap`**

In `handle()`, change `Some(run_uninstall_in_place(&a))` → `Some(run_bootstrap(&a))`.

- [ ] **Step 4: Build + lint**

Run: `cargo build -p ws-scrcpy-web-launcher`
Expected: builds clean (fix any FFI signature per the Step-1 note).
Run: `cargo clippy -p ws-scrcpy-web-launcher -- -D warnings`
Expected: clean.
Run: `cargo test -p ws-scrcpy-web-launcher`
Expected: PASS — pure tests unaffected (no test calls `run_bootstrap`; it does real I/O).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/windows_app_uninstall.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): Phase-1 bootstrap — self-copy to temp + spawn cleaner"
```

---

## Task 6: Phase 2 — `wait_for_pid` + `run_cleaner` + `handle_run`

**Files:**
- Modify: `launcher/src/windows_app_uninstall.rs`

- [ ] **Step 1: Add `wait_for_pid` (Win32)**

```rust
/// Best-effort wait for process `pid` to exit, up to `timeout_ms`. Opens the
/// process for SYNCHRONIZE and waits on its handle. If the handle can't be
/// opened (already exited, or PID reused) we just return — the caller's
/// delete-retry is the actual guarantee that the lock has cleared.
#[cfg(windows)]
fn wait_for_pid(pid: u32, timeout_ms: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(handle) => {
                let _ = WaitForSingleObject(handle, timeout_ms);
                let _ = CloseHandle(handle);
            }
            Err(_) => { /* already gone / not openable — proceed to delete-retry */ }
        }
    }
}
```

> Confirm against windows 0.58: `OpenProcess(PROCESS_SYNCHRONIZE, BOOL/bool, u32) -> Result<HANDLE>`, `WaitForSingleObject(HANDLE, u32) -> WAIT_EVENT`, `CloseHandle(HANDLE) -> Result<()>`. `install_acl.rs` already uses `WaitForSingleObject`/`CloseHandle`/`GetExitCodeProcess` from the same modules — match its call form.

- [ ] **Step 2: Add `run_cleaner` (Win32)**

```rust
/// Phase 2 (runs from the temp copy, logging disabled): wait for the
/// originating helper to exit, run Update.exe --uninstall, then delete the
/// dataRoot targets with a bounded retry. The copy then exits and remains in
/// temp (self-managing). Returns 0 (best-effort throughout).
#[cfg(windows)]
fn run_cleaner(a: &RunArgs) -> i32 {
    // No logging: append() would create_dir_all(<dataRoot>/logs) and resurrect
    // the data root after the wipe. Must be the first thing we do.
    log::disable();

    // Wait for the originating helper (its exe lives under dataRoot\control) to
    // exit so its image lock releases. 30s cap; the delete-retry is the real
    // guarantee, so a timeout or PID-reuse mismatch is non-fatal.
    wait_for_pid(a.wait_pid, 30_000);

    run_update_exe(&a.update_exe);

    let plan = windows_app_uninstall_commands(&a.update_exe, &a.data_root, a.keep);
    // ~5s of retry (10 × 500ms) to absorb residual handle-release lag.
    remove_targets(&plan.data_root_targets, 10);
    0
}
```

- [ ] **Step 3: Add `handle_run` dispatch entry**

```rust
/// Dispatch `--windows-app-uninstall-run` (the Phase-2 cleaner, the temp copy).
/// Returns `Some(exit_code)` when it owns the invocation, `None` otherwise.
#[cfg(windows)]
pub fn handle_run(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--windows-app-uninstall-run") {
        return None;
    }
    match parse_run_args(args) {
        Some(a) => Some(run_cleaner(&a)),
        None => Some(2),
    }
}
```

- [ ] **Step 4: Build + lint + test**

Run: `cargo build -p ws-scrcpy-web-launcher`
Expected: builds clean (adjust FFI per notes if needed).
Run: `cargo clippy -p ws-scrcpy-web-launcher -- -D warnings`
Expected: clean.
Run: `cargo test -p ws-scrcpy-web-launcher`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/windows_app_uninstall.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): Phase-2 cleaner — wait-pid + Update.exe + retry-delete"
```

---

## Task 7: Wire the `handle_run` dispatch in `main.rs`

**Files:**
- Modify: `launcher/src/main.rs` (add the dispatch entry beside the existing `windows_app_uninstall::handle`, ~main.rs:233-237)

- [ ] **Step 1: Add the dispatch entry**

Immediately after the existing `#[cfg(windows)] if let Some(code) = windows_app_uninstall::handle(&args) { ... }` block, add:

```rust
    // Phase 2 of the Windows in-app uninstall: the temp copy staged by
    // windows_app_uninstall::handle. Logging-disabled; waits for the original
    // to exit, runs Update.exe --uninstall, then deletes the dataRoot targets.
    // Distinct exact flag (--windows-app-uninstall-run) so it never collides
    // with the Phase-1 --windows-app-uninstall match above.
    #[cfg(windows)]
    if let Some(code) = windows_app_uninstall::handle_run(&args) {
        log::info(&format!("windows-app-uninstall-run exiting with code {code}"));
        std::process::exit(code);
    }
```

> `log::info` here runs in the temp copy *before* `run_cleaner` calls `log::disable()`. That single line would target `<temp-copy-dir>` only if DATA_ROOT resolves there; to be safe it is acceptable (it's one line, pre-disable, and the dispatch mirrors every other handler's log line). The disable inside `run_cleaner` covers all subsequent logging including the deletion.

- [ ] **Step 2: Build + lint**

Run: `cargo build -p ws-scrcpy-web-launcher`
Expected: builds clean.
Run: `cargo clippy -p ws-scrcpy-web-launcher -- -D warnings`
Expected: clean.

- [ ] **Step 3: Full crate test sweep**

Run: `cargo test -p ws-scrcpy-web-launcher -p ws-scrcpy-web-common`
Expected: PASS — full launcher + common suites green.

- [ ] **Step 4: Cross-platform compile sanity (the non-Windows crates)**

Run: `cargo build`
Expected: workspace builds on the host. (The Windows-gated code is `#[cfg(windows)]`; CI's `cross` covers the Linux target. This fix adds no Linux-path code.)

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): dispatch --windows-app-uninstall-run (Phase-2 cleaner)"
```

---

## Task 8: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a `Fixed` entry**

Under the top `[Unreleased]` (or the current working) section's `### Fixed` (create the heading if absent), add:

```markdown
### Fixed
- **Windows in-app uninstall now fully removes the data root.** The uninstall helper ran from
  `%ProgramData%\WsScrcpyWeb\control\operation-server\` — inside the tree it deleted — so a
  `--wipe` orphaned the data root (Windows can't delete a running exe, and every log line
  recreated `…\logs`). The helper now copies itself to the OS temp dir and the copy (logging
  disabled, waiting for the original to exit) performs `Update.exe --uninstall` + the dataRoot
  deletion. `--keep` continues to preserve `config.json` + `logs`.
```

- [ ] **Step 2: Verify format**

Run: `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" diff CHANGELOG.md`
Expected: a single `### Fixed` bullet added under the unreleased section, Keep-a-Changelog style.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): windows uninstall wipe self-deletion fix"
```

---

## Task 9: Smoke-doc fixes (the two flagged discrepancies)

**Files:**
- Modify: `docs/smoke-tests/smoke-checklist.md` (tag → beta.52; add Windows in-app-uninstall batch)
- Modify: `docs/smoke-tests/smoke-full.md` (tag → beta.52)

- [ ] **Step 1: Bump the smoke-target tag in both docs**

In `docs/smoke-tests/smoke-checklist.md` line 3 and `docs/smoke-tests/smoke-full.md` line 3, change:

```
> **Smoke target: `v0.1.30-beta.50`** — bump this one line each release; everything below is version-agnostic.
```
to:
```
> **Smoke target: `v0.1.30-beta.52`** — bump this one line each release; everything below is version-agnostic.
```

- [ ] **Step 2: Add the Windows in-app-uninstall batch to the checklist**

In `docs/smoke-tests/smoke-checklist.md`, after the `## #15 — App-section UX (Linux)` section and before `## Global pass criteria`, insert (these mirror `smoke-full.md` Module 15; `[W]` tags disambiguate from the Linux `15.x` rows in `#15`):

```markdown
## #16 — Windows App-section: in-app uninstall + stop-exit 🪟 *(drive from smoke-full Module 15)*

New in beta.51, fixed in beta.52 (wipe self-deletion). Run on the clean Win11 snapshot after the MSI install.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **15.1** `[W]` In-app uninstall — keep | MSI install → Settings → **App** → **uninstall** → keep **checked** (default) → uninstall | **One UAC** (Update.exe self-elevates — VM decision #1); `C:\Program Files\WsScrcpyWeb\` gone; service gone (`sc query WsScrcpyWeb` → not found); tray gone; **ARP entry gone**; `config.json` + `logs\` **survive** under `%ProgramData%\WsScrcpyWeb`, `dependencies\` gone; reinstall reuses the saved port |
| ☐ **15.2** `[W]` In-app uninstall — wipe | Same but **uncheck** keep | As 15.1, **and the whole `%ProgramData%\WsScrcpyWeb` is gone** — incl. `control\operation-server\` (the beta.52 fix: the temp-copy cleaner removes it after the original exits). Confirm **no** leftover dir |
| ☐ **15.3** `[W]` Uninstall modal UX | Open the uninstall modal | Top-layer overlay above Settings; **cancel** white-outline, **uninstall** red text+border; keep checkbox **checked by default**; cancel / Esc / backdrop = no action |
| ☐ **15.4** `[W]` Stop-exit reaps tray + adb | Local mode, device + stream live → Settings → **App** → **stop server & exit** | Tab closes / "app stopped"; Task Manager shows **no** lingering `ws-scrcpy-web-launcher.exe` / `node.exe` / `ws-scrcpy-web-tray.exe` / `adb.exe` |
| ☐ **15.5** `[W]` App-section order | Settings → App | Order top→bottom: **reset prompts → stop server & exit → uninstall ws-scrcpy-web** (no "install for all users" on Windows) |
```

- [ ] **Step 3: Verify**

Run: `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" diff docs/smoke-tests/`
Expected: tag bumped to beta.52 in both files; the `#16` Windows batch added to the checklist.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add docs/smoke-tests/smoke-checklist.md docs/smoke-tests/smoke-full.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(smoke): target beta.52 + add Windows in-app-uninstall batch"
```

---

## Task 10: Open the `release:beta` PR (auto-release cuts beta.52)

Per the project's auto-release convention: **one `release:beta` PR, do NOT manually bump the version** — auto-release Mode 1 opens the bump PR and Mode 2 tags + builds `v0.1.30-beta.52`. (See `reference_wsscrcpy_version_bump`, `master_github_releases`.)

**This task is the handoff to the finishing-a-development-branch flow — execute it only after Tasks 1-9 are merged-ready and all verification is green.**

- [ ] **Step 1: Push the branch**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin fix-windows-uninstall-wipe-self-deletion
```

- [ ] **Step 2: Open the PR with the `release:beta` label**

```bash
gh pr create --repo bilbospocketses/ws-scrcpy-web --label release:beta \
  --title "fix: windows in-app uninstall fully wipes data root (temp-copy cleaner)" \
  --body "<summary of the spec: the three leftover mechanisms + the two-phase temp-copy cleaner; links the spec/plan; notes ServiceApi unchanged; notes VM smoke 15.2 is the runtime gate>"
```

- [ ] **Step 3: Wait for CI green, then squash-merge**

Per the signed-repo rule, squash-merge only:

```bash
gh pr merge --repo bilbospocketses/ws-scrcpy-web --squash --delete-branch --auto <PR#>
```

- [ ] **Step 4: Confirm the auto-release produced beta.52**

After the bump PR + tag flow completes, verify `/releases/latest` = `v0.1.30-beta.52` (prerelease=false, Velopack-discoverable) and CI green on `main`. This is the build the smoke runs against.

---

## Self-Review (writing-plans)

**1. Spec coverage:**
- Three leftover mechanisms → closed: running-exe lock (Task 5 bootstrap + Task 6 wait/retry), CWD lock (Task 5 `current_dir(temp)`), log-recreation (Task 1 `disable()` + Task 6 first line). ✅
- Phase 1 (GetTempPath2W → copy → spawn → exit, legacy fallback) → Task 5. ✅
- Phase 2 (disable → wait → Update.exe → retry-delete, lives in temp) → Task 6. ✅
- `GetTempPath2W` + `GetTempPathW` fallback → Task 5 + Task 3 feature enable. ✅
- `ServiceApi.ts` unchanged → no task touches it (verified: the phase split is internal). ✅
- Error handling (copy/spawn fallback; wait timeout; Update.exe failure; delete-retry) → Tasks 4-6. ✅
- Testing (pure unit + smoke 15.x) → Tasks 1-3 unit; smoke rows in Task 9. ✅
- Release sequencing (beta.52) + doc fixes #1/#2 → Tasks 8-10. ✅

**2. Placeholder scan:** No TBD/TODO. PR body in Task 10 Step 2 is described, not a code step (acceptable — it's prose to author at PR time). FFI signature "confirm at compile" notes are explicit, not placeholders.

**3. Type/name consistency:** `RunArgs`/`build_run_args`/`parse_run_args` (Task 2) used consistently in Tasks 5-6. `run_update_exe`/`remove_targets`/`run_uninstall_in_place` (Task 4) used in Tasks 5-6. `temp_copy_filename` (Task 3) used in Task 5. `resolve_temp_dir`/`run_bootstrap`/`wait_for_pid`/`run_cleaner`/`handle_run` defined then dispatched (Task 7). `log::disable`/`is_disabled` (Task 1) used in Task 6. Flags `--windows-app-uninstall-run`/`--wait-pid`/`--no-log` consistent across build/parse/dispatch. ✅
```
