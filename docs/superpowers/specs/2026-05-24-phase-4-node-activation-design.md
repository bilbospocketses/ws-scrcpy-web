# Phase 4 — Node Activation (Operation-Server Rearchitecture)

> **Standalone spec for Phase 4.** Phases 1-3 SHIPPED (beta.39-42). Bat migration fix SHIPPED (beta.43). This spec supersedes the Phase 4 section of the original plan (`2026-05-23-operation-server-rearchitecture.md` lines 2053-2449) with three design revisions: (1) pre-exit operation-server spawn from Node, (2) `'shutting-down'` response status + frontend modal keep-alive, (3) `silent_command` helper for console window flash suppression.

## Goal

Wire Node-side to write the `uninstall-pending` marker, spawn the operation-server, and exit cleanly — replacing the Theory D handoff for the service+LocalSystem context. This is the activation that makes the operation-server pattern fire for real on service-uninstall. Also eliminates console window flashes during install/uninstall operations.

## Architecture overview

```
Browser ──POST /api/service/uninstall──▶ Service-Node (LocalSystem)
                                              │
                                     1. Write uninstall-pending marker
                                     2. Spawn operation-server (detached)
                                     3. Return 200 { status: 'shutting-down' }
                                     4. Schedule process.exit(0) in 5s
                                              │
                                              ▼
                              Service exits → op-server grabs port (~25ms)
                                              │
                                              ▼
                              Browser connection drops → page reloads
                              → hits operation-server "Uninstalling service..."
                                              │
                                              ▼
                              Servy fires post-stop.bat
                              → bat sees uninstall-pending marker
                              → bat's op-server spawn fails (port bound) — harmless
                              → servy-cli uninstall
                              → --spawn-user-launcher
                                              │
                                              ▼
                              Op-server wind-down detects new Node
                              → serves redirect → browser lands on local-mode app
```

## Design decisions

### Pre-exit operation-server spawn (vs bat-only spawn)

The original plan had Node write a marker and exit, leaving the bat to spawn the operation-server. This creates a timing gap: after the service exits, the port is unbound until the bat spawns the operation-server. The browser's page dies and has nowhere to reload to.

**Chosen approach:** Node spawns the operation-server as a detached child BEFORE exiting. The operation-server retry-loops on the config port; when the service releases it ~5s later, it binds within 25ms. The browser's stale page reloads directly into the "Uninstalling service" page.

The bat's redundant `start "" /b "<helper>" --operation-server` sees the port already bound, times out after 10s, and exits harmlessly. The bat's other commands (`servy-cli uninstall`, `--spawn-user-launcher`) run independently and are unaffected.

This mirrors the proven apply-update pre-exit spawn pattern from Part 5b (which was later moved to the bat for Velopack process-tree reasons that don't apply to uninstall).

### Frontend modal keep-alive (vs redirectTo)

The original plan returned `redirectTo` pointing at the service's own port. Since the service is still alive for ~5s, the browser would reload the full app, which then dies — cosmetically jarring.

**Chosen approach:** Return `status: 'shutting-down'` with NO `redirectTo`. The frontend checks for this status and keeps the `ServiceOperationModal` open (via a `keepModalOpen` flag that suppresses the `using _closeModal` disposal). The modal stays visible with its "uninstalling service" spinner until the page reloads into the operation-server's HTML.

### Console window flash suppression

`elevated_runner.rs::run_capture` uses bare `Command::new().output()` for servy-cli and reg.exe calls. Since the elevated runner launches via `ShellExecuteExW(verb="runas")` (no parent console), each spawn creates a visible console window that flashes briefly.

**Fix:** A `silent_command(exe)` helper that sets `CREATE_NO_WINDOW` (0x08000000) on Windows. Applied to all three console-app spawn sites in `elevated_runner.rs`.

## Files modified

### Node (server)

| File | Change |
|------|--------|
| `src/common/ServiceEvents.ts` | Add `'shutting-down'` to `ServiceStatus` union type |
| `src/server/Config.ts` | Add `uninstallPendingMarkerPath` getter mirroring `applyUpdatePendingMarkerPath` |
| `src/server/api/ServiceApi.ts` | Add `import { spawn } from 'child_process'`. Replace `handleUninstall` service+LocalSystem branch (lines 419-446): write marker, spawn operation-server, return `'shutting-down'`, schedule exit. `handoffUninstallToUserSession` body stays (dead code for Phase 5). |
| `src/server/__tests__/Config.test.ts` | One new test for the getter |
| `src/server/__tests__/ServiceApi.test.ts` | ~5 new tests for the marker-write + spawn + response shape |

### Frontend

| File | Change |
|------|--------|
| `src/app/client/SettingsModal.ts` | Uninstall handler: check `data.status === 'shutting-down'` before `redirectTo` check; set `keepModalOpen` flag to suppress modal disposal |

### Rust (launcher)

| File | Change |
|------|--------|
| `launcher/src/elevated_runner.rs` | Add `silent_command` helper; swap 3 callsites from `Command::new` to `silent_command` (lines 471, 429, 515) |

## Detailed changes

### ServiceEvents.ts — `ServiceStatus` type extension

Add `'shutting-down'` to the union (line 12):

```typescript
export type ServiceStatus = 'running' | 'stopped' | 'not-installed' | 'shutting-down';
```

### Config.ts — `uninstallPendingMarkerPath` getter

Mirrors `applyUpdatePendingMarkerPath` (line 526). Added immediately after it:

```typescript
public get uninstallPendingMarkerPath(): string {
    const base = this._dataRoot !== null
        ? this._dataRoot
        : path.dirname(this._dependenciesPath);
    return path.join(base, 'control', 'uninstall-pending');
}
```

### ServiceApi.ts — `handleUninstall` rewrite

**New import needed:** `import { spawn } from 'child_process';` (matches existing pattern in `AdbClient.ts`, `openBrowser.ts`, etc.).

The `else` branch at lines 419-446 (service+LocalSystem context) is replaced. Current code:

```typescript
} else {
    const installMode = cfg.getAppConfig().installMode;
    const runningAsService = installMode === 'user-service' || installMode === 'system-service';
    const isWindows = result.platform === 'win32';

    if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
        const handoff = await this.handoffUninstallToUserSession(cfg.dependenciesPath, res);
        if (handoff) return true;
        const body: ServiceActionFailure = {
            ok: false,
            error: "Couldn't reach the user session to relay the uninstall request. ...",
            reason: 'handoff-timeout',
        };
        res.writeHead(503);
        res.end(JSON.stringify(body));
        return true;
    }
}
```

New code:

```typescript
} else {
    const installMode = cfg.getAppConfig().installMode;
    const runningAsService = installMode === 'user-service' || installMode === 'system-service';
    const isWindows = result.platform === 'win32';

    if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
        // Phase 4 operation-server flow: write uninstall-pending marker,
        // spawn operation-server (detached, retry-loops on port), return
        // 'shutting-down' status, schedule process.exit(0).
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

        // Spawn operation-server so it's retry-looping on the port before
        // we exit. It grabs the port within ~25ms of service exit.
        // cfg.dataRoot is string | null; fall back to deps parent.
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
        try {
            const child = spawn(helperPath, ['--operation-server'], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: { ...process.env, WS_SCRCPY_DATA_ROOT: dataRoot },
            });
            child.unref();
            log.info(`uninstall: spawned operation-server at ${helperPath}`);
        } catch (err) {
            log.warn(`uninstall: failed to spawn operation-server (bat will handle it): ${(err as Error).message}`);
        }

        setTimeout(() => {
            log.info('uninstall: scheduled exit firing (post-stop.bat takes over)');
            process.exit(0);
        }, 5000).unref();

        const body: ServiceActionSuccess = {
            ok: true,
            status: 'shutting-down',
            installMode: 'user-service',
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }
}
```

**Note:** `handoffUninstallToUserSession` function body stays untouched as dead code. Phase 5 deletes it.

**Note:** The operation-server spawn is best-effort (catch + warn). If it fails, the bat's spawn takes over — same as if we hadn't tried. The bat's spawn will succeed because the port will be free by then (service already exited). The only cost is a brief gap where the port is unbound.

### SettingsModal.ts — modal keep-alive

In the uninstall handler (~line 909-928), add a `keepModalOpen` flag:

```typescript
let keepModalOpen = false;
const modal = new ServiceOperationModal({ operation: 'uninstall' });
using _closeModal = { [Symbol.dispose](): void { if (!keepModalOpen) modal.close(); } };
try {
    const r = await fetch('/api/service/uninstall', { method: 'POST' });
    const data = (await r.json().catch(() => null)) as ServiceUninstallResponse | null;
    if (!r.ok || !data || data.ok !== true) {
        // ... existing error handling unchanged ...
        return;
    }
    if (data.status === 'shutting-down') {
        keepModalOpen = true;
        return;
    }
    if (data.redirectTo) {
        // ... existing redirect handling unchanged ...
        return;
    }
    await this.refreshService();
} catch {
    this.renderServiceError("couldn't reach server", () => void this.refreshService());
}
```

### elevated_runner.rs — `silent_command` helper

```rust
/// Build a `Command` that suppresses console window creation on Windows.
/// Used for servy-cli, taskkill, reg.exe — any console app spawned from the
/// elevated runner (which has no parent console due to ShellExecuteExW).
#[cfg(windows)]
fn silent_command(exe: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(exe);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(windows))]
fn silent_command(exe: &str) -> Command {
    Command::new(exe)
}
```

Three callsites updated:

1. `run_capture` (line 471): `Command::new(exe)` → `silent_command(exe)`
2. `uninstall_service` taskkill (line 429): `Command::new("taskkill")` → `silent_command("taskkill")`
3. `reg_delete_value_best_effort` (line 515): `Command::new("reg.exe")` → `silent_command("reg.exe")`

## Tests

### vitest (Node)

**Config.test.ts:**
- `Config.uninstallPendingMarkerPath` returns `<dataRoot>/control/uninstall-pending`

**ServiceApi.test.ts** — new `describe('handleUninstall — operation-server flow')`:
- Writes `uninstall-pending` marker when service+LocalSystem on Windows
- Spawns operation-server helper (spy on `child_process.spawn`)
- Returns `200 { ok: true, status: 'shutting-down' }` with no `redirectTo`
- Schedules `process.exit(0)` after 5s (fake timers)
- Does NOT write marker or spawn in local mode

### cargo test (Rust)

**elevated_runner.rs:**
- `silent_command` returns a Command (compile-time verification is sufficient; the creation flag is a u32 constant with no runtime failure mode)

### vitest (frontend)

**SettingsModal tests:**
- `status: 'shutting-down'` response keeps modal open (verify `modal.close()` not called)
- Normal response still closes modal

## Smoke plan (clean VM, mandatory)

| # | Scenario | Pass criteria |
|---|----------|---------------|
| 1 | Install Service | Phase 3 modal visible. **No console window flash.** Browser lands on service-mode UI. |
| 2 | Uninstall Service x3 (pre-reboot) | "Uninstalling service" modal stays visible. **No UAC prompt.** Page reloads to operation-server page, then redirects to local-mode Node. Re-install between iterations. |
| 3 | Reboot → Uninstall | Succeeds across reboot boundary. |
| 4 | Reboot → idle 15+ min → Uninstall | Old Bug B aggravation case. Must succeed. |

**Log capture per uninstall:**
- `launcher.log`: `operation-server: starting` + `variant=Uninstall` + `bound 0.0.0.0:<port>`
- `post-stop.log`: `uninstall-pending marker found, firing uninstall branch`
- `ws-scrcpy-web.log`: `uninstall: wrote uninstall-pending marker` + `spawned operation-server` + `scheduled exit firing`
- Verify `control/uninstall-pending` marker is GONE post-uninstall

**Pass gate:** 3/3 pre-reboot + 1 post-reboot + 1 post-idle, all clean with no console flashes and no UAC prompts during uninstall.

## Phase 5 (next, out of scope)

Dead-code sweep: delete `handoffUninstallToUserSession` body + associated imports (`consumeToken`, `issueToken`, `writeUninstallHandoffMarker`, `resolveActiveSessionId`, `resolveLauncherPathForElevation`). Audit each for other callers before deletion.

## Relationship to original plan

This spec supersedes `docs/superpowers/plans/2026-05-23-operation-server-rearchitecture.md` Phase 4 (lines 2053-2449). The original plan's Task 4.2 (Config getter), Task 4.3 (handleUninstall rewrite), Task 4.4 (CHANGELOG + PR), Task 4.5 (smoke), Task 4.6 (beta cut) remain structurally valid but with the three design revisions documented above. Beta numbering shifts: Phase 4 ships as beta.44 (not beta.42 as originally planned).
