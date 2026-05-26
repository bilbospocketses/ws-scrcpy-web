# §40 Local-Mode Update Relaunch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix silent local-mode update failure by switching to `restart=false` + our own bat-based relaunch.

**Architecture:** Change `waitExitThenApplyUpdate` to `restart=false` for all modes. Add a local-post-stop.bat (generated on-the-fly by the supervisor) that sleeps 12s then launches the new `current/ws-scrcpy-web-launcher.exe`. Mirrors the proven service-mode post-stop pattern.

**Tech Stack:** TypeScript (one-line change), Rust (bat generation + spawn)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/server/UpdateService.ts` | Modify (1 line) | `restart` param: `!isServiceMode` → `false` |
| `src/server/__tests__/UpdateService.test.ts` | Modify | Update test assertions for `restart=false` in all modes |
| `launcher/src/supervisor.rs` | Modify (~20 lines) | Write + spawn local-post-stop.bat in apply-update branch |

---

### Task 1: Change restart param to false for all modes

**Files:**
- Modify: `src/server/UpdateService.ts:377`
- Modify: `src/server/__tests__/UpdateService.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/server/__tests__/UpdateService.test.ts`, find the existing `it.each` block that tests `applyUpdate` across all four installModes. The test currently asserts that the third argument to `waitExitThenApplyUpdate` is `!isServiceMode` (true for user/system, false for service modes). Update the assertion to expect `false` for ALL modes:

Find the assertion that looks like:
```typescript
expect(applyFn.mock.calls[0]![2]).toBe(!isServiceMode);
```

Change it to:
```typescript
expect(applyFn.mock.calls[0]![2]).toBe(false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: FAIL — user and system modes pass `true` but test expects `false`.

- [ ] **Step 3: Change the restart param**

In `src/server/UpdateService.ts`, line 377, change:

```typescript
this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, !isServiceMode);
```

to:

```typescript
this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts`

Expected: ALL tests pass.

- [ ] **Step 5: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/UpdateService.ts src/server/__tests__/UpdateService.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(§40): set restart=false for all modes — we own the relaunch"
```

---

### Task 2: Add local-post-stop.bat generation + spawn to supervisor

**Files:**
- Modify: `launcher/src/supervisor.rs`

- [ ] **Step 1: Write a unit test for the bat content generator**

Add to the test module in `supervisor.rs` (or create one if it doesn't exist):

```rust
#[test]
fn local_post_stop_bat_contains_launcher_path_and_sleep() {
    let install_root = std::path::Path::new(r"C:\Program Files\WsScrcpyWeb");
    let bat = build_local_post_stop_bat(install_root);
    assert!(bat.contains("timeout /t 12 /nobreak"));
    assert!(bat.contains(r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe"));
    assert!(bat.contains("exit /b 0"));
}
```

- [ ] **Step 2: Run cargo test to verify it fails**

Run: `cargo test -p ws-scrcpy-web-launcher` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: FAIL — `build_local_post_stop_bat` doesn't exist.

- [ ] **Step 3: Implement the bat content generator**

Add this function to `supervisor.rs`:

```rust
/// Generate a one-shot bat that sleeps through the Velopack swap window,
/// then launches the new launcher from `current/`. Written on-the-fly
/// and spawned detached by the supervisor during local-mode updates.
fn build_local_post_stop_bat(install_root: &Path) -> String {
    let launcher = install_root.join("current").join("ws-scrcpy-web-launcher.exe");
    let launcher_str = launcher.to_string_lossy();
    format!(
        "@echo off\r\n\
         timeout /t 12 /nobreak >nul\r\n\
         start \"\" \"{launcher_str}\"\r\n\
         exit /b 0\r\n"
    )
}
```

- [ ] **Step 4: Run cargo test to verify it passes**

Run: `cargo test -p ws-scrcpy-web-launcher`

Expected: PASS

- [ ] **Step 5: Wire the bat spawn into the apply-update branch**

In `supervisor.rs`, inside the `if marker.exists()` block (around line 221), AFTER the `spawn_detached_helper` call (line 232), add the bat write + spawn:

```rust
// §40 — local-mode relaunch. Write + spawn a one-shot bat that
// sleeps through the Velopack swap window, then launches the
// new current/launcher.exe. Mirrors the service-mode post-stop
// bat pattern (12s sleep + sc start → 12s sleep + start launcher).
let bat_dir = paths.data_root.join("control");
let bat_path = bat_dir.join("local-post-stop.bat");
let bat_content = build_local_post_stop_bat(&paths.install_root);
match std::fs::write(&bat_path, &bat_content) {
    Ok(()) => {
        log::info(&format!(
            "supervisor: wrote local-post-stop.bat at {bat_path:?}"
        ));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use std::process::Stdio;
            const DETACHED_PROCESS: u32 = 0x00000008;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            match std::process::Command::new(r"C:\Windows\System32\cmd.exe")
                .args(["/c", &bat_path.to_string_lossy()])
                .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => log::info(&format!(
                    "supervisor: spawned local-post-stop.bat (pid {})",
                    child.id()
                )),
                Err(e) => log::error(&format!(
                    "supervisor: failed to spawn local-post-stop.bat: {e}"
                )),
            }
        }
    }
    Err(e) => log::error(&format!(
        "supervisor: failed to write local-post-stop.bat: {e}"
    )),
}
```

- [ ] **Step 6: Update the comment block above the apply-update branch**

Replace the existing comment (lines 201-215) that says "Velopack's restart=true ... will relaunch this launcher post-swap" with accurate language:

```rust
// §40 — local-mode update relaunch. If apply-update-pending
// marker is present AND we're in local mode:
//   1. Spawn operation-server (serves "updating" page)
//   2. Write + spawn local-post-stop.bat (sleeps 12s, then
//      launches the new current/launcher.exe post-swap)
//   3. Exit — Velopack Update.exe swaps current/ (restart=false,
//      we own the relaunch via the bat)
//
// In service mode, Servy's post-stop.bat handles both the
// operation-server spawn and the sc start relaunch — gating
// to local-mode-only here keeps the two architectures from
// racing.
```

- [ ] **Step 7: Run full cargo test**

Run: `cargo test` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass.

- [ ] **Step 8: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(§40): add local-post-stop.bat for local-mode update relaunch"
```

---

### Task 3: Full verification

**Files:** None (verification only)

- [ ] **Step 1: Run tsc --noEmit**

Run: `npx tsc --noEmit` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: clean.

- [ ] **Step 2: Run full vitest suite**

Run: `npx vitest run` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass.

- [ ] **Step 3: Run full cargo test**

Run: `cargo test` from `C:/Users/jscha/source/repos/ws-scrcpy-web`

Expected: all tests pass.

---

### Task 4: CHANGELOG + version bump + beta cut

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`, `Cargo.toml` (via `npm run version:bump`)

- [ ] **Step 1: Add CHANGELOG entry**

Under `## [Unreleased]`:

```markdown
### Fixed

- **Local-mode in-app updates now work.** Velopack's `restart=true` silently failed under non-elevated user identity — the `current/` swap completed but the app was never relaunched. Fix: `restart=false` for all modes + a local-post-stop.bat (sleeps 12s for Velopack swap, then launches the new launcher). Mirrors the proven service-mode post-stop.bat pattern.
```

- [ ] **Step 2: Version bump**

Check the latest tag and bump accordingly.

- [ ] **Step 3: Commit + push + PR + tag**

Branch → push → PR → auto-merge → tag → release pipeline.

---

### Task 5: Deploy smoke test

**Smoke matrix (3 items, all local mode on Windows):**

1. **Local-mode update (same channel):** install v0.1.27 stable, trigger update to v0.1.28 → operation-server page appears → 12s later app relaunches on new version
2. **Local-mode update (cross-channel):** install a beta, switch channel to stable, update → same flow, new version
3. **Service-mode update (regression check):** install service, trigger update → existing flow still works (no regression from restart=false change — service mode was already restart=false)
