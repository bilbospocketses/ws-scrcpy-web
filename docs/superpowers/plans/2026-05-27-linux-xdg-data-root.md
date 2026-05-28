# Linux XDG Data Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redirect Linux data_root from read-only squashfs mount to `$XDG_DATA_HOME/WsScrcpyWeb` (~/.local/share/WsScrcpyWeb), enabling config saves, dependency downloads, log writes, and service install on Linux AppImage.

**Architecture:** Three layers compute the same XDG path: Rust common crate (`data_root_for_linux`), Rust launcher (`paths.rs`), and Node server (`resolveDataRoot`). The launcher passes `DATA_ROOT` env var to Node as a belt-and-suspenders bridge. Windows is unchanged.

**Tech Stack:** Rust (common + launcher crates), TypeScript/Node (server Config.ts), vitest, cargo test

**Spec:** `docs/superpowers/specs/2026-05-27-linux-xdg-data-root-design.md`

**Repo:** `C:/Users/jscha/source/repos/ws-scrcpy-web`

---

### Task 1: Add `data_root_for_linux()` to Rust common crate

**Files:**
- Modify: `common/src/config.rs:21-39` (add function + update `data_root_from_env`)

- [ ] **Step 1: Write the failing tests**

Add these tests after the existing `data_root_for_windows_*` tests (after line 233):

```rust
#[test]
fn data_root_for_linux_uses_xdg_data_home_when_set() {
    let result = data_root_for_linux(Some("/custom/data"), Some("/home/user"));
    assert_eq!(result, PathBuf::from("/custom/data/WsScrcpyWeb"));
}

#[test]
fn data_root_for_linux_falls_back_to_home_local_share() {
    let result = data_root_for_linux(None, Some("/home/user"));
    assert_eq!(result, PathBuf::from("/home/user/.local/share/WsScrcpyWeb"));
}

#[test]
fn data_root_for_linux_ignores_empty_xdg_data_home() {
    let result = data_root_for_linux(Some(""), Some("/home/user"));
    assert_eq!(result, PathBuf::from("/home/user/.local/share/WsScrcpyWeb"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p common data_root_for_linux 2>&1`
Expected: FAIL with "cannot find function `data_root_for_linux`"

- [ ] **Step 3: Implement `data_root_for_linux`**

Add this function after `data_root_for_windows` (after line 26 in `common/src/config.rs`):

```rust
/// Pure resolver for the writable-state root on Linux. Follows the XDG
/// Base Directory spec: `$XDG_DATA_HOME/WsScrcpyWeb` if set, otherwise
/// `~/.local/share/WsScrcpyWeb`. Mirrors `resolveDataRoot` in
/// `src/server/Config.ts`. Parameters are injectable for testing.
pub fn data_root_for_linux(xdg_data_home: Option<&str>, home: Option<&str>) -> PathBuf {
    if let Some(xdg) = xdg_data_home.filter(|s| !s.is_empty()) {
        return PathBuf::from(xdg).join("WsScrcpyWeb");
    }
    match home {
        Some(h) => PathBuf::from(h).join(".local").join("share").join("WsScrcpyWeb"),
        None => PathBuf::from("/tmp").join("WsScrcpyWeb"),
    }
}
```

- [ ] **Step 4: Update `data_root_from_env` to return `Some` on Linux**

Replace the existing `data_root_from_env` function (lines 32-39) with:

```rust
/// Convenience wrapper that reads env vars and delegates to the
/// platform-specific resolver. Returns `Some` on all platforms now
/// (Linux gained XDG support; was `None` before this change).
pub fn data_root_from_env() -> Option<PathBuf> {
    if cfg!(windows) {
        let pd = std::env::var("PROGRAMDATA").ok();
        Some(data_root_for_windows(pd.as_deref()))
    } else {
        let xdg = std::env::var("XDG_DATA_HOME").ok();
        let home = std::env::var("HOME").ok();
        Some(data_root_for_linux(xdg.as_deref(), home.as_deref()))
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p common 2>&1`
Expected: All existing + 3 new tests PASS

- [ ] **Step 6: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/src/config.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: add data_root_for_linux with XDG_DATA_HOME support"
```

---

### Task 2: Update Rust launcher `paths.rs` to use XDG on Linux

**Files:**
- Modify: `launcher/src/paths.rs:59-62` (data_root computation)
- Modify: `launcher/src/paths.rs:130-146` (non-Windows test)

- [ ] **Step 1: Update the non-Windows test to expect XDG path**

Replace the test `compute_collapses_data_root_to_install_root_on_non_windows` (lines 130-146) with:

```rust
#[test]
#[cfg(not(windows))]
fn compute_uses_xdg_data_root_on_non_windows() {
    let dir = tempdir().unwrap();
    let install_root = dir.path();
    let exe_dir = install_root.join("current");
    std::fs::create_dir_all(&exe_dir).unwrap();

    // XDG_DATA_HOME takes precedence. Inject via the env for this test,
    // then clean up. data_root_from_env reads from process env.
    let xdg_dir = dir.path().join("xdg-data");
    std::fs::create_dir_all(&xdg_dir).unwrap();
    std::env::set_var("XDG_DATA_HOME", &xdg_dir);
    let paths = Paths::from_env_with_exe_dir(&exe_dir, None);
    std::env::remove_var("XDG_DATA_HOME");

    let paths = paths.unwrap();
    let expected_data_root = xdg_dir.join("WsScrcpyWeb");
    assert_eq!(paths.data_root, expected_data_root);
    assert_eq!(paths.deps_path, expected_data_root.join("dependencies"));
    assert_eq!(paths.restart_marker, expected_data_root.join(".restart"));
}
```

- [ ] **Step 2: Run tests to verify the test fails**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher compute_uses_xdg 2>&1`
Expected: FAIL (function not found or assertion mismatch)

- [ ] **Step 3: Update paths.rs data_root computation**

Replace lines 59-62 in `launcher/src/paths.rs`:

```rust
        let data_root = if cfg!(windows) {
            common::config::data_root_for_windows(programdata_override)
        } else {
            install_root.clone()
        };
```

with:

```rust
        let data_root = if cfg!(windows) {
            common::config::data_root_for_windows(programdata_override)
        } else {
            let xdg = std::env::var("XDG_DATA_HOME").ok();
            let home = std::env::var("HOME").ok();
            common::config::data_root_for_linux(xdg.as_deref(), home.as_deref())
        };
```

- [ ] **Step 4: Add `from_env_with_exe_dir` helper if the test needs it**

If `Paths::compute` doesn't accept the env vars the test needs to override, add a thin wrapper. Check whether the test in step 1 compiles against the existing `compute` signature. If it does (because `compute` calls `data_root_for_linux` which reads from `std::env::var` internally via the updated paths.rs code), no helper is needed. If the test needs a different entry point, add:

```rust
/// Test helper: compute from a given exe_dir, bypassing current_exe().
#[cfg(test)]
pub fn from_env_with_exe_dir(exe_dir: &Path, deps_override: Option<&str>) -> Result<Self> {
    Self::compute(exe_dir, deps_override, None)
}
```

- [ ] **Step 5: Run full launcher test suite**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher 2>&1`
Expected: All tests PASS (including the renamed non-Windows test)

- [ ] **Step 6: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/paths.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: use XDG data root on Linux instead of install_root collapse"
```

---

### Task 3: Pass DATA_ROOT env var from launcher to Node child

**Files:**
- Modify: `launcher/src/spawn.rs:104-108` (Windows spawn)
- Modify: `launcher/src/spawn.rs:146-149` (Linux spawn)

- [ ] **Step 1: Add DATA_ROOT to the Windows spawn**

In `launcher/src/spawn.rs`, the `#[cfg(windows)]` variant of `spawn_server` (line 104-108), change:

```rust
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path)
        .creation_flags(CREATE_NO_WINDOW);
```

to:

```rust
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path)
        .env("DATA_ROOT", data_root)
        .creation_flags(CREATE_NO_WINDOW);
```

- [ ] **Step 2: Add DATA_ROOT to the Linux spawn**

In the `#[cfg(not(windows))]` variant (line 146-149), change:

```rust
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path);
```

to:

```rust
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .current_dir(&work_dir)
        .env("DEPS_PATH", deps_path)
        .env("DATA_ROOT", data_root);
```

- [ ] **Step 3: Run full launcher test suite**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" 2>&1`
Expected: All tests PASS (spawn tests don't actually execute the child, so no env var side effects)

- [ ] **Step 4: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/spawn.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: pass DATA_ROOT env var from launcher to Node child"
```

---

### Task 4: Update Node `resolveDataRoot()` with Linux + DATA_ROOT support

**Files:**
- Modify: `src/server/Config.ts:144-153` (resolveDataRoot function)
- Modify: `src/server/__tests__/config.dataRoot.test.ts:28-38` (non-win32 tests)

- [ ] **Step 1: Write the failing tests**

Replace the `on non-win32` describe block (lines 28-38 in `config.dataRoot.test.ts`) with:

```typescript
describe('on linux', () => {
    it('returns DATA_ROOT/WsScrcpyWeb when DATA_ROOT env is set', () => {
        const result = resolveDataRoot({ DATA_ROOT: '/custom/data/WsScrcpyWeb' }, 'linux');
        expect(result).toBe('/custom/data/WsScrcpyWeb');
    });

    it('returns XDG_DATA_HOME/WsScrcpyWeb when XDG_DATA_HOME is set', () => {
        const result = resolveDataRoot({ XDG_DATA_HOME: '/custom/xdg', HOME: '/home/user' }, 'linux');
        expect(result).toBe(path.join('/custom/xdg', 'WsScrcpyWeb'));
    });

    it('falls back to ~/.local/share/WsScrcpyWeb when no XDG var set', () => {
        const result = resolveDataRoot({ HOME: '/home/user' }, 'linux');
        expect(result).toBe(path.join('/home/user', '.local', 'share', 'WsScrcpyWeb'));
    });

    it('DATA_ROOT takes precedence over XDG_DATA_HOME', () => {
        const result = resolveDataRoot({
            DATA_ROOT: '/launcher/provided/WsScrcpyWeb',
            XDG_DATA_HOME: '/should/not/use',
            HOME: '/home/user',
        }, 'linux');
        expect(result).toBe('/launcher/provided/WsScrcpyWeb');
    });

    it('ignores empty XDG_DATA_HOME and falls back to HOME', () => {
        const result = resolveDataRoot({ XDG_DATA_HOME: '', HOME: '/home/user' }, 'linux');
        expect(result).toBe(path.join('/home/user', '.local', 'share', 'WsScrcpyWeb'));
    });
});

describe('on darwin', () => {
    it('returns XDG-based path on darwin (same as linux)', () => {
        const result = resolveDataRoot({ HOME: '/Users/jamie' }, 'darwin');
        expect(result).toBe(path.join('/Users/jamie', '.local', 'share', 'WsScrcpyWeb'));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" test -- --run -t "resolveDataRoot" 2>&1`
Expected: FAIL (new tests expect non-null but current implementation returns null for non-win32)

- [ ] **Step 3: Implement the updated `resolveDataRoot`**

Replace the `resolveDataRoot` function (lines 144-153 in `Config.ts`) with:

```typescript
export function resolveDataRoot(
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
): string | null {
    if (platform === 'win32') {
        const programData = env['PROGRAMDATA'] && env['PROGRAMDATA'].length > 0
            ? env['PROGRAMDATA']
            : 'C:\\ProgramData';
        return path.win32.join(programData, 'WsScrcpyWeb');
    }
    // Non-Windows: DATA_ROOT (launcher bridge) > XDG_DATA_HOME > ~/.local/share
    if (env['DATA_ROOT'] && env['DATA_ROOT'].length > 0) {
        return env['DATA_ROOT'];
    }
    if (env['XDG_DATA_HOME'] && env['XDG_DATA_HOME'].length > 0) {
        return path.join(env['XDG_DATA_HOME'], 'WsScrcpyWeb');
    }
    if (env['HOME'] && env['HOME'].length > 0) {
        return path.join(env['HOME'], '.local', 'share', 'WsScrcpyWeb');
    }
    return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" test -- --run 2>&1`
Expected: All 717+ tests PASS (existing win32 tests unchanged, new linux/darwin tests pass)

- [ ] **Step 5: Commit**

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Config.ts src/server/__tests__/config.dataRoot.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat: resolveDataRoot returns XDG path on Linux, reads DATA_ROOT env bridge"
```

---

### Task 5: Full test suite + type check

**Files:** None (verification only)

- [ ] **Step 1: Run Rust test suite**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" 2>&1`
Expected: 130+ tests PASS

- [ ] **Step 2: Run TypeScript type check**

Run: `& "C:/Users/jscha/source/repos/ws-scrcpy-web/node_modules/.bin/tsc.ps1" --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web/tsconfig.json" 2>&1`
Expected: Clean (no errors)

- [ ] **Step 3: Run vitest suite**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" test -- --run 2>&1`
Expected: 717+ tests PASS

- [ ] **Step 4: Squash into single commit for the PR**

All four task commits get squash-merged by the PR workflow, so no manual squash needed. Verify the branch has the right commits:

```
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" log --oneline -5
```
