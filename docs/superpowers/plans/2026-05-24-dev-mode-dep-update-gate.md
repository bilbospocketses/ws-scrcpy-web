# Dev-mode dep update gate + installNodejs rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the design from `docs/superpowers/specs/2026-05-24-dev-mode-dep-update-gate-design.md` — gate the in-app dep update flow per-dep so dev mode no longer hits the launcher-only `extractZip` path, and reorder `installNodejs` to extract-first-then-rename so production extract/copy failures cannot leave Node missing.

**Architecture:** Per-dep `requiresLauncher` on `DependencyDefinition`. `DependencyInfo.canUpdate = !requiresLauncher || launcherIsAvailable()` recomputed each `getAll()`. `update()` early-bails with typed `reason: 'launcher-required'` when the gate trips, surfaced as HTTP 503 by `DependencyApi`. `installNodejs` extracts to `tmpDir` first, then performs the destructive rename + copy with a tight rollback if copy fails.

**Tech Stack:** TypeScript, vitest (server-side unit tests), webpack-bundled Node.js server + custom-element frontend. Local-Dependencies-Only architecture (CLAUDE.md).

---

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/common/DependencyTypes.ts` | modify | Add `canUpdate` to `DependencyInfo`, `reason` to `UpdateResult` |
| `src/server/DependencyDefinitions.ts` | modify | Add `requiresLauncher` to interface + per-dep values |
| `src/server/DependencyManager.ts` | modify | `getAll()` recomputes canUpdate; `update()` guard; `autoInstallMissing()` skip; `installNodejs` reorder + rollback |
| `src/server/api/DependencyApi.ts` | modify | Map `result.reason === 'launcher-required'` to HTTP 503 |
| `src/app/client/DependencyPanel.ts` | modify | `actionButton` renders disabled `update (dev)` when `!canUpdate`; lowercase labels |
| `src/server/__tests__/dependencyDefinitions.test.ts` | modify | Add requiresLauncher value test |
| `src/server/__tests__/dependencyManager.test.ts` | modify | Add canUpdate tests (mock elevatedRunner) |
| `src/server/__tests__/dependencyManager.update.test.ts` | modify | Add guard tests + installNodejs rollback tests |
| `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts` | modify | Add launcher-required-skip test |
| `src/server/__tests__/dependencyApi.update.test.ts` | create | NEW — 503 routing tests |
| `CHANGELOG.md` | modify | Unreleased entry (final task) |

**Working branch:** `fix/dev-mode-dep-update-gate` (already created, spec committed at `390a4de`).

**Commands you will use frequently:**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" status
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add <files>
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "..."

# Run tests (all)
cd C:/Users/jscha/source/repos/ws-scrcpy-web
npm test

# Run one test file
npx vitest run src/server/__tests__/<file>.test.ts

# Type check only
npx tsc --noEmit
```

> **cwd discipline (CLAUDE.md):** prefer `git -C "<absolute-path>"` for git operations to keep cross-session-safe. For `npm test` / `npx tsc`, the test runner needs to be in the repo root — `cd` once at the start of an implementation session and stay there for the duration. Do NOT `cd` if a parallel session might be in this repo.

---

## Task 1: Extend shared types

**Files:**
- Modify: `src/common/DependencyTypes.ts`
- Modify: `src/server/DependencyManager.ts:42-54` (constructor state initialization)

This task is type-only — it adds the fields and initializes them in the one place that constructs `DependencyInfo`. No new test cases yet; existing 695 tests must still pass.

- [ ] **Step 1: Add fields to `DependencyTypes.ts`**

Replace lines 10-27 of `src/common/DependencyTypes.ts` with:

```ts
export interface DependencyInfo {
    name: string;
    displayName: string;
    installedVersion: string | null;
    latestVersion: string | null;
    status: DependencyStatus;
    description: string;
    errorMessage?: string | undefined;
    requiresRestart: boolean;
    pairedWith?: string | undefined;
    canUpdate: boolean;
}

export interface UpdateResult {
    success: boolean;
    newVersion?: string | undefined;
    errorMessage?: string | undefined;
    requiresRestart: boolean;
    reason?: 'launcher-required' | undefined;
}
```

(Two new fields: `canUpdate: boolean` required on `DependencyInfo`; `reason?: 'launcher-required'` optional on `UpdateResult`. Existing fields unchanged. The `?: T | undefined` pattern matches existing fields, satisfying `exactOptionalPropertyTypes`.)

- [ ] **Step 2: Initialize `canUpdate` in `DependencyManager` constructor**

In `src/server/DependencyManager.ts`, find the constructor's state initialization loop (around lines 43-54):

```ts
for (const def of this.definitions) {
    this.state.set(def.name, {
        name: def.name,
        displayName: def.displayName,
        installedVersion: null,
        latestVersion: null,
        status: DependencyStatus.Unknown,
        description: def.description,
        requiresRestart: def.requiresRestart,
        pairedWith: def.pairedWith,
    });
}
```

Add `canUpdate: false` to the object literal (it will be recomputed by `getAll()` in Task 3):

```ts
for (const def of this.definitions) {
    this.state.set(def.name, {
        name: def.name,
        displayName: def.displayName,
        installedVersion: null,
        latestVersion: null,
        status: DependencyStatus.Unknown,
        description: def.description,
        requiresRestart: def.requiresRestart,
        pairedWith: def.pairedWith,
        canUpdate: false,
    });
}
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: clean (no errors). If any errors surface from other DependencyInfo construction sites, surface them — those would be unexpected.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: 695/695 pass (unchanged from baseline).

- [ ] **Step 5: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/common/DependencyTypes.ts src/server/DependencyManager.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(deps): add canUpdate + launcher-required reason to DependencyInfo/UpdateResult"
```

---

## Task 2: Add `requiresLauncher` to dependency definitions

**Files:**
- Modify: `src/server/DependencyDefinitions.ts` (interface at line 48-57; definitions at lines 74-173)
- Modify: `src/server/__tests__/dependencyDefinitions.test.ts`

- [ ] **Step 1: Write failing test**

Add this test block to `src/server/__tests__/dependencyDefinitions.test.ts` (after the existing `scrcpy-server does not require restart` test, around line 51):

```ts
    it('nodejs and adb require the launcher (extractZip path); scrcpy-server does not', () => {
        const defs = getDependencyDefinitions('/tmp/test-deps');
        const node = defs.find((d) => d.name === 'nodejs');
        const adb = defs.find((d) => d.name === 'adb');
        const scrcpy = defs.find((d) => d.name === 'scrcpy-server');
        expect(node?.requiresLauncher).toBe(true);
        expect(adb?.requiresLauncher).toBe(true);
        expect(scrcpy?.requiresLauncher).toBe(false);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: FAIL on the new test (`requiresLauncher` undefined on all defs). Other tests in file: pass.

- [ ] **Step 3: Add `requiresLauncher` field to the interface**

In `src/server/DependencyDefinitions.ts`, find the `DependencyDefinition` interface (around line 48-57) and add `requiresLauncher`:

```ts
export interface DependencyDefinition {
    name: string;
    displayName: string;
    description: string;
    requiresRestart: boolean;
    pairedWith?: string;
    requiresLauncher: boolean;
    checkInstalled: (depsPath: string) => Promise<string | null>;
    checkLatest: () => Promise<string | null>;
    getDownloadUrl: (version: string) => string;
}
```

- [ ] **Step 4: Set `requiresLauncher` on each definition**

In `src/server/DependencyDefinitions.ts`, find `getDependencyDefinitions` (around line 69 onward). For each of the three definitions, add `requiresLauncher`:

- **nodejs** (around line 74-121): add `requiresLauncher: true` after `pairedWith: 'node-pty'`.
- **adb** (around line 122-146): add `requiresLauncher: true` after `requiresRestart: false`.
- **scrcpy-server** (around line 147-173): add `requiresLauncher: false` after `requiresRestart: false`.

Example for the nodejs section (the new field is the last line shown):

```ts
{
    name: 'nodejs',
    displayName: 'Node.js',
    description: 'JavaScript runtime that runs the ws-scrcpy-web server',
    requiresRestart: true,
    pairedWith: 'node-pty',
    requiresLauncher: true,
    checkInstalled: async (depsPath) => {
        // ... existing body unchanged
    },
    // ...
},
```

Apply the analogous one-line addition to the other two definitions.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/dependencyDefinitions.test.ts`
Expected: all tests pass, including the new `requiresLauncher` assertion.

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: 696/696 (1 new test, all existing still pass).

- [ ] **Step 7: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/DependencyDefinitions.ts src/server/__tests__/dependencyDefinitions.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(deps): add requiresLauncher to DependencyDefinition (true for nodejs/adb, false for scrcpy-server)"
```

---

## Task 3: Compute `canUpdate` in `getAll()`

**Files:**
- Modify: `src/server/DependencyManager.ts:57-59` (getAll method)
- Modify: `src/server/__tests__/dependencyManager.test.ts`

- [ ] **Step 1: Write failing tests**

Add this describe block to `src/server/__tests__/dependencyManager.test.ts` (after the existing `describe('DependencyManager', ...)` block, before `describe('DependencyManager.requestRestart', ...)`):

```ts
describe('DependencyManager.getAll() canUpdate', () => {
    it('reports canUpdate=true for all deps when launcher is available', async () => {
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: () => true,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        // Re-import after mock to pick up the stubbed module
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const mgr = new Mgr('/tmp/test-deps-canupdate-yes');
        const deps = mgr.getAll();
        for (const dep of deps) {
            expect(dep.canUpdate).toBe(true);
        }
        vi.doUnmock('../service/elevatedRunner');
    });

    it('reports canUpdate=false for launcher-required deps when launcher is unavailable', async () => {
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const mgr = new Mgr('/tmp/test-deps-canupdate-no');
        const byName = Object.fromEntries(mgr.getAll().map((d) => [d.name, d]));
        expect(byName.nodejs?.canUpdate).toBe(false);
        expect(byName.adb?.canUpdate).toBe(false);
        expect(byName['scrcpy-server']?.canUpdate).toBe(true);
        vi.doUnmock('../service/elevatedRunner');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: both new tests FAIL (canUpdate is always false from Task 1's constructor init; getAll doesn't recompute yet).

- [ ] **Step 3: Implement `getAll()` recomputation**

In `src/server/DependencyManager.ts`, replace the existing `getAll()` (around lines 57-59):

```ts
public getAll(): DependencyInfo[] {
    return Array.from(this.state.values());
}
```

with:

```ts
public getAll(): DependencyInfo[] {
    const launcherAvail = launcherIsAvailable();
    return Array.from(this.state.values()).map((info) => {
        const def = this.definitions.find((d) => d.name === info.name);
        return { ...info, canUpdate: !def?.requiresLauncher || launcherAvail };
    });
}
```

(`launcherIsAvailable` is already imported at the top of the file via `import { launcherIsAvailable, resolveLauncherPath } from './service/elevatedRunner';` — confirm the import line exists at line 21; if missing, add it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.test.ts`
Expected: both new tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 698/698 (2 new tests added; baseline grows from 696).

- [ ] **Step 6: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(deps): getAll() computes canUpdate per launcher availability"
```

---

## Task 4: `update()` early-bail with `reason: 'launcher-required'`

**Files:**
- Modify: `src/server/DependencyManager.ts:122-192` (update method)
- Modify: `src/server/__tests__/dependencyManager.update.test.ts`

- [ ] **Step 1: Write failing tests**

Add this describe block to `src/server/__tests__/dependencyManager.update.test.ts` (after the existing `describe('DependencyManager.update("scrcpy-server") — loop fix', ...)` block):

```ts
describe('DependencyManager.update() launcher-required gate', () => {
    afterEach(() => {
        vi.doUnmock('../service/elevatedRunner');
    });

    it('returns reason=launcher-required for nodejs when launcher is unavailable', async () => {
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-gate-'));
        try {
            const mgr = new Mgr(tmp);
            const result = await mgr.update('nodejs');
            expect(result.success).toBe(false);
            expect(result.reason).toBe('launcher-required');
            expect(result.errorMessage).toMatch(/installed build/);
            expect(result.requiresRestart).toBe(false);
            // Status MUST remain UpdateAvailable / Unknown — NOT transition to Updating or Error.
            const info = mgr.getByName('nodejs')!;
            expect(info.status).not.toBe(DependencyStatus.Updating);
            expect(info.status).not.toBe(DependencyStatus.Error);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('does not gate scrcpy-server (no launcher needed)', async () => {
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-gate-scrcpy-'));
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('api.github.com')) {
                return new Response(JSON.stringify({ tag_name: 'v4.0' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response('fake-jar-bytes', { status: 200 });
        });
        try {
            const mgr = new Mgr(tmp);
            const info = mgr.getByName('scrcpy-server')!;
            info.installedVersion = '3.3.4';
            info.latestVersion = '4.0';
            const result = await mgr.update('scrcpy-server');
            expect(result.success).toBe(true);
            expect(result.reason).toBeUndefined();
        } finally {
            fetchSpy.mockRestore();
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
```

(This block reuses the existing `fs`, `os`, `path`, `vi`, `describe`, `expect`, `it`, `DependencyStatus` imports at the top of the file — no new imports needed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.update.test.ts`
Expected: nodejs gate test FAILS (no guard exists, update proceeds and hits extractZip which then throws a different way, so the assertion on `result.reason` fails). scrcpy-server test may pass already (no launcher path).

- [ ] **Step 3: Implement the guard**

In `src/server/DependencyManager.ts`, find `update(name)` (around line 122). Insert the guard immediately after the "Unknown dependency" early return, BEFORE `info.status = DependencyStatus.Updating`:

```ts
public async update(name: string): Promise<UpdateResult> {
    const def = this.definitions.find((d) => d.name === name);
    const info = this.state.get(name);
    if (!def || !info) {
        return { success: false, errorMessage: `Unknown dependency: ${name}`, requiresRestart: false };
    }
    if (def.requiresLauncher && !launcherIsAvailable()) {
        return {
            success: false,
            reason: 'launcher-required',
            errorMessage:
                `${def.displayName} updates require an installed build. ` +
                `In dev mode, populate dependencies/ via scripts/fetch-node.mjs.`,
            requiresRestart: false,
        };
    }

    info.status = DependencyStatus.Updating;
    // ... existing body unchanged from here onward
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.update.test.ts`
Expected: both new tests pass; existing scrcpy-server loop-fix test still passes.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 700/700.

- [ ] **Step 6: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.update.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(deps): update() early-bails with reason=launcher-required when launcher unavailable"
```

---

## Task 5: `autoInstallMissing()` skips launcher-required deps in dev

**Files:**
- Modify: `src/server/DependencyManager.ts:194-215` (autoInstallMissing method)
- Modify: `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`

- [ ] **Step 1: Write failing test**

Add this test to the existing `describe('DependencyManager.autoInstallMissing', ...)` block in `src/server/__tests__/dependencyManager.autoInstallMissing.test.ts` (insert after the last `it(...)` at line 80):

```ts
    it('skips launcher-required deps in dev mode (no launcher available)', async () => {
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const localMgr = new Mgr('/tmp/test-deps-skip');
        const localUpdateSpy = vi.spyOn(localMgr, 'update').mockResolvedValue({
            success: true,
            newVersion: 'stub',
            requiresRestart: false,
        });

        const nodejs = localMgr.getByName('nodejs')!;
        nodejs.installedVersion = null;
        nodejs.latestVersion = '24.15.0';

        const scrcpy = localMgr.getByName('scrcpy-server')!;
        scrcpy.installedVersion = null;
        scrcpy.latestVersion = '4.0';

        await localMgr.autoInstallMissing();

        // nodejs is skipped (requiresLauncher && !launcherIsAvailable)
        expect(localUpdateSpy).not.toHaveBeenCalledWith('nodejs');
        // scrcpy-server still gets installed (no launcher needed)
        expect(localUpdateSpy).toHaveBeenCalledWith('scrcpy-server');

        localUpdateSpy.mockRestore();
        vi.doUnmock('../service/elevatedRunner');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`
Expected: new test FAILS (autoInstallMissing currently calls update for both nodejs and scrcpy-server when both are missing).

- [ ] **Step 3: Implement the skip**

In `src/server/DependencyManager.ts`, replace `autoInstallMissing` (around lines 194-215) with:

```ts
public async autoInstallMissing(): Promise<void> {
    // v0.1.9: try the seed-promotion path before any network
    // download. If we ship scrcpy-server as a seed (in
    // <install>/seed/scrcpy-server/scrcpy-server), copy it into
    // <deps>/scrcpy-server/scrcpy-server so the runtime path
    // (DeviceProbe / ScrcpyConnection) can read it. Idempotent —
    // if the dest already exists, the promotion is a no-op.
    // Network download still runs after, in case the seed is
    // missing or the user has an updater-managed newer version.
    try {
        this.promoteSeedScrcpyServer();
    } catch (err) {
        log.warn(`seed-promote scrcpy-server failed: ${(err as Error).message}`);
    }

    const launcherAvail = launcherIsAvailable();
    for (const info of this.state.values()) {
        if (info.installedVersion === null && info.latestVersion !== null) {
            const def = this.definitions.find((d) => d.name === info.name);
            if (def?.requiresLauncher && !launcherAvail) {
                log.info(`Skipping auto-install of ${info.name} in dev mode (no launcher)`);
                continue;
            }
            log.info(`First-run: auto-installing ${info.name}`);
            await this.update(info.name);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/__tests__/dependencyManager.autoInstallMissing.test.ts`
Expected: all tests pass including the new skip test.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 701/701.

- [ ] **Step 6: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.autoInstallMissing.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(deps): autoInstallMissing skips launcher-required deps when launcher unavailable"
```

---

## Task 6: DependencyApi returns 503 for `launcher-required`

**Files:**
- Modify: `src/server/api/DependencyApi.ts:34-42` (update endpoint handler)
- Create: `src/server/__tests__/dependencyApi.update.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/__tests__/dependencyApi.update.test.ts` with:

```ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DependencyApi } from '../api/DependencyApi';
import { DependencyManager } from '../DependencyManager';

interface MockRes {
    statusCode?: number;
    body?: string;
    writeHead: (...args: unknown[]) => unknown;
    end: (...args: unknown[]) => unknown;
    setHeader: (...args: unknown[]) => unknown;
}

function makeMockRes() {
    const res = Object.assign(new EventEmitter(), {
        statusCode: undefined as number | undefined,
        body: undefined as string | undefined,
        setHeader: vi.fn(),
        writeHead: vi.fn(),
        end: vi.fn(),
    }) as MockRes;
    (res.writeHead as ReturnType<typeof vi.fn>).mockImplementation((code: number) => {
        res.statusCode = code;
    });
    (res.end as ReturnType<typeof vi.fn>).mockImplementation((body: string) => {
        res.body = body;
    });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    return res as any;
}

function makeReq(method: string, url: string) {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    return { method, url } as any;
}

describe('DependencyApi.update endpoint', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns 503 when update result has reason=launcher-required', async () => {
        const mgr = new DependencyManager('/tmp/test-api-503');
        vi.spyOn(mgr, 'update').mockResolvedValue({
            success: false,
            reason: 'launcher-required',
            errorMessage: 'Node.js updates require an installed build.',
            requiresRestart: false,
        });
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/nodejs/update');
        const res = makeMockRes();

        const handled = await api.handle(req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(503);
        const body = JSON.parse(res.body!);
        expect(body.success).toBe(false);
        expect(body.reason).toBe('launcher-required');
    });

    it('returns 200 when update succeeds (no launcher gate)', async () => {
        const mgr = new DependencyManager('/tmp/test-api-200');
        vi.spyOn(mgr, 'update').mockResolvedValue({
            success: true,
            newVersion: '4.0',
            requiresRestart: false,
        });
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/scrcpy-server/update');
        const res = makeMockRes();

        const handled = await api.handle(req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body!);
        expect(body.success).toBe(true);
    });

    it('returns 500 for non-gate update failures', async () => {
        const mgr = new DependencyManager('/tmp/test-api-500');
        vi.spyOn(mgr, 'update').mockResolvedValue({
            success: false,
            errorMessage: 'Download failed: HTTP 500',
            requiresRestart: false,
        });
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/nodejs/update');
        const res = makeMockRes();

        await api.handle(req, res);

        expect(res.statusCode).toBe(500);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/dependencyApi.update.test.ts`
Expected: 503 test FAILS (currently returns 500 for any !success); 200 + 500 tests pass.

- [ ] **Step 3: Implement the 503 branch**

In `src/server/api/DependencyApi.ts`, find the update endpoint block (around lines 34-42):

```ts
// POST /api/dependencies/:name/update — update specific dependency
const updateMatch = url.match(/^\/api\/dependencies\/([a-z-]+)\/update$/);
if (req.method === 'POST' && updateMatch) {
    const name = updateMatch[1]!;
    const result = await this.manager.update(name);
    res.writeHead(result.success ? 200 : 500);
    res.end(JSON.stringify(result));
    return true;
}
```

Replace the `res.writeHead(...)` line so the 503 case is checked first:

```ts
// POST /api/dependencies/:name/update — update specific dependency
const updateMatch = url.match(/^\/api\/dependencies\/([a-z-]+)\/update$/);
if (req.method === 'POST' && updateMatch) {
    const name = updateMatch[1]!;
    const result = await this.manager.update(name);
    if (result.reason === 'launcher-required') {
        res.writeHead(503);
    } else {
        res.writeHead(result.success ? 200 : 500);
    }
    res.end(JSON.stringify(result));
    return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyApi.update.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 704/704.

- [ ] **Step 6: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/DependencyApi.ts src/server/__tests__/dependencyApi.update.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(deps): DependencyApi POST /:name/update returns 503 for launcher-required refusals"
```

---

## Task 7: `installNodejs` reorder + rollback

**Files:**
- Modify: `src/server/DependencyManager.ts:322-367` (installNodejs method)
- Modify: `src/server/__tests__/dependencyManager.update.test.ts`

This task fixes Bug #2 — destructive rename before failed extract leaves Node missing. New order: extract first (non-destructive), then rename + copy with tight rollback.

- [ ] **Step 1: Write failing tests**

Add this describe block to `src/server/__tests__/dependencyManager.update.test.ts` (after the gate tests from Task 4):

```ts
describe('DependencyManager.installNodejs rollback', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-nodeinstall-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    async function callInstallNodejs(
        mgr: DependencyManager,
        downloadPath: string,
        version: string,
        installTmp: string,
        platform: 'win32' | 'linux',
    ): Promise<void> {
        // installNodejs is private — invoke via a typed cast for the test only.
        // biome-ignore lint/suspicious/noExplicitAny: invoke private method
        await (mgr as any).installNodejs(downloadPath, version, installTmp, platform);
    }

    it('win32: extract failure leaves destDir untouched (original node.exe intact)', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNodeExe = path.join(destDir, 'node.exe');
        fs.writeFileSync(originalNodeExe, 'ORIGINAL-NODE-BYTES');

        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-'));

        // Mock extractZip to throw
        // biome-ignore lint/suspicious/noExplicitAny: private method spy
        vi.spyOn(mgr as any, 'extractZip').mockRejectedValue(new Error('mock extract fail'));

        await expect(
            callInstallNodejs(mgr, '/fake/download.zip', '24.15.0', extractTmp, 'win32'),
        ).rejects.toThrow('mock extract fail');

        // Original node.exe must be intact; no .old created.
        expect(fs.readFileSync(originalNodeExe, 'utf8')).toBe('ORIGINAL-NODE-BYTES');
        expect(fs.existsSync(path.join(destDir, 'node.exe.old'))).toBe(false);

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });

    it('win32: copy failure restores .old back to .exe (rollback)', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNodeExe = path.join(destDir, 'node.exe');
        fs.writeFileSync(originalNodeExe, 'ORIGINAL-NODE-BYTES');

        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-'));
        // Simulate a successful extract: write the expected archive layout.
        const archiveRoot = path.join(extractTmp, 'node-v24.15.0-win-x64');
        fs.mkdirSync(archiveRoot, { recursive: true });
        fs.writeFileSync(path.join(archiveRoot, 'node.exe'), 'NEW-NODE-BYTES');

        // extractZip mock succeeds (no-op — the layout is pre-populated).
        // biome-ignore lint/suspicious/noExplicitAny: private method spy
        vi.spyOn(mgr as any, 'extractZip').mockResolvedValue(undefined);
        // copyDirContents mock throws partway.
        // biome-ignore lint/suspicious/noExplicitAny: private method spy
        vi.spyOn(mgr as any, 'copyDirContents').mockImplementation(() => {
            throw new Error('mock copy fail');
        });

        await expect(
            callInstallNodejs(mgr, '/fake/download.zip', '24.15.0', extractTmp, 'win32'),
        ).rejects.toThrow('mock copy fail');

        // node.exe must be restored from .old; .old must no longer exist after restore.
        expect(fs.existsSync(originalNodeExe)).toBe(true);
        expect(fs.readFileSync(originalNodeExe, 'utf8')).toBe('ORIGINAL-NODE-BYTES');
        expect(fs.existsSync(path.join(destDir, 'node.exe.old'))).toBe(false);

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });

    it('win32: full success replaces node.exe (and leaves node.exe.old per current behavior)', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNodeExe = path.join(destDir, 'node.exe');
        fs.writeFileSync(originalNodeExe, 'ORIGINAL-NODE-BYTES');

        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-'));
        const archiveRoot = path.join(extractTmp, 'node-v24.15.0-win-x64');
        fs.mkdirSync(archiveRoot, { recursive: true });
        fs.writeFileSync(path.join(archiveRoot, 'node.exe'), 'NEW-NODE-BYTES');
        fs.writeFileSync(path.join(archiveRoot, 'npm.cmd'), 'NPM-CMD-BYTES');

        // biome-ignore lint/suspicious/noExplicitAny: private method spy
        vi.spyOn(mgr as any, 'extractZip').mockResolvedValue(undefined);
        // Don't mock copyDirContents — let it run for real on the pre-populated archive.

        await callInstallNodejs(mgr, '/fake/download.zip', '24.15.0', extractTmp, 'win32');

        expect(fs.readFileSync(originalNodeExe, 'utf8')).toBe('NEW-NODE-BYTES');
        expect(fs.readFileSync(path.join(destDir, 'npm.cmd'), 'utf8')).toBe('NPM-CMD-BYTES');
        // Current behavior: node.exe.old lingers post-success (cleanup is a separate non-goal).
        expect(fs.existsSync(path.join(destDir, 'node.exe.old'))).toBe(true);

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });

    it('linux: extract failure leaves destDir untouched', async () => {
        // The Linux branch uses execFileAsync('tar', ...) directly, not extractZip.
        // Mocking the actual tar call is tricky; instead verify by checking that
        // after a failure, destDir state is unchanged from initial.
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNode = path.join(destDir, 'node');
        fs.writeFileSync(originalNode, 'ORIGINAL-LINUX-NODE');

        // Point download at a non-existent file so tar will fail.
        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-linux-'));

        await expect(
            callInstallNodejs(mgr, '/does/not/exist.tar.gz', '24.15.0', extractTmp, 'linux'),
        ).rejects.toThrow();

        // Linux destDir state unchanged.
        expect(fs.readFileSync(originalNode, 'utf8')).toBe('ORIGINAL-LINUX-NODE');

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/server/__tests__/dependencyManager.update.test.ts`
Expected: the 4 new rollback tests FAIL in characteristic ways:
- win32 extract-failure: probably FAILS because the current code renames node.exe → node.exe.old BEFORE extractZip throws, so the assertion `fs.readFileSync(originalNodeExe, 'utf8')).toBe('ORIGINAL-NODE-BYTES')` fails (file no longer exists at `originalNodeExe`).
- win32 copy-failure: FAILS because no rollback path exists.
- win32 success: may pass — depends on whether current code can complete with the mock setup.
- linux: probably FAILS because the test path uses a non-existent file but the current code may write something to destDir before the tar call fails. Adjust test if it surfaces a different real-bug shape.

- [ ] **Step 3: Implement the reordered installNodejs**

In `src/server/DependencyManager.ts`, replace `installNodejs` entirely (around lines 322-367):

```ts
private async installNodejs(
    downloadPath: string,
    _version: string,
    tmpDir: string,
    platform: 'win32' | 'linux',
): Promise<void> {
    const destDir = path.join(this.depsPath, 'node');
    fs.mkdirSync(destDir, { recursive: true });

    // 1. Non-destructive: extract to tmpDir (both platforms).
    if (platform === 'win32') {
        await this.extractZip(downloadPath, tmpDir, platform);
    } else {
        await execFileAsync('tar', ['xzf', downloadPath, '-C', tmpDir]);
    }
    const archiveDir = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-v'));
    if (!archiveDir) {
        throw new Error('Could not find Node.js directory in extracted archive');
    }
    const extractedPath = path.join(tmpDir, archiveDir);

    // 2. Destructive (Windows only): rename + copy with rollback.
    if (platform === 'win32') {
        const runningExe = path.join(destDir, 'node.exe');
        const oldExe = path.join(destDir, 'node.exe.old');
        let renamed = false;
        if (fs.existsSync(runningExe)) {
            try {
                fs.renameSync(runningExe, oldExe);
                renamed = true;
            } catch {
                // May fail if not the managed node — proceed without rollback safety net.
            }
        }
        try {
            this.copyDirContents(extractedPath, destDir);
        } catch (err) {
            if (renamed && !fs.existsSync(runningExe)) {
                try {
                    fs.renameSync(oldExe, runningExe);
                } catch {
                    // Best-effort rollback. Original error bubbles up regardless.
                }
            }
            throw err;
        }
    } else {
        this.copyDirContents(extractedPath, destDir);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/dependencyManager.update.test.ts`
Expected: all rollback tests pass. The pre-existing scrcpy-server loop-fix + Task 4 gate tests still pass.

If the linux extract-failure test behaves differently than expected (e.g., the mkdirSync runs before tar fails, leaving destDir in a "created but empty" state), adjust the test assertion to verify that no NEW files appear in destDir, rather than asserting that `originalNode` is untouched (which it would be regardless).

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 708/708.

- [ ] **Step 6: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/DependencyManager.ts src/server/__tests__/dependencyManager.update.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(deps): installNodejs reorder (extract-first) + rollback on copy failure"
```

---

## Task 8: Frontend gated `update (dev)` button

**Files:**
- Modify: `src/app/client/DependencyPanel.ts:218-226` (actionButton method) and lines 210-212 (badge text — lowercase consistency)

No frontend test harness exists for `DependencyPanel`; this is a pure rendering change verified by manual smoke (Task 9).

- [ ] **Step 1: Modify `actionButton` and lowercase status badges**

In `src/app/client/DependencyPanel.ts`, find `actionButton` (around lines 218-226):

```ts
private actionButton(dep: DependencyInfo): string {
    if (dep.status === 'update-available') {
        return `<button class="dep-btn dep-update" data-update="${dep.name}">Update</button>`;
    }
    if (dep.status === 'updating') {
        return '<button class="dep-btn" disabled>Updating...</button>';
    }
    return '';
}
```

Replace with:

```ts
private actionButton(dep: DependencyInfo): string {
    if (dep.status === 'update-available') {
        if (!dep.canUpdate) {
            const tooltip = 'In-app updates require an installed build. ' +
                'In dev mode, populate dependencies/ via scripts/fetch-node.mjs.';
            return `<button class="dep-btn dep-update" disabled title="${tooltip}">` +
                `update (dev)</button>`;
        }
        return `<button class="dep-btn dep-update" data-update="${dep.name}">update</button>`;
    }
    if (dep.status === 'updating') {
        return '<button class="dep-btn" disabled>updating...</button>';
    }
    return '';
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: clean — `dep.canUpdate` is now a known field on `DependencyInfo` from Task 1.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: 708/708 (no test changes; existing tests unaffected).

- [ ] **Step 4: Build the frontend bundle**

The dev server uses webpack to bundle the frontend. Rebuild before manual smoke:

```powershell
npm run build
```

Expected: build completes with no errors. Output in `dist/`.

- [ ] **Step 5: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/DependencyPanel.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): DependencyPanel disables update button for launcher-required deps in dev (lowercase labels)"
```

---

## Task 9: Manual smoke + CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

This task closes the loop: confirm the fix works end-to-end in dev mode (and ideally also against a deployed install), then write the CHANGELOG entry with the actual measured test counts.

### Manual smoke

The fix is initially landed in dev only. The deployed-mode validation comes when the next beta ships (out of scope for this plan). The dev-mode smoke is sufficient gate for merge.

- [ ] **Step 1: Recover from the broken Node state (if not already done)**

In PowerShell:

```powershell
Move-Item "C:\ProgramData\WsScrcpyWeb\dependencies\node\node.exe.old" "C:\ProgramData\WsScrcpyWeb\dependencies\node\node.exe"
```

(Skip this step if Node was already recovered earlier, or if Node was never broken in this session.)

- [ ] **Step 2: Start the dev server**

```powershell
cd C:/Users/jscha/source/repos/ws-scrcpy-web
npm start
```

Watch the server log. Confirm: no `[DependencyManager] ERROR Update nodejs failed: extractZip requires the packaged launcher binary` line on startup. If autoInstallMissing would previously have re-fired for missing nodejs, you should now see `[DependencyManager] INFO Skipping auto-install of nodejs in dev mode (no launcher)`.

- [ ] **Step 3: Open the app + check the dep panel**

Navigate to `http://localhost:8000/` → Settings → Dependencies panel.

Verify:
- **nodejs:** "update available" badge, action column shows a **disabled** "update (dev)" button. Hover shows the tooltip: "In-app updates require an installed build. In dev mode, populate dependencies/ via scripts/fetch-node.mjs."
- **adb:** same shape as nodejs.
- **scrcpy-server:** if an update is available, the action column shows an **enabled** "update" button (no launcher needed for this dep).

- [ ] **Step 4: Verify the disabled button does not fire**

Click the disabled "update (dev)" button on the nodejs row. Confirm:
- Nothing happens (the disabled attribute blocks the click).
- No POST request appears in DevTools Network tab.
- Server log shows no new ERROR lines.

- [ ] **Step 5: Verify the 503 path via direct API call**

In DevTools console:

```js
const r = await fetch('/api/dependencies/nodejs/update', { method: 'POST' });
console.log('status:', r.status);
console.log('body:', await r.json());
```

Expected:
- `status: 503`
- `body: { success: false, reason: 'launcher-required', errorMessage: 'Node.js updates require an installed build. In dev mode, populate dependencies/ via scripts/fetch-node.mjs.', requiresRestart: false }`

Server log shows no ERROR — the guard returns cleanly, no destructive code path entered.

- [ ] **Step 6: Verify scrcpy-server update still works in dev**

Click the (enabled) "update" button on the scrcpy-server row. If an update is available, it should download and install. Confirm:
- Status transitions update-available → updating → up-to-date (or stays update-available if checkLatest matches installed).
- No errors.
- (If no update is currently available, this step is a no-op — skip and document below.)

- [ ] **Step 7: Stop the dev server**

Ctrl+C in the npm start terminal. Wait for clean shutdown.

### CHANGELOG entry

- [ ] **Step 8: Remeasure final test counts**

Run: `npm test`
Expected: ~708/708. Note the exact number for the CHANGELOG entry.

- [ ] **Step 9: Add the CHANGELOG entry**

Open `CHANGELOG.md`. Under the most recent `## [Unreleased]` section (create it if it doesn't exist, at the top of the file under the `# Changelog` header), add:

```markdown
### Fixed

- **Dev mode no longer crashes on Update Node click.** Per-dep `requiresLauncher` flag gates the in-app dep updater. In dev mode, `nodejs` and `adb` show a disabled "update (dev)" button with a tooltip pointing at `scripts/fetch-node.mjs`. `scrcpy-server` remains updatable in dev (no launcher needed). `POST /api/dependencies/:name/update` returns HTTP 503 with `reason: 'launcher-required'` for the dev-mode refusal.

- **`installNodejs` no longer leaves Node missing on failed updates.** Reordered to extract to `tmpDir` first (non-destructive); only after extract succeeds does it rename `node.exe` → `node.exe.old` and copy new files. On copy failure, the rename is rolled back so `node.exe` remains the prior version. Reachable in production via any extract/copy failure mode (network-zip-corrupt, disk-full, AV-quarantine, malformed archive).

- **`autoInstallMissing` no longer restart-loops in dev.** Skips deps where `requiresLauncher && !launcherIsAvailable()` with a log line. Previously: a failed manual update that renamed `node.exe` → `node.exe.old` made `checkInstalled` return null, which fired `autoInstallMissing` on every dev startup, which re-threw the same launcher-missing error on every restart.

Tests: vitest <NNN>/<NNN> (was 695/695 pre-fix; +<N> new tests across dependencyDefinitions, dependencyManager, dependencyManager.update, dependencyManager.autoInstallMissing, dependencyApi.update suites).
```

Fill in `<NNN>/<NNN>` and `<N>` from the measurement in Step 8.

- [ ] **Step 10: Commit the CHANGELOG entry**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): dev-mode dep update gate + installNodejs rollback"
```

### Optional: version bump + tag (out of plan)

Per `reference_wsscrcpy_version_bump.md`, releases use `npm run version:bump <ver>`. This is intentionally out of plan — surfacing it as a separate operation that you'll run at PR-merge time or as part of the next beta cut. The breadcrumb in `todo_ws_scrcpy_web.md` reserves `v0.1.25-beta.41` for Phase 3 of the operation-server arc; this fix would naturally land as a separate beta (e.g., `v0.1.25-beta.42` or pulled forward as `.41` if the user prioritizes it).

Surface to the user when implementation is complete:

> Plan executed. PR is on branch `fix/dev-mode-dep-update-gate` with N commits ahead of main. Final test count: NNN/NNN. Want to bump the version + tag + open a PR now, or fold into a later beta cut?

---

## Self-review

Spec coverage:

| Spec section | Task |
| --- | --- |
| Data model: DependencyInfo.canUpdate | Task 1 |
| Data model: UpdateResult.reason | Task 1 |
| Data model: DependencyDefinition.requiresLauncher | Task 2 |
| Server: getAll() recompute | Task 3 |
| Server: update() guard | Task 4 |
| Server: autoInstallMissing skip | Task 5 |
| Server: DependencyApi 503 | Task 6 |
| Server: installNodejs rollback | Task 7 |
| Frontend: actionButton gate + lowercase | Task 8 |
| Testing: 6.1 definitions test | Task 2 |
| Testing: 6.2 manager canUpdate tests | Task 3 |
| Testing: 6.3 update guard tests | Task 4 |
| Testing: 6.4 autoInstallMissing skip test | Task 5 |
| Testing: 6.5 dependencyApi.update.test.ts NEW | Task 6 |
| Testing: 6.6 rollback tests | Task 7 |
| Testing: 6.7 baseline-no-regress | All tasks (full suite at each commit) |
| Risks: stringly-vs-typed reason | Resolved by typed `reason` in Task 1 |
| Risks: rollback-fails-too | Best-effort try/catch in Task 7 |
| Manual smoke per spec 6 | Task 9 |
| CHANGELOG entry | Task 9 |
| Out of scope: version bump | Documented in Task 9 epilogue |

All spec sections have an implementing task. No placeholders. Type names match across tasks (`canUpdate`, `reason: 'launcher-required'`, `requiresLauncher`). Method signatures match between definition and consumer (Task 1's interface fields used in Task 3's getAll, Task 4's update, Task 8's actionButton).
