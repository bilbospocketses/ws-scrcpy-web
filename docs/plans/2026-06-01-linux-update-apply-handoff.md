# Linux update apply fix + "upgrading" handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linux in-app updates apply + relaunch, with a smooth "upgrading…" browser handoff — without changing the Windows update path.

**Architecture:** Server `applyUpdate` gets a Linux local-mode branch that calls Velopack's `waitExitThenApplyUpdate(restart=true)` instead of the Windows `.exe` operation-server helper. The apply response gains a Linux-only `mode:'reconnect'` flag. The client, on that flag, shows a full-viewport overlay and polls the same origin until the new version answers, then reloads (timeout → bookmark fallback). Windows keeps its operation-server redirect + 5s-reload path byte-for-byte.

**Tech Stack:** TypeScript, Node http server, Velopack node binding, vitest. Client is vanilla TS DOM (no framework).

**Spec:** `docs/specs/2026-06-01-linux-update-apply-handoff-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `src/common/UpdateEvents.ts` | shared API types | add `mode?: 'reconnect'` to `UpdatesApplyResponse` |
| `src/server/UpdateService.ts` | apply orchestration | Linux local-mode branch in `applyUpdate` |
| `src/server/api/UpdatesApi.ts` | HTTP transport | Linux apply returns `mode:'reconnect'` |
| `src/app/client/reconnectAfterApply.ts` (new) | poll the origin until the new version answers | new module (pure logic, testable) |
| `src/app/client/UpgradingOverlay.ts` (new) | full-viewport overlay UI | new component |
| `src/app/client/UpdateButton.ts` | home-page apply chip | on `mode:'reconnect'` → overlay + reconnect |
| `src/app/client/SettingsModal.ts` | settings apply button | on `mode:'reconnect'` → overlay + reconnect |

**Windows-freeze invariant:** the only `applyUpdate`/`handleApply` change behind `win32` is *additive branching*; the Windows code path is unchanged. The two client handlers keep their existing `r.ok` → restart+reload path and ONLY diverge when the JSON body has `mode === 'reconnect'` (Linux). Run the full suite after every server task to confirm Windows tests stay green.

---

## Task 1: Add the `mode` field to the apply response type

**Files:**
- Modify: `src/common/UpdateEvents.ts:73-76`

- [ ] **Step 1: Edit the type**

Replace:
```ts
/** Apply success envelope (returned right before the deferred process.exit). */
export interface UpdatesApplyResponse {
    ok: true;
}
```
with:
```ts
/** Apply success envelope (returned right before the deferred process.exit). */
export interface UpdatesApplyResponse {
    ok: true;
    /**
     * Linux only. When 'reconnect', the client shows the upgrading overlay and
     * polls the same origin until the relaunched app answers on the new
     * version. Absent on Windows (which uses the operation-server HTML redirect).
     */
    mode?: 'reconnect';
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/common/UpdateEvents.ts
git commit -m "feat(updates): add mode:'reconnect' to UpdatesApplyResponse (Linux)"
```

---

## Task 2: Linux local-mode branch in `UpdateService.applyUpdate`

The current `applyUpdate` (around lines 420-465) has: service-mode branch (`waitExitThenApplyUpdate(update, true, false)`) then a Windows-shaped local-mode path that spawns `…/operation-server/ws-scrcpy-web-launcher.exe`. Add a Linux local-mode branch BEFORE the helper-spawn so Linux never reaches the `.exe`.

**Files:**
- Modify: `src/server/UpdateService.ts` (the `applyUpdate` local-mode section)
- Test: `src/server/__tests__/UpdateService.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `UpdateService.test.ts` (in the applyUpdate describe area). It asserts that on Linux local mode, `waitExitThenApplyUpdate` is called with `restart=true` and the operation-server helper is NOT spawned:

```ts
it('applyUpdate (linux local mode): waitExitThenApplyUpdate(restart=true), no helper spawn', async () => {
    Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
    const info = fakeUpdateInfo('0.2.0');
    const applyFn = vi.fn();
    const mgr = fakeMgr({ checkForUpdatesAsync: async () => info, waitExitThenApplyUpdate: applyFn });
    const spawnMock = vi.mocked(child_process.spawn);
    spawnMock.mockClear();
    const svc = new UpdateService({
        platform: 'linux',
        installRoot: path.join('/fake', 'mount', 'usr'),
        existsSync: () => true,
        updateManagerFactory: () => mgr,
        setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
        clearIntervalFn: () => undefined,
    });
    svc.init();
    await svc.checkForUpdates();
    expect(svc.getStatus().status).toBe('ready');
    const result = await svc.applyUpdate();
    expect(applyFn).toHaveBeenCalledTimes(1);
    expect(applyFn.mock.calls[0]![1]).toBe(true);   // silent
    expect(applyFn.mock.calls[0]![2]).toBe(true);   // restart
    expect(result.redirectPort).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();        // no operation-server helper
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts -t "linux local mode"`
Expected: FAIL — current Linux code path falls through to the `.exe` spawn (so `applyFn` not called / spawn called).

- [ ] **Step 3: Add the Linux branch in `applyUpdate`**

In `applyUpdate`, immediately AFTER the existing service-mode block:
```ts
        if (isServiceMode) {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
            return { redirectPort: null };
        }
```
insert:
```ts
        // Linux local mode: Velopack applies on exit and relaunches the AppImage
        // (which rebinds the freed web port). No Windows operation-server helper
        // exists on Linux — calling it would ENOENT and the apply would never run.
        if (this.platform !== 'win32') {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, true);
            return { redirectPort: null };
        }
```
Leave the Windows operation-server helper code below it unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts -t "linux local mode"`
Expected: PASS.

- [ ] **Step 5: Run the whole UpdateService suite (Windows path unchanged)**

Run: `npx vitest run src/server/__tests__/UpdateService.test.ts`
Expected: all pass (the existing Windows/service apply tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/server/UpdateService.ts src/server/__tests__/UpdateService.test.ts
git commit -m "fix(linux): apply updates via waitExitThenApplyUpdate(restart=true), not the win32 helper"
```

---

## Task 3: `handleApply` returns `mode:'reconnect'` on Linux

**Files:**
- Modify: `src/server/api/UpdatesApi.ts:156-169` (the `redirectPort === null` branch)
- Test: `src/server/api/__tests__/UpdatesApi.test.ts` (existing apply tests live here; match their pattern)

- [ ] **Step 1: Write the failing test**

Add a test asserting that when `applyUpdate` returns `{redirectPort:null}` and platform is non-win32, the JSON body contains `mode:'reconnect'`. Match the existing UpdatesApi test harness (it stubs the `UpdateService` + captures the `ServerResponse`). Minimal shape:

```ts
it('handleApply (linux): returns { ok:true, mode:"reconnect" } when redirectPort is null', async () => {
    const svc = makeSvcStub({ isInstalled: true, status: 'ready' }, { redirectPort: null });
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const api = new UpdatesApi(svc, (cb) => { cb(); return 0; }, () => {});
    const res = makeResCapture();
    await api.handle(makeReq('POST', '/api/updates/apply'), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, mode: 'reconnect' });
    platformSpy.mockRestore();
});
```
(If the existing test file uses different helpers, mirror them — the assertion is the contract: body `{ok:true, mode:'reconnect'}` on non-win32 when redirectPort is null.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/server/api/__tests__/UpdatesApi.test.ts -t "reconnect"`
Expected: FAIL — body is `{ ok: true }` (no `mode`).

- [ ] **Step 3: Implement**

In `handleApply`, change the `else` branch (currently `const body: UpdatesApplyResponse = { ok: true };`) to:
```ts
        } else {
            const body: UpdatesApplyResponse = { ok: true };
            if (process.platform !== 'win32') {
                body.mode = 'reconnect';
            }
            res.writeHead(200);
            res.end(JSON.stringify(body));
        }
```
The Windows `redirectPort !== null` branch (HTML redirect) is unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/server/api/__tests__/UpdatesApi.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/UpdatesApi.ts src/server/api/__tests__/UpdatesApi.test.ts
git commit -m "feat(updates): handleApply signals mode:'reconnect' on Linux"
```

---

## Task 4: `reconnectAfterApply` — poll the origin until the new version answers

A pure-logic module (no DOM) so it's unit-testable with a stubbed `fetch`.

**Files:**
- Create: `src/app/client/reconnectAfterApply.ts`
- Test: `src/app/client/__tests__/reconnectAfterApply.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { reconnectAfterApply } from '../reconnectAfterApply';

function statusResponse(version: string) {
    return { ok: true, json: async () => ({ currentVersion: version }) } as unknown as Response;
}

describe('reconnectAfterApply', () => {
    it('resolves "updated" when status reports a new version', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new Error('down'))      // swap window
            .mockResolvedValueOnce(statusResponse('0.1.0')) // old still
            .mockResolvedValueOnce(statusResponse('0.2.0')); // new!
        const result = await reconnectAfterApply({
            previousVersion: '0.1.0',
            fetchFn: fetchMock,
            intervalMs: 0,
            deadlineMs: 10_000,
            now: (() => { let t = 0; return () => (t += 1); })(),
        });
        expect(result).toBe('updated');
        expect(fetchMock).toHaveBeenCalledWith('/api/updates/status', { cache: 'no-store' });
    });

    it('resolves "timeout" when the deadline passes without a new version', async () => {
        const fetchMock = vi.fn().mockResolvedValue(statusResponse('0.1.0'));
        const result = await reconnectAfterApply({
            previousVersion: '0.1.0',
            fetchFn: fetchMock,
            intervalMs: 0,
            deadlineMs: 5,
            now: (() => { let t = 0; return () => (t += 2); })(),
        });
        expect(result).toBe('timeout');
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/client/__tests__/reconnectAfterApply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
export interface ReconnectOptions {
    previousVersion: string;
    fetchFn?: typeof fetch;
    intervalMs?: number;
    deadlineMs?: number;
    now?: () => number;
}

/**
 * Poll GET /api/updates/status on the same origin until it answers with a
 * currentVersion different from previousVersion (→ 'updated'), or the deadline
 * elapses (→ 'timeout'). Fetch errors are expected during the swap and are
 * swallowed (keep polling). No DOM here — caller handles the UI.
 */
export async function reconnectAfterApply(opts: ReconnectOptions): Promise<'updated' | 'timeout'> {
    const fetchFn = opts.fetchFn ?? fetch;
    const intervalMs = opts.intervalMs ?? 1000;
    const deadlineMs = opts.deadlineMs ?? 60_000;
    const now = opts.now ?? (() => Date.now());
    const start = now();
    for (;;) {
        try {
            const r = await fetchFn('/api/updates/status', { cache: 'no-store' });
            if (r.ok) {
                const s = (await r.json()) as { currentVersion?: string };
                if (s.currentVersion && s.currentVersion !== opts.previousVersion) {
                    return 'updated';
                }
            }
        } catch {
            // server down during the swap — expected; keep polling
        }
        if (now() - start >= deadlineMs) return 'timeout';
        if (intervalMs > 0) await new Promise((res) => setTimeout(res, intervalMs));
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/client/__tests__/reconnectAfterApply.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/app/client/reconnectAfterApply.ts src/app/client/__tests__/reconnectAfterApply.test.ts
git commit -m "feat(client): reconnectAfterApply poll helper"
```

---

## Task 5: `UpgradingOverlay` component

A full-viewport overlay with three states. Follow the existing client DOM idiom (plain `document.createElement` + a class with `mount()`/`setState()`/`remove()`; see `PortChangeModal.ts` / `ServiceFirstRunModal.ts` for the style — but this is a non-dismissible takeover, not a dialog). Lowercase copy per the app motif (`feedback` melt: "all UI text lowercase").

**Files:**
- Create: `src/app/client/UpgradingOverlay.ts`
- Test: `src/app/client/__tests__/UpgradingOverlay.test.ts` (jsdom — vitest is configured with the happy-dom/jsdom environment used by other client tests; match an existing client test's environment header)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { UpgradingOverlay } from '../UpgradingOverlay';

describe('UpgradingOverlay', () => {
    it('mounts, shows the applying message, and removes', () => {
        const o = new UpgradingOverlay();
        o.mount();
        const el = document.querySelector('.upgrading-overlay');
        expect(el).not.toBeNull();
        expect(el!.textContent).toContain('updating');
        o.setState('timeout', 'http://localhost:8000/');
        expect(document.querySelector('.upgrading-overlay')!.textContent).toContain('http://localhost:8000/');
        o.remove();
        expect(document.querySelector('.upgrading-overlay')).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/client/__tests__/UpgradingOverlay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
type OverlayState = 'applying' | 'reconnecting' | 'timeout';

/**
 * Full-viewport, non-dismissible overlay shown during a Linux in-app update.
 * Pure DOM; survives the server exiting (no network needed to render).
 */
export class UpgradingOverlay {
    private root: HTMLDivElement | null = null;
    private msg: HTMLParagraphElement | null = null;

    mount(): void {
        if (this.root) return;
        const root = document.createElement('div');
        root.className = 'upgrading-overlay';
        // Inline the few critical styles so the overlay renders even if the
        // stylesheet is mid-reload. Keep visual polish in the stylesheet.
        root.style.cssText =
            'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:1rem;background:rgba(0,0,0,0.85);' +
            'color:#fff;font:14px/1.5 system-ui,sans-serif;text-align:center;padding:2rem;';
        const spinner = document.createElement('div');
        spinner.className = 'upgrading-overlay-spinner';
        const msg = document.createElement('p');
        msg.className = 'upgrading-overlay-msg';
        root.append(spinner, msg);
        document.body.appendChild(root);
        this.root = root;
        this.msg = msg;
        this.setState('applying');
    }

    setState(state: OverlayState, url?: string): void {
        if (!this.msg) return;
        if (state === 'applying') {
            this.msg.textContent = 'updating — applying the new version…';
        } else if (state === 'reconnecting') {
            this.msg.textContent = 'updating — restarting and reconnecting…';
        } else {
            this.msg.textContent =
                `update applied. if this page doesn't return on its own, reopen ${url ?? 'the app url'}.`;
        }
    }

    remove(): void {
        this.root?.remove();
        this.root = null;
        this.msg = null;
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/app/client/__tests__/UpgradingOverlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/client/UpgradingOverlay.ts src/app/client/__tests__/UpgradingOverlay.test.ts
git commit -m "feat(client): UpgradingOverlay component"
```

---

## Task 6: Wire both apply handlers to the overlay on `mode:'reconnect'`

Both `UpdateButton.ts` (`onApplyClick`, ~line 203) and `SettingsModal.ts` (`onApplyClick`, ~line 656) currently do: `fetch('/api/updates/apply')` → if `r.ok` → show "restarting…" → `setTimeout(reload, 5000)`. Extend ONLY the `r.ok` success path: parse the JSON body; if `mode === 'reconnect'` (Linux), run the overlay + reconnect instead of the blind 5s reload. Windows responses (HTML, no JSON `mode`) keep the existing reload path.

**Files:**
- Modify: `src/app/client/UpdateButton.ts` (success branch of `onApplyClick`)
- Modify: `src/app/client/SettingsModal.ts` (success branch of `onApplyClick`)

- [ ] **Step 1: Add a shared helper call in `UpdateButton.onApplyClick`**

Replace the success branch (`renderRestarting(); window.setTimeout(reload, …)`) with:
```ts
            const body = await r.json().catch(() => ({}) as { mode?: string; currentVersion?: string });
            if (body && (body as { mode?: string }).mode === 'reconnect') {
                await runUpgradingHandoff(state.currentVersion ?? '');
                return;
            }
            // Windows / fallback: existing blind reload after grace.
            renderRestarting();
            window.setTimeout(() => { try { window.location.reload(); } catch { /* down */ } }, APPLY_RELOAD_DELAY_MS);
```
where `state.currentVersion` is the version known before apply (the module already tracks status; use the last status's `currentVersion`). Add the helper at module scope:
```ts
import { reconnectAfterApply } from './reconnectAfterApply';
import { UpgradingOverlay } from './UpgradingOverlay';

async function runUpgradingHandoff(previousVersion: string): Promise<void> {
    const overlay = new UpgradingOverlay();
    overlay.mount();
    overlay.setState('reconnecting');
    const result = await reconnectAfterApply({ previousVersion });
    if (result === 'updated') {
        window.location.reload();
    } else {
        overlay.setState('timeout', window.location.origin + '/');
    }
}
```

- [ ] **Step 2: Mirror it in `SettingsModal.onApplyClick`**

Same change in the `SettingsModal` success branch (the one that sets `btn.textContent = 'restarting…'` + `setTimeout(reload, 5000)`). Reuse the same `reconnectAfterApply` + `UpgradingOverlay` imports; the previous version is `this.updatesLastStatus?.currentVersion ?? ''`. Define a private `runUpgradingHandoff` method with the identical body (or extract a shared module-level function imported by both — preferred to keep DRY: put `runUpgradingHandoff` in `reconnectAfterApply.ts` and import it in both files).

> DRY note: implement `runUpgradingHandoff(previousVersion)` ONCE in `src/app/client/reconnectAfterApply.ts` (exported) and import it in both `UpdateButton.ts` and `SettingsModal.ts`. Update Task 4's module to export it too.

- [ ] **Step 3: Typecheck + full client/server suite**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: tsc clean; all tests pass (Windows apply tests unchanged + new tests green).

- [ ] **Step 4: Commit**

```bash
git add src/app/client/UpdateButton.ts src/app/client/SettingsModal.ts src/app/client/reconnectAfterApply.ts
git commit -m "feat(client): Linux upgrading overlay + reconnect on apply (win path unchanged)"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; **all** tests pass, including the pre-existing Windows operation-server + service-mode apply tests (the Windows-freeze invariant).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: webpack build succeeds (client bundle includes the new modules).

- [ ] **Step 3: Confirm no Windows behavior change (manual code review)**

Re-read the diffs of `UpdateService.applyUpdate`, `UpdatesApi.handleApply`, and the two client handlers; confirm every Windows branch is byte-identical and the new behavior is reached only on non-win32 / `mode:'reconnect'`.

---

## Out of plan (follow-on, tracked separately)

- Cut **beta.25** (this fix) + **beta.26** (no-op target) via the bump-PR → Auto Release pipeline; user installs beta.25, clicks update, confirms the overlay shows and the app reloads on beta.26 (timeout fallback if Velopack auto-relaunch doesn't fire). This is the real-Linux verification of `waitExitThenApplyUpdate(restart=true)`.
