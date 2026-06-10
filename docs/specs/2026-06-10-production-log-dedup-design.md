# Production log dedup — design

- **Date:** 2026-06-10
- **Status:** Approved (brainstorm complete) — pending implementation plan
- **Item:** todo_ws_scrcpy_web #52
- **Ships as:** its own beta (target **beta.59**), after the beta.58 Linux re-smoke — does NOT fold into the in-flight beta.58 build.

## Problem

In a launcher-managed install, `<dataRoot>/logs/` carries **four** log files forming **two duplicate pairs** — each application stream is written to disk twice with byte-identical content:

| Stream | Canonical file | Duplicate file | Mechanism of the duplicate |
|---|---|---|---|
| **Node server** | `ws-scrcpy-web.log` (`Logger`'s file sink) | `server.log` | `Logger` also writes every line to `console.*`; the launcher redirects the Node child's stdout/stderr to `server.log` (`launcher/src/spawn.rs::open_server_log`). |
| **Launcher** | `launcher.log` (`common::log`'s file sink) | `service.log` | `common::log::append` also `eprintln!`s every line to stderr; under a service the service manager captures that stderr to `service.log` (systemd `StandardError=append:` / servy `--stderr`). |

Both pairs are **cross-platform**:
- `server.log` exists on every launcher-managed install — Windows MSI and Linux AppImage, local **and** service mode.
- `service.log` exists under a service on **both** OSes: Linux via systemd (`SystemdClient.renderUnitFile` → `StandardOutput/StandardError=append:service.log`), Windows via servy (`elevated_runner.rs` → `--stdout service.log --stderr service.log`), with the path set in `ServiceApi.ts` (`<dataRoot>/logs/service.log`). README.md:342 labels it "Servy service-mode stdio capture."

This was confirmed at runtime during the beta.57 Linux re-smoke (#7 test 10.3: `server.log ≈ ws-scrcpy-web.log`; the `service.log ≈ launcher.log` facet surfaced in the same tail).

## Goals

1. Eliminate the duplicate **content** in both pairs: each application stream is written to **one** canonical, rotated file.
2. Preserve the forensic value of the stdio captures — raw crashes/panics/native output that never goes through a logger must still land somewhere.
3. Keep **dev** logging (no launcher) completely unchanged.
4. Make the mechanism **robust** — the decision to suppress a duplicate must not depend on ambient environment that can drift from the actual condition.
5. Symmetric across Windows / Linux / local / service / dev.

## Non-goals

- No change to where logs live (`<dataRoot>/logs/`), to the file names, or to the capture plumbing itself (`spawn.rs` redirect, the systemd unit `append:`, servy `--stdout/--stderr`, `ServiceApi` logPath all stay).
- No in-app log viewer/download (none exists; confirmed no programmatic reader of any `.log` in the server).
- No change to `--print-active-session` stdout output.

## Key design decision — the suppression signal

A logger must know whether its console/stderr echo is being **captured to a file** (in which case echoing duplicates the canonical file) or is going to a **terminal** (dev, where the echo is the point).

**Rejected: an environment-variable gate** (e.g. "suppress when `DEPS_PATH`/`WS_SCRCPY_SERVICE` is set"). Two flaws: (a) it overloads a variable whose real job is something else (`DEPS_PATH` = dependency/dataRoot location; `WS_SCRCPY_SERVICE` = `servedByService`), and (b) it is *ambient* — it answers "did someone set this string?" not "is the duplicate-causing condition true right now?" A stray value in a dev/test shell would silently change logging behavior. That is a fragility we eliminate, not document.

**Chosen: OS-level terminal detection.** The duplicate can only exist when the stream is **captured to a file**, and the very act that captures it — redirecting the stream to a file handle — is exactly what makes that stream **not a terminal**. The capture and the non-terminal-ness are the *same physical fact*, so the signal can never drift from the condition.

- **Node:** `process.stdout.isTTY` (for `console.log`) / `process.stderr.isTTY` (for `console.warn`/`console.error`).
- **Launcher/tray (Rust):** `std::io::stderr().is_terminal()` (`std::io::IsTerminal`, stable since Rust 1.70; toolchain is 1.95 — no new dependency).

Each decision is isolated behind a **pure function** so tests pass the boolean directly — no environment munging, no global-state hacks:
- `shouldLogToConsole(isTty: boolean): boolean` (Node)
- `should_echo_stderr(is_terminal: bool) -> bool` (Rust)

**Why this eliminates the risk:** environment is never consulted for the logging-mode decision. `dup-exists ⟺ stream-captured-to-a-file ⟺ not-a-terminal ⟺ suppressed`. The trigger and the condition are physically the same fact.

## Design

### Node server — `src/server/Logger.ts`

- Add pure `shouldLogToConsole(isTty: boolean): boolean` → returns `isTty`.
- `info()`: `if (shouldLogToConsole(process.stdout.isTTY ?? false)) console.log(...)` — file write (`writeToFile`) **always** runs.
- `warn()` / `error()`: gate on `process.stderr.isTTY` (the stream `console.warn`/`console.error` write to); file write always runs.
- File-path resolution (`resolveLogFilePath`, which uses `DEPS_PATH`) is **unchanged** — `DEPS_PATH` keeps its one legitimate job (the path of `ws-scrcpy-web.log`); it is no longer consulted for the console decision.

Effect: under the launcher, `process.stdout/stderr.isTTY` is falsy (stdout/stderr are file handles → `server.log`), so `Logger` writes only `ws-scrcpy-web.log`. In dev (terminal), both are TTYs → console preserved.

### Node server — `src/server/Config.ts` (catch ①)

`Config.ts` currently calls `console.*` **directly**, bypassing `Logger`:
- `:420` `const warn = (msg) => console.warn(`[Config] ${msg}`)`
- `:461` `console.info(`[Config] adbPath=… (source=…)`)`

These land in `server.log` only, never the canonical `ws-scrcpy-web.log`. Route them through `Logger.for('Config')` (`.warn` / `.info`) so the boot diagnostic lands in the canonical log and `server.log` is left purely forensic. `Logger` imports only `fs`/`path`, so `Config` → `Logger` introduces no import cycle.

### Launcher/tray — `common/src/log.rs`

- Add pure `should_echo_stderr(is_terminal: bool) -> bool` → returns `is_terminal`.
- `append()` becomes:
  ```
  if is_disabled() { return; }                 // unchanged — uninstall cleaner kills all logging first
  let ts = ...;
  if let Some(path) = log_path() { write file } // unchanged — file write always
  if should_echo_stderr(std::io::stderr().is_terminal()) {
      eprintln!("{ts} [{prefix}] {msg}");
  }
  ```
- Effect: under a service (stderr → `service.log` file, not a terminal) the echo is suppressed → `service.log` holds only raw launcher panics. In a local terminal the echo is preserved. For the tray (`windows_subsystem = "windows"`, no console) `is_terminal()` is false → the previously NUL-bound `eprintln!` is suppressed; `tray.log` (file) is unaffected.

### Log rotation (catch ⑥, folded in)

`common/log.rs` currently never rotates — `launcher.log` and `tray.log` grow unbounded. Add rotation symmetric with `Logger.ts` (rename to `<name>.log.1` at 5 MB, single backup), so the canonical launcher/tray logs are bounded. Implementation: before/at first write in `append()` (a `OnceLock<()>` "rotation-checked" guard mirroring `Logger.ts::rotateIfNeeded`'s once-per-process check), `stat` the file and `rename` to `.1` if `>= 5 MB`. `server.log`/`service.log` remain unrotated by design (now thin crash-catchers; minimal growth).

## What is deliberately unchanged

- `launcher/src/spawn.rs` — keeps redirecting the Node child's stdout/stderr to `server.log` (now thin).
- `SystemdClient.renderUnitFile` — keeps `StandardOutput/StandardError=append:service.log`.
- servy `--stdout/--stderr` (`elevated_runner.rs`) and `ServiceApi` `logPath` — keep `service.log`.
- The uninstall logs keep-list (`hooks.rs`) — all files still exist, so keep/wipe logic is unaffected.
- `launcher/src/main.rs:51` `println!` for `--print-active-session` — intentional **stdout** command output (consumed by the caller), NOT logging; the gate is stderr-only, so it is untouched.
- `capture-logs.{sh,ps1}` and the smoke docs — all four files still exist, so **no retargeting**; only descriptive relabeling (see below).

## File inventory (after)

| Mode | `<dataRoot>/logs/` |
|---|---|
| Dev (`npm start`, no launcher) | `ws-scrcpy-web.log` only · console → terminal |
| Windows / Linux **local** | `ws-scrcpy-web.log` (full) · `launcher.log` (full) · `server.log` (thin crash-catcher) |
| Windows / Linux **service** | + `service.log` (thin crash-catcher) |
| Windows only | + `tray.log` (full, per-user tray) |

`ws-scrcpy-web.log` (incl. the routed `[Config]` lines) and `launcher.log`/`tray.log` own all real content; `server.log`/`service.log` hold only non-logger output (raw crashes, panics, native noise). Zero content duplication. Under a Linux service the launcher stream additionally appears in `journalctl -u` only as systemd's own unit lifecycle (start/stop) — its app lines go to `service.log` per the retained `append:` directive.

## Interactions / edge cases (traced)

- **`index.ts` exit teardown:** `exit()` uses `setBlocking(true)` to flush teardown logs. With console suppressed in prod, teardown lines still reach `ws-scrcpy-web.log` via synchronous `appendFileSync`; `setBlocking` is moot in prod, still needed in dev. This **subsumes the SE-3 console-parity nit** (item 40 follow-up) in production — no console teardown output remains to drop. `setBlocking` stays.
- **`open_server_log` fails** (can't open `server.log`): `spawn.rs` falls back to inherited stdio; `isTTY` then tracks the real destination (terminal → console on; service capture → off). Self-correcting.
- **Windows `CREATE_NO_WINDOW`:** Node stdout/stderr are file handles → not a TTY → console suppressed → `server.log` thin. Correct.
- **Short-lived launcher helpers** (`Stdio::null`): not a terminal → `eprintln!` suppressed (harmless; the line is in `launcher.log` via the file write).
- **`is_disabled()`** (Windows uninstall cleaner): still wins first; the new gate only governs the echo.

## Consumers / docs to update

- **Comments:** `Logger.ts` (the v0.1.17 "prefix console so server.log matches" comment is now obsolete), `common/log.rs`, `spawn.rs::open_server_log` — relabel `server.log`/`service.log` as thin crash-catchers and document the `isTTY`/`is_terminal` gates.
- **`README.md:342`**, **`docs/TECHNICAL_GUIDE.md`**, **`docs/PROGRAMDATA-MIGRATION.md`** — update the log-file descriptions to the canonical-vs-crash-catcher model.
- **Smoke** (`smoke-full.md`/`smoke-runbook.md` 10.2/10.3): note that `server.log`/`service.log` are now thin (normal lines moved to `ws-scrcpy-web.log`/`launcher.log`); files are still tail-able. `capture-logs.{sh,ps1}` need no code change.
- Historical specs/plans referencing the old filenames are left as-is (historical record).

## The one behavioral consequence (not a hidden risk)

A dev who pipes stdout (`npm start | tee out.txt`, `> out.txt`) gets console output suppressed — correct, since stdout is a pipe/file, not a terminal, and `ws-scrcpy-web.log` still has the complete log. A console-on-a-pipe override, if ever wanted, would be a deliberate `--verbose` flag, never an ambient env var (YAGNI; not added).

## Test plan (TDD)

- **Pure decision functions:** `shouldLogToConsole(true)→true`, `(false)→false`; `should_echo_stderr(true/false)` likewise.
- **`Logger`:** writes the file in both console states (spy `fs.appendFileSync` or assert file contents); console gated by the injected/stubbed `isTTY`.
- **`Config`-via-`Logger`:** the `[Config] adbPath` line is produced through `Logger` (lands in the `ws-scrcpy-web.log` path), not raw `console`.
- **`common::log`:** file write happens when not a terminal (existing `disable_silences_logging` pattern extended); `should_echo_stderr` pure unit.
- **Rotation (new, Rust side):** a `common::log` file `>= 5 MB` is renamed to `<name>.log.1` once per process. (`Logger.ts` already rotates `ws-scrcpy-web.log`; unchanged.)
- **Full gates:** `vitest` + `tsc --noEmit` + launcher `cross test` + `cross clippy -D warnings`.

## Rollout

Own branch `production-log-dedup` (off `487803d`). `release:beta` PR → auto-release cuts **beta.59**, after the beta.58 re-smoke (#9) completes. CHANGELOG note under `## [Unreleased]` (never a pre-written version heading — `bump-version.mjs` promotes Unreleased).
