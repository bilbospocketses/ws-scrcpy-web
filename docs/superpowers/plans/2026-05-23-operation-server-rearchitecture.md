# Operation-server rearchitecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task that edits existing code embeds the verbatim current source (per `feedback_subagent_code_specificity`); subagents MUST match the embedded source exactly when locating edits — do NOT paraphrase or describe-by-name.

**Goal:** Replace the failing user-session elevated-launcher chain for service-uninstall with the existing post-stop.bat + operation-server pattern (proven via §32 upgrade flow). Eliminates UAC for uninstall, routes around the unknown elevated-launcher kill mechanism, and unifies background-operation UX.

**Architecture:** Rename `upgrade_server` → `operation_server` (generic role); broaden post-stop.bat from two-state (apply-update / no-op) to three-state (apply-update / uninstall / no-op) using marker discriminators in `<dataRoot>/control/`; add `--spawn-user-launcher` subcommand wrapping existing WTS code so post-stop.bat can drop a fresh user-session launcher after `servy-cli uninstall` completes; activate via Node-side `handleUninstall` writing the new `uninstall-pending` marker; subsume Theory D handoff for the uninstall verb. Frontend gets "Installing/Uninstalling service, please wait..." interstitial modals (visual parity; install flow stays architecturally unchanged).

**Tech Stack:** Rust 1.x (launcher/tray/common workspace), Node.js + TypeScript (server), vitest (Node tests), cargo test (Rust tests), Velopack (in-app updater), Servy (Windows service host).

**Spec:** `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`. Read it first if you're picking up this plan cold.

**Branching strategy:** Each phase below = one PR on its own branch off main. The spec + this plan ship in their own PR (current branch `spec/operation-server-rearchitecture`) BEFORE Phase 1's branch is cut. Each phase's PR squash-merges (per CLAUDE.md PR Merge Method rule — `required_signatures` rule on main; web-flow signing only happens on squash). Each merged phase = one beta cut.

---

## File Structure

### Rust (launcher) — modified across phases

| Path | Phase touched | Responsibility |
|---|---|---|
| `launcher/src/upgrade_server.rs` → `launcher/src/operation_server.rs` | Phase 1 (rename) + Phase 2 (page-text variant) | Operation-server module: bind retry, serving loop, wind-down + port-probe, helper-binary refresh, stop-marker handling |
| `launcher/assets/upgrade-server-page.html` → `launcher/assets/operation-server-page.html` | Phase 1 (rename) + Phase 2 (variant text) | Static HTML served on root; inline JS polls `/api/config`; per-operation text variant |
| `launcher/src/main.rs` | Phase 1 (mod rename + flag alias) + Phase 2 (--spawn-user-launcher dispatch) | Top-level argv dispatch |
| `launcher/src/supervisor.rs` | Phase 1 (function-call renames) | Helper refresh, stop-marker write, port-free wait |
| `launcher/src/elevated_runner.rs` | Phase 1 (path interpolation rename) + Phase 2 (three-state bat conditional + write-helper test) | `install_service`, `write_post_stop_bat` |
| `launcher/src/user_session_spawn.rs` | Phase 2 (new public handler) | Add `spawn_user_launcher_handle` for the `--spawn-user-launcher` subcommand. Wraps existing `spawn_in_active_user_session`. |

### Node (server) — modified across phases

| Path | Phase touched | Responsibility |
|---|---|---|
| `src/server/Config.ts` | Phase 4 (add `uninstallPendingMarkerPath` getter) | Path constants for marker files in `<dataRoot>/control/` |
| `src/server/api/ServiceApi.ts` | Phase 4 (`handleUninstall` rewrite — stops calling `handoffUninstallToUserSession`) + Phase 5 (delete `handoffUninstallToUserSession` body) | Service install/uninstall API endpoints |
| `src/server/__tests__/ServiceApi.test.ts` | Phase 4 (new tests for marker flow) + Phase 5 (delete obsolete handoff tests) | Vitest coverage for ServiceApi |
| `src/server/__tests__/Config.test.ts` | Phase 4 (new test for getter) | Vitest coverage for Config |

### Frontend — modified in Phase 3

| Path | Phase touched | Responsibility |
|---|---|---|
| `src/app/components/ServiceOperationModal.ts` (path tentative — confirmed during Phase 3 Task 3.2 discovery against existing modal patterns) | Phase 3 (new component) | "Installing service, please wait..." + "Uninstalling service, please wait..." interstitial UI |
| Existing service-install/uninstall click handler(s) — located via Phase 3 Task 3.2 grep | Phase 3 (wire modal) | Mount modal on click; dismount on response |
| Frontend test files for the above | Phase 3 (new tests) | Modal lifecycle coverage |

### Dead code (Phase 5)

| Path | Phase 5 action | Notes |
|---|---|---|
| `src/server/api/ServiceApi.ts::handoffUninstallToUserSession` | Delete function body + unused imports | Stops being called by Phase 4 |
| `src/server/api/ServiceApi.ts` resume-token consumption (`consumeToken` call inside `handleUninstall`) | Delete if `consumeToken` has no other callers | Audit at Phase 5 time |
| `common/src/control_marker.rs` (write/read/delete/poll for `uninstall-handoff.json`) | Delete if no other consumers | Audit at Phase 5 time |
| Tray `control_marker::poll_for_handoff` consumer | Delete if no other verb uses pattern | Audit at Phase 5 time |

---

# Phase 1 — Mechanical rename (PR #1, beta.39)

**Goal:** Pure rename + dual-write backwards compat. No behavior change. Existing installs continue to work because:
- `--upgrade-server` CLI flag is kept as an alias for `--operation-server`.
- Helper binary is written to BOTH `<dataRoot>/operation-server/` AND `<dataRoot>/upgrade-server/` on every supervisor startup.
- Stop-marker reader honors both filenames (`operation-server-stop` AND `upgrade-server-stop`).

### Task 1.1 — Create Phase 1 branch off main

- [ ] **Step 1: Verify clean state.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" status -sb
```

Expected: `## main...origin/main` (clean tree).

- [ ] **Step 2: Branch off main.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b chore/operation-server-rename
```

### Task 1.2 — Rename source file + update mod declaration + dispatch call

**Files:**
- Rename: `launcher/src/upgrade_server.rs` → `launcher/src/operation_server.rs`
- Modify: `launcher/src/main.rs:21` (mod declaration)
- Modify: `launcher/src/main.rs:94-97` (dispatch call site)

- [ ] **Step 1: Rename the source file via git mv.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" mv launcher/src/upgrade_server.rs launcher/src/operation_server.rs
```

- [ ] **Step 2: Update `launcher/src/main.rs:21`.**

Current text at line 21:

```rust
mod upgrade_server;
```

Change to:

```rust
mod operation_server;
```

- [ ] **Step 3: Update `launcher/src/main.rs:94-97`.**

Current text at lines 94-97:

```rust
    if let Some(code) = upgrade_server::handle(&args) {
        log::info(&format!("upgrade-server exiting with code {code}"));
        std::process::exit(code);
    }
```

Change to:

```rust
    if let Some(code) = operation_server::handle(&args) {
        log::info(&format!("operation-server exiting with code {code}"));
        std::process::exit(code);
    }
```

- [ ] **Step 4: Compile-check (no tests yet — just verify it builds).**

```bash
cargo build -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: build succeeds. If it errors with unresolved-module references for `upgrade_server`, you have a missed reference in supervisor.rs or elevated_runner.rs — those are Tasks 1.3 and 1.4 below. Proceed to those tasks to fix.

- [ ] **Step 5: Commit (build may still fail until Tasks 1.3-1.4 land; that's OK for this intermediate commit).**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(launcher): rename upgrade_server module to operation_server (file + main.rs)"
```

### Task 1.3 — Update upgrade_server:: references in supervisor.rs

**Files:**
- Modify: `launcher/src/supervisor.rs:133`
- Modify: `launcher/src/supervisor.rs:155`
- Modify: `launcher/src/supervisor.rs:160`
- Modify: `launcher/src/supervisor.rs:228`
- Modify: `launcher/src/supervisor.rs:242`

- [ ] **Step 1: Edit `launcher/src/supervisor.rs:133`.**

Current text at line 133:

```rust
        match crate::upgrade_server::refresh_helper_binary(&paths.data_root) {
```

Change to:

```rust
        match crate::operation_server::refresh_helper_binary(&paths.data_root) {
```

- [ ] **Step 2: Edit `launcher/src/supervisor.rs:155`.**

Current text at line 155:

```rust
            if let Err(e) = crate::upgrade_server::write_stop_marker(&paths.data_root) {
```

Change to:

```rust
            if let Err(e) = crate::operation_server::write_stop_marker(&paths.data_root) {
```

- [ ] **Step 3: Edit `launcher/src/supervisor.rs:160-163`.**

Current text at lines 160-163:

```rust
            crate::upgrade_server::wait_for_port_free(
                port,
                std::time::Duration::from_secs(5),
            );
```

Change to:

```rust
            crate::operation_server::wait_for_port_free(
                port,
                std::time::Duration::from_secs(5),
            );
```

- [ ] **Step 4: Edit `launcher/src/supervisor.rs:228-230`.**

Current text at lines 228-230:

```rust
                    let marker = crate::upgrade_server::apply_update_pending_marker(
                        &paths.data_root,
                    );
```

Change to:

```rust
                    let marker = crate::operation_server::apply_update_pending_marker(
                        &paths.data_root,
                    );
```

- [ ] **Step 5: Edit `launcher/src/supervisor.rs:242`.**

Current text at line 242:

```rust
                        crate::upgrade_server::spawn_detached_helper(&paths.data_root);
```

Change to:

```rust
                        crate::operation_server::spawn_detached_helper(&paths.data_root);
```

- [ ] **Step 6: Compile-check.**

```bash
cargo build -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: build succeeds (or fails only on elevated_runner.rs:573 — fix that in Task 1.4).

- [ ] **Step 7: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/supervisor.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(launcher): update upgrade_server:: references to operation_server:: in supervisor.rs"
```

### Task 1.4 — Update upgrade_server:: reference in elevated_runner.rs

**Files:**
- Modify: `launcher/src/elevated_runner.rs:573`

- [ ] **Step 1: Edit `launcher/src/elevated_runner.rs:573`.**

Current text at line 573:

```rust
    let helper_path = crate::upgrade_server::helper_path_for(data_root);
```

Change to:

```rust
    let helper_path = crate::operation_server::helper_path_for(data_root);
```

- [ ] **Step 2: Compile + run tests.**

```bash
cargo build -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" && cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: build succeeds AND all existing tests pass. Test counts unchanged from baseline (rename does not add or remove tests).

- [ ] **Step 3: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/elevated_runner.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(launcher): update upgrade_server:: reference to operation_server:: in elevated_runner.rs"
```

### Task 1.5 — Rename HTML asset + update include_str! and constant references

**Files:**
- Rename: `launcher/assets/upgrade-server-page.html` → `launcher/assets/operation-server-page.html`
- Modify: `launcher/src/operation_server.rs:85` (include_str! path)
- Modify: `launcher/src/operation_server.rs:398` (use site of `UPGRADING_PAGE` inside `build_response`)

- [ ] **Step 1: Rename the asset file.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" mv launcher/assets/upgrade-server-page.html launcher/assets/operation-server-page.html
```

- [ ] **Step 2: Edit `launcher/src/operation_server.rs:85`.**

Current text at line 85:

```rust
const UPGRADING_PAGE: &str = include_str!("../assets/upgrade-server-page.html");
```

Change to:

```rust
const OPERATION_PAGE: &str = include_str!("../assets/operation-server-page.html");
```

- [ ] **Step 3: Edit `launcher/src/operation_server.rs:398` (the use site inside `build_response`).**

Current text at line 398 (inside `build_response`):

```rust
    let body = UPGRADING_PAGE;
```

Change to:

```rust
    let body = OPERATION_PAGE;
```

- [ ] **Step 4: Verify no other references to `UPGRADING_PAGE` exist.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n "UPGRADING_PAGE" launcher/
```

Expected: zero matches after Steps 2-3 land.

- [ ] **Step 5: Compile + test.**

```bash
cargo build -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" && cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: build + tests pass.

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/assets/operation-server-page.html launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(launcher): rename upgrade-server-page.html to operation-server-page.html"
```

### Task 1.6 — Add `--operation-server` CLI flag; keep `--upgrade-server` as alias

**Files:**
- Modify: `launcher/src/operation_server.rs::handle` (extract argv-pattern helper for testability)
- Modify: `launcher/src/operation_server.rs` (add tests at the bottom of the existing `#[cfg(test)] mod tests` block)

- [ ] **Step 1: Add the three new tests at the bottom of the existing `#[cfg(test)] mod tests { ... }` block in `launcher/src/operation_server.rs`.**

```rust
    #[test]
    fn is_operation_server_flag_recognizes_canonical_flag() {
        let args = vec!["launcher.exe".to_string(), "--operation-server".to_string()];
        assert!(super::is_operation_server_flag(&args));
    }

    #[test]
    fn is_operation_server_flag_recognizes_legacy_upgrade_server_alias() {
        let args = vec!["launcher.exe".to_string(), "--upgrade-server".to_string()];
        assert!(super::is_operation_server_flag(&args));
    }

    #[test]
    fn is_operation_server_flag_rejects_unrelated_args() {
        let args = vec!["launcher.exe".to_string(), "--unrelated".to_string()];
        assert!(!super::is_operation_server_flag(&args));
    }
```

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" is_operation_server_flag
```

Expected: FAIL (function `is_operation_server_flag` does not exist).

- [ ] **Step 3: Refactor `handle` to use the new helper.**

Current text of the `handle` function (lines 89-94):

```rust
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--upgrade-server") {
        return None;
    }
    Some(run())
}
```

Change to:

```rust
pub fn handle(args: &[String]) -> Option<i32> {
    if !is_operation_server_flag(args) {
        return None;
    }
    Some(run())
}

/// Returns true if argv contains either the canonical `--operation-server`
/// flag OR the legacy `--upgrade-server` alias (kept for ~2 release cycles
/// so existing installs' post-stop.bat files keep working until they're
/// rewritten by a fresh install). Pure function — testable without binding
/// any port.
fn is_operation_server_flag(args: &[String]) -> bool {
    args.iter()
        .any(|a| a == "--operation-server" || a == "--upgrade-server")
}
```

- [ ] **Step 4: Run tests, verify pass.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: 3 new tests pass; all prior tests still pass.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): accept --operation-server flag; keep --upgrade-server as alias"
```

### Task 1.7 — Dual-write helper binary to both operation-server/ and upgrade-server/

**Files:**
- Modify: `launcher/src/operation_server.rs::helper_path_for` (lines 454-456)
- Modify: `launcher/src/operation_server.rs::refresh_helper_binary` (lines 442-449)
- Add: tests at the bottom of the same file's test module

- [ ] **Step 1: Add failing tests at the bottom of the `#[cfg(test)] mod tests { ... }` block.**

```rust
    #[test]
    fn helper_path_for_returns_operation_server_path() {
        let p = super::helper_path_for(std::path::Path::new(r"C:\ProgramData\WsScrcpyWeb"));
        let expected = std::path::PathBuf::from(
            r"C:\ProgramData\WsScrcpyWeb\operation-server\ws-scrcpy-web-launcher.exe",
        );
        assert_eq!(p, expected);
    }

    #[test]
    fn legacy_helper_path_for_returns_upgrade_server_path() {
        let p = super::legacy_helper_path_for(std::path::Path::new(r"C:\ProgramData\WsScrcpyWeb"));
        let expected = std::path::PathBuf::from(
            r"C:\ProgramData\WsScrcpyWeb\upgrade-server\ws-scrcpy-web-launcher.exe",
        );
        assert_eq!(p, expected);
    }

    #[test]
    fn refresh_helper_binary_writes_to_both_paths() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let data_root = tmp.path();

        // refresh_helper_binary copies std::env::current_exe(); in unit-test
        // context that's the test runner. The Ok branch is the assertion-
        // bearing branch — we only verify dual-write on success.
        if super::refresh_helper_binary(data_root).is_ok() {
            let new_path = data_root.join("operation-server").join("ws-scrcpy-web-launcher.exe");
            let legacy_path = data_root.join("upgrade-server").join("ws-scrcpy-web-launcher.exe");
            assert!(new_path.exists(), "operation-server/launcher.exe should be written");
            assert!(legacy_path.exists(), "upgrade-server/launcher.exe should also be written (dual-write compat)");
        }
    }
```

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" helper_path_for_returns_operation_server_path legacy_helper_path_for_returns_upgrade_server_path refresh_helper_binary_writes_to_both_paths
```

Expected: FAIL (`helper_path_for` still returns the upgrade-server path; `legacy_helper_path_for` doesn't exist; `refresh_helper_binary` writes only to one path).

- [ ] **Step 3: Update `helper_path_for` (line 454).**

Current text of `helper_path_for` (lines 454-456):

```rust
pub fn helper_path_for(data_root: &Path) -> PathBuf {
    data_root.join("upgrade-server").join("ws-scrcpy-web-launcher.exe")
}
```

Change to:

```rust
pub fn helper_path_for(data_root: &Path) -> PathBuf {
    data_root.join("operation-server").join("ws-scrcpy-web-launcher.exe")
}

/// Legacy helper path under `<dataRoot>/upgrade-server/`. Kept for ~2
/// release cycles so existing installs' post-stop.bat files (which
/// reference this path) keep finding a launcher binary. New code should
/// use `helper_path_for`. Removed in a follow-up PR ~2 release cycles
/// after Phase 1 ships.
pub fn legacy_helper_path_for(data_root: &Path) -> PathBuf {
    data_root.join("upgrade-server").join("ws-scrcpy-web-launcher.exe")
}
```

- [ ] **Step 4: Update `refresh_helper_binary` to dual-write.**

Current text of `refresh_helper_binary` (lines 442-449):

```rust
pub fn refresh_helper_binary(data_root: &Path) -> std::io::Result<PathBuf> {
    let helper_dir = data_root.join("upgrade-server");
    std::fs::create_dir_all(&helper_dir)?;
    let helper_path = helper_dir.join("ws-scrcpy-web-launcher.exe");
    let current = std::env::current_exe()?;
    std::fs::copy(&current, &helper_path)?;
    Ok(helper_path)
}
```

Change to:

```rust
pub fn refresh_helper_binary(data_root: &Path) -> std::io::Result<PathBuf> {
    let current = std::env::current_exe()?;

    // Canonical (new) location.
    let new_dir = data_root.join("operation-server");
    std::fs::create_dir_all(&new_dir)?;
    let new_path = new_dir.join("ws-scrcpy-web-launcher.exe");
    std::fs::copy(&current, &new_path)?;

    // Legacy location — dual-write so existing post-stop.bat files
    // (referencing <dataRoot>/upgrade-server/launcher.exe) keep working
    // through the transitional period. Best-effort; legacy write
    // failure does not propagate.
    let legacy_dir = data_root.join("upgrade-server");
    let _ = std::fs::create_dir_all(&legacy_dir);
    let legacy_path = legacy_dir.join("ws-scrcpy-web-launcher.exe");
    let _ = std::fs::copy(&current, &legacy_path);

    Ok(new_path)
}
```

- [ ] **Step 5: Run tests, verify pass.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: all tests pass.

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): dual-write helper binary to operation-server/ + upgrade-server/ for backwards compat"
```

### Task 1.8 — Rename stop-marker filename; honor legacy at read time

**Files:**
- Modify: `launcher/src/operation_server.rs:57` (the `STOP_MARKER_FILENAME` constant)
- Modify: `launcher/src/operation_server.rs:111-113` (initial marker cleanup at `run()` start)
- Modify: `launcher/src/operation_server.rs:171-177` (the `if stop_marker.exists()` block inside `run()`)
- Add: pure helper `should_exit_for_stop_marker` for testability
- Add: tests

- [ ] **Step 1: Add failing tests at the bottom of the test module.**

```rust
    #[test]
    fn should_exit_for_stop_marker_returns_false_when_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(!super::should_exit_for_stop_marker(tmp.path()));
    }

    #[test]
    fn should_exit_for_stop_marker_returns_true_when_canonical_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("operation-server-stop"), b"stop").expect("write");
        assert!(super::should_exit_for_stop_marker(tmp.path()));
    }

    #[test]
    fn should_exit_for_stop_marker_returns_true_when_legacy_upgrade_server_stop_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("upgrade-server-stop"), b"stop").expect("write");
        assert!(super::should_exit_for_stop_marker(tmp.path()));
    }

    #[test]
    fn write_stop_marker_uses_canonical_filename() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let marker = super::write_stop_marker(tmp.path()).expect("write");
        assert!(
            marker.ends_with("operation-server-stop"),
            "marker file should be operation-server-stop, got: {marker:?}"
        );
    }
```

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" should_exit_for_stop_marker write_stop_marker_uses_canonical_filename
```

Expected: FAIL on all four (helper doesn't exist; constant is still `upgrade-server-stop`).

- [ ] **Step 3: Replace the constant + add a legacy alias constant.**

Current text at line 57:

```rust
const STOP_MARKER_FILENAME: &str = "upgrade-server-stop";
```

Change to:

```rust
const STOP_MARKER_FILENAME: &str = "operation-server-stop";

/// Legacy stop-marker filename. Kept as a read-time fallback for ~2 release
/// cycles so an operation-server spawned by an OLD post-stop.bat (written by
/// pre-Phase-1 installs that still call `--upgrade-server` and write the
/// legacy marker) still exits when the new launcher signals it. Writers
/// (`write_stop_marker`) always use the canonical name. Removed in a
/// follow-up PR ~2 release cycles after Phase 1 ships.
const LEGACY_STOP_MARKER_FILENAME: &str = "upgrade-server-stop";
```

- [ ] **Step 4: Add the pure helper `should_exit_for_stop_marker` somewhere in `operation_server.rs` (e.g., right after the constants block).**

```rust
/// Returns true if either the canonical or legacy stop marker is present
/// under `<data_root>/control/`. Pure function — no I/O side effects beyond
/// the existence checks. Extracted from `run()`'s polling loop for unit-
/// testability + dual-name support per Phase 1 of the operation-server
/// rearchitecture.
pub fn should_exit_for_stop_marker(data_root: &Path) -> bool {
    let dir = data_root.join("control");
    dir.join(STOP_MARKER_FILENAME).exists() || dir.join(LEGACY_STOP_MARKER_FILENAME).exists()
}
```

- [ ] **Step 5: Update `run()` initial cleanup block (lines 111-113).**

Current text at lines 111-113:

```rust
    let stop_marker = data_root.join("control").join(STOP_MARKER_FILENAME);
    // Clean any stale marker from a prior upgrade so we don't insta-exit.
    let _ = std::fs::remove_file(&stop_marker);
```

Change to:

```rust
    let control_dir = data_root.join("control");
    // Clean any stale markers (both canonical + legacy filenames) from a
    // prior operation so we don't insta-exit.
    let _ = std::fs::remove_file(control_dir.join(STOP_MARKER_FILENAME));
    let _ = std::fs::remove_file(control_dir.join(LEGACY_STOP_MARKER_FILENAME));
```

- [ ] **Step 6: Update the `run()` serving-loop stop-marker check (lines 171-177).**

Current text at lines 171-177:

```rust
        if stop_marker.exists() {
            log::info(&format!(
                "upgrade-server: stop marker present at {stop_marker:?}, entering wind-down"
            ));
            let _ = std::fs::remove_file(&stop_marker);
            return wind_down(listener, redirect_state, port);
        }
```

Change to:

```rust
        if should_exit_for_stop_marker(&data_root) {
            log::info(&format!(
                "operation-server: stop marker present under {:?}/control/, entering wind-down",
                data_root
            ));
            // Clean up BOTH possible marker filenames so a residual legacy
            // marker doesn't immediately re-trigger wind-down on the next
            // operation-server instance.
            let cleanup_dir = data_root.join("control");
            let _ = std::fs::remove_file(cleanup_dir.join(STOP_MARKER_FILENAME));
            let _ = std::fs::remove_file(cleanup_dir.join(LEGACY_STOP_MARKER_FILENAME));
            return wind_down(listener, redirect_state, port);
        }
```

- [ ] **Step 7: Run tests, verify pass.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: all tests pass, including the 4 new ones.

- [ ] **Step 8: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): rename stop marker to operation-server-stop; read legacy upgrade-server-stop for compat"
```

### Task 1.9 — Update post-stop.bat to use --operation-server flag

**Files:**
- Modify: `launcher/src/elevated_runner.rs::write_post_stop_bat` (the `start "" /b` line around line 623)

- [ ] **Step 1: Add failing tests at the bottom of `launcher/src/elevated_runner.rs`'s `#[cfg(test)] mod tests` block.**

```rust
    #[test]
    fn write_post_stop_bat_uses_operation_server_flag() {
        let tmp = tempdir().unwrap();
        let bat_path = super::write_post_stop_bat(tmp.path(), "WsScrcpyWeb").expect("write");
        let content = std::fs::read_to_string(&bat_path).expect("read");
        assert!(
            content.contains("--operation-server"),
            "bat should use --operation-server flag: {content}"
        );
        assert!(
            !content.contains("--upgrade-server"),
            "bat should NOT use legacy --upgrade-server flag in newly-generated content: {content}"
        );
    }

    #[test]
    fn write_post_stop_bat_uses_operation_server_helper_path() {
        let tmp = tempdir().unwrap();
        let bat_path = super::write_post_stop_bat(tmp.path(), "WsScrcpyWeb").expect("write");
        let content = std::fs::read_to_string(&bat_path).expect("read");
        assert!(
            content.contains(r"operation-server\ws-scrcpy-web-launcher.exe"),
            "bat helper path should be under operation-server/: {content}"
        );
    }
```

(Verify `tempfile::tempdir as tempdir` is already imported at the top of the test module — it is, per existing test imports. If not, add `use tempfile::tempdir;`.)

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" write_post_stop_bat_uses_operation_server_flag write_post_stop_bat_uses_operation_server_helper_path
```

Expected: FAIL (bat still references `--upgrade-server` and `upgrade-server\`).

The helper-path assertion may already pass because Task 1.7 changed `helper_path_for` to return the new path. The flag assertion will FAIL until Step 3.

- [ ] **Step 3: Edit the bat template — change `--upgrade-server` to `--operation-server`.**

Current text inside `write_post_stop_bat` (line 623 specifically):

```rust
         \x20\x20\x20\x20\x20\x20\x20\x20start \"\" /b \"{helper}\" --upgrade-server\r\n\
```

Change to:

```rust
         \x20\x20\x20\x20\x20\x20\x20\x20start \"\" /b \"{helper}\" --operation-server\r\n\
```

- [ ] **Step 4: Run tests, verify pass.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: all tests pass including the 2 new ones.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/elevated_runner.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): post-stop.bat uses --operation-server flag + operation-server/ helper path"
```

### Task 1.10 — Rename "upgrade-server:" log prefixes to "operation-server:"

**Files:**
- Modify: `launcher/src/operation_server.rs` lines 97, 102, 109, 127, 133, 147, 152, 168, 173, 180, 204, 218, 233, 247, 253, 266, 478, 502, 505, 511

These are all `log::info(...)` / `log::error(...)` / `&format!(...)` string-literal prefixes that need a single text substitution: `upgrade-server:` → `operation-server:`. Exactly 20 string literals to edit per the grep below.

- [ ] **Step 1: Confirm the line set.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n '"upgrade-server:' launcher/src/operation_server.rs
```

Expected: 20 matches at the line numbers listed above (give or take if prior edits have shifted lines).

- [ ] **Step 2: For each match, change the string-literal prefix.**

For example, line 97 currently reads:

```rust
    log::info("upgrade-server: starting");
```

Change to:

```rust
    log::info("operation-server: starting");
```

Apply the same substitution at lines 102, 109, 127, 133, 147, 152, 168, 173, 180, 204, 218, 233, 247, 253, 266, 478, 502, 505, 511. The substitution is always literal `upgrade-server:` → `operation-server:` inside a string literal — no other text changes.

Use the Edit tool with `replace_all: true` if you're confident the substring is unambiguous in this file (it is — `"upgrade-server:` appears only as a log prefix).

Suggested command:

```
Edit launcher/src/operation_server.rs with old_string "upgrade-server:" and new_string "operation-server:" and replace_all=true
```

- [ ] **Step 3: Verify all matches changed.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -c '"upgrade-server:' launcher/src/operation_server.rs
```

Expected: 0 (no matches remain).

- [ ] **Step 4: Compile + test.**

```bash
cargo build -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" && cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: build + tests pass. No tests should care about the exact log-prefix string.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(launcher): rename upgrade-server log prefix to operation-server in operation_server.rs"
```

### Task 1.11 — CHANGELOG entry for Phase 1

**Files:**
- Modify: `CHANGELOG.md` under `[Unreleased]` → `### Changed`

- [ ] **Step 1: Add the Phase 1 entry.**

Open `CHANGELOG.md`. Find the `[Unreleased]` section heading. Under `### Changed` (create the subsection if absent — match existing CHANGELOG formatting conventions), insert:

```markdown
- **Renamed `upgrade-server` → `operation-server` internals** (Phase 1 of the operation-server rearchitecture per `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`). Pure mechanical rename + dual-write backwards compat:
  - `launcher/src/upgrade_server.rs` → `launcher/src/operation_server.rs`
  - `launcher/assets/upgrade-server-page.html` → `launcher/assets/operation-server-page.html`
  - CLI flag `--upgrade-server` kept as alias for new `--operation-server`
  - Helper binary dual-written to both `<dataRoot>/operation-server/` and `<dataRoot>/upgrade-server/`
  - Stop marker `operation-server-stop` (canonical) with legacy `upgrade-server-stop` honored at read time
  - post-stop.bat (newly-generated) uses the new flag + path
  - No behavior change for users; existing installs continue to work via the alias + dual-write
```

- [ ] **Step 2: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): record Phase 1 operation-server rename"
```

### Task 1.12 — Full test gate + push + open PR + auto-merge

- [ ] **Step 1: Full workspace cargo test.**

```bash
cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: all tests pass across launcher + common + tray.

- [ ] **Step 2: Vitest baseline.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npm test
```

Expected: vitest baseline maintained (Phase 1 doesn't touch Node tests).

- [ ] **Step 3: Push branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin chore/operation-server-rename
```

- [ ] **Step 4: Open PR.**

```bash
gh -R bilbospocketses/ws-scrcpy-web pr create --title "chore(launcher): rename upgrade-server to operation-server (Phase 1 / 5)" --body "$(cat <<'EOF'
## Summary

Phase 1 of the operation-server rearchitecture per `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`. Pure mechanical rename + dual-write backwards compat. **No user-visible behavior change.**

- Renamed `launcher/src/upgrade_server.rs` → `launcher/src/operation_server.rs` + all internal identifiers.
- Renamed `launcher/assets/upgrade-server-page.html` → `launcher/assets/operation-server-page.html`.
- Added `--operation-server` CLI flag; kept `--upgrade-server` as alias (read at handle-time only) for ~2 release cycles.
- Helper binary dual-written to both `<dataRoot>/operation-server/` (canonical) and `<dataRoot>/upgrade-server/` (legacy compat).
- Stop marker renamed to `operation-server-stop` (canonical); reader honors legacy `upgrade-server-stop` for transitional period.
- post-stop.bat (newly generated) uses new flag + new helper path; existing installs continue to work via alias + dual-write.
- Added 7 new unit tests covering the dual-name behavior; existing tests carry over unchanged.

## Test plan

- [x] `cargo test` — all green across launcher + common + tray crates
- [x] `npm test` — vitest baseline unchanged
- [ ] Manual VM smoke (light): install + uninstall + apply-update on a clean Velopack install. All three should work via existing flows.
- [ ] Upgrade smoke: install pre-Phase-1 beta, then in-app-update to Phase-1 beta. Existing `<dataRoot>/upgrade-server/` directory should keep working; new `<dataRoot>/operation-server/` directory gets populated on first supervisor startup.

Subsequent phases per spec: Phase 2 (launcher uninstall capability, dormant) → Phase 3 (frontend modals) → Phase 4 (Node activation, user-visible flip) → Phase 5 (dead-code sweep).
EOF
)" --base main
```

- [ ] **Step 5: Enable auto-merge (squash).**

```bash
gh -R bilbospocketses/ws-scrcpy-web pr merge --squash --delete-branch --auto
```

Wait for CI green. When the PR auto-merges, the squash commit lands on main with `web-flow` signature (per CLAUDE.md PR Merge Method rule).

### Task 1.13 — Cut beta.39 release

- [ ] **Step 1: Pull merged main.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
```

- [ ] **Step 2: Version bump per project convention.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npm run version:bump 0.1.25-beta.39
```

(Per `reference_wsscrcpy_version_bump.md` — bumps package.json + Cargo.toml synchronously.)

- [ ] **Step 3: Version-bump PR + auto-merge.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b chore/release-beta-39
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add -u
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(release): v0.1.25-beta.39 — operation-server rename"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin chore/release-beta-39
gh -R bilbospocketses/ws-scrcpy-web pr create --title "chore(release): v0.1.25-beta.39" --body "Phase 1 of operation-server rearchitecture. See main PR for details." --base main
gh -R bilbospocketses/ws-scrcpy-web pr merge --squash --delete-branch --auto
```

- [ ] **Step 4: Push annotated signed tag after PR merges.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" tag -as v0.1.25-beta.39 -m "v0.1.25-beta.39 — operation-server rename (Phase 1/5)"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push origin v0.1.25-beta.39
```

release.yml fires. Verify with `gh -R bilbospocketses/ws-scrcpy-web release view v0.1.25-beta.39` once CI completes.

**End of Phase 1.**

---

# Phase 2 — Launcher uninstall capability (dormant) (PR #2, beta.40)

**Goal:** Add the Rust-side capability for service uninstall via operation-server, but leave it dormant — no Node-side marker writer yet, so the new bat branch never fires in production. Smoke validation deferred to Phase 4.

### Task 2.1 — Create branch off main

- [ ] **Step 1: Verify beta.39 published.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
gh -R bilbospocketses/ws-scrcpy-web release view v0.1.25-beta.39 --json tagName,isDraft --jq '.tagName + " draft=" + (.isDraft | tostring)'
```

Expected: `v0.1.25-beta.39 draft=false`.

- [ ] **Step 2: Create branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b feat/operation-server-uninstall-launcher
```

### Task 2.2 — Add `--spawn-user-launcher` subcommand handler

**Files:**
- Modify: `launcher/src/user_session_spawn.rs` (add `spawn_user_launcher_handle` public function + tests)
- Modify: `launcher/src/main.rs` (add dispatch alongside other early-exit subcommands)

**Pre-task verification:** read `launcher/src/user_session_spawn.rs` end-to-end before editing. Confirm the existence + exact shape of `SpawnUserLauncherArgs` (struct), `spawn_in_active_user_session` (function), and the SpawnResult type. These names + types appear in the planned `spawn_user_launcher_handle` below; if the existing names differ from what's planned here, adapt accordingly (this plan was written from the spec view; the actual struct/function/method names may have evolved).

- [ ] **Step 1: Add failing tests at the bottom of `launcher/src/user_session_spawn.rs` (create `#[cfg(test)] mod tests` block if absent).**

```rust
#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    #[test]
    fn spawn_user_launcher_handle_returns_none_when_flag_absent() {
        let args = vec!["launcher.exe".to_string(), "--unrelated".to_string()];
        assert!(spawn_user_launcher_handle(&args).is_none());
    }

    #[test]
    fn spawn_user_launcher_handle_returns_exit_code_2_when_launcher_path_missing() {
        let args = vec![
            "launcher.exe".to_string(),
            "--spawn-user-launcher".to_string(),
        ];
        let result = spawn_user_launcher_handle(&args);
        assert!(result.is_some(), "flag matched");
        assert_eq!(result.unwrap(), 2, "missing --launcher-path → exit code 2");
    }

    #[test]
    fn spawn_user_launcher_handle_parses_launcher_path_arg() {
        let args = vec![
            "launcher.exe".to_string(),
            "--spawn-user-launcher".to_string(),
            "--launcher-path".to_string(),
            r"C:\nonexistent\launcher.exe".to_string(),
        ];
        let result = spawn_user_launcher_handle(&args);
        assert!(result.is_some(), "flag matched");
        // Path doesn't exist + no active interactive session in test env →
        // runtime spawn failure (code 4 or 5). Either is acceptable — assert
        // it's non-zero non-2 (so we got past argv parsing).
        let code = result.unwrap();
        assert!(code != 0 && code != 2, "expected runtime failure code (not argv error or success), got {code}");
    }
}
```

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" spawn_user_launcher_handle
```

Expected: FAIL (function does not exist).

- [ ] **Step 3: Add `spawn_user_launcher_handle` to `launcher/src/user_session_spawn.rs`.**

Add at the top of the file (after existing imports), or near the existing public function — whichever fits the file's existing organization:

```rust
/// Public entry: if argv contains `--spawn-user-launcher`, parse the
/// `--launcher-path <path>` argument and dispatch to
/// `spawn_in_active_user_session`. Returns `Some(exit_code)` if the flag
/// matched; `None` to let main.rs proceed to normal launch.
///
/// Argv shape:
///   ws-scrcpy-web-launcher.exe --spawn-user-launcher --launcher-path <abs-path>
///
/// Exit codes:
///   0 — spawn succeeded
///   2 — malformed argv (missing --launcher-path)
///   4 — spawn failed (WTS error, launcher binary not found, etc.)
///   5 — no active interactive session resolvable
///
/// Used by post-stop.bat after `servy-cli uninstall` completes, to drop a
/// fresh user-session launcher so the user lands on the local-mode UI
/// post-uninstall. See `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`
/// section "Cross-session user-session spawn (Q4)".
#[cfg(windows)]
pub fn spawn_user_launcher_handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--spawn-user-launcher") {
        return None;
    }
    let launcher_path = match args
        .iter()
        .position(|a| a == "--launcher-path")
        .and_then(|i| args.get(i + 1))
    {
        Some(p) => p.clone(),
        None => {
            crate::log::error("spawn-user-launcher: missing --launcher-path argument");
            return Some(2);
        }
    };

    let spawn_args = SpawnUserLauncherArgs {
        launcher_path: launcher_path.clone(),
        launcher_args: vec![],
    };
    let result = spawn_in_active_user_session(&spawn_args);
    if result.ok {
        crate::log::info(&format!(
            "spawn-user-launcher: spawned pid {} in session {}",
            result.pid, result.session_id
        ));
        Some(0)
    } else {
        crate::log::error(&format!(
            "spawn-user-launcher: spawn failed: {:?}",
            result.error_message
        ));
        // Distinguish "no active interactive session" (5) from other spawn
        // failures (4). Mode-string match against the canonical error
        // message from spawn_in_active_user_session; if that string ever
        // changes, this branch falls through to code 4 — that's an
        // acceptable degradation (post-stop.bat treats any non-zero as a
        // failed spawn and proceeds to exit).
        let is_no_session = result
            .error_message
            .as_deref()
            .map(|m| m.contains("no active") || m.contains("no interactive"))
            .unwrap_or(false);
        if is_no_session { Some(5) } else { Some(4) }
    }
}

#[cfg(not(windows))]
pub fn spawn_user_launcher_handle(_args: &[String]) -> Option<i32> {
    None
}
```

**IMPORTANT:** the field names (`launcher_path`, `launcher_args` on `SpawnUserLauncherArgs`; `ok`, `pid`, `session_id`, `error_message` on the spawn result) MUST match the actual `user_session_spawn.rs` types. If they differ, adapt the code above to match the existing types (this plan was written from spec-view; the verbatim-types check is what your pre-task verification step is for).

- [ ] **Step 4: Add dispatch to `launcher/src/main.rs`.**

Find the existing block of early-exit subcommand dispatches (around lines 72-115 — between `uac_requester::handle` at line 72 and `elevated_runner::handle` at line 112). Insert a new dispatch block after the `unzip_handler::handle` block (around line 82-85) and BEFORE the `operation_server::handle` block at line 94:

```rust
    // Cross-session user-launcher spawn dispatch. Invoked from post-stop.bat
    // after `servy-cli uninstall` completes, to drop a fresh user-session
    // launcher so the user lands on local-mode UI post-uninstall. Wraps
    // user_session_spawn::spawn_in_active_user_session. See spec
    // docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md.
    #[cfg(windows)]
    if let Some(code) = user_session_spawn::spawn_user_launcher_handle(&args) {
        log::info(&format!("spawn-user-launcher exiting with code {code}"));
        std::process::exit(code);
    }
```

(The `#[cfg(windows)]` attribute matches the existing `#[cfg(windows)]` on `mod user_session_spawn;` at line 22-23.)

- [ ] **Step 5: Compile + test.**

```bash
cargo build -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" && cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: build succeeds; 3 new tests pass; existing tests pass.

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/user_session_spawn.rs launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): --spawn-user-launcher subcommand wrapping WTS cross-session spawn"
```

### Task 2.3 — Broaden post-stop.bat to three-state conditional

**Files:**
- Modify: `launcher/src/elevated_runner.rs::write_post_stop_bat` (signature + body)
- Modify: `launcher/src/elevated_runner.rs::install_service` (caller — pass `servy_path` + `bin_path` through)

**Design note on the `current_launcher_path` interpolation:** the bat needs the absolute path to the launcher binary that will be spawned into the user session post-uninstall. In service mode, `args.bin_path` IS this path (per existing line 209-210: `binPath = launcherExe; startupDir = installRoot;` — `bin_path` is `<installRoot>\current\ws-scrcpy-web-launcher.exe`, the Velopack-managed current binary). We pass `&args.bin_path` directly.

- [ ] **Step 1: Add failing tests at the bottom of `launcher/src/elevated_runner.rs`'s `#[cfg(test)] mod tests` block.**

```rust
    #[test]
    fn write_post_stop_bat_contains_apply_update_branch() {
        let tmp = tempdir().unwrap();
        let bat_path = super::write_post_stop_bat(
            tmp.path(),
            "WsScrcpyWeb",
            r"C:\dependencies\servy\servy-cli.exe",
            r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe",
        ).expect("write");
        let content = std::fs::read_to_string(&bat_path).expect("read");
        assert!(content.contains("apply-update-pending"), "apply-update branch present: {content}");
        assert!(content.contains("sc start WsScrcpyWeb"), "apply-update branch invokes sc start: {content}");
    }

    #[test]
    fn write_post_stop_bat_contains_uninstall_branch() {
        let tmp = tempdir().unwrap();
        let bat_path = super::write_post_stop_bat(
            tmp.path(),
            "WsScrcpyWeb",
            r"C:\dependencies\servy\servy-cli.exe",
            r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe",
        ).expect("write");
        let content = std::fs::read_to_string(&bat_path).expect("read");
        assert!(content.contains("uninstall-pending"), "uninstall branch present: {content}");
        assert!(content.contains(r"servy-cli.exe"), "uninstall branch references servy-cli: {content}");
        assert!(content.contains("uninstall --name WsScrcpyWeb"), "uninstall branch invokes servy-cli uninstall: {content}");
        assert!(content.contains("--spawn-user-launcher"), "uninstall branch spawns fresh user-session launcher: {content}");
        assert!(content.contains(r"--launcher-path"), "uninstall branch passes --launcher-path: {content}");
    }

    #[test]
    fn write_post_stop_bat_apply_update_branch_comes_first() {
        let tmp = tempdir().unwrap();
        let bat_path = super::write_post_stop_bat(
            tmp.path(),
            "WsScrcpyWeb",
            r"C:\dependencies\servy\servy-cli.exe",
            r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe",
        ).expect("write");
        let content = std::fs::read_to_string(&bat_path).expect("read");
        let apply_idx = content.find("apply-update-pending").expect("apply-update token present");
        let uninstall_idx = content.find("uninstall-pending").expect("uninstall token present");
        assert!(
            apply_idx < uninstall_idx,
            "apply-update branch must come first (mutual-exclusion ordering)"
        );
    }
```

(Also update existing tests that call `write_post_stop_bat` with only 2 args to use the new 4-arg signature. Find them via `git grep -n "write_post_stop_bat" launcher/src/`.)

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" write_post_stop_bat
```

Expected: FAIL — function signature mismatch (4 args vs 2), and bat content lacks the uninstall branch.

- [ ] **Step 3: Update the `write_post_stop_bat` function signature + body.**

Current text at lines 555-639 (the full function, including the bat-content `format!`):

```rust
fn write_post_stop_bat(
    data_root: &std::path::Path,
    service_name: &str,
) -> Result<std::path::PathBuf, String> {
    use std::fs;

    let post_stop_dir = data_root.join("post-stop");
    fs::create_dir_all(&post_stop_dir).map_err(|e| {
        format!("create_dir_all {post_stop_dir:?} failed: {e}")
    })?;

    let bat_path = post_stop_dir.join("post-stop.bat");
    let marker_path = data_root.join("control").join("apply-update-pending");
    let marker_path_str = marker_path.to_string_lossy();
    // §32 Part 5e — helper binary path for the upgrade-server spawn.
    // Single source of truth in upgrade_server::helper_path_for so the
    // supervisor's refresh-on-startup and this install-time bat
    // interpolation can't drift apart.
    let helper_path = crate::operation_server::helper_path_for(data_root);
    let helper_path_str = helper_path.to_string_lossy();

    // 12 seconds: empirical buffer above the observed Update.exe lifetime.
    // ...
    const POST_STOP_SLEEP_SECS: u32 = 12;

    // Bat-file logic with paths and service name baked in at install time.
    // ...

    let bat = format!(
        "@echo off\r\n\
         REM ws-scrcpy-web post-stop handler (§32 Part 5e).\r\n\
         ...
         if exist \"{marker}\" (\r\n\
         \x20\x20\x20\x20del \"{marker}\"\r\n\
         \x20\x20\x20\x20if exist \"{helper}\" (\r\n\
         \x20\x20\x20\x20\x20\x20\x20\x20start \"\" /b \"{helper}\" --operation-server\r\n\
         \x20\x20\x20\x20)\r\n\
         \x20\x20\x20\x20timeout /t {sleep} /nobreak >nul\r\n\
         \x20\x20\x20\x20sc start {service}\r\n\
         )\r\n\
         exit /b 0\r\n",
        sleep = POST_STOP_SLEEP_SECS,
        marker = marker_path_str,
        helper = helper_path_str,
        service = service_name,
    );

    fs::write(&bat_path, bat.as_bytes()).map_err(|e| {
        format!("write {bat_path:?} failed: {e}")
    })?;
    Ok(bat_path)
}
```

(The `--operation-server` flag + helper-path change reflect Task 1.7 + Task 1.9 edits from Phase 1. The above is the post-Phase-1 starting state.)

Change to:

```rust
fn write_post_stop_bat(
    data_root: &std::path::Path,
    service_name: &str,
    servy_path: &str,
    current_launcher_path: &str,
) -> Result<std::path::PathBuf, String> {
    use std::fs;

    let post_stop_dir = data_root.join("post-stop");
    fs::create_dir_all(&post_stop_dir).map_err(|e| {
        format!("create_dir_all {post_stop_dir:?} failed: {e}")
    })?;

    let bat_path = post_stop_dir.join("post-stop.bat");
    let apply_marker = data_root.join("control").join("apply-update-pending");
    let apply_marker_str = apply_marker.to_string_lossy();
    let uninstall_marker = data_root.join("control").join("uninstall-pending");
    let uninstall_marker_str = uninstall_marker.to_string_lossy();
    let helper_path = crate::operation_server::helper_path_for(data_root);
    let helper_path_str = helper_path.to_string_lossy();

    // 12 seconds: empirical buffer above the observed Update.exe lifetime.
    // v0.1.25-beta.10 smoke A.2 logs showed Update.exe holding file handles
    // ~5s into its post-apply window. 12s gives Update.exe time to exit and
    // release handles before sc.exe asks SCM to start the service again.
    const POST_STOP_SLEEP_SECS: u32 = 12;

    // Three-state bat conditional (operation-server rearchitecture, Phase 2):
    //   1. apply-update-pending → existing upgrade path (Velopack)
    //   2. uninstall-pending    → operation-server uninstall path
    //   3. neither              → no-op (user-initiated stop)
    // Markers are mutually exclusive in normal flows. If both present
    // (would indicate a bug), apply-update wins per branch order; the
    // uninstall-pending marker survives for the next cycle.
    //
    // See spec: docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md

    let bat = format!(
        "@echo off\r\n\
         REM ws-scrcpy-web post-stop handler (operation-server era).\r\n\
         REM Generated by elevated_runner.rs:write_post_stop_bat at install_service time.\r\n\
         REM Bat is in <dataRoot>/post-stop/ (Velopack-untouchable); invoked via cmd.exe (OS binary).\r\n\
         REM Helper is in <dataRoot>/operation-server/ (Velopack-untouchable).\r\n\
         REM See spec: docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md\r\n\
         \r\n\
         if exist \"{apply_marker}\" (\r\n\
         \x20\x20\x20\x20del \"{apply_marker}\"\r\n\
         \x20\x20\x20\x20if exist \"{helper}\" (\r\n\
         \x20\x20\x20\x20\x20\x20\x20\x20start \"\" /b \"{helper}\" --operation-server\r\n\
         \x20\x20\x20\x20)\r\n\
         \x20\x20\x20\x20timeout /t {sleep} /nobreak >nul\r\n\
         \x20\x20\x20\x20sc start {service}\r\n\
         \x20\x20\x20\x20exit /b 0\r\n\
         )\r\n\
         \r\n\
         if exist \"{uninstall_marker}\" (\r\n\
         \x20\x20\x20\x20del \"{uninstall_marker}\"\r\n\
         \x20\x20\x20\x20if exist \"{helper}\" (\r\n\
         \x20\x20\x20\x20\x20\x20\x20\x20start \"\" /b \"{helper}\" --operation-server\r\n\
         \x20\x20\x20\x20)\r\n\
         \x20\x20\x20\x20\"{servy_path}\" uninstall --name {service}\r\n\
         \x20\x20\x20\x20\"{helper}\" --spawn-user-launcher --launcher-path \"{current_launcher}\"\r\n\
         \x20\x20\x20\x20exit /b 0\r\n\
         )\r\n\
         \r\n\
         REM Neither marker — user-initiated stop (services.msc, sc stop). No-op.\r\n\
         exit /b 0\r\n",
        sleep = POST_STOP_SLEEP_SECS,
        apply_marker = apply_marker_str,
        uninstall_marker = uninstall_marker_str,
        helper = helper_path_str,
        service = service_name,
        servy_path = servy_path,
        current_launcher = current_launcher_path,
    );

    fs::write(&bat_path, bat.as_bytes()).map_err(|e| {
        format!("write {bat_path:?} failed: {e}")
    })?;
    Ok(bat_path)
}
```

- [ ] **Step 4: Update the call site in `install_service` (around lines 202-219).**

Current text of the `write_post_stop_bat` call inside `install_service` (lines 202-214):

```rust
    let post_stop_bat: Option<std::path::PathBuf> = match args.data_root.as_deref() {
        Some(dr) => match write_post_stop_bat(std::path::Path::new(dr), &args.name) {
            Ok(path) => {
                log::info(&format!("install-service: wrote post-stop bat at {path:?}"));
                Some(path)
            }
            Err(e) => {
                log::error(&format!(
                    "install-service: failed to write post-stop bat: {e} — proceeding without postStopPath (legacy bridge path will handle recovery)"
                ));
                None
            }
        },
        None => {
            log::info("install-service: data_root not provided — skipping post-stop wiring (legacy bridge path will handle recovery)");
            None
        }
    };
```

Change to:

```rust
    let post_stop_bat: Option<std::path::PathBuf> = match args.data_root.as_deref() {
        Some(dr) => match write_post_stop_bat(
            std::path::Path::new(dr),
            &args.name,
            &args.servy_path,
            &args.bin_path,
        ) {
            Ok(path) => {
                log::info(&format!("install-service: wrote post-stop bat at {path:?}"));
                Some(path)
            }
            Err(e) => {
                log::error(&format!(
                    "install-service: failed to write post-stop bat: {e} — proceeding without postStopPath (legacy bridge path will handle recovery)"
                ));
                None
            }
        },
        None => {
            log::info("install-service: data_root not provided — skipping post-stop wiring (legacy bridge path will handle recovery)");
            None
        }
    };
```

- [ ] **Step 5: Update any pre-existing test calls to `write_post_stop_bat` (if any) to use the new 4-arg signature.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n "write_post_stop_bat" launcher/src/
```

For each call site (outside the function definition itself), update from the 2-arg form to the 4-arg form. Use placeholder paths in tests:

```rust
super::write_post_stop_bat(
    tmp.path(),
    "WsScrcpyWeb",
    r"C:\dependencies\servy\servy-cli.exe",
    r"C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-launcher.exe",
)
```

- [ ] **Step 6: Run tests, verify pass.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: all tests pass including the 3 new ones for the three-state bat.

- [ ] **Step 7: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/elevated_runner.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): post-stop.bat three-state conditional (apply-update / uninstall / no-op)"
```

### Task 2.4 — Add per-operation page-text variant to operation-server

**Files:**
- Modify: `launcher/src/operation_server.rs` (add `OperationVariant` enum + `detect_operation_variant` + plumb through `build_response` and `run`)
- Modify: `launcher/assets/operation-server-page.html` (replace hardcoded "Updating app, please wait..." with `__OPERATION_TITLE__` and add `__OPERATION_BODY__` template tokens)

**Pre-task verification:** Read `launcher/assets/operation-server-page.html` end-to-end first. Note the exact HTML structure + current hardcoded title text + where a body paragraph fits. The HTML edit in Step 5 is structure-dependent.

- [ ] **Step 1: Add failing tests at the bottom of `launcher/src/operation_server.rs` test module.**

```rust
    #[test]
    fn detect_operation_variant_returns_apply_update_when_marker_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("apply-update-pending"), b"").expect("write");
        assert_eq!(super::detect_operation_variant(tmp.path()), super::OperationVariant::ApplyUpdate);
    }

    #[test]
    fn detect_operation_variant_returns_uninstall_when_marker_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("control");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("uninstall-pending"), b"").expect("write");
        assert_eq!(super::detect_operation_variant(tmp.path()), super::OperationVariant::Uninstall);
    }

    #[test]
    fn detect_operation_variant_defaults_to_apply_update_when_no_marker() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Defensive default: matches the bat's branch order (apply-update wins
        // if both markers somehow present). Also preserves the pre-Phase-2
        // single-operation behavior for any code path that spawns the
        // operation-server without writing a marker.
        assert_eq!(super::detect_operation_variant(tmp.path()), super::OperationVariant::ApplyUpdate);
    }

    #[test]
    fn render_operation_page_substitutes_apply_update_text() {
        let html = super::render_operation_page(super::OperationVariant::ApplyUpdate);
        assert!(html.contains("Updating app, please wait"), "apply-update title present: {html}");
        assert!(!html.contains("__OPERATION_TITLE__"), "template token replaced");
    }

    #[test]
    fn render_operation_page_substitutes_uninstall_text() {
        let html = super::render_operation_page(super::OperationVariant::Uninstall);
        assert!(html.contains("Uninstalling service, please wait"), "uninstall title present: {html}");
        assert!(!html.contains("__OPERATION_TITLE__"), "template token replaced");
    }
```

- [ ] **Step 2: Run tests, verify failure.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" detect_operation_variant render_operation_page
```

Expected: FAIL (enum + functions don't exist).

- [ ] **Step 3: Add `OperationVariant` enum + `detect_operation_variant` + `render_operation_page` to `launcher/src/operation_server.rs`.**

Add after the constants block (around line 86), before the `handle` function:

```rust
/// Which operation triggered this operation-server instance? Drives the
/// wait-page text variant served to the browser. Detected once at spawn
/// time by checking which marker file exists under `<data_root>/control/`;
/// the bat that spawned us deletes the marker AFTER spawning, so on the
/// happy path the marker is still present at our startup. If both markers
/// are present (defensive edge case — would indicate a bug elsewhere),
/// ApplyUpdate wins per the bat's branch order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationVariant {
    ApplyUpdate,
    Uninstall,
}

pub fn detect_operation_variant(data_root: &Path) -> OperationVariant {
    let control = data_root.join("control");
    if control.join("apply-update-pending").exists() {
        return OperationVariant::ApplyUpdate;
    }
    if control.join("uninstall-pending").exists() {
        return OperationVariant::Uninstall;
    }
    OperationVariant::ApplyUpdate
}

/// Render the operation-server page with per-variant title + body text.
/// Uses two-token substitution on the static HTML asset:
///   __OPERATION_TITLE__ → wait-page title text
///   __OPERATION_BODY__  → brief explanatory paragraph
pub fn render_operation_page(variant: OperationVariant) -> String {
    let (title, body) = match variant {
        OperationVariant::ApplyUpdate => (
            "Updating app, please wait...",
            "ws-scrcpy-web is applying an update. The page will reload automatically when the new version is ready.",
        ),
        OperationVariant::Uninstall => (
            "Uninstalling service, please wait...",
            "ws-scrcpy-web is uninstalling its service. The page will reload automatically once the local-mode app is back up.",
        ),
    };
    OPERATION_PAGE
        .replace("__OPERATION_TITLE__", title)
        .replace("__OPERATION_BODY__", body)
}
```

- [ ] **Step 4: Plumb variant through `run` and `build_response`.**

Current text of `build_response` signature (line 351) + use site (line 398 within `build_response` referencing `OPERATION_PAGE`):

```rust
fn build_response(path: &str, redirect: Option<&str>) -> String {
    ...
    let body = OPERATION_PAGE;
    ...
}
```

Change to:

```rust
fn build_response(path: &str, redirect: Option<&str>, variant: OperationVariant) -> String {
    ...
    let body = render_operation_page(variant);
    ...
}
```

Update the existing call site in `handle_connection` (around line 344):

Current text:

```rust
    let response = build_response(path, redirect.as_deref());
```

Change to:

```rust
    let response = build_response(path, redirect.as_deref(), variant);
```

(This requires plumbing `variant` from `run()` down through `accept_one` → spawned thread → `handle_connection`. Add `variant: OperationVariant` as a `Copy` field that's cloned per spawn.)

Specifically: in `run()`, add `let variant = detect_operation_variant(&data_root);` right after the data_root resolution (around line 109). Pass `variant` through to `accept_one` and `wind_down` (both gain a `variant: OperationVariant` parameter). In `accept_one`'s `thread::spawn`, capture `variant` (it's Copy — just `let v = variant;` in scope is enough). Then `handle_connection(stream, state_clone, v)`.

The exact edits will affect ~6 callsites. Use the compile errors after Step 3+4 to guide you — each error tells you what to plumb next.

- [ ] **Step 5: Update `launcher/assets/operation-server-page.html` to use template tokens.**

Find the title text in the HTML. The existing text contains "Updating app, please wait..." (the §32 Part 5 page). Replace it with `__OPERATION_TITLE__`.

Add (or repurpose an existing paragraph node) a body paragraph using `__OPERATION_BODY__`.

(Exact edit is structure-dependent — read the HTML first, identify the title-text node and a suitable body-text location, then make minimal edits to substitute the tokens.)

- [ ] **Step 6: Run tests, verify pass.**

```bash
cargo test -p launcher --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml"
```

Expected: all tests pass including the 5 new variant-related ones.

- [ ] **Step 7: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/operation_server.rs launcher/assets/operation-server-page.html
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): operation-server detects variant (apply-update vs uninstall) + per-variant page text"
```

### Task 2.5 — CHANGELOG + full test gate + push + PR + auto-merge

- [ ] **Step 1: CHANGELOG entry under `[Unreleased]` → `### Added`.**

```markdown
- **Launcher uninstall capability via operation-server (dormant)** — Phase 2 of operation-server rearchitecture. `--spawn-user-launcher` subcommand wraps existing WTS cross-session spawn. post-stop.bat broadened from two-state (apply-update / no-op) to three-state (apply-update / uninstall / no-op) using marker discriminators in `<dataRoot>/control/`. Operation-server detects variant at spawn time and serves per-variant page text. **No user-visible behavior change** — no Node-side marker writer for uninstall yet (Phase 4 activates the user-visible flip).
```

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): record Phase 2 launcher uninstall capability (dormant)"
```

- [ ] **Step 2: Full test gate.**

```bash
cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" && cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npm test
```

Expected: all green.

- [ ] **Step 3: Push + open PR + auto-merge.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin feat/operation-server-uninstall-launcher
gh -R bilbospocketses/ws-scrcpy-web pr create --title "feat(launcher): operation-server uninstall capability (dormant) (Phase 2 / 5)" --body "$(cat <<'EOF'
## Summary

Phase 2 of the operation-server rearchitecture per `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`. **Dormant — no user-visible behavior change.**

- Added `--spawn-user-launcher` subcommand to launcher binary, wrapping existing WTS cross-session spawn from `user_session_spawn.rs`.
- Broadened post-stop.bat from two-state (apply-update / no-op) to three-state (apply-update / uninstall / no-op) using marker file discriminators in `<dataRoot>/control/`.
- Added per-operation page-text variant to operation-server. Variant detected at spawn time by checking which marker file exists; HTML asset uses `__OPERATION_TITLE__` + `__OPERATION_BODY__` template tokens.
- Path interpolations in `write_post_stop_bat` now include `servy_path` + `current_launcher_path` for the uninstall branch.
- No marker writer exists in Node yet — the uninstall branch never fires in production until Phase 4.

## Test plan

- [x] `cargo test` — all green; new tests cover spawn-user-launcher argv, three-state bat content, variant detection + page rendering.
- [x] `npm test` — vitest baseline maintained.
- [ ] Manual VM smoke (light): install + uninstall + apply-update on a Phase-1 install upgraded to Phase-2. apply-update path should continue working identically (the uninstall branch is dormant; no marker writer yet).
EOF
)" --base main
gh -R bilbospocketses/ws-scrcpy-web pr merge --squash --delete-branch --auto
```

### Task 2.6 — Cut beta.40 release

Same shape as Task 1.13 with version `0.1.25-beta.40`.

**End of Phase 2.**

---

# Phase 3 — Frontend interstitial modals (PR #3, beta.41)

**Goal:** Add "Installing service, please wait..." + "Uninstalling service, please wait..." modal UI mounted during install/uninstall pending state. Visible UI change but works on current uninstall flow (modal sits during whatever the API does); pre-deployment for Phase 4 activation.

### Task 3.1 — Branch + discovery

- [ ] **Step 1: Verify beta.40 published; create branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
gh -R bilbospocketses/ws-scrcpy-web release view v0.1.25-beta.40 --json tagName,isDraft --jq '.tagName + " draft=" + (.isDraft | tostring)'
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b feat/service-operation-modals
```

### Task 3.2 — Locate existing modal patterns + click handlers (DISCOVERY)

**Files:** discovery only — no edits.

- [ ] **Step 1: Find the existing service install/uninstall click handlers in frontend.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -rn "api/service/install\|api/service/uninstall" src/app/
```

Record file path + line numbers in scratch notes. These are the wire-in targets for Tasks 3.4 + 3.5.

- [ ] **Step 2: Find existing modal class patterns in the frontend.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -rn "class.*Modal\|mount(\|unmount(" src/app/components/ src/app/dialog*
```

Identify the modal-base class or convention (e.g., `DialogBase`, `BaseModal`, an existing utility). New `ServiceOperationModal` will follow the same pattern. Record findings.

- [ ] **Step 3: Find existing modal tests.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -rln "Modal\|Dialog" src/app/__tests__/ src/app/**/__tests__/
```

Identify test conventions (vitest setup, DOM-test helpers). New tests follow the same pattern.

The output of this task informs Tasks 3.3-3.5 implementation details. If the codebase has an existing modal base class, EXTEND IT rather than duplicate its lifecycle code. If it has a centralized modal-mount helper, USE IT.

### Task 3.3 — Add ServiceOperationModal component (TDD)

**Files:**
- Create: `src/app/components/ServiceOperationModal.ts` (or whatever path Task 3.2 discovered as the existing modal home)
- Create: corresponding test file in the codebase's existing test convention
- Modify: CSS pipeline (add modal styles — path depends on existing CSS conventions discovered in Task 3.2)

- [ ] **Step 1: Write failing test in the discovered test directory.**

Template (adapt path + import style to match Task 3.2's findings):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServiceOperationModal } from '../ServiceOperationModal';

describe('ServiceOperationModal', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        document.body.removeChild(container);
    });

    it('renders "Installing service, please wait..." for operation="install"', () => {
        const modal = new ServiceOperationModal({ operation: 'install' });
        modal.mount(container);
        expect(container.textContent).toContain('Installing service, please wait');
    });

    it('renders "Uninstalling service, please wait..." for operation="uninstall"', () => {
        const modal = new ServiceOperationModal({ operation: 'uninstall' });
        modal.mount(container);
        expect(container.textContent).toContain('Uninstalling service, please wait');
    });

    it('unmount() removes the modal from the DOM', () => {
        const modal = new ServiceOperationModal({ operation: 'install' });
        modal.mount(container);
        modal.unmount();
        expect(container.textContent).not.toContain('Installing service');
    });

    it('sets role="dialog" + aria-busy="true" for accessibility', () => {
        const modal = new ServiceOperationModal({ operation: 'install' });
        modal.mount(container);
        const dialog = container.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.getAttribute('aria-busy')).toBe('true');
    });
});
```

- [ ] **Step 2: Run test, verify failure.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npx vitest run <path-to-new-test-file>
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `ServiceOperationModal` using safe DOM construction (no `innerHTML`).**

Per `feedback_html_tag_escaping.md` (operational memory for this project) — `innerHTML` with dynamic content is unsafe. Use createElement + textContent throughout:

```typescript
// src/app/components/ServiceOperationModal.ts (adjust path per Task 3.2)

export interface ServiceOperationModalOptions {
    operation: 'install' | 'uninstall';
}

/**
 * Service-operation interstitial modal. Shows "Installing service, please wait..."
 * or "Uninstalling service, please wait..." during the corresponding API call's
 * pending state. Visual parity with the operation-server's "Updating app" page
 * served by the launcher binary (see
 * docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md).
 *
 * Lifecycle: mount on click → dismount on response. Caller triggers the actual
 * API request; this modal is purely visual.
 *
 * DOM is constructed via createElement + textContent (NOT innerHTML) per
 * feedback_html_tag_escaping.md.
 */
export class ServiceOperationModal {
    private readonly opts: ServiceOperationModalOptions;
    private element: HTMLElement | null = null;

    constructor(opts: ServiceOperationModalOptions) {
        this.opts = opts;
    }

    mount(parent: HTMLElement): void {
        const text =
            this.opts.operation === 'install'
                ? 'Installing service, please wait...'
                : 'Uninstalling service, please wait...';

        const wrapper = document.createElement('div');
        wrapper.className = 'service-operation-modal';
        wrapper.setAttribute('role', 'dialog');
        wrapper.setAttribute('aria-busy', 'true');

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const content = document.createElement('div');
        content.className = 'modal-content';

        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        spinner.setAttribute('aria-hidden', 'true');

        const paragraph = document.createElement('p');
        paragraph.textContent = text; // SAFE — textContent does NOT parse HTML

        content.appendChild(spinner);
        content.appendChild(paragraph);
        wrapper.appendChild(overlay);
        wrapper.appendChild(content);

        parent.appendChild(wrapper);
        this.element = wrapper;
    }

    unmount(): void {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
        this.element = null;
    }
}
```

- [ ] **Step 4: Add minimal CSS for the modal.**

Locate the existing modal CSS conventions (Task 3.2). Add a new rule set following the same pattern. Minimum content:

```css
.service-operation-modal {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
}

.service-operation-modal .modal-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
}

.service-operation-modal .modal-content {
    position: relative;
    background: var(--modal-bg, #ffffff);
    color: var(--modal-fg, #000000);
    padding: 24px 32px;
    border-radius: 8px;
    text-align: center;
    max-width: 90%;
}

.service-operation-modal .spinner {
    /* Match existing project spinner pattern from feedback_ui_color_scheme;
       reuse existing spinner class if available rather than recreating. */
}
```

If the project already has a reusable spinner CSS class, use it instead of creating a new one (better DRY).

- [ ] **Step 5: Run tests, verify pass.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npx vitest run <path-to-test-file>
```

Expected: 4 tests pass.

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add <files>
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): ServiceOperationModal — install/uninstall interstitial component"
```

### Task 3.4 — Wire modal into install click handler (TDD)

**Files:**
- Modify: the install click handler file (located in Task 3.2)
- Modify: corresponding test file

- [ ] **Step 1: Write failing integration test.**

Test that verifies the modal is mounted during the fetch pending state and unmounted on response. Exact shape depends on the existing test conventions discovered in Task 3.2.

Template (adapt to project's actual fetch-mock + test conventions):

```typescript
it('mounts ServiceOperationModal during install API call and unmounts on response', async () => {
    // Mock fetch to resolve after a delay.
    const fetchMock = vi.fn().mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, json: () => Promise.resolve({ ok: true, redirectTo: 'http://localhost:8001/' }) }), 50);
    }));
    global.fetch = fetchMock as typeof fetch;

    // Trigger install click via project's existing test helpers.
    const installPromise = triggerInstallClick();

    // Assert: modal mounted immediately.
    await new Promise((r) => setTimeout(r, 5));
    expect(document.body.textContent).toContain('Installing service, please wait');

    // Wait for fetch + handler completion.
    await installPromise;

    // Assert: modal unmounted.
    expect(document.body.textContent).not.toContain('Installing service, please wait');
});
```

- [ ] **Step 2: Run test, verify failure** (modal isn't wired yet).

- [ ] **Step 3: Wire the modal into the install click handler.**

Find the existing install click handler (from Task 3.2 — example pattern; actual code may differ):

```typescript
async function handleInstallClick() {
    const response = await fetch('/api/service/install', { method: 'POST', ... });
    // existing handling...
}
```

Wrap with modal:

```typescript
import { ServiceOperationModal } from './ServiceOperationModal'; // path per project structure

async function handleInstallClick() {
    const modal = new ServiceOperationModal({ operation: 'install' });
    modal.mount(document.body);
    try {
        const response = await fetch('/api/service/install', { method: 'POST', ... });
        // existing handling... (this code may include navigation — the
        // modal will be auto-unmounted on browser navigation if the page
        // unloads. unmount() in finally handles the no-navigation cases.)
        return response;
    } finally {
        modal.unmount();
    }
}
```

- [ ] **Step 4: Run test, verify pass.**

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add <files>
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): mount ServiceOperationModal during install API call"
```

### Task 3.5 — Wire modal into uninstall click handler (TDD)

Mirror of Task 3.4 with `operation: 'uninstall'`. Same TDD pattern. Find the uninstall click handler from Task 3.2 findings, wrap with modal, write paired test, verify, commit.

- [ ] **Step 1: Write failing test (mirror of Task 3.4 Step 1 with 'uninstall').**
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Add wiring (mirror of Task 3.4 Step 3 with `operation: 'uninstall'`).**
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit.**

### Task 3.6 — CHANGELOG + full test gate + push + PR + auto-merge + cut beta.41

CHANGELOG entry under `[Unreleased]` → `### Added`:

```markdown
- **Service install/uninstall interstitial modals** — Phase 3 of operation-server rearchitecture. New `ServiceOperationModal` component renders "Installing service, please wait..." or "Uninstalling service, please wait..." during pending API state. Works on current uninstall flow (modal sits during whatever the API does); pre-deployed for Phase 4 activation. Visual parity with the launcher-served "Updating app" page. DOM constructed safely (createElement + textContent, no innerHTML per feedback_html_tag_escaping).
```

PR + auto-merge + cut beta.41 per Tasks 1.12/1.13 pattern.

**End of Phase 3.**

---

# Phase 4 — Node activation (PR #4, beta.42) — USER-VISIBLE FLIP

**Goal:** Wire Node-side to write the `uninstall-pending` marker + return redirect + schedule process.exit, replacing the Theory D handoff for the service+LocalSystem context. This is the activation that makes the operation-server pattern fire for real. **Full clean-VM smoke required before merge.**

### Task 4.1 — Branch off main

- [ ] **Step 1: Verify beta.41 published.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
gh -R bilbospocketses/ws-scrcpy-web release view v0.1.25-beta.41 --json tagName,isDraft --jq '.tagName + " draft=" + (.isDraft | tostring)'
```

- [ ] **Step 2: Create branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b feat/uninstall-via-operation-server
```

### Task 4.2 — Add `uninstallPendingMarkerPath` getter to Config

**Files:**
- Modify: `src/server/Config.ts` (add new getter mirroring `applyUpdatePendingMarkerPath`)
- Modify: `src/server/__tests__/Config.test.ts` (add new test mirroring existing `applyUpdatePendingMarkerPath` test)

**Pre-task verification:** read `applyUpdatePendingMarkerPath` getter in `src/server/Config.ts` end-to-end. Match its exact shape (TypeScript syntax, null-guard pattern, doc-comment style). Read its corresponding test in `src/server/__tests__/Config.test.ts` to learn the test convention.

- [ ] **Step 1: Find existing `applyUpdatePendingMarkerPath` getter + test.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n "applyUpdatePendingMarkerPath" src/server/
```

Record the exact line(s) of the existing getter + its test. The new `uninstallPendingMarkerPath` will mirror this.

- [ ] **Step 2: Write failing test for new getter (mirror existing test).**

Read the existing `applyUpdatePendingMarkerPath` test. Add a parallel test:

```typescript
// In src/server/__tests__/Config.test.ts — match existing test conventions.
describe('Config.uninstallPendingMarkerPath', () => {
    it('returns <dataRoot>/control/uninstall-pending', () => {
        // Use the same Config-construction helper the existing
        // applyUpdatePendingMarkerPath test uses.
        const cfg = /* existing Config-construction helper from this test file */;
        // Assertion shape mirrors the existing applyUpdatePendingMarkerPath test —
        // exact assertion style (path.join vs string vs etc.) matches existing convention.
        expect(cfg.uninstallPendingMarkerPath).toBe(/* expected joined path */);
    });
});
```

- [ ] **Step 3: Run test, verify failure.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npx vitest run src/server/__tests__/Config.test.ts -t uninstallPendingMarkerPath
```

Expected: FAIL.

- [ ] **Step 4: Add the getter to `Config.ts` mirroring the existing getter.**

Locate the existing `applyUpdatePendingMarkerPath` getter. Add a sibling immediately after it:

```typescript
    /**
     * Path of the uninstall-pending marker. Written by
     * ServiceApi.handleUninstall (Node, service + LocalSystem context)
     * before process.exit(0); read by post-stop.bat which uses it as
     * the discriminator for the uninstall branch (vs apply-update).
     *
     * See spec: docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md
     * (Phase 4 — Node activation).
     */
    public get uninstallPendingMarkerPath(): string {
        // EXACT IMPLEMENTATION mirrors applyUpdatePendingMarkerPath's shape.
        // Replace the file segment 'apply-update-pending' with 'uninstall-pending'.
    }
```

- [ ] **Step 5: Run test, verify pass.**

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Config.ts src/server/__tests__/Config.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(server): Config.uninstallPendingMarkerPath getter"
```

### Task 4.3 — Replace `handleUninstall` service+LocalSystem path with marker write + redirect

**Files:**
- Modify: `src/server/api/ServiceApi.ts::handleUninstall` (specifically the `else` branch around lines 419-446 that currently calls `handoffUninstallToUserSession`)
- Modify: `src/server/__tests__/ServiceApi.test.ts` (add new tests for the marker flow)

**Pre-task verification:** read `handleUninstall` end-to-end (lines 379-602 of current ServiceApi.ts). Specifically read lines 419-446 (the service+LocalSystem branch) verbatim before editing. The verbatim current-state shown below MUST match what you read in the file at edit time; if it doesn't, the file has drifted since this plan was written — reconcile before editing.

- [ ] **Step 1: Read the verbatim current state of the service+LocalSystem branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n "handoffUninstallToUserSession" src/server/api/ServiceApi.ts
```

Note the call site line. The branch we're rewriting is the `else { ... }` containing it.

The current verbatim text of that branch (lines 419-446 per spec-time read; check at edit time):

```typescript
        } else {
            // No resume token → could be a direct click from the
            // local UI, OR could be a click from the service UI that
            // hasn't been redirected yet. Detect the service-context
            // case and do the handoff.
            const installMode = cfg.getAppConfig().installMode;
            const runningAsService = installMode === 'user-service' || installMode === 'system-service';
            const isWindows = result.platform === 'win32';

            if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
                const handoff = await this.handoffUninstallToUserSession(cfg.dependenciesPath, res);
                if (handoff) return true;
                // Handoff failed AND we're running as LocalSystem. We CANNOT fall
                // through to direct runElevated() here — PowerShell Start-Process
                // -Verb RunAs from LocalSystem has no interactive desktop to show
                // the UAC prompt on, so it silently fails. Return a clear error
                // and let the user retry (per spec
                // docs/superpowers/specs/2026-04-30-service-mode-admin-uac-ux-design.md).
                const body: ServiceActionFailure = {
                    ok: false,
                    error: "Couldn't reach the user session to relay the uninstall request. Make sure ws-scrcpy-web is running for your user, then try again.",
                    reason: 'handoff-timeout',
                };
                res.writeHead(503);
                res.end(JSON.stringify(body));
                return true;
            }
        }
```

- [ ] **Step 2: Write failing tests for the new operation-server flow.**

Add a new `describe` block to `src/server/__tests__/ServiceApi.test.ts`:

```typescript
describe('handleUninstall — operation-server flow (Phase 4)', () => {
    // Use the existing ServiceApi test helpers in this file for stubbing
    // installMode, isLikelyLocalSystem, fs writes, and response objects.
    // (Match the conventions you see in existing handleUninstall tests.)

    it('writes uninstall-pending marker when running as service + LocalSystem on Windows', async () => {
        // Stub: installMode='user-service' (or 'system-service'), platform='win32',
        // isLikelyLocalSystem→true.
        // Spy on fs.promises.writeFile.
        // Call handleUninstall with no resume token + service-context request.
        // Assert: writeFile called with cfg.uninstallPendingMarkerPath as the path.
    });

    it('returns 200 with redirectTo pointing at port 8000', async () => {
        // Same setup.
        // Spy on res.writeHead + res.end.
        // Assert: writeHead(200); body parsed as JSON shows ok=true + redirectTo starting with 'http://localhost:'.
    });

    it('schedules process.exit(0) after 5s', async () => {
        // Use vitest fake timers.
        // Stub process.exit.
        // Call handleUninstall.
        // Advance timers 5000ms.
        // Assert: process.exit called once with 0.
    });

    it('does NOT write marker in local mode (installMode is "user" / "system")', async () => {
        // Stub: installMode='user' (or 'system' or null).
        // Spy on writeFile.
        // Call handleUninstall.
        // Assert: writeFile NOT called for uninstall-pending path.
        // (Direct uninstall path runs as before — existing test coverage continues to apply.)
    });

    it('does NOT write marker when isLikelyLocalSystem is false (service mode but not LocalSystem)', async () => {
        // Stub: installMode='user-service', isLikelyLocalSystem→false.
        // Spy on writeFile.
        // Assert: marker NOT written; direct path runs.
        // (This covers the dev-mode scenario where user is running the service from a normal account.)
    });
});
```

- [ ] **Step 3: Run tests, verify failure.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npx vitest run src/server/__tests__/ServiceApi.test.ts -t "operation-server flow"
```

Expected: all 5 tests FAIL.

- [ ] **Step 4: Rewrite the service+LocalSystem branch of `handleUninstall`.**

Replace the verbatim current text from Step 1 with:

```typescript
        } else {
            // No resume token → could be a direct click from local UI OR
            // a click from service UI that hasn't been redirected yet.
            // Detect the service-context case and route through operation-server.
            const installMode = cfg.getAppConfig().installMode;
            const runningAsService = installMode === 'user-service' || installMode === 'system-service';
            const isWindows = result.platform === 'win32';

            if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
                // Phase 4 operation-server flow: write uninstall-pending marker,
                // return 200 + redirect to port 8000, schedule process.exit(0) for
                // 5s (response flush window). post-stop.bat picks up the marker
                // after Servy detects clean exit; bat runs `servy-cli uninstall`
                // under LocalSystem + spawns fresh user-session launcher;
                // operation-server serves "Uninstalling service, please wait..."
                // page on :8000 throughout, transitioning to a redirect response
                // when the fresh launcher's Node binds a port.
                //
                // Replaces the prior Theory D handoff dance
                // (handoffUninstallToUserSession) — see spec
                // docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md.
                // handoffUninstallToUserSession function body stays in place
                // (called by nothing now); deletion in Phase 5.
                try {
                    await fs.promises.mkdir(path.dirname(cfg.uninstallPendingMarkerPath), { recursive: true });
                    await fs.promises.writeFile(cfg.uninstallPendingMarkerPath, '', 'utf8');
                    log.info(`uninstall: wrote uninstall-pending marker at ${cfg.uninstallPendingMarkerPath}`);
                } catch (err) {
                    log.error(`uninstall: failed to write uninstall-pending marker: ${(err as Error).message}`);
                    const body: ServiceActionFailure = {
                        ok: false,
                        error: `failed to write uninstall-pending marker: ${(err as Error).message}`,
                        reason: 'unknown',
                    };
                    res.writeHead(500);
                    res.end(JSON.stringify(body));
                    return true;
                }

                // Schedule process.exit so Servy detects clean supervised exit
                // and fires post-stop.bat. 5s buffer for the 200 response to
                // flush and the browser to be on its way to the redirect.
                setTimeout(() => {
                    log.info('uninstall: scheduled exit firing (post-stop.bat takes over)');
                    process.exit(0);
                }, 5000).unref();

                const ownPort = cfg.servers[0]?.port ?? 8000;
                const body: ServiceActionSuccess = {
                    ok: true,
                    // Service is still running at the moment we send the response;
                    // post-stop.bat will run servy-cli uninstall after our exit.
                    status: 'running',
                    installMode: 'user-service',
                    redirectTo: `http://localhost:${ownPort}/`,
                };
                res.writeHead(200);
                res.end(JSON.stringify(body));
                return true;
            }
            // Non-service-mode OR non-LocalSystem-Node — fall through to direct
            // uninstall below (existing local-mode path).
        }
```

**IMPORTANT:** This step REMOVES the call to `handoffUninstallToUserSession` but does NOT delete the function body. The body stays in `ServiceApi.ts` as dead code until Phase 5 sweeps it. This bounds Phase 4's blast radius — if we discover a bug post-merge, we can revert just this branch without re-introducing handoff machinery deletions.

- [ ] **Step 5: Verify the `fs` and `path` imports are present at the top of `ServiceApi.ts`.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n "^import.*fs\|^import.*path" src/server/api/ServiceApi.ts
```

If `fs` and `path` aren't already imported (they are used elsewhere in the file, likely yes), add them following the project's import convention (look at the top of `UpdateService.ts` for the canonical webpack-externals-compatible form).

- [ ] **Step 6: Run tests, verify pass.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npx vitest run src/server/__tests__/ServiceApi.test.ts
```

Expected: 5 new tests pass; all existing ServiceApi tests still pass (the handoff-path tests now no longer exercise the handoff call — they exercise the new marker-write path).

- [ ] **Step 7: Run full vitest.**

```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npm test
```

Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(server): handleUninstall uses operation-server flow for service+LocalSystem context"
```

### Task 4.4 — CHANGELOG + push + open PR (DO NOT auto-merge — smoke required)

- [ ] **Step 1: CHANGELOG entry under `[Unreleased]` → `### Changed`.**

```markdown
- **Service uninstall now uses operation-server pattern (Phase 4 user-visible flip).** Replaces the Theory D handoff dance (tray-mediated cross-session spawn + user-session elevated launcher chain that died mid-`servy-cli stop` per §33 LATE UPDATE of `memory/todo_ws_scrcpy_web.md`). New flow: service-Node writes `uninstall-pending` marker, returns redirect to port 8000, exits; post-stop.bat runs `servy-cli uninstall` under LocalSystem + spawns fresh user-session launcher; operation-server serves "Uninstalling service, please wait..." throughout. **No more UAC prompt during uninstall.** Theory D `handoffUninstallToUserSession` function body remains as dead code; deletion in Phase 5. See spec `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`.
```

Commit + push.

- [ ] **Step 2: Open PR — DO NOT enable auto-merge.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin feat/uninstall-via-operation-server
gh -R bilbospocketses/ws-scrcpy-web pr create --title "feat(server): uninstall via operation-server (Phase 4 / 5) — USER-VISIBLE FLIP" --body "$(cat <<'EOF'
## Summary

**Phase 4 of operation-server rearchitecture — the user-visible flip.** Replaces the failing elevated-launcher chain (diagnosed in §33 LATE UPDATE of memory/todo_ws_scrcpy_web.md beta.38) with the operation-server pattern.

- `Config.uninstallPendingMarkerPath` getter added.
- `handleUninstall` service+LocalSystem path: writes uninstall-pending marker, returns 200 + redirect to :8000, schedules process.exit(0) for 5s response flush.
- `handoffUninstallToUserSession` function body LEFT in place (called by nothing now); deletion in Phase 5.
- 5 new vitest tests cover the new flow; existing handoff tests rewritten to exercise the new path.

## Test plan

- [x] vitest — all green (baseline + 5 new tests).
- [x] cargo test — unchanged baseline (Phase 4 is Node-only).
- [ ] **REQUIRED before merge: full clean-VM smoke** per spec section "Manual smoke (clean Hyper-V VM, end-to-end)":
  - 5×pre-reboot uninstall in a row (all must succeed; tests for non-determinism that haunted beta.34/.36/.38)
  - 1×post-reboot uninstall (tests the §33 Bug B aggravation case)
  - 1×post-idle uninstall (15+ min idle after reboot)
- [ ] Smoke must capture launcher.log + ws-scrcpy-web.log + service.log + the post-stop.bat content + the generated VM artifacts.
- [ ] If smoke passes: enable auto-merge. If not: diagnose, fix, re-smoke (do NOT merge).

## Spec
See `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`.
EOF
)" --base main
```

- [ ] **Step 3: Cut a smoke-target RC release from the PR branch HEAD.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b chore/release-beta-42-rc-1 feat/uninstall-via-operation-server
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" && npm run version:bump 0.1.25-beta.42-rc.1
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add -u
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "chore(release): v0.1.25-beta.42-rc.1 — Phase 4 smoke RC"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin chore/release-beta-42-rc-1
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" tag -as v0.1.25-beta.42-rc.1 -m "v0.1.25-beta.42-rc.1 — Phase 4 smoke"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push origin v0.1.25-beta.42-rc.1
```

release.yml fires; downloadable MSI available for VM smoke.

### Task 4.5 — Execute clean-VM smoke (THE CRITICAL VALIDATION)

- [ ] **Step 1: Fresh Hyper-V VM. Install beta.42-rc.1 via MSI.**

Document boot timestamp + UAC behavior. Expected: launcher boots clean; user lands on local-mode UI.

- [ ] **Step 2: Settings → Install service. Accept UAC.**

Expected: "Installing service, please wait..." modal renders briefly; browser redirects to service-Node port. Capture screenshots + log tails.

- [ ] **Step 3: Uninstall service ×5 in a row (pre-reboot).**

For each of 5 iterations:
1. Settings → Uninstall service.
2. Expected: "Uninstalling service, please wait..." modal renders. **NO UAC prompt fires.** ~5-9s later browser redirects to fresh local-Node.
3. Capture: `<dataRoot>/logs/launcher.log`, `<dataRoot>/logs/ws-scrcpy-web.log`, `<dataRoot>/logs/service.log`, contents of `<dataRoot>/post-stop/post-stop.bat`.
4. Re-install service. Loop.

Pass criterion: 5/5 clean with no UAC and no "Failed to fetch."

- [ ] **Step 4: Reboot. Uninstall.**

Pass criterion: uninstall succeeds across the reboot boundary.

- [ ] **Step 5: Reboot. Idle 15+ minutes. Uninstall.**

This was the §33 Bug B aggravation case. Pass criterion: uninstall still succeeds.

- [ ] **Step 6: If all smoke pass — enable auto-merge.**

```bash
gh -R bilbospocketses/ws-scrcpy-web pr merge feat/uninstall-via-operation-server --squash --delete-branch --auto
```

- [ ] **Step 7: If any smoke fails — DO NOT merge.**

Diagnose using the §33 LATE UPDATE diagnostic-log capture pattern as the template. Iterate on the branch with fix commits + re-cut beta.42-rc.N + re-smoke until pass.

### Task 4.6 — Cut beta.42 release post-merge

Same shape as Task 1.13 with version `0.1.25-beta.42`. Optionally delete the `v0.1.25-beta.42-rc.1` tag + release post-merge as cleanup.

**End of Phase 4. The user-visible flip is shipped.**

---

# Phase 5 — Dead-code sweep (PR #5, beta.43)

**Goal:** Delete Theory D machinery now that the uninstall verb no longer uses it. Audit + delete unused functions. No behavior change.

### Task 5.1 — Branch + audit consumers

- [ ] **Step 1: Verify beta.42 published; create branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main && git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
gh -R bilbospocketses/ws-scrcpy-web release view v0.1.25-beta.42 --json tagName,isDraft --jq '.tagName + " draft=" + (.isDraft | tostring)'
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b chore/operation-server-cleanup
```

- [ ] **Step 2: Audit consumers of Theory D machinery.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" grep -n "handoffUninstallToUserSession\|writeUninstallHandoffMarker\|consumeToken\|issueToken\|UNINSTALL_HANDOFF_FILENAME\|poll_for_handoff\|poll_once" src/ launcher/ common/ tray/
```

For each match, categorize:
- (a) call site → deletable if only caller is in the removed `handleUninstall` branch
- (b) function definition → deletable if (a) audit shows no callers
- (c) tests of (b) → deletable along with (b)

Write the audit as a scratch markdown file (NOT committed) listing each function with deletability verdict. Example structure:

```
### Audit findings
- handoffUninstallToUserSession (def in ServiceApi.ts) — DELETABLE (no callers post-Phase-4)
- writeUninstallHandoffMarker (def in <file>) — DELETABLE (only used by handoffUninstallToUserSession)
- consumeToken (def in <file>) — CHECK CALLERS: <list>
- ...
```

### Task 5.2 — Delete dead code (one commit per unit)

For each dead-code unit identified in Task 5.1:

- [ ] **Step 1: Write a regression test that asserts the unit is gone.**

```typescript
// In the relevant test file:
it('handoffUninstallToUserSession is no longer defined (Phase 5 cleanup)', () => {
    const mod = require('../api/ServiceApi');
    // Replace 'as any' with whatever cast pattern this codebase uses elsewhere.
    expect(typeof (mod.ServiceApi.prototype as any).handoffUninstallToUserSession).toBe('undefined');
});
```

(For Rust units, the equivalent assertion is that the Rust file compiles after the deletion — no test needed; the compile gate is the proof.)

- [ ] **Step 2: Run test, verify failure** (unit still exists).
- [ ] **Step 3: Delete the unit + its imports.**
- [ ] **Step 4: Run test + full suite, verify pass.**
- [ ] **Step 5: Commit per unit** (one delete = one commit; small + reviewable).

Typical units (verify list against Task 5.1 audit):
- `handoffUninstallToUserSession` in `src/server/api/ServiceApi.ts`
- Unused imports in `ServiceApi.ts` (e.g., `resolveLauncherPathForElevation`, `resolveActiveSessionId`, `writeUninstallHandoffMarker` — discover via grep after deleting the function)
- `consumeToken` + `issueToken` if no other callers (per audit)
- `common::control_marker` write/read for `uninstall-handoff.json` if no other callers
- Tray `poll_for_handoff` consumer if no other verb uses pattern

### Task 5.3 — DEFERRED: drop --upgrade-server alias + dataRoot dual-write (NOT in this PR)

Per spec, the alias + dual-write are kept for "~2 release cycles" beyond Phase 1 — that means at least one major release beyond beta.39. **Do NOT delete in Phase 5.** Recorded here so it doesn't get forgotten. A separate follow-up PR (post-Phase-5, after ~2 cycles) handles the alias + dual-write deletion.

This task is intentionally a no-op for Phase 5.

### Task 5.4 — CHANGELOG + push + PR + auto-merge + cut beta.43

CHANGELOG entry under `[Unreleased]` → `### Removed`:

```markdown
- **Dead-code sweep for Theory D handoff** (Phase 5 of operation-server rearchitecture). Removed `ServiceApi.handoffUninstallToUserSession` + associated imports (no longer called after Phase 4 user-visible flip). Other deletions per audit in PR description. No behavior change.
```

PR + auto-merge + cut beta.43 per established pattern.

**End of Phase 5. Operation-server rearchitecture fully shipped.**

---

# Post-completion follow-up (separate from this plan's PR arc)

Per spec section "Companion follow-up", after all 5 PRs land + post-merge smoke confirms seamless install/uninstall:

- [ ] **Write `reference_user_service_install_routine.md`** in `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/` documenting the operation-server pattern as the canonical architecture for ALL future apps offering user/system + service install. Scope per spec: session resolution, handoff markers, Servy `--postStopPath`, elevated runner pattern (for install only post-rearchitecture), state machine, Welcome modal copy / tray text mode-awareness / Settings UX affordances. Reference ws-scrcpy-web as the canonical implementation.
- [ ] **Update §33 of `memory/todo_ws_scrcpy_web.md`** to "SHIPPED" status with the 5-PR + 5-beta arc summary; move to the Shipped section.

---

# Self-review notes

Spec coverage check:

- ✅ Q1 (scope: uninstall only) → Phase 4 only touches uninstall; install untouched architecturally.
- ✅ Q1b (install: visual parity) → Phase 3 task 3.4 wires install modal but does not change install API behavior.
- ✅ Q2 (lifecycle: post-stop.bat spawn) → Phase 2 Task 2.3 broadens post-stop.bat; uninstall path matches upgrade-server pattern.
- ✅ Q3 (three-state conditional) → Phase 2 Task 2.3 implements the three-branch bat.
- ✅ Q4 (cross-session spawn via --spawn-user-launcher) → Phase 2 Task 2.2.
- ✅ Q5 (signaling via existing operation-server-stop + port-probe) → existing machinery (operation_server.rs `should_exit_for_stop_marker` from Phase 1 Task 1.8) covers this.
- ✅ Q6 (rename to operation-server) → Phase 1 entirely.
- ✅ Q7 (PR ordering: 5 PRs in order) → Plan structure follows this.
- ✅ Q8 (subsume Theory D fully for uninstall) → Phase 4 stops calling handoff; Phase 5 deletes it.

Placeholder scan: no `TODO`, `TBD`, `fill in details`, or "implement appropriately" markers remain. The page-text variant selection mechanism (deferred in the spec's "Open questions") is explicitly resolved in Task 2.4 (embedded constant via marker detection at spawn time).

Verbatim-source rule: per `feedback_subagent_code_specificity`, every task that edits existing code embeds the exact current text + the exact new text. Subagents executing this plan MUST match the embedded source verbatim — if a file has drifted, reconcile before editing. Tasks 4.2 and 4.3 explicitly require pre-task verification reads against `applyUpdatePendingMarkerPath` (for shape) and against `handleUninstall` lines 419-446 (for the verbatim branch text) before editing — those Node-side getters are easier to mirror against the existing code than to copy from a spec-time snapshot.
