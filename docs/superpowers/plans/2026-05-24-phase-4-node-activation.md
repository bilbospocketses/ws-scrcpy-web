# Phase 4 — Node Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task that edits existing code embeds the verbatim current source (per `feedback_subagent_code_specificity`); subagents MUST match the embedded source exactly when locating edits — do NOT paraphrase or describe-by-name. If you see modifications you don't expect in files OUTSIDE your task's scope, STOP and ASK — never silently revert or assume they're pre-existing user changes.

**Goal:** Activate the operation-server pattern for service-uninstall by wiring the Node-side marker write + pre-exit operation-server spawn + frontend modal keep-alive, and suppress console window flashes from servy-cli/taskkill/reg.exe spawns.

**Architecture:** Service-Node writes `uninstall-pending` marker, spawns operation-server (detached, retry-loops on port), returns `200 { status: 'shutting-down' }`, then schedules `process.exit(0)`. Operation-server grabs port ~25ms after exit. Frontend keeps the ServiceOperationModal open via a `keepModalOpen` flag. Post-stop.bat runs `servy-cli uninstall` + `--spawn-user-launcher`. Console window flashes eliminated via `silent_command` helper in `elevated_runner.rs`.

**Tech Stack:** Node.js + TypeScript (server), vitest (Node + frontend tests), Rust 1.x (launcher workspace), cargo test (Rust tests).

**Spec:** `docs/superpowers/specs/2026-05-24-phase-4-node-activation-design.md`

**Branching strategy:** Single PR branch off `main`, squash-merge per CLAUDE.md rule (`required_signatures` on main). Beta.44 cut after smoke.

**Repo absolute path:** `C:/Users/jscha/source/repos/ws-scrcpy-web`

**IMPORTANT — multi-session cwd discipline:** ALL git commands MUST use `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`. ALL file paths MUST be absolute. NO `cd` into the repo.

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `src/common/ServiceEvents.ts` | Modify line 12 | Add `'shutting-down'` to `ServiceStatus` union |
| `src/server/Config.ts` | Modify after line 531 | Add `uninstallPendingMarkerPath` getter |
| `src/server/__tests__/Config.test.ts` | Modify — append test | Test the new getter |
| `src/server/api/ServiceApi.ts` | Modify lines 1 (import) + 419-446 (branch rewrite) | `spawn` import + operation-server activation flow |
| `src/server/__tests__/ServiceApi.test.ts` | Modify — append describe block | 5 tests for the new flow |
| `src/app/client/SettingsModal.ts` | Modify lines 909-931 | `keepModalOpen` flag + `'shutting-down'` check |
| `launcher/src/elevated_runner.rs` | Modify — add helper + swap 3 callsites | `silent_command` helper |

---

### Task 1: Create feature branch

- [ ] **Step 1: Verify clean state and pull latest main.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" status -sb
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull origin main
```

Expected: `## main...origin/main` (clean tree). Pull succeeds.

- [ ] **Step 2: Create branch.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout -b feat/phase-4-node-activation
```

- [ ] **Step 3: Commit spec (already on main, verify present).**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" log --oneline -3
```

Expected: spec commit `3fe224d` visible in recent history.

---

### Task 2: Add `'shutting-down'` to `ServiceStatus` type

**Files:**
- Modify: `src/common/ServiceEvents.ts:12`

- [ ] **Step 1: Edit the type.**

Current text at line 12:

```typescript
export type ServiceStatus = 'running' | 'stopped' | 'not-installed';
```

Replace with:

```typescript
export type ServiceStatus = 'running' | 'stopped' | 'not-installed' | 'shutting-down';
```

- [ ] **Step 2: Type-check.**

```powershell
npx tsc --noEmit --project "C:/Users/jscha/source/repos/ws-scrcpy-web/tsconfig.json"
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/common/ServiceEvents.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(common): add 'shutting-down' to ServiceStatus type"
```

---

### Task 3: Add `Config.uninstallPendingMarkerPath` getter + test

**Files:**
- Modify: `src/server/Config.ts` (add getter after line 531)
- Modify: `src/server/__tests__/Config.test.ts` (append test)

- [ ] **Step 1: Write the failing test.**

Append to the bottom of `src/server/__tests__/Config.test.ts`, INSIDE the existing `describe('Config — AppConfig extension', () => { ... })` block, just before the final `});`:

```typescript
    it('uninstallPendingMarkerPath returns <dataRoot>/control/uninstall-pending', () => {
        setup({});
        const cfg = Config.getInstance();
        const depsDir = process.env['DEPS_PATH']!;
        const expectedBase = path.dirname(depsDir);
        expect(cfg.uninstallPendingMarkerPath).toBe(
            path.join(expectedBase, 'control', 'uninstall-pending'),
        );
    });
```

- [ ] **Step 2: Run test, verify failure.**

```powershell
npx vitest run "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/__tests__/Config.test.ts" -t "uninstallPendingMarkerPath"
```

Expected: FAIL — `uninstallPendingMarkerPath` does not exist on Config.

- [ ] **Step 3: Add the getter to `Config.ts`.**

Current text at lines 526-531 of `src/server/Config.ts`:

```typescript
    public get applyUpdatePendingMarkerPath(): string {
        const base = this._dataRoot !== null
            ? this._dataRoot
            : path.dirname(this._dependenciesPath);
        return path.join(base, 'control', 'apply-update-pending');
    }
```

Add immediately after (after line 531, before the blank line):

```typescript

    public get uninstallPendingMarkerPath(): string {
        const base = this._dataRoot !== null
            ? this._dataRoot
            : path.dirname(this._dependenciesPath);
        return path.join(base, 'control', 'uninstall-pending');
    }
```

- [ ] **Step 4: Run test, verify pass.**

```powershell
npx vitest run "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/__tests__/Config.test.ts" -t "uninstallPendingMarkerPath"
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/Config.ts src/server/__tests__/Config.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(server): Config.uninstallPendingMarkerPath getter"
```

---

### Task 4: Rewrite `handleUninstall` service+LocalSystem branch + tests

**Files:**
- Modify: `src/server/api/ServiceApi.ts` (add `spawn` import at line 3; replace lines 419-446)
- Modify: `src/server/__tests__/ServiceApi.test.ts` (append new describe block)

This is the core activation. TDD: write 5 failing tests first, then rewrite the branch, then verify all pass.

- [ ] **Step 1: Write failing tests.**

Append the following `describe` block to `src/server/__tests__/ServiceApi.test.ts`, INSIDE the existing `describe('ServiceApi', () => { ... })` block, just before its closing `});`:

```typescript
    describe('handleUninstall — operation-server flow (Phase 4)', () => {
        it('writes uninstall-pending marker when service+LocalSystem on Windows', async () => {
            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(() => factoryResult, () => 'user');
            vi.spyOn(
                api as unknown as { isLikelyLocalSystem: () => boolean },
                'isLikelyLocalSystem',
            ).mockReturnValue(true);
            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            const cfg = Config.getInstance();
            expect(fs.existsSync(cfg.uninstallPendingMarkerPath)).toBe(true);
        });

        it('returns 200 with status=shutting-down and no redirectTo', async () => {
            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(() => factoryResult, () => 'user');
            vi.spyOn(
                api as unknown as { isLikelyLocalSystem: () => boolean },
                'isLikelyLocalSystem',
            ).mockReturnValue(true);
            Config.getInstance().updateAppConfig({ installMode: 'system-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
            expect(body.installMode).toBe('system-service');
            expect(body.redirectTo).toBeUndefined();
        });

        it('schedules process.exit(0) after 5s', async () => {
            vi.useFakeTimers();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
            try {
                const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
                const factoryResult: ServiceClientFactoryResult = {
                    client,
                    supported: true,
                    platform: 'win32',
                };
                const api = new ServiceApi(() => factoryResult, () => 'user');
                vi.spyOn(
                    api as unknown as { isLikelyLocalSystem: () => boolean },
                    'isLikelyLocalSystem',
                ).mockReturnValue(true);
                Config.getInstance().updateAppConfig({ installMode: 'user-service' });

                const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
                await api.handle(req, res);

                expect(exitSpy).not.toHaveBeenCalled();
                vi.advanceTimersByTime(5000);
                expect(exitSpy).toHaveBeenCalledWith(0);
            } finally {
                exitSpy.mockRestore();
                vi.useRealTimers();
            }
        });

        it('does NOT write marker in local mode', async () => {
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'not-installed' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(() => factoryResult, () => 'user');
            vi.spyOn(
                api as unknown as { isLikelyLocalSystem: () => boolean },
                'isLikelyLocalSystem',
            ).mockReturnValue(false);
            Config.getInstance().updateAppConfig({ installMode: 'user' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            const cfg = Config.getInstance();
            expect(fs.existsSync(cfg.uninstallPendingMarkerPath)).toBe(false);
        });

        it('does NOT write marker when isLikelyLocalSystem is false in service mode', async () => {
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'not-installed' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(() => factoryResult, () => 'user');
            vi.spyOn(
                api as unknown as { isLikelyLocalSystem: () => boolean },
                'isLikelyLocalSystem',
            ).mockReturnValue(false);
            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            const cfg = Config.getInstance();
            expect(fs.existsSync(cfg.uninstallPendingMarkerPath)).toBe(false);
        });
    });
```

- [ ] **Step 2: Run tests, verify all 5 fail.**

```powershell
npx vitest run "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/__tests__/ServiceApi.test.ts" -t "operation-server flow"
```

Expected: 5 failures. The first two hit the old `handoffUninstallToUserSession` code path; the last two hit the direct uninstall path (no marker written in either case).

- [ ] **Step 3: Add `spawn` import to `ServiceApi.ts`.**

Current text at lines 1-4 of `src/server/api/ServiceApi.ts`:

```typescript
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'node:fs';
import * as path from 'node:path';
```

Replace with:

```typescript
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { spawn } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
```

- [ ] **Step 4: Rewrite the service+LocalSystem branch.**

Current verbatim text at lines 419-446 of `src/server/api/ServiceApi.ts`:

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

Replace with:

```typescript
        } else {
            const installMode = cfg.getAppConfig().installMode;
            const runningAsService = installMode === 'user-service' || installMode === 'system-service';
            const isWindows = result.platform === 'win32';

            if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
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
                    installMode,
                };
                res.writeHead(200);
                res.end(JSON.stringify(body));
                return true;
            }
        }
```

- [ ] **Step 5: Run the 5 new tests, verify pass.**

```powershell
npx vitest run "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/__tests__/ServiceApi.test.ts" -t "operation-server flow"
```

Expected: 5 PASS.

- [ ] **Step 6: Run the existing handoff-timeout test, verify it changed behavior.**

The existing test at line 645 (`returns 503 with reason=handoff-timeout when LocalSystem handoff fails`) mocks `handoffUninstallToUserSession` to return false, then asserts 503. With Phase 4, `handoffUninstallToUserSession` is never called. The test needs updating: change its assertions to expect `200` with `status: 'shutting-down'` (since the code now writes the marker instead of calling handoff).

Current test text at lines 645-679 of `src/server/__tests__/ServiceApi.test.ts`:

```typescript
    it('returns 503 with reason=handoff-timeout when LocalSystem handoff fails (does NOT direct-uninstall)', async () => {
        const uninstallSpy = vi.fn(async () => undefined);
        const client = fakeClient({
            uninstall: uninstallSpy,
            status: vi.fn(async () => 'running' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        // Force isLikelyLocalSystem() to return true.
        vi.spyOn(
            api as unknown as { isLikelyLocalSystem: () => boolean },
            'isLikelyLocalSystem',
        ).mockReturnValue(true);
        // Force the handoff to fail (resolve false synchronously).
        vi.spyOn(
            api as unknown as { handoffUninstallToUserSession: (...args: unknown[]) => Promise<boolean> },
            'handoffUninstallToUserSession',
        ).mockResolvedValue(false);
        // Set installMode to 'system-service' so the running-as-service branch fires.
        Config.getInstance().updateAppConfig({ installMode: 'system-service' });

        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);

        expect((res as any).getStatus()).toBe(503);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('handoff-timeout');
        // Critical: the direct uninstall path must NOT have been attempted.
        expect(uninstallSpy).not.toHaveBeenCalled();
    });
```

Replace with:

```typescript
    it('service+LocalSystem uninstall writes marker and returns shutting-down (Phase 4 replaces handoff)', async () => {
        const uninstallSpy = vi.fn(async () => undefined);
        const client = fakeClient({
            uninstall: uninstallSpy,
            status: vi.fn(async () => 'running' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        vi.spyOn(
            api as unknown as { isLikelyLocalSystem: () => boolean },
            'isLikelyLocalSystem',
        ).mockReturnValue(true);
        Config.getInstance().updateAppConfig({ installMode: 'system-service' });

        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);

        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(true);
        expect(body.status).toBe('shutting-down');
        expect(uninstallSpy).not.toHaveBeenCalled();
    });
```

- [ ] **Step 7: Run full ServiceApi test suite.**

```powershell
npx vitest run "C:/Users/jscha/source/repos/ws-scrcpy-web/src/server/__tests__/ServiceApi.test.ts"
```

Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(server): handleUninstall uses operation-server flow for service+LocalSystem"
```

---

### Task 5: Frontend modal keep-alive for `'shutting-down'` status

**Files:**
- Modify: `src/app/client/SettingsModal.ts` (lines 909-931)

- [ ] **Step 1: Add the `keepModalOpen` flag and `'shutting-down'` check.**

Current verbatim text at lines 909-931 of `src/app/client/SettingsModal.ts`:

```typescript
        const modal = new ServiceOperationModal({ operation: 'uninstall' });
        using _closeModal = { [Symbol.dispose](): void { modal.close(); } };
        try {
            const r = await fetch('/api/service/uninstall', { method: 'POST' });
            const data = (await r.json().catch(() => null)) as ServiceUninstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg = data && data.ok === false
                    ? SettingsModal.reasonToUserMessage(data.reason, data.error)
                    : `uninstall failed (${r.status})`;
                this.renderServiceError(errMsg, () => void this.refreshService());
                return;
            }
            if (data.redirectTo) {
                btn.textContent = '→ user mode (uninstall)…';
                setTimeout(() => {
                    window.location.href = data.redirectTo!;
                }, 500);
                return;
            }
            await this.refreshService();
        } catch {
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
        }
```

Replace with:

```typescript
        let keepModalOpen = false;
        const modal = new ServiceOperationModal({ operation: 'uninstall' });
        using _closeModal = { [Symbol.dispose](): void { if (!keepModalOpen) modal.close(); } };
        try {
            const r = await fetch('/api/service/uninstall', { method: 'POST' });
            const data = (await r.json().catch(() => null)) as ServiceUninstallResponse | null;
            if (!r.ok || !data || data.ok !== true) {
                const errMsg = data && data.ok === false
                    ? SettingsModal.reasonToUserMessage(data.reason, data.error)
                    : `uninstall failed (${r.status})`;
                this.renderServiceError(errMsg, () => void this.refreshService());
                return;
            }
            if (data.status === 'shutting-down') {
                keepModalOpen = true;
                return;
            }
            if (data.redirectTo) {
                btn.textContent = '→ user mode (uninstall)…';
                setTimeout(() => {
                    window.location.href = data.redirectTo!;
                }, 500);
                return;
            }
            await this.refreshService();
        } catch {
            this.renderServiceError("couldn't reach server", () => void this.refreshService());
        }
```

- [ ] **Step 2: Type-check.**

```powershell
npx tsc --noEmit --project "C:/Users/jscha/source/repos/ws-scrcpy-web/tsconfig.json"
```

Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): keep ServiceOperationModal open on shutting-down status"
```

---

### Task 6: `silent_command` helper in `elevated_runner.rs`

**Files:**
- Modify: `launcher/src/elevated_runner.rs`

- [ ] **Step 1: Add the `silent_command` helper.**

Add the following just ABOVE the existing `run_capture` function (which starts at line 470):

```rust
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

- [ ] **Step 2: Update `run_capture` to use `silent_command`.**

Current verbatim text at lines 470-474 of `launcher/src/elevated_runner.rs`:

```rust
fn run_capture(exe: &str, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<CapturedOutput, String> {
    let output = Command::new(exe)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
```

Replace with:

```rust
fn run_capture(exe: &str, args: &[impl AsRef<std::ffi::OsStr>]) -> Result<CapturedOutput, String> {
    let output = silent_command(exe)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
```

- [ ] **Step 3: Update the `taskkill` call in `uninstall_service`.**

Current verbatim text at lines 429-431 of `launcher/src/elevated_runner.rs`:

```rust
    match Command::new("taskkill")
        .args(["/F", "/IM", "ws-scrcpy-web-tray.exe"])
        .output()
```

Replace with:

```rust
    match silent_command("taskkill")
        .args(["/F", "/IM", "ws-scrcpy-web-tray.exe"])
        .output()
```

- [ ] **Step 4: Update the `reg.exe` call in `reg_delete_value_best_effort`.**

Current verbatim text at lines 515-518 of `launcher/src/elevated_runner.rs`:

```rust
    let out = Command::new("reg.exe")
        .args(["delete", key, "/v", value, "/f"])
        .output()
        .map_err(|e| e.to_string())?;
```

Replace with:

```rust
    let out = silent_command("reg.exe")
        .args(["delete", key, "/v", value, "/f"])
        .output()
        .map_err(|e| e.to_string())?;
```

- [ ] **Step 5: Run cargo test.**

```powershell
cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml"
```

Expected: 130/130 pass (existing tests unchanged — `silent_command` is a transparent wrapper).

- [ ] **Step 6: Commit.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/elevated_runner.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(launcher): suppress console window flashes from servy-cli/taskkill/reg.exe spawns"
```

---

### Task 7: Full test suite + type-check gate

- [ ] **Step 1: Run full vitest.**

```powershell
cd "C:/Users/jscha/source/repos/ws-scrcpy-web" ; npm test
```

Expected: 714 + new tests, all pass.

- [ ] **Step 2: Run full cargo test.**

```powershell
cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/launcher/Cargo.toml"
```

Expected: 130/130 pass.

- [ ] **Step 3: Run tsc.**

```powershell
npx tsc --noEmit --project "C:/Users/jscha/source/repos/ws-scrcpy-web/tsconfig.json"
```

Expected: clean.

- [ ] **Step 4: Record test counts.**

Note the exact vitest count (should be 714 + 6 new = 720) and cargo count (130 unchanged) for the CHANGELOG.

---

### Task 8: CHANGELOG + push + open PR

- [ ] **Step 1: Add CHANGELOG entry.**

Add under `[Unreleased]` → `### Changed` in `CHANGELOG.md`:

```markdown
- **Service uninstall now uses operation-server pattern (Phase 4 user-visible flip).** Replaces the Theory D handoff dance. New flow: service-Node writes `uninstall-pending` marker, spawns operation-server (detached), returns `shutting-down` status, exits; post-stop.bat runs `servy-cli uninstall` + spawns fresh user-session launcher; operation-server serves "Uninstalling service, please wait..." page throughout. Frontend `ServiceOperationModal` stays open during transition. **No more UAC prompt during uninstall.** `handoffUninstallToUserSession` function body remains as dead code; deletion in Phase 5.
- **Console window flashes eliminated during service install/uninstall.** `silent_command` helper in `elevated_runner.rs` sets `CREATE_NO_WINDOW` on servy-cli, taskkill, and reg.exe spawns.
```

- [ ] **Step 2: Commit CHANGELOG.**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): Phase 4 node activation + console flash suppression"
```

- [ ] **Step 3: Push + open PR (DO NOT auto-merge — smoke required).**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin feat/phase-4-node-activation
```

```bash
gh -R bilbospocketses/ws-scrcpy-web pr create --title "feat: Phase 4 — service uninstall via operation-server + console flash suppression" --body "$(cat <<'EOF'
## Summary

**Phase 4 of operation-server rearchitecture — the user-visible flip.**

- `ServiceStatus` type gains `'shutting-down'` variant
- `Config.uninstallPendingMarkerPath` getter added
- `handleUninstall` service+LocalSystem path: writes uninstall-pending marker, spawns operation-server (detached, retry-loops on port), returns `{ status: 'shutting-down' }`, schedules `process.exit(0)`
- Frontend `ServiceOperationModal` stays open via `keepModalOpen` flag on `shutting-down` status
- `silent_command` helper in `elevated_runner.rs` suppresses console window flashes from servy-cli/taskkill/reg.exe
- `handoffUninstallToUserSession` body LEFT in place (Phase 5 deletes it)

## Test plan

- [x] vitest — all green (baseline + new tests)
- [x] cargo test — 130/130 unchanged
- [x] tsc --noEmit — clean
- [ ] **REQUIRED before merge: full clean-VM smoke** per spec smoke plan:
  - Install service (no console flash)
  - Uninstall x3 pre-reboot (modal stays, no UAC, op-server page, redirect to local)
  - Post-reboot uninstall
  - Post-idle (15+ min) uninstall

## Spec
`docs/superpowers/specs/2026-05-24-phase-4-node-activation-design.md`
EOF
)" --base main
```

---

### Task 9: Clean-VM smoke (THE CRITICAL VALIDATION)

Manual validation on a Hyper-V VM. See spec smoke plan for full matrix.

- [ ] **Step 1: Cut a smoke-target beta.**

Version bump to `0.1.25-beta.44`, commit, tag, push tag. Wait for release.yml to publish.

- [ ] **Step 2: Fresh VM — install beta.44 via MSI.**

- [ ] **Step 3: Install service — verify no console window flash.**

- [ ] **Step 4: Uninstall service x3 (pre-reboot) — verify modal stays, no UAC, op-server page, redirect to local.**

- [ ] **Step 5: Reboot → uninstall.**

- [ ] **Step 6: Reboot → idle 15+ min → uninstall.**

- [ ] **Step 7: If all pass — enable auto-merge.**

```bash
gh -R bilbospocketses/ws-scrcpy-web pr merge feat/phase-4-node-activation --squash --delete-branch --auto
```

- [ ] **Step 8: If any fail — diagnose, fix on branch, re-cut RC, re-smoke.**
