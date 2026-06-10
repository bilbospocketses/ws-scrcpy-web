# Production Log Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the two duplicate log pairs (`server.log≈ws-scrcpy-web.log`, `service.log≈launcher.log`) and bound every log file at 10 MB, by gating each logger's console/stderr echo on OS terminal-detection and adding rotation matched to each file's fd ownership.

**Architecture:** Each application stream is written to one canonical rotated file by its own logger; the OS/service-manager stdio captures (`server.log`, `service.log`) become thin crash-only catchers because the loggers stop echoing their normal lines when the stream is not a terminal (`process.stdout.isTTY` / `std::io::stderr().is_terminal()` — never an env var). Rotation: rename-on-write for logger-owned files, rename-at-open for `server.log`, servy-native (Windows) / launcher copy-truncate (Linux) for `service.log`.

**Tech Stack:** TypeScript (Node server, vitest), Rust (launcher/common/tray crates, `cross test`/`clippy`), servy-cli 8.2, systemd.

**Spec:** `docs/specs/2026-06-10-production-log-dedup-design.md`

**Conventions:** All git via `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" …`. Branch is `production-log-dedup` (already created off `487803d`). TS test run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- <file>`. Rust tests run from `C:/Users/jscha/source/repos/ws-scrcpy-web/launcher` or `/common`. Ships as its own beta (beta.59) AFTER the beta.58 re-smoke — do not bump versions here.

---

## File Structure

**Node (TypeScript):**
- `src/server/Logger.ts` — MODIFY: add `shouldLogToConsole`, gate console per-stream, change rotation to per-write + 10 MB, export `rotateIfNeeded`.
- `src/server/Config.ts` — MODIFY: route the two direct `console.*` calls (`:420`, `:461`) through `Logger`.
- `src/server/__tests__/Logger.test.ts` — CREATE: tests for `shouldLogToConsole`, console gating, `rotateIfNeeded`.

**Rust (common crate — shared by launcher + tray):**
- `common/src/log.rs` — MODIFY: add `should_echo_stderr`, gate `eprintln!`, add `rotate_by_rename_if_large` + `copy_truncate_if_large`, wire per-write rename into `append()`, bump `MAX_LOG_SIZE` to 10 MB. Tests in the in-file `#[cfg(test)] mod tests`.
- `common/Cargo.toml` — MODIFY (if needed): add `tempfile` to `[dev-dependencies]`.

**Rust (launcher crate):**
- `launcher/src/spawn.rs` — MODIFY: rotate `server.log` at open in `open_server_log`. Test in the in-file tests mod.
- `launcher/src/main.rs` — MODIFY: copy-truncate the Linux `service.log` at startup.
- `launcher/src/elevated_runner.rs` — MODIFY: extract `build_servy_install_args`, add the three rotation flags, test the argv.

**Docs:**
- `src/server/Logger.ts`, `common/src/log.rs`, `launcher/src/spawn.rs` (comments); `README.md:342`, `docs/TECHNICAL_GUIDE.md`, `docs/PROGRAMDATA-MIGRATION.md`, `docs/smoke-tests/smoke-full.md`, `docs/smoke-tests/smoke-runbook.md`; `CHANGELOG.md`.

---

## Task 1: Logger console gating (isTTY)

**Files:**
- Modify: `src/server/Logger.ts:92-118`
- Test: `src/server/__tests__/Logger.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/Logger.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, shouldLogToConsole } from '../Logger';

describe('shouldLogToConsole', () => {
    it('returns true for a TTY, false otherwise', () => {
        expect(shouldLogToConsole(true)).toBe(true);
        expect(shouldLogToConsole(false)).toBe(false);
    });
});

describe('Logger console gating', () => {
    const origOut = process.stdout.isTTY;
    const origErr = process.stderr.isTTY;
    afterEach(() => {
        process.stdout.isTTY = origOut;
        process.stderr.isTTY = origErr;
        vi.restoreAllMocks();
    });

    it('suppresses console when stdout/stderr are not a TTY (captured to a file)', () => {
        process.stdout.isTTY = false;
        process.stderr.isTTY = false;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        Logger.for('Test').info('hi');
        Logger.for('Test').error('boom');
        expect(log).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
    });

    it('writes console when stdout/stderr are a TTY (dev terminal)', () => {
        process.stdout.isTTY = true;
        process.stderr.isTTY = true;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        Logger.for('Test').info('hi');
        Logger.for('Test').error('boom');
        expect(log).toHaveBeenCalledOnce();
        expect(err).toHaveBeenCalledOnce();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- src/server/__tests__/Logger.test.ts`
Expected: FAIL — `shouldLogToConsole` is not exported; the gating tests fail (console still called when not a TTY).

- [ ] **Step 3: Implement the gating**

In `src/server/Logger.ts`, add the pure function above the `Logger` class (after line 79):

```typescript
/**
 * Whether Logger should echo to the console. True only when the target stream
 * is a terminal (dev). Under the launcher, stdout/stderr are redirected to a
 * file (server.log), so isTTY is falsy and we skip the console echo — that
 * echo would only duplicate ws-scrcpy-web.log into server.log. Keyed on the
 * OS truth (isTTY), never an env var, so it can never drift from the actual
 * capture state.
 */
export function shouldLogToConsole(isTty: boolean): boolean {
    return isTty;
}
```

Then gate each method (replace lines 92-118). `info` writes to `console.log` (stdout); `warn`/`error` write to `console.warn`/`console.error` (stderr) — gate each on the stream it writes to:

```typescript
    info(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ${message}`;
        if (shouldLogToConsole(Boolean(process.stdout.isTTY))) {
            console.log(`${ts} ${this.tag}`, ...args);
        }
        writeToFile(line);
    }

    warn(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} WARN ${message}`;
        if (shouldLogToConsole(Boolean(process.stderr.isTTY))) {
            console.warn(`${ts} ${this.tag} WARN`, ...args);
        }
        writeToFile(line);
    }

    error(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ERROR ${message}`;
        if (shouldLogToConsole(Boolean(process.stderr.isTTY))) {
            console.error(`${ts} ${this.tag} ERROR`, ...args);
        }
        writeToFile(line);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- src/server/__tests__/Logger.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Logger.ts src/server/__tests__/Logger.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): gate Logger console echo on isTTY (dedup server.log)"
```

---

## Task 2: Logger per-write rotation at 10 MB

**Files:**
- Modify: `src/server/Logger.ts:4,40-66,72-79`
- Test: `src/server/__tests__/Logger.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/server/__tests__/Logger.test.ts`:

```typescript
import { rotateIfNeeded } from '../Logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('rotateIfNeeded', () => {
    it('renames the log to .1 when it is at/over the threshold, every call', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-log-'));
        const file = path.join(dir, 'ws-scrcpy-web.log');
        fs.writeFileSync(file, Buffer.alloc(11));
        rotateIfNeeded(file, 10); // 10-byte threshold, file is 11 bytes
        expect(fs.existsSync(`${file}.1`)).toBe(true);
        expect(fs.existsSync(file)).toBe(false); // renamed away; next append recreates
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does not rotate when under the threshold', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-log-'));
        const file = path.join(dir, 'ws-scrcpy-web.log');
        fs.writeFileSync(file, Buffer.alloc(5));
        rotateIfNeeded(file, 10);
        expect(fs.existsSync(`${file}.1`)).toBe(false);
        expect(fs.existsSync(file)).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- src/server/__tests__/Logger.test.ts`
Expected: FAIL — `rotateIfNeeded` is not exported / has the wrong signature.

- [ ] **Step 3: Implement per-write rotation**

In `src/server/Logger.ts`:

(a) Change the size constant at line 4 from 5 MB to 10 MB:

```typescript
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
```

(b) Replace the `rotationChecked` flag + `rotateIfNeeded` (lines 42-66) with an exported, parameterized, per-call version (no once-per-process short-circuit):

```typescript
/**
 * Rotate `logFile` to `logFile.1` when it reaches `maxBytes`. Called on EVERY
 * write (no once-per-process guard) so a long-running process stays bounded.
 * Single backup; a prior `.1` is overwritten by renameSync. All failures are
 * swallowed — logging must never crash the server.
 */
export function rotateIfNeeded(logFile: string, maxBytes: number): void {
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {
        // directory uncreatable — the appendFileSync below will no-op too
    }
    try {
        const stats = fs.statSync(logFile);
        if (stats.size >= maxBytes) {
            fs.renameSync(logFile, `${logFile}.1`);
        }
    } catch {
        // file doesn't exist yet — nothing to rotate
    }
}
```

(c) Update `writeToFile` (lines 72-79) to call it every write with the module constants:

```typescript
function writeToFile(line: string): void {
    rotateIfNeeded(LOG_FILE, MAX_LOG_SIZE);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
        // If we can't write to the log file, don't crash the server
    }
}
```

(d) Delete the now-unused `BACKUP_FILE` const (line 40) and the `let rotationChecked = false;` line if still present.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- src/server/__tests__/Logger.test.ts`
Expected: PASS (all rotation + gating tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Logger.ts src/server/__tests__/Logger.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): per-write 10MB rotation for ws-scrcpy-web.log"
```

---

## Task 3: Route Config.ts through Logger

**Files:**
- Modify: `src/server/Config.ts` (imports; `:420`, `:461`)
- Test: covered by `tsc` + an assertion in `src/server/__tests__/Logger.test.ts` is not needed; verify via `tsc` + manual grep.

- [ ] **Step 1: Add the failing check (grep-based)**

Run: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web"`
This passes now; the "test" for this task is the absence of raw `console.*` in `Config.ts`. Confirm the current state:
Run (PowerShell): `Select-String -Path "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/Config.ts" -Pattern "console\."`
Expected: two hits (lines 420, 461).

- [ ] **Step 2: Add the import**

In `src/server/Config.ts`, add to the existing imports near the top:

```typescript
import { Logger } from './Logger';
```

- [ ] **Step 3: Route the two call sites**

At `Config.ts:420`, replace:

```typescript
            const warn = (msg: string) => console.warn(`[Config] ${msg}`);
```
with:
```typescript
            const log = Logger.for('Config');
            const warn = (msg: string) => log.warn(msg);
```

At `Config.ts:461`, replace:

```typescript
            console.info(`[Config] adbPath=${adbPath} (source=${adbResolution.source})`);
```
with:
```typescript
            log.info(`adbPath=${adbPath} (source=${adbResolution.source})`);
```

(`Logger.for('Config')` already prefixes `[Config]`, so drop the literal prefix.)

- [ ] **Step 4: Verify**

Run: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web"`
Expected: exit 0.
Run (PowerShell): `Select-String -Path "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/Config.ts" -Pattern "console\."`
Expected: no hits.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Config.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "refactor(config): route [Config] logs through Logger (canonical log, not server.log)"
```

---

## Task 4: Launcher/tray eprintln gating (is_terminal)

**Files:**
- Modify: `common/src/log.rs:30-36,125-136` (+ `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

In `common/src/log.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn should_echo_stderr_follows_is_terminal() {
        assert!(super::should_echo_stderr(true));
        assert!(!super::should_echo_stderr(false));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/common && cargo test should_echo_stderr_follows_is_terminal`
Expected: FAIL — `should_echo_stderr` does not exist.

- [ ] **Step 3: Implement the gate**

In `common/src/log.rs`:

(a) Add `IsTerminal` to the `std::io` import (line 31):

```rust
use std::io::{IsTerminal, Write};
```

(b) Add the pure function (after `is_disabled`, around line 52):

```rust
/// Whether the launcher/tray should echo a log line to stderr. True only when
/// stderr is a terminal. Under a service the service manager redirects stderr
/// to a file (service.log) — not a terminal — so we skip the echo, which would
/// only duplicate launcher.log into service.log. Keyed on the OS truth, never
/// an env var.
pub fn should_echo_stderr(is_terminal: bool) -> bool {
    is_terminal
}
```

(c) Gate the `eprintln!` in `append()` (line 135):

```rust
    if should_echo_stderr(std::io::stderr().is_terminal()) {
        eprintln!("{ts} [{prefix}] {msg}");
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/common && cargo test should_echo_stderr_follows_is_terminal`
Expected: PASS.
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/common && cargo test` (no regressions)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/src/log.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): gate launcher/tray stderr echo on is_terminal (dedup service.log)"
```

---

## Task 5: Rotation helpers + per-write rename in common/log.rs

**Files:**
- Modify: `common/src/log.rs` (`MAX_LOG_SIZE`, helpers, `append()`, tests)
- Modify (if needed): `common/Cargo.toml` `[dev-dependencies]`

- [ ] **Step 1: Ensure tempfile is a dev-dependency**

Run (PowerShell): `Select-String -Path "C:/Users/jscha/source/repos/ws-scrcpy-web/common/Cargo.toml" -Pattern "tempfile"`
If no hit, add under `[dev-dependencies]` in `common/Cargo.toml`:

```toml
tempfile = "3"
```

- [ ] **Step 2: Write the failing tests**

In `common/src/log.rs` `mod tests`, add:

```rust
    #[test]
    fn rename_rotation_moves_oversized_file_to_dot_one() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("launcher.log");
        std::fs::write(&f, vec![0u8; 11]).unwrap();
        super::rotate_by_rename_if_large(&f, 10);
        assert!(dir.path().join("launcher.log.1").exists());
        assert!(!f.exists(), "original renamed away; next append recreates it");
    }

    #[test]
    fn rename_rotation_leaves_small_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("launcher.log");
        std::fs::write(&f, vec![0u8; 5]).unwrap();
        super::rotate_by_rename_if_large(&f, 10);
        assert!(!dir.path().join("launcher.log.1").exists());
        assert!(f.exists());
    }

    #[test]
    fn copy_truncate_preserves_inode_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("service.log");
        std::fs::write(&f, vec![b'x'; 11]).unwrap();
        super::copy_truncate_if_large(&f, 10);
        // backup holds the old bytes; original truncated to 0 (same path/inode)
        assert_eq!(std::fs::read(dir.path().join("service.log.1")).unwrap().len(), 11);
        assert_eq!(std::fs::metadata(&f).unwrap().len(), 0);
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/common && cargo test rotation`
Expected: FAIL — helpers don't exist.

- [ ] **Step 4: Implement helpers + wire into append()**

In `common/src/log.rs`:

(a) Add imports (extend line 30-32):

```rust
use std::fs::{self, OpenOptions};
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
```

(b) Change `MAX_LOG_SIZE` (or add it if absent) near the top constants:

```rust
const MAX_LOG_SIZE: u64 = 10 * 1024 * 1024; // 10MB
```

(c) Add both helpers (after `append`):

```rust
/// Append ".1" to a path's full filename (so `launcher.log` -> `launcher.log.1`,
/// not `Path::with_extension`'s `launcher.1`).
fn dot_one(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".1");
    PathBuf::from(s)
}

/// Rotate by RENAME when `path` is at/over `max_bytes`. Safe only for files
/// WE open per-write (no persistent fd) — launcher.log / tray.log / server.log
/// between spawns. Best-effort; never panics.
pub fn rotate_by_rename_if_large(path: &Path, max_bytes: u64) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= max_bytes {
            let backup = dot_one(path);
            let _ = fs::remove_file(&backup); // Windows rename won't replace
            let _ = fs::rename(path, &backup);
        }
    }
}

/// Rotate by COPY-TRUNCATE when `path` is at/over `max_bytes`. The logrotate
/// `copytruncate` technique: copy -> `.1`, then truncate the original in place.
/// Required for files an EXTERNAL writer holds open in append mode (systemd
/// service.log) — a rename would orphan that fd. Best-effort; never panics.
pub fn copy_truncate_if_large(path: &Path, max_bytes: u64) {
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() >= max_bytes {
            let _ = fs::copy(path, dot_one(path));
            let _ = OpenOptions::new().write(true).truncate(true).open(path);
        }
    }
}
```

(d) Wire per-write rename into `append()` — add before the file write (after `if let Some(path) = log_path() {`):

```rust
    if let Some(path) = log_path() {
        rotate_by_rename_if_large(&path, MAX_LOG_SIZE);
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{ts} [{prefix}] {msg}");
        }
    }
```

- [ ] **Step 5: Run tests + clippy to verify**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/common && cargo test`
Expected: PASS (all rotation tests + existing).
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/common && cargo clippy -- -D warnings`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add common/src/log.rs common/Cargo.toml
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): 10MB rotation helpers + per-write rename for launcher.log/tray.log"
```

---

## Task 6: Rotate server.log at launcher open

**Files:**
- Modify: `launcher/src/spawn.rs:87-97` (+ tests mod)

- [ ] **Step 1: Write the failing test**

In `launcher/src/spawn.rs` `#[cfg(test)] mod tests`, add:

```rust
    #[test]
    fn open_server_log_rotates_when_oversized() {
        let dir = tempdir().unwrap();
        let logs = dir.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        let server_log = logs.join("server.log");
        // Write 10 MB + 1 so it's at/over threshold.
        fs::write(&server_log, vec![0u8; 10 * 1024 * 1024 + 1]).unwrap();
        let _f = open_server_log(dir.path());
        assert!(logs.join("server.log.1").exists(), "oversized server.log rotated to .1");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test open_server_log_rotates_when_oversized`
Expected: FAIL — no `.1` produced (rotation not wired).

- [ ] **Step 3: Implement rotate-at-open**

In `launcher/src/spawn.rs`, modify `open_server_log` (lines 87-97) to rotate before opening:

```rust
fn open_server_log(data_root: &Path) -> Option<std::fs::File> {
    let log_path = data_root.join("logs").join("server.log");
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Rotate at 10 MB. server.log is free between spawns (the prior Node child
    // released its fd), so a rename is safe here. It is now a thin crash-catcher
    // (Logger no longer echoes to console under the launcher), so this cadence
    // is ample.
    crate::log::rotate_by_rename_if_large(&log_path, 10 * 1024 * 1024);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test open_server_log_rotates_when_oversized`
Expected: PASS.
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test` (no regressions) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/spawn.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): rotate server.log at launcher open (10MB)"
```

---

## Task 7: Copy-truncate the Linux service.log at startup

**Files:**
- Modify: `launcher/src/main.rs:66-73`

- [ ] **Step 1: Add the implementation (no unit test — startup wiring)**

This task wires the already-tested `copy_truncate_if_large` (Task 5) into `main()`. There is no new unit (the helper is covered by `copy_truncate_preserves_inode_and_backs_up`); verification is a compile + a manual size check, and the Windows path uses servy-native rotation (Task 8), so this is Linux-gated.

In `launcher/src/main.rs`, insert AFTER the `--no-log` block (after line 68, before the first `log::info` at line 70):

```rust
    // Rotate the Linux systemd service.log (the launcher's own stderr captured
    // by `StandardError=append:`). systemd holds the O_APPEND fd, so we MUST
    // copy-truncate (a rename would orphan that fd). No-op off-Linux, when the
    // file is absent/small, or when not service-run (harmless on a stale file).
    // Windows service.log is rotated by servy natively (see elevated_runner).
    #[cfg(target_os = "linux")]
    if let Some(data_root) = common::config::data_root_from_env() {
        common::log::copy_truncate_if_large(
            &data_root.join("logs").join("service.log"),
            10 * 1024 * 1024,
        );
    }
```

- [ ] **Step 2: Verify it compiles (both targets)**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo build`
Expected: success (Windows host — the `#[cfg(target_os = "linux")]` block is excluded).
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cross build --target x86_64-unknown-linux-gnu` (or `cross test` per project norm)
Expected: success (the Linux block compiles; `common::config::data_root_from_env` + `common::log::copy_truncate_if_large` resolve).

- [ ] **Step 3: clippy**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cross clippy --target x86_64-unknown-linux-gnu -- -D warnings`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): copy-truncate Linux service.log at startup (10MB)"
```

---

## Task 8: Servy native rotation flags for Windows service.log

**Files:**
- Modify: `launcher/src/elevated_runner.rs:~220-250` (extract `build_servy_install_args` + add flags; add a test)

- [ ] **Step 1: Write the failing test**

In `launcher/src/elevated_runner.rs`, add a `#[cfg(test)] mod tests` (or extend the existing one) with a test against an extracted arg-builder. First the test:

```rust
#[cfg(test)]
mod rotation_tests {
    use super::*;

    fn sample_args() -> InstallServiceArgs {
        InstallServiceArgs {
            servy_path: "servy-cli.exe".into(),
            name: "WsScrcpyWeb".into(),
            display_name: "ws-scrcpy-web".into(),
            description: "desc".into(),
            bin_path: "C:/app/launcher.exe".into(),
            startup_dir: "C:/app".into(),
            startup_type: "Automatic".into(),
            max_restart_attempts: 3,
            env_vars: "K=V".into(),
            log_path: "C:/data/logs/service.log".into(),
            tray_helper_path: None,
            data_root: None,
        }
    }

    #[test]
    fn servy_install_args_enable_size_rotation_10mb_one_backup() {
        let argv = build_servy_install_args(&sample_args(), None);
        assert!(argv.iter().any(|a| a == "--enableSizeRotation"));
        let pos = argv.iter().position(|a| a == "--rotationSize").expect("--rotationSize present");
        assert_eq!(argv[pos + 1], "10");
        let mpos = argv.iter().position(|a| a == "--maxRotations").expect("--maxRotations present");
        assert_eq!(argv[mpos + 1], "1");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test servy_install_args_enable_size_rotation`
Expected: FAIL — `build_servy_install_args` does not exist.

- [ ] **Step 3: Extract the arg-builder + add the flags**

In `elevated_runner.rs`, extract the inline `servy_args` Vec (currently ~lines 220-269) into a function, and append the rotation flags after the `--stderr` pair. The extracted function:

```rust
/// Build the servy-cli `install` argv. Extracted for unit-testing the flag
/// shape. `--enableSizeRotation` (presence) + `--rotationSize 10` +
/// `--maxRotations 1` bound service.log natively (servy owns the append fd, so
/// the app can't rename/truncate it — servy rotates it itself; size rotation
/// takes precedence over date rotation per servy 8.2).
fn build_servy_install_args(args: &InstallServiceArgs, post_stop_bat: Option<&PathBuf>) -> Vec<String> {
    let mut servy_args = vec![
        "install".to_string(),
        "--name".to_string(),
        args.name.clone(),
        "--displayName".to_string(),
        args.display_name.clone(),
        "--description".to_string(),
        args.description.clone(),
        "--path".to_string(),
        args.bin_path.clone(),
        "--startupDir".to_string(),
        args.startup_dir.clone(),
        "--startupType".to_string(),
        args.startup_type.clone(),
        "--recoveryAction".to_string(),
        "RestartProcess".to_string(),
        "--maxRestartAttempts".to_string(),
        args.max_restart_attempts.to_string(),
        "--envVars".to_string(),
        args.env_vars.clone(),
        "--stdout".to_string(),
        args.log_path.clone(),
        "--stderr".to_string(),
        args.log_path.clone(),
        "--enableSizeRotation".to_string(),
        "--rotationSize".to_string(),
        "10".to_string(),
        "--maxRotations".to_string(),
        "1".to_string(),
    ];
    if let Some(bat_path) = post_stop_bat {
        let bat_path_str = bat_path.to_string_lossy().into_owned();
        servy_args.push("--postStopPath".to_string());
        servy_args.push(r"C:\Windows\System32\cmd.exe".to_string());
        servy_args.push("--postStopParams".to_string());
        servy_args.push(format!("/c \"{bat_path_str}\""));
        servy_args.push("--postStopStartupDir".to_string());
        servy_args.push(
            bat_path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| args.startup_dir.clone()),
        );
    }
    servy_args
}
```

Then in the original install flow, replace the inline Vec + postStop push block with:

```rust
    let servy_args = build_servy_install_args(&args, post_stop_bat.as_ref());
```

(Confirm `post_stop_bat`'s type at the call site — it is `Option<PathBuf>`; pass `.as_ref()`. The original `args.display_name`/`startup_type`/`max_restart_attempts` lines `230-249` and the `post_stop_bat` push block `252-269` are now inside `build_servy_install_args`.)

- [ ] **Step 4: Run test + clippy to verify**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test servy_install_args_enable_size_rotation`
Expected: PASS.
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test` — Expected: PASS (no regressions).
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo clippy -- -D warnings` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/elevated_runner.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(logging): servy native size-rotation for Windows service.log (10MB)"
```

---

## Task 9: Docs + comments

**Files:**
- Modify: `src/server/Logger.ts` (comment), `common/src/log.rs` (module doc), `launcher/src/spawn.rs` (open_server_log doc), `README.md`, `docs/TECHNICAL_GUIDE.md`, `docs/PROGRAMDATA-MIGRATION.md`, `docs/smoke-tests/smoke-full.md`, `docs/smoke-tests/smoke-runbook.md`.

- [ ] **Step 1: Code comments**

- `src/server/Logger.ts:96-99`: the v0.1.17 comment ("prefix console output too so server.log … matches launcher.log") is now obsolete (console is suppressed under the launcher). Replace it with a one-line note that console is gated on `isTTY` (dev only) and `server.log` is a thin crash-catcher.
- `launcher/src/spawn.rs:70-86` (`open_server_log` doc): update "Plumb the child's stdout AND stderr into server.log so a crashed startup leaves a forensic trail" to note server.log is now a thin crash-catcher (Logger echoes nothing under the launcher) and is rename-rotated at open.
- `common/src/log.rs` module doc (top): add a sentence that the stderr echo is gated on `is_terminal()` (so service.log stays a thin crash-catcher) and the file is rename-rotated per write at 10 MB.

- [ ] **Step 2: README.md:342**

Change the line `- \`service.log\` — Servy service-mode stdio capture` and its siblings (the log-file list) to reflect the model: `ws-scrcpy-web.log` (app), `launcher.log` (launcher), `server.log`/`service.log` (thin crash/native catchers), each rotated at 10 MB with a `.1` backup. Read the surrounding list (~lines 335-345) and update each entry's description.

- [ ] **Step 3: docs/TECHNICAL_GUIDE.md + docs/PROGRAMDATA-MIGRATION.md**

Grep each for `server.log` / `service.log` / `ws-scrcpy-web.log` / `launcher.log` and update any description of the four files to the canonical-vs-crash-catcher + 10 MB-rotation model. Do not rewrite historical narrative — only the "what each log is" descriptions.

Run (PowerShell) to find sites: `Select-String -Path "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/TECHNICAL_GUIDE.md","C:/Users/jscha/source/repos/ws-scrcpy-web/docs/PROGRAMDATA-MIGRATION.md" -Pattern "server\.log|service\.log|launcher\.log|ws-scrcpy-web\.log"`

- [ ] **Step 4: Smoke docs (10.2 / 10.3)**

In `docs/smoke-tests/smoke-full.md` and `docs/smoke-tests/smoke-runbook.md`, update rows 10.2 (Windows logs) and 10.3 (Linux logs): note that `server.log`/`service.log` are now thin (normal lines live in `ws-scrcpy-web.log`/`launcher.log`); a `.1` backup may exist; files are still tail-able. `capture-logs.{sh,ps1}` need no change (optionally add `*.log.1` to the bundle — note it, do not require it).

- [ ] **Step 5: Verify + commit**

Run: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web"` (comment-only TS change compiles) — Expected: exit 0.

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Logger.ts common/src/log.rs launcher/src/spawn.rs README.md docs/TECHNICAL_GUIDE.md docs/PROGRAMDATA-MIGRATION.md docs/smoke-tests/smoke-full.md docs/smoke-tests/smoke-runbook.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(logging): describe the dedup'd 10MB-rotated log model"
```

---

## Task 10: Full gates, CHANGELOG, PR

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Full gates (all green before publishing)**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test` — Expected: all pass.
Run: `npx --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" tsc --noEmit -p "C:/Users/jscha/source/repos/ws-scrcpy-web"` — Expected: exit 0.
Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run build` — Expected: webpack clean.
Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cross test --target x86_64-unknown-linux-gnu && cross clippy --target x86_64-unknown-linux-gnu -- -D warnings` — Expected: pass + clean.
Run (Windows-native, for the `#[cfg(windows)]` servy/spawn code): `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cargo test && cargo clippy -- -D warnings` — Expected: pass + clean.

- [ ] **Step 2: CHANGELOG under [Unreleased]**

In `CHANGELOG.md`, under the existing `## [Unreleased]` heading (do NOT create a version heading — `bump-version.mjs` promotes Unreleased and aborts if a version heading pre-exists), add:

```markdown
### Changed

- **Production logs no longer duplicate, and every log file is bounded at 10 MB.** Previously each log line was written twice on disk — the app log to both `ws-scrcpy-web.log` and `server.log`, and (under a service) the launcher log to both `launcher.log` and `service.log`. Now each logger writes only its own file when its output is being captured to disk (detected via whether the stream is a real terminal — dev keeps console output), so `server.log`/`service.log` hold only crash/native output. All four logs (plus the Windows `tray.log`) rotate at 10 MB with a single `.1` backup.
```

- [ ] **Step 3: Push + open PR**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): production log dedup + 10MB rotation"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin production-log-dedup
```

Then open the PR with the `release:beta` label (auto-release cuts beta.59):

```bash
gh pr create --repo bilbospocketses/ws-scrcpy-web --base main --head production-log-dedup --title "feat(logging): dedup production logs + 10MB rotation (item 52)" --body "<summary referencing docs/specs/2026-06-10-production-log-dedup-design.md>" --label "release:beta"
```

- [ ] **Step 4: Arm squash auto-merge (after CI green)**

```bash
gh pr merge <N> --repo bilbospocketses/ws-scrcpy-web --squash --delete-branch --auto
```

---

## Notes for the implementer

- **Sequencing:** Tasks 4→5 both edit `common/src/log.rs::append()` (Task 4 adds the eprintln gate; Task 5 adds the rename call). Do them in order. Task 6 depends on Task 5's `rotate_by_rename_if_large`; Task 7 depends on Task 5's `copy_truncate_if_large`.
- **Do NOT bump versions** in this branch — auto-release (Mode 1) cuts the bump PR after merge. One `release:beta` PR only.
- **Windows-only code** (`elevated_runner.rs` servy, `spawn.rs` `#[cfg(windows)]`) must be checked with native `cargo test`/`clippy` on the Windows host in addition to `cross` for Linux — see Task 10 Step 1.
- **Servy flag form:** verified against `dependencies/servy/v8.2/servy-cli.exe install --help` — `--enableSizeRotation` is a presence flag; `--rotationSize`/`--maxRotations` take a value. The Windows smoke (#16) is the runtime gate that service.log actually rotates.
- **Runtime verification (folds into the next Linux/Windows smoke, NOT this plan):** after a long-running service accumulates logs, confirm `server.log`/`service.log` are thin (no duplicated `[tag]` app lines), `ws-scrcpy-web.log`/`launcher.log` are complete, and `.1` backups appear at 10 MB. Linux service.log copy-truncate + Windows servy rotation are runtime-only checks.
