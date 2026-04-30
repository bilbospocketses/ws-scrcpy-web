# Tray Auto-Start: Machine-Wide (HKLM\Run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the service-mode tray helper auto-start registration from `HKCU\...\Run` to `HKLM\...\Run` so every user logging into the machine receives a tray icon at logon, not only the installing admin. Clean up the stale HKCU value on upgrade from v0.1.24.

**Architecture:** Single Rust file change — `launcher/src/elevated_runner.rs`. Two constants flipped (registration target + new stale-cleanup target), one new helper function (`cleanup_stale_hkcu_tray_run_key`), one new call site in `install_service()`. No changes to the tray helper binary, the launcher's local-mode tray, or the install hook caller chain. The elevated install context already has the privilege required to write HKLM.

**Tech Stack:** Rust (`launcher/` crate, edition 2021), `reg.exe` (shelled out via `std::process::Command`), `cargo test` for the regression-guard unit test, manual VM verification for the registry side-effect coverage.

**Spec:** `docs/superpowers/specs/2026-04-30-tray-autostart-machine-wide-design.md`

---

## File Structure

**Files modified:**
- `launcher/src/elevated_runner.rs` — register/unregister/cleanup constants and helpers; new call site in `install_service()`

**Files unchanged but referenced** (for the agent's mental model):
- `launcher/src/hooks.rs` — already calls `unregister_tray_run_key()`; same call site, now hits HKLM by virtue of the constant flip.
- `tray/src/main.rs` — tray helper binary; verified to have no HKCU dependencies.
- `launcher/src/tray.rs` — local-mode tray (separate code path, not affected).

**No new files. No file splits.** All changes are confined to one file with clear, narrow responsibility (helpers around the elevated install/uninstall flow).

---

## Task 1: Add regression-guard unit test for HKLM constant

**Files:**
- Modify: `launcher/src/elevated_runner.rs` (test module at the bottom)

**Why this first:** TDD. The test will fail against the current `HKCU` constant, then pass once Task 2 flips it. Cheap, permanent guard against future "let's flip back" mistakes.

- [ ] **Step 1: Add the failing test**

Append this test to the `mod tests` block at the bottom of `launcher/src/elevated_runner.rs` (the existing test module, after the `write_result_round_trips` test):

```rust
    #[test]
    fn tray_run_key_targets_hklm() {
        // Auto-start for the service-mode tray must be machine-wide so
        // every user (not only the installing admin) gets a tray at logon.
        // See docs/superpowers/specs/2026-04-30-tray-autostart-machine-wide-design.md.
        assert!(
            TRAY_RUN_KEY.starts_with(r"HKLM\"),
            "TRAY_RUN_KEY must target HKLM, got: {TRAY_RUN_KEY}"
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run from the repo root:

```bash
cargo test --manifest-path launcher/Cargo.toml -p ws-scrcpy-web-launcher tray_run_key_targets_hklm
```

Expected: FAIL with `assertion failed: TRAY_RUN_KEY.starts_with("HKLM\\")` and the actual value `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` echoed in the panic message.

If `cargo test` complains about the package name, fall back to:

```bash
cargo test --manifest-path launcher/Cargo.toml tray_run_key_targets_hklm
```

- [ ] **Step 3: Commit**

```bash
git add launcher/src/elevated_runner.rs
git commit -m "test(launcher): regression guard for HKLM\\Run tray registration"
```

The commit intentionally lands a failing test on the branch; Task 2 makes it pass. Branch is `feat/tray-hklm-autostart`, not main, so this is fine.

---

## Task 2: Flip TRAY_RUN_KEY from HKCU to HKLM

**Files:**
- Modify: `launcher/src/elevated_runner.rs:73` (docstring) and `:348` (constant)

- [ ] **Step 1: Update the docstring on `tray_helper_path` field**

Find this block near the top of the file (around line 72-74):

```rust
    /// Optional tray-helper path. If present and the file exists, we
    /// register the HKCU Run-key and spawn the tray detached.
    pub tray_helper_path: Option<String>,
```

Replace with:

```rust
    /// Optional tray-helper path. If present and the file exists, we
    /// register the HKLM Run-key (machine-wide, so every user gets a
    /// tray at logon) and spawn the tray detached for the installing
    /// admin's session.
    pub tray_helper_path: Option<String>,
```

- [ ] **Step 2: Flip the constant**

Find this line (around line 348):

```rust
const TRAY_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
```

Replace with:

```rust
const TRAY_RUN_KEY: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
```

- [ ] **Step 3: Run the regression-guard test to verify it passes**

```bash
cargo test --manifest-path launcher/Cargo.toml tray_run_key_targets_hklm
```

Expected: PASS.

- [ ] **Step 4: Run the full launcher test suite to confirm no regressions**

```bash
cargo test --manifest-path launcher/Cargo.toml
```

Expected: all tests pass. The other tests in `elevated_runner` (`handle_returns_none_when_flag_absent`, `handle_returns_exit_code_2_for_unknown_command`, `handle_returns_exit_code_3_when_args_json_missing`, `write_result_round_trips`) do not exercise registry calls and should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add launcher/src/elevated_runner.rs
git commit -m "fix(launcher): register tray auto-start under HKLM\\Run for all users

Previously the tray helper was registered under HKCU\\...\\Run from the
elevated install context, so HKCU resolved to the installing admin's
hive only. Other users on the machine never received a tray icon at
logon. Switch to HKLM\\...\\Run so Windows spawns the tray under each
user's own token at their logon.

The tray helper itself is per-user-session-clean (reads machine-wide
config from %PROGRAMDATA%, no HKCU deps), so no other changes needed."
```

---

## Task 3: Add stale-HKCU cleanup helper

**Files:**
- Modify: `launcher/src/elevated_runner.rs` (add constant + new function near the existing `register_tray_run_key` / `unregister_tray_run_key`)

- [ ] **Step 1: Add the stale-HKCU constant**

Find this block (around lines 348-349):

```rust
const TRAY_RUN_KEY: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
const TRAY_RUN_VALUE: &str = "WsScrcpyWebTray";
```

Add a new constant immediately after them:

```rust
const TRAY_RUN_KEY: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
const TRAY_RUN_VALUE: &str = "WsScrcpyWebTray";

/// Pre-v0.1.25 the tray was registered under HKCU\...\Run from the
/// elevated install context, which only wrote to the installing admin's
/// hive. We keep this path constant so install upgrades can clean up
/// that stale value. Other users' hives never had it written, so the
/// cleanup is intentionally limited to the elevated user's HKCU.
const STALE_HKCU_TRAY_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
```

- [ ] **Step 2: Add the cleanup function**

Find `pub fn unregister_tray_run_key()` (around line 362) and add a new function immediately after it (before the `#[cfg(test)]` line):

```rust
/// Best-effort delete of the pre-v0.1.25 HKCU tray Run-key value, run
/// during install to clean up upgrades from the HKCU era. "Value not
/// found" is treated as success (matches `unregister_tray_run_key`
/// semantics) — fresh installs have nothing to clean up, and that's
/// the expected post-state.
fn cleanup_stale_hkcu_tray_run_key() -> Result<(), String> {
    let out = Command::new("reg.exe")
        .args(["delete", STALE_HKCU_TRAY_RUN_KEY, "/v", TRAY_RUN_VALUE, "/f"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.to_lowercase().contains("cannot find")
            || stderr.to_lowercase().contains("system was unable to find")
        {
            return Ok(());
        }
        return Err(stderr.into_owned());
    }
    Ok(())
}
```

- [ ] **Step 3: Verify it compiles (no callers yet, so the function is dead — that's fine for this step)**

```bash
cargo build --manifest-path launcher/Cargo.toml
```

Expected: PASS with a `dead_code` warning for `cleanup_stale_hkcu_tray_run_key`. Task 4 wires the call site, which clears the warning.

If the warning is a hard error in this crate's lint config, temporarily add `#[allow(dead_code)]` above the function and remove it in Task 4. Check `launcher/Cargo.toml` and `launcher/src/main.rs` for `#![deny(dead_code)]` first; if neither has it, the warning is just a warning and you can proceed without the allow attribute.

- [ ] **Step 4: Commit**

```bash
git add launcher/src/elevated_runner.rs
git commit -m "feat(launcher): add cleanup_stale_hkcu_tray_run_key helper

Best-effort removal of the pre-v0.1.25 HKCU\\...\\Run\\WsScrcpyWebTray
value, to be called from the elevated install hook on upgrade. Mirrors
unregister_tray_run_key semantics — value-not-found treated as success."
```

---

## Task 4: Wire cleanup into install_service

**Files:**
- Modify: `launcher/src/elevated_runner.rs` — `install_service()` function, around lines 222-228

- [ ] **Step 1: Add the cleanup call after register**

Find this block in `install_service()` (around lines 219-228):

```rust
    // Tray Run-key registration is also best-effort; failure here doesn't
    // void the install (the user gets a working service, just no tray icon
    // on next login).
    if let Some(tray) = &args.tray_helper_path {
        if std::path::Path::new(tray).exists() {
            let _ = register_tray_run_key(tray);
            // Spawn the tray detached so it survives our exit.
            let _ = Command::new(tray).spawn();
        }
    }
```

Replace with:

```rust
    // Tray Run-key registration is also best-effort; failure here doesn't
    // void the install (the user gets a working service, just no tray icon
    // on next login).
    if let Some(tray) = &args.tray_helper_path {
        if std::path::Path::new(tray).exists() {
            let _ = register_tray_run_key(tray);
            // Best-effort cleanup of the pre-v0.1.25 HKCU value for the
            // installing admin. Fresh installs no-op; upgrades from the
            // HKCU era avoid a one-time double-spawn at next admin logon.
            let _ = cleanup_stale_hkcu_tray_run_key();
            // Spawn the tray detached so it survives our exit.
            let _ = Command::new(tray).spawn();
        }
    }
```

- [ ] **Step 2: Build and confirm dead-code warning is gone**

```bash
cargo build --manifest-path launcher/Cargo.toml
```

Expected: PASS, no `dead_code` warning for `cleanup_stale_hkcu_tray_run_key`.

(If you added `#[allow(dead_code)]` in Task 3 Step 3, remove it now.)

- [ ] **Step 3: Run the launcher test suite**

```bash
cargo test --manifest-path launcher/Cargo.toml
```

Expected: all tests pass. The new call site is inside `install_service()` which requires a real Servy/reg.exe environment, so it isn't exercised by unit tests — that's by design (registry side effects are covered by VM verification in Task 6).

- [ ] **Step 4: Commit**

```bash
git add launcher/src/elevated_runner.rs
git commit -m "feat(launcher): clean up stale HKCU tray Run-key on install

Call cleanup_stale_hkcu_tray_run_key() from install_service() right
after the HKLM register, so upgrades from v0.1.24 (HKCU era) don't
leave a duplicate Run-key entry pointing at the new install path.
Fresh installs no-op."
```

---

## Task 5: Whole-workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Rust workspace test suite**

```bash
cargo test --workspace
```

Expected: all tests pass across `launcher`, `tray`, `common`, and any other workspace members. The change is confined to `launcher/src/elevated_runner.rs`; nothing else should regress.

- [ ] **Step 2: Run `cargo clippy` on the whole workspace**

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: PASS. If clippy flags anything in the modified file (e.g., complaining about `let _ =` patterns or constant naming), surface it before fixing — the existing file already uses `let _ =` for best-effort calls, so clippy should be quiet here.

- [ ] **Step 3: Build the full release binary set**

```bash
npm run build
```

(From the repo root. This is the canonical full-build command per `todo_ws_scrcpy_web.md` and runs the webpack frontend build plus the Cargo release build for launcher/tray.)

Expected: PASS. The launcher binary picks up the constant change automatically; the tray binary is unchanged.

- [ ] **Step 4: Confirm the produced launcher binary contains the new HKLM string**

On Windows, run:

```bash
powershell -NoProfile -Command "Select-String -Path target/release/ws-scrcpy-web-launcher.exe -Pattern 'HKLM\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run' -Encoding utf8 | Select-Object -First 1"
```

Expected: a non-empty match line. (PowerShell's `Select-String` will treat the binary as binary-with-text-extractable; if the string is present in the .rodata section it'll match.)

If the match is empty, double-check that the build actually rebuilt the launcher (Cargo can cache aggressively if the file edit didn't invalidate). Force a rebuild:

```bash
cargo clean -p ws-scrcpy-web-launcher && npm run build
```

Then re-run the Select-String check.

- [ ] **Step 5: Confirm the binary does NOT contain the old HKCU string in a Run-key context**

```bash
powershell -NoProfile -Command "Select-String -Path target/release/ws-scrcpy-web-launcher.exe -Pattern 'HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run' -Encoding utf8 | Select-Object -First 5"
```

Expected: ONE match — the `STALE_HKCU_TRAY_RUN_KEY` constant. NOT two matches (which would mean the old `TRAY_RUN_KEY = "HKCU\..."` somehow stuck around).

If two or more matches appear, something went wrong with the Task 2 edit — re-read `launcher/src/elevated_runner.rs:348` and confirm the constant is `HKLM`.

- [ ] **Step 6: Commit any clippy fixes if needed**

If Task 5 Step 2 surfaced clippy issues you fixed, commit them now. If not, skip this step.

```bash
git add launcher/src/elevated_runner.rs
git commit -m "chore(launcher): clippy fixes for HKLM tray registration"
```

---

## Task 6: Manual VM verification (required before merge)

**Files:** none (manual testing)

This is the actual ship gate per `feedback_verify_install_on_fresh_vm.md` — fresh-VM install + multi-user verification. Cannot be automated; the VM operator (the user) executes these steps and reports results.

- [ ] **Step 1: Prep a multi-user Win11 VM**

Snapshot a Win11 VM with three accounts pre-created and able to log in:
- `Admin` — local admin, will run the installer
- `User1` — standard user
- `User2` — standard user

Take a clean snapshot before any installer runs. All test variants below revert to this snapshot.

- [ ] **Step 2: Fresh-install verification**

1. Log in as `Admin` on the clean snapshot.
2. Install the new build (Velopack Setup.exe), choose service mode.
3. Confirm tray icon appears in `Admin`'s tray within ~5s of install completion.
4. Use Fast User Switching to log in as `User1`.
5. Confirm tray icon appears in `User1`'s tray within ~2s of logon.
6. Right-click tray → "Open" — confirm browser navigates to `http://localhost:<webPort>/` and the page loads.
7. Switch to `User2`, repeat step 5 and 6.
8. Open `regedit` as `Admin`, confirm:
   - `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` = `<installRoot>\current\ws-scrcpy-web-tray.exe`
   - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray` does NOT exist for `Admin`.

Expected: all four sessions (`Admin`, `User1`, `User2`, plus a re-logon of `Admin`) get a tray icon at logon. PASS = step 3, 5, 7 all show trays; step 8 confirms registry state.

- [ ] **Step 3: Upgrade-from-v0.1.24 verification**

Revert VM to clean snapshot.

1. Log in as `Admin`. Install **v0.1.24** (the HKCU-era version), service mode.
2. Confirm `Admin` has a tray.
3. Switch to `User1`. Confirm `User1` has NO tray (this reproduces the bug we're fixing).
4. Switch back to `Admin`. Confirm `HKCU\...\Run\WsScrcpyWebTray` exists for `Admin` in regedit.
5. Sideload the new-version installer (or use in-app update if the update channel is configured), upgrade.
6. After upgrade completes, confirm `Admin`'s tray still works (re-spawned by the install hook).
7. In regedit, confirm:
   - `HKCU\...\Run\WsScrcpyWebTray` for `Admin` is GONE (cleaned up by Task 4's call).
   - `HKLM\...\Run\WsScrcpyWebTray` is PRESENT.
8. Switch to `User1`. Confirm tray icon NOW appears at logon.

Expected: step 7 + step 8 both pass = upgrade migration works.

- [ ] **Step 4: Uninstall verification**

Continuing from Step 3's VM state (or revert and re-install fresh):

1. With trays running for `Admin` and `User1`, uninstall as `Admin` via Add/Remove Programs.
2. Confirm `Admin`'s tray icon disappears (existing `taskkill` reaches it).
3. Switch to `User1`. Confirm `User1`'s tray is still running (orphaned — known limitation).
4. Click `User1`'s tray → "Open". Confirm it silently fails (browser opens to dead port, page does not load) but the tray helper does NOT crash.
5. Right-click `User1`'s tray → "Exit", confirm tray helper closes cleanly.
6. Log `User1` out and back in. Confirm no tray reappears (HKLM Run-key is gone).
7. In regedit, confirm `HKLM\...\Run\WsScrcpyWebTray` is absent.

Expected: orphan tray on `User1` is benign (silent fail on click, clean manual exit), HKLM cleared.

- [ ] **Step 5: Multi-user port-drift repro retry (§1c bug 2)**

With `User1` now able to receive a tray on the HKLM-aware build, retry the multi-user port-drift reproduction that motivated this whole investigation. This is a separate bug; just confirm the testing path is now usable. Findings go in `todo_ws_scrcpy_web.md` §1c bug 2 entry, not this plan.

- [ ] **Step 6: Record results**

In a comment on the PR (or directly in the task tracker), record:
- Pass/fail for each step above.
- Any unexpected behavior.
- Build hash / version tag tested.

Do NOT merge until Steps 2, 3, and 4 all PASS. Step 5 is informational.

---

## Task 7: Update CHANGELOG and todo file

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section)
- Modify: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/todo_ws_scrcpy_web.md` (move §1c bug 2 status note + log this fix)

- [ ] **Step 1: Update CHANGELOG.md**

Open `CHANGELOG.md` at the repo root. Find the `## [Unreleased]` section (it should exist per the project's Keep a Changelog convention from `feedback_changelog_sop.md`). Under `### Fixed` (create the heading if absent), add:

```markdown
- Service-mode tray helper now registers under `HKLM\...\Run` instead of `HKCU\...\Run`, so every user logging into the machine receives a tray icon at logon — not only the installing admin. Upgrades from v0.1.24 also clean up the stale HKCU value for the installing admin to avoid a one-time double-spawn.
```

Keep it terse — the project rule (per `todo_ws_scrcpy_web.md` Lesson 2026-04-27) is each CHANGELOG bullet ≤ 2 sentences. Engineering detail belongs in the commit messages and the spec.

- [ ] **Step 2: Update the project todo file**

Open `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/todo_ws_scrcpy_web.md`. Find §1c bug 2 (multi-user port drift, currently deferred awaiting a Procmon session). Add a note under that entry:

```markdown
**2026-04-30 unblock:** §1c bug 2 reproduction was previously gated on the multi-user tray coverage gap — non-installer users had no tray, so there was no UX surface for the port to drift in from a second session. That gap is being fixed on branch `feat/tray-hklm-autostart` (HKLM\...\Run registration + stale-HKCU cleanup, spec at `docs/superpowers/specs/2026-04-30-tray-autostart-machine-wide-design.md`). Once that lands, retry the port-drift repro per Task 6 Step 5 of the implementation plan.
```

If there's an active "tray coverage" item (there isn't yet), close it as part of this work.

- [ ] **Step 3: Commit CHANGELOG**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): tray auto-start now machine-wide (HKLM\\Run)"
```

The todo file lives outside the repo (in the global memory vault) and is not committed.

---

## Self-Review

**Spec coverage:**
- Goal 1 (every user gets tray) → Task 2 (HKLM flip).
- Goal 2 (stale HKCU cleanup on upgrade) → Tasks 3 + 4.
- Goal 3 (uninstall removes HKLM) → no code change needed; existing `unregister_tray_run_key` flips to HKLM via Task 2's constant change. Verified in Task 6 Step 4.
- Goal 4 (per-user opt-out via Startup apps tab) → no code; HKLM\Run entries appear there automatically. Verified manually in Task 6 if desired (not gated).
- Goal 5 (no tray-helper changes) → respected; only `launcher/src/elevated_runner.rs` modified.
- Non-goal (cross-session uninstall killing) → respected; orphan tray observed in Task 6 Step 4 explicitly accepts the known limitation.
- Non-goal (cross-user HKCU cleanup) → respected; cleanup limited to `STALE_HKCU_TRAY_RUN_KEY` from the elevated user's hive only.

**Placeholder scan:** No "TBD" / "TODO later" / "implement appropriately" / vague-handling phrases. Each step has the exact code or command. Tests have full assertions. Commands have exact arguments.

**Type/name consistency:**
- `TRAY_RUN_KEY`, `TRAY_RUN_VALUE`, `STALE_HKCU_TRAY_RUN_KEY`, `register_tray_run_key`, `unregister_tray_run_key`, `cleanup_stale_hkcu_tray_run_key` — all spelled identically across tasks.
- Test name `tray_run_key_targets_hklm` — used in both Task 1 and Task 2.
- Branch name `feat/tray-hklm-autostart` — already exists from the brainstorm-stage commit.

No issues found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-tray-autostart-machine-wide.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
