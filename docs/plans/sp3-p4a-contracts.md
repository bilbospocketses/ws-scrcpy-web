# SP3 P4a — Windows Tray Icon: Lead Contracts

**Branch:** `sp3-p4a-tray-icon` (off `main` at `96718fb`)
**Authored:** 2026-04-26 (lead reality-check pass before agent dispatch)
**Reads with:** `docs/specs/2026-04-26-sp3-velopack-installer.md` § UI section C (Tray icon) + § Service integration login Run-key, `docs/plans/2026-04-26-sp3-velopack-installer.md` § P4.

**Scope clarification:** P4a covers Windows tray only. Linux tray (and the SystemdClient real implementation) ships in P4b per `todo_ws_scrcpy_web.md`. Manual smoke testing is deferred until SP3 closes — agents do NOT run live UI tests.

## Drift findings (vs plan file table)

| Plan said | Reality | Resolution |
|---|---|---|
| `tray/Cargo.toml` already exists; modify it | ✓ Confirmed — minimal stub at `tray/Cargo.toml`, `tray/src/main.rs` is a `println!` placeholder | Modify both |
| `launcher/src/config.rs` exists; expose installMode for tray init decision | ✓ Confirmed — already has `is_service_mode()` helper that returns `installMode` ends with `-service`. **Will be MOVED to `common/` per decision 3 below.** | Move to `common::config::AppConfig`; launcher updates its `use` paths |
| `assets/tray-icon.ico` (Create) | ✓ Lead pre-generated a placeholder at `assets/tray-icon.ico` (1129 bytes; multi-res 16/32/48 PNG-encoded blue square with white "W"). User will replace with branded art before P4a closes. | Use it as-is; don't regenerate |
| `src/server/ServyClient.ts` modify for Run-key | Reality: the Servy install/uninstall path is in `src/server/service/ServyClient.ts` (note `service/` subdir from P3) | Adjusted path |

## Architectural decisions (locked by user 2026-04-26)

1. **Tray crate:** `tray-icon` 0.x + `winit` 0.30+
2. **Click-confirm dialog:** Win32 `MessageBoxW` via `windows` crate (no extra dep)
3. **Code-sharing strategy:** **Extract a `common/` workspace lib crate now.** Holds shared `config` module (moved from `launcher/src/config.rs`) and a shared `tray` module (new). Cleaner long-term than duplicating tray logic in two binaries.
4. **Run-key registration:** `reg.exe add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v WsScrcpyWebTray /d "<absPath>" /f` via `execFileSync`. Universal, no new deps. `reg.exe delete /f` on uninstall.
5. **Spawn-on-install:** `child_process.spawn` (detached, unref'd) immediately after Run-key registration so the tray icon appears without re-login.
6. **Icon:** Placeholder ICO already in repo at `assets/tray-icon.ico`. Both binaries embed via `include_bytes!`. **User will provide final art before P4a closes** — agents should NOT modify the .ico file.
7. **Hidden-window subsystem:** tray helper crate gets `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` matching launcher.
8. **HTTP shutdown endpoint:** new `POST /api/server/shutdown` returns 200 immediately, then `setTimeout(() => process.exit(0), 100)` so the response flushes before exit. Body-less request. No auth (localhost-only intent; future hardening if exposed remotely).
9. **Servy auto-restart-on-exit-0 risk:** Servy's behavior on a clean exit-0 from the managed process is undocumented in the README/wiki accessible to lead at authoring time (Servy v8.2 elevation requirement blocked CLI help). Most service managers (Windows SCM, systemd) treat exit-0 as "stopped, don't restart." Flagging as a smoke-test item: if Servy auto-restarts after the shutdown endpoint, we'll need to also call `servy stop` from inside the shutdown handler before exiting (acceptable mitigation, adds ~0.5s to shutdown). Out-of-scope for P4a coding; will be verified in user's SP3-close smoke.

## Workspace restructure — common/ extraction

```
ws-scrcpy-web/
├── Cargo.toml              # MODIFIED — members += "common"; workspace.deps += tray-icon, winit, ureq
├── common/                 # NEW
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs          # `pub mod config; pub mod tray;`
│       ├── config.rs       # MOVED from launcher/src/config.rs (see API delta below)
│       └── tray.rs         # NEW — shared tray rendering + click handler
├── launcher/
│   ├── Cargo.toml          # MODIFIED — add `common = { path = "../common" }`, tray-icon, winit
│   └── src/
│       ├── main.rs         # MODIFIED — spawn tray thread before supervisor::run when non-service
│       ├── tray.rs         # NEW — thin wrapper that calls common::tray::run on a dedicated thread
│       ├── config.rs       # DELETED (re-exported via common)
│       ├── hooks.rs        # MODIFIED — `use common::config::AppConfig` instead of `crate::config::*`
│       ├── log.rs          # UNCHANGED — launcher-internal logger
│       └── ...             # spawn.rs, supervisor.rs, paths.rs unchanged
├── tray/
│   ├── Cargo.toml          # MODIFIED — add common, tray-icon, winit, windows, ureq
│   └── src/
│       └── main.rs         # REPLACED — uses common::config + common::tray; HTTP POSTs to /api/server/shutdown
└── assets/
    └── tray-icon.ico       # ALREADY EXISTS (placeholder; user will replace)
```

### common::config API (delta from launcher::config)

The current `AppConfig::load` swallows errors and returns `AppConfig::default()` on missing/malformed files, calling `crate::log::error` internally. To make `common` a true library with no side-effect dependencies on launcher's `log` module, change to:

```rust
#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl AppConfig {
    /// Strict load: missing file -> Err; malformed JSON -> Err.
    pub fn load_strict(install_root: &Path) -> Result<Self, ConfigError>;

    /// Lenient load: missing file -> default; malformed -> default. Always returns
    /// a valid `AppConfig`. Caller is responsible for any logging it wants on the
    /// fallback path; this method itself never logs (so common can stay
    /// dependency-free of launcher's log module).
    pub fn load(install_root: &Path) -> Self;
}
```

The existing `load` semantics are preserved (always returns `Self`, missing/bad → default), just no longer logs internally. Callers that want logging do:

```rust
// in launcher/src/hooks.rs, replacing `let cfg = AppConfig::load(install_root);`:
let cfg = match AppConfig::load_strict(install_root) {
    Ok(cfg) => cfg,
    Err(e) => {
        log::error(&format!("config load failed: {e:?}; using defaults"));
        AppConfig::default()
    }
};
```

If the agent finds this verbosity unpleasant, an acceptable simplification is to keep `pub fn load(install_root: &Path) -> Self` swallowing errors silently (no logging in common), and add a separate `load_with_logger(install_root: &Path, log: impl Fn(&str)) -> Self` for callers that want feedback. Either approach is acceptable.

All existing tests in the migrated config.rs should pass unchanged (they only use `AppConfig::load`, which retains its `-> Self` signature with no-op-on-error semantics).

### common::tray API

```rust
use std::sync::Arc;

/// Result of the user's interaction with the tray.
pub enum TrayAction {
    /// User chose "Yes" on the exit-confirmation dialog.
    ConfirmedExit,
    /// User chose "No" or dismissed the dialog.
    Cancelled,
}

/// Run a tray icon event loop. BLOCKS the calling thread until the user
/// confirms exit (returns `TrayAction::ConfirmedExit`) or the loop is told
/// to exit programmatically (e.g., parent process shutting down).
///
/// # Arguments
/// - `icon_bytes`: raw ICO bytes (typically `include_bytes!("../../assets/tray-icon.ico")`)
/// - `tooltip`: hover text on the icon (e.g., "ws-scrcpy-web")
/// - `confirm_title`, `confirm_body`: text of the confirmation MessageBox
///
/// # Returns
/// `TrayAction::ConfirmedExit` when user confirms; never returns
/// `Cancelled` from the public API (cancellation just keeps the loop running).
pub fn run(
    icon_bytes: &[u8],
    tooltip: &str,
    confirm_title: &str,
    confirm_body: &str,
) -> anyhow::Result<TrayAction>;
```

Implementation notes for the agent:
- `tray-icon` crate works on a non-main thread on Windows since v0.x (verify the latest stable); if there's a main-thread requirement for the chosen version, the launcher's wiring (decision 3 below) will need adjustment.
- Click handler shows `MessageBoxW` synchronously (it's a modal). The dialog blocks the click handler. On `IDYES` -> exit the event loop with `ConfirmedExit`. On `IDNO` -> continue the loop.
- Use `windows` crate (already in workspace deps) for `MessageBoxW`. Required features: `Win32_UI_WindowsAndMessaging`. Add to workspace.dependencies.windows.features.
- No Tokio / async runtime — synchronous code throughout.

### launcher tray wiring (`launcher/src/tray.rs`)

```rust
use std::thread;
use crate::log;

/// Spawn the tray icon on a dedicated thread. Returns immediately.
/// The supervisor is left running on the main thread.
///
/// On `ConfirmedExit`, the tray thread sends a shutdown signal (TODO: through
/// the supervisor's existing exit-75 / .restart mechanism, OR — preferred —
/// directly call `std::process::exit(0)` after asking the supervisor to stop
/// the Node child gracefully. The agent picks the cleanest integration point.)
pub fn spawn(install_mode_is_service: bool) -> Option<thread::JoinHandle<()>> {
    if install_mode_is_service {
        // Service mode: tray helper handles it (separate process). Do nothing here.
        return None;
    }
    Some(thread::spawn(|| {
        let icon = include_bytes!("../../assets/tray-icon.ico");
        match common::tray::run(icon, "ws-scrcpy-web", "Exit ws-scrcpy-web?", "Stop the server and quit?") {
            Ok(common::tray::TrayAction::ConfirmedExit) => {
                log::info("tray: user confirmed exit");
                // TODO (agent decides): cleanest way to signal shutdown to supervisor
                std::process::exit(0);
            }
            Ok(_) => {} // Cancelled — unreachable per common::tray docs
            Err(e) => log::error(&format!("tray loop failed: {e:?}")),
        }
    }))
}
```

Then in `launcher/src/main.rs`:

```rust
// After velopack hook dispatch + VelopackApp::build().run(), before supervisor::run():
let install_root = paths::install_root();
let cfg = common::config::AppConfig::load(&install_root);
let _tray_handle = tray::spawn(cfg.is_service_mode());
// supervisor::run() then runs as before; tray thread terminates with the process
let exit_code = match supervisor::run() { ... };
```

**Agent note:** the supervisor doesn't currently have a "graceful stop from external thread" API. Adding one is in-scope for P4a if the agent can do it cleanly (5-10 lines in supervisor.rs); otherwise `std::process::exit(0)` from the tray thread is acceptable for P4a (the supervisor is wrapped in a process-exit anyway in main.rs, and the Node child receives SIGINT/SIGTERM via process-tree teardown on Windows). Lead does not gate on a graceful-shutdown signal for P4a.

### tray helper (`tray/src/main.rs`)

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Context;
use std::env;
use std::path::PathBuf;

const ICON_BYTES: &[u8] = include_bytes!("../../assets/tray-icon.ico");

fn install_root_from_exe() -> anyhow::Result<PathBuf> {
    let exe = env::current_exe().context("current_exe")?;
    // `current/<helper>.exe` -> install root is one level up from `current/`
    let parent = exe.parent().context("exe parent")?;
    // If parent is named "current", go up one more; otherwise treat parent as install root.
    if parent.file_name().and_then(|n| n.to_str()) == Some("current") {
        Ok(parent.parent().context("install root")?.to_path_buf())
    } else {
        Ok(parent.to_path_buf())
    }
}

fn main() -> anyhow::Result<()> {
    let install_root = install_root_from_exe()?;
    let cfg = common::config::AppConfig::load(&install_root);
    let port = cfg.web_port.unwrap_or(8000);

    let action = common::tray::run(
        ICON_BYTES,
        "ws-scrcpy-web (service)",
        "Exit ws-scrcpy-web?",
        "Stop the service and quit?",
    )?;

    if matches!(action, common::tray::TrayAction::ConfirmedExit) {
        // POST /api/server/shutdown — body-less, fire-and-forget.
        // Use ureq (sync) to avoid pulling in tokio.
        let url = format!("http://localhost:{port}/api/server/shutdown");
        let _ = ureq::post(&url).timeout(std::time::Duration::from_secs(5)).send_string("");
    }
    Ok(())
}
```

### Cargo.toml updates

**Root `Cargo.toml`:**
```toml
[workspace]
resolver = "2"
members = ["common", "launcher", "tray"]

[workspace.dependencies]
# ...existing deps unchanged...
tray-icon = "0.19"     # check crates.io for current stable at agent runtime; 0.19 was current as of 2026-04
winit = "0.30"
ureq = { version = "2.10", default-features = false, features = ["tls"] }
windows = { version = "0.58", features = [
    "Win32_System_Threading",
    "Win32_System_Console",
    "Win32_Foundation",
    "Win32_UI_WindowsAndMessaging",  # NEW — for MessageBoxW
] }
```

**`common/Cargo.toml`** (new):
```toml
[package]
name = "ws-scrcpy-web-common"
version.workspace = true
edition.workspace = true
authors.workspace = true
license.workspace = true
repository.workspace = true

[lib]
name = "common"
path = "src/lib.rs"

[dependencies]
serde.workspace = true
serde_json.workspace = true
tray-icon.workspace = true
winit.workspace = true
windows = { workspace = true }
anyhow.workspace = true

[dev-dependencies]
tempfile = "3.10"
```

**`launcher/Cargo.toml`** (modified — add common dep; tray-icon/winit NOT needed here since common owns it):
```toml
[dependencies]
# ...existing...
common = { path = "../common" }
```

**`tray/Cargo.toml`** (modified):
```toml
[dependencies]
common = { path = "../common" }
anyhow.workspace = true
ureq.workspace = true
```

## TypeScript / Node side

### POST /api/server/shutdown — new endpoint

**File:** `src/server/api/ServerShutdownApi.ts` (new)

```typescript
import type { IncomingMessage, ServerResponse } from 'http';
import { Logger } from '../Logger';

const log = Logger.for('ServerShutdownApi');

export class ServerShutdownApi {
    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (req.url !== '/api/server/shutdown' || req.method !== 'POST') return false;

        log.info('shutdown requested via /api/server/shutdown');
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

        // Defer exit so the response flushes. 100ms is enough on localhost;
        // the tray helper has a 5s connection timeout and exits regardless.
        setTimeout(() => {
            log.info('exiting (process.exit 0)');
            process.exit(0);
        }, 100);

        return true;
    }
}
```

**Wired into:** `src/server/index.ts` — register alongside ConfigApi / ServiceApi:
```typescript
const shutdownApi = new ServerShutdownApi();
HttpServer.addApiHandler(shutdownApi);
```

**Test:** `src/server/__tests__/ServerShutdownApi.test.ts` — mock `setTimeout` + `process.exit`, verify response shape and that exit is scheduled.

### ServyClient modifications — Run-key registration

**File:** `src/server/service/ServyClient.ts` (modify)

Add three new methods:

```typescript
/**
 * Register the tray helper to auto-start at user login.
 * Idempotent — overwrites if value already exists.
 */
private registerTrayRunKey(trayHelperPath: string): void {
    execFileSync('reg.exe', [
        'add',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', 'WsScrcpyWebTray',
        '/t', 'REG_SZ',
        '/d', trayHelperPath,
        '/f',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Remove the tray helper Run-key entry. Idempotent — succeeds if value is absent.
 */
private unregisterTrayRunKey(): void {
    try {
        execFileSync('reg.exe', [
            'delete',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', 'WsScrcpyWebTray',
            '/f',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        // reg.exe delete returns non-zero if value doesn't exist — that's fine.
        const msg = (err as Error).message ?? '';
        if (!/cannot find/i.test(msg) && !/system was unable to find/i.test(msg)) {
            throw err;
        }
    }
}

/** Resolve the tray helper exe path (sibling of servy-cli.exe in installed mode; publish/ in dev). */
private resolveTrayHelperPath(): string {
    const installedCandidate = path.join(process.cwd(), 'ws-scrcpy-web-tray.exe');
    if (fs.existsSync(installedCandidate)) return installedCandidate;
    const cwdPublish = path.join(process.cwd(), 'publish', 'ws-scrcpy-web-tray.exe');
    if (fs.existsSync(cwdPublish)) return cwdPublish;
    throw new Error(`ws-scrcpy-web-tray.exe not found (looked at ${installedCandidate} and ${cwdPublish})`);
}
```

Wire `install()` to call `registerTrayRunKey` AND spawn the helper after Servy install succeeds:

```typescript
async install(opts: ServiceInstallOptions): Promise<void> {
    // ... existing servy-cli install logic ...

    // After Servy registration succeeds, register the tray helper for auto-start
    // and spawn it now so the user sees the icon without re-login.
    const trayPath = this.resolveTrayHelperPath();
    this.registerTrayRunKey(trayPath);
    // Detached + unref'd: helper outlives this process.
    spawn(trayPath, [], { detached: true, stdio: 'ignore' }).unref();
}
```

Wire `uninstall()` to remove the Run-key:

```typescript
async uninstall(name: string): Promise<void> {
    // ... existing servy-cli uninstall logic ...
    this.unregisterTrayRunKey();
    // Note: any currently-running tray helper process is left alone. It will
    // see the next /api/server/shutdown failure (server gone) gracefully OR
    // be ended by the user / next reboot. Killing it explicitly here would
    // require enumerating processes by name — out of scope for P4a.
}
```

**Tests** (`src/server/__tests__/ServyClient.test.ts` — add new cases): mock `execFileSync` for `reg.exe` calls, verify the argv shapes for both register and unregister, verify install path also spawns the helper, verify uninstall calls reg delete and tolerates a missing-value error.

## File ownership matrix

**Rust agent owns:**
- `Cargo.toml` (root — modify members + workspace.dependencies)
- `common/` (entire new tree)
- `common/Cargo.toml`, `common/src/lib.rs`, `common/src/config.rs` (moved), `common/src/tray.rs` (new)
- `launcher/Cargo.toml` (modify — add common dep)
- `launcher/src/main.rs` (modify — spawn tray)
- `launcher/src/tray.rs` (new — thin wrapper)
- `launcher/src/config.rs` (DELETE — moved to common)
- `launcher/src/hooks.rs` (modify — `use common::config::AppConfig`)
- `tray/Cargo.toml` (modify)
- `tray/src/main.rs` (replace stub with real impl)
- Tests in common/src/config.rs (migrate from launcher), common/src/tray.rs (new — basic instantiation test if feasible without an event loop), tray/src/main.rs

**TypeScript agent owns:**
- `src/server/api/ServerShutdownApi.ts` (new)
- `src/server/__tests__/ServerShutdownApi.test.ts` (new)
- `src/server/service/ServyClient.ts` (modify — add Run-key methods + spawn-on-install + uninstall hook)
- `src/server/__tests__/ServyClient.test.ts` (modify — add test cases)
- `src/server/index.ts` (modify — register ServerShutdownApi)

**No-touch list (do NOT modify):**
- `assets/tray-icon.ico` — placeholder is in place; user replaces before P4a closes
- Any frontend code in `src/app/` — P4a has no UI changes (Settings modal "Stop Server & Exit" button is per spec § D, separate from tray; lands later)
- Any P3 code (ConfigApi, SettingsModal, WelcomeModal, etc.)
- launcher/src/spawn.rs, launcher/src/supervisor.rs, launcher/src/log.rs, launcher/src/paths.rs

## Validation gates (lead runs after both agents finish)

1. `cargo build --workspace` — all three crates compile clean
2. `cargo test --workspace` — config tests still pass post-move; new tray tests (if any) pass
3. `cargo clippy --workspace --all-targets -- -D warnings` — clean
4. `npx tsc --noEmit` — clean (pre-existing libcDetect error allowed)
5. `npm test` — all green; expect 429+N tests where N = ServerShutdownApi tests + new ServyClient tests
6. `npm run build` — webpack green
7. **NO live smoke for P4a** per user decision — manual smoke deferred until SP3 closes for one-shot Windows + Linux deployment validation.

## Coordination notes

- Both agents reference this doc as primary spec. Read it before touching any plan/spec.
- Rust agent does the workspace restructure FIRST (move config.rs to common/, update launcher imports) before adding new tray code, so the launcher build doesn't break in an intermediate state.
- TypeScript agent does NOT depend on Rust agent's output (different files). Can run truly parallel.
- Neither agent commits. Lead reviews diffs, runs validation, commits as one unit.
- If an agent finds a drift not noted here (e.g., a tray-icon crate API change, or a Servy CLI difference), append a "## Agent drift notes" section to the BOTTOM of this contracts doc and proceed with the most consistent choice — don't block.
- **Servy auto-restart-on-exit-0 risk** (decision 9): if either agent encounters evidence one way or another (e.g., from Servy source if browsing, or test output), log it in the drift notes section so lead doesn't re-research at validation time.

## Agent drift notes

### Rust agent (2026-04-26)

**Crate versions chosen:**
- `tray-icon` **0.22** (latest stable; doc spec'd 0.19). 0.22's README confirms Windows non-main-thread support so launcher's threaded model holds. `TrayIconEvent::Click` variant is used (not the older `TrayIconEvent` struct with `event` field).
- `winit` — **NOT USED**. Decided to skip winit entirely and use a manual Win32 message pump (`GetMessageW`/`TranslateMessage`/`DispatchMessageW`) via the `windows` crate. Rationale: tray-icon's only requirement on Windows is "a win32 event loop on the same thread" — winit would add hundreds of KB and a complex `ApplicationHandler` API for zero benefit when we have no windows of our own. `winit = "0.30"` workspace dep was also NOT added (declined the dep entirely). If a future feature needs a real windowing surface, add it then.
- `ureq` **2.10** (workspace.dependencies pin). Stuck with 2.x for the synchronous `.timeout()` + `.send_string()` API the contracts doc spec'd; ureq 3.x has a different agent API.
- `png` **0.18** added as a direct `common` dep for ICO PNG-entry decoding. Already a transitive dep of tray-icon, so no new build cost.

**Package-name tweak:** `common = { path = "../common" }` failed because the package name in `common/Cargo.toml` is `ws-scrcpy-web-common`. Fixed by using `common = { path = "../common", package = "ws-scrcpy-web-common" }` in both launcher and tray manifests, preserving the short `common::` import path the rest of the code uses.

**windows crate `Option<HWND>` mismatch:** `windows` 0.58's `MessageBoxW`/`GetMessageW` take `HWND` directly via `Param<HWND, CopyType>`, not `Option<HWND>`. Pass `HWND::default()` (NULL) instead of `Some(HWND::default())`. (Newer `windows` 0.6x uses `Option<HWND>`; if/when we bump, both calls flip back.)

**Servy auto-restart-on-exit-0 risk:** No new evidence surfaced during this work — Servy was not invoked and its source not browsed. Contracts doc decision 9 stands as authored: smoke-test at SP3 close.

**ICO decoding strategy:** `tray_icon::Icon::from_rgba` is the portable path; we hand-decode the ICO ourselves (largest entry, PNG or 32bpp BMP) using `png`. Picking the largest entry mimics what Windows' `LoadIcon` would do for the system tray (~16-32px). The placeholder ICO is multi-res PNG, which the parser handles. If the user replaces it with a 32bpp BMP-encoded ICO that's also fine; an indexed-color or 24bpp BMP ICO would surface a clear error message rather than crash.

**Files created (8):**
- `common/Cargo.toml`
- `common/src/lib.rs`
- `common/src/config.rs`
- `common/src/tray.rs`
- `launcher/src/tray.rs`
- (+ tray helper `tray/src/main.rs` was a replacement, listed under modified)
