# Settings Migration (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every `localStorage` UI pref into the per-user SQLite store via a new HTTP `SettingsApi`, add a one-time client import, rework theme first-paint, and make "reset" clear **all of the current user's** settings.

**Architecture:** The browser never touches SQLite — a small client `SettingsService` reads/writes through `SettingsApi` (per-user, keyed by `resolveUserId(req)`). Global prefs (theme, icon size, scan subnets, prompt dismissals) live in `user_settings`; per-device prefs (video/stream, audio) live in `device_settings` keyed `(user, udid, scope)`. Theme first-paint reads the OS (`prefers-color-scheme`) as a throwaway, then the app applies the user's stored theme. Prompt-dismissal flags move off `/api/config` (where Phase 1 parked them for compatibility) onto `SettingsApi`.

**Tech Stack:** TypeScript (server + browser), the Phase-1 `Db`/`UserSettingsStore`/`DeviceStore`, vitest.

**Spec:** `docs/specs/2026-06-11-sqlite-persistence-and-auth-design.md` (Settings migration phase). **Depends on Phase 1** (stores) and **Phase 2** (`resolveUserId` seam). **Coordination:** this phase edits the Settings modal + player/file-browser client code that the **beta.62** restructure also touches — its tasks rebase onto the post-beta.62 tree; the exact line targets below are from the pre-beta.62 tree and pin at execution.

> **⚠️ Phase 1 as-built (read first, PR #425).** The DB is reached via `Config.getInstance().db`; the legacy import lives in `src/server/db/import/`. Phase 1 composes the prompt-dismissal flags into `AppConfig` by overlaying `user_settings` (`Config.overlayStore(out, prompts, PROMPT_KEYS)`) — this phase moves them onto `SettingsApi`, so remove that overlay (and drop `PROMPT_KEYS` from the compose). The `config.json` trim preserves `server`/`allowedHosts`; don't re-introduce a trio-only trim. Re-pin the Settings-modal / player line targets against the current (post-beta.66) tree.

---

## File structure

| File | Change |
|---|---|
| `src/server/db/DeviceStore.ts` | **Modify.** Add `getDeviceSetting`/`setDeviceSetting`/`getDeviceSettings`/`clearForUser` (per-user `device_settings`). |
| `src/server/api/SettingsApi.ts` | **Create.** `GET/PATCH /api/settings` (global), `GET/PATCH /api/settings/device` (per-device), `POST /api/settings/reset`. |
| `src/server/index.ts` | **Modify.** `HttpServer.addApiHandler(new SettingsApi())`. |
| `src/app/client/SettingsService.ts` | **Create.** Browser client over `SettingsApi` (replaces direct `localStorage`). |
| `src/app/client/migrateLocalStorage.ts` | **Create.** One-time import of legacy keys → `SettingsApi`, then clears them. |
| `src/app/googDevice/client/ListFilesModal.ts` | **Modify.** Icon size via `SettingsService` (was `ICON_SIZE_KEY`). |
| `src/app/player/BasePlayer.ts` | **Modify.** Video/stream via per-device settings (was `get/putVideoSettings...Storage`). |
| `src/app/client/AudioSettingsStore.ts` | **Modify.** Audio via per-device settings (was `ws-scrcpy-web:audio:<udid>`). |
| `src/app/client/ScanNetworkModal.ts` | **Modify.** Scan subnets via global settings (was `ws-scrcpy-web:scan-subnets`). |
| `src/app/public/themeEmbed.ts` | **Modify.** First paint = `prefers-color-scheme`; app applies stored theme after load. |
| `src/app/client/PortChangeModal.ts`, `src/common/ConfigEvents.ts` | **Modify.** Prompt-dismissal flags via `SettingsService` (off `/api/config`). |
| `src/server/Config.ts` | **Modify.** Stop composing prompt flags into `AppConfig` (they live on `SettingsApi` now). |

---

## Task 1: DeviceStore per-device settings + clearForUser

**Files:**
- Modify: `src/server/db/DeviceStore.ts`
- Test: `src/server/db/__tests__/deviceStoreSettings.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { DeviceStore } from '../DeviceStore';

let db: DatabaseSync; let store: DeviceStore;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); store = new DeviceStore(db); });

describe('DeviceStore per-device settings', () => {
    it('round-trips scoped per-device JSON and lists by udid', () => {
        store.setDeviceSetting(1, 'UDID1', 'video:0:0', { codec: 'h264', bitrate: 8000 });
        store.setDeviceSetting(1, 'UDID1', 'audio', { source: 'output' });
        expect(store.getDeviceSetting(1, 'UDID1', 'video:0:0')).toEqual({ codec: 'h264', bitrate: 8000 });
        expect(store.getDeviceSettings(1, 'UDID1')).toEqual({ 'video:0:0': { codec: 'h264', bitrate: 8000 }, audio: { source: 'output' } });
        expect(store.getDeviceSetting(2, 'UDID1', 'audio')).toBeUndefined(); // per-user isolation
    });

    it('clearForUser removes that user labels + device settings only', () => {
        store.setLabel(1, 'S1', 'TV');
        store.setDeviceSetting(1, 'UDID1', 'audio', { source: 'mic' });
        store.clearForUser(1);
        expect(store.getAllLabels(1)).toEqual({});
        expect(store.getDeviceSettings(1, 'UDID1')).toEqual({});
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/db/__tests__/deviceStoreSettings.test.ts`

- [ ] **Step 3: Implement** (append to `DeviceStore`)

```ts
    getDeviceSetting(userId: number, udid: string, scope: string): unknown | undefined {
        const r = this.db.prepare('SELECT value FROM device_settings WHERE user_id = ? AND udid = ? AND scope = ?').get(userId, udid, scope) as { value: string } | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }

    setDeviceSetting(userId: number, udid: string, scope: string, value: unknown): void {
        this.db
            .prepare('INSERT INTO device_settings (user_id, udid, scope, value) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, udid, scope) DO UPDATE SET value = excluded.value')
            .run(userId, udid, scope, JSON.stringify(value));
    }

    getDeviceSettings(userId: number, udid: string): Record<string, unknown> {
        const rows = this.db.prepare('SELECT scope, value FROM device_settings WHERE user_id = ? AND udid = ?').all(userId, udid) as Array<{ scope: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.scope] = JSON.parse(r.value);
        return out;
    }

    clearForUser(userId: number): void {
        this.db.prepare('DELETE FROM device_labels WHERE user_id = ?').run(userId);
        this.db.prepare('DELETE FROM device_settings WHERE user_id = ?').run(userId);
    }
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/DeviceStore.ts src/server/db/__tests__/deviceStoreSettings.test.ts
git commit -m "feat(db): DeviceStore per-device settings + clearForUser"
```

---

## Task 2: SettingsApi (server HTTP surface)

**Files:**
- Create: `src/server/api/SettingsApi.ts`
- Modify: `src/server/index.ts` (register the handler)
- Test: `src/server/__tests__/settingsApi.test.ts`

**Endpoints** (all keyed by `resolveUserId(req)`; `db = Db.getInstance(Config.getInstance().dataRoot ?? <fallback>)`):
- `GET /api/settings` → `{ ...user_settings.getAll(userId) }`
- `PATCH /api/settings` (body: `{ [key]: value }`) → `userSettings.set(userId, key, value)` for each
- `GET /api/settings/device?udid=...` → `devices.getDeviceSettings(userId, udid)`
- `PATCH /api/settings/device?udid=...` (body: `{ [scope]: value }`) → `devices.setDeviceSetting(userId, udid, scope, value)` for each
- `POST /api/settings/reset` → `userSettings.clearForUser(userId)` + `devices.clearForUser(userId)`

- [ ] **Step 1: Failing test** (drive global set/get + reset; reuse the repo HTTP mock helper from Phase 2 Task 2)

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../db/Db';
import { Config } from '../Config';
import { SettingsApi } from '../api/SettingsApi';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { makeReqRes } from './helpers/httpMock';

const dirs: string[] = [];
function root(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsset-')); dirs.push(d); return d; }
afterEach(() => { Db._resetForTest(); Config._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); process.env['DATA_ROOT'] = ''; });

describe('SettingsApi', () => {
    it('PATCH then GET global settings for the implicit admin', async () => {
        const dir = root(); process.env['DATA_ROOT'] = dir; Config.getInstance();
        const api = new SettingsApi();
        const patch = makeReqRes('PATCH', '/api/settings', { theme: 'dark', scanSubnets: ['10.0.0.0/24'] });
        await api.handle(patch.req, patch.res);
        expect(Db.getInstance(dir).userSettings.get(IMPLICIT_ADMIN_ID, 'theme')).toBe('dark');
        const get = makeReqRes('GET', '/api/settings');
        await api.handle(get.req, get.res);
        expect(get.getJson()).toMatchObject({ theme: 'dark', scanSubnets: ['10.0.0.0/24'] });
    });

    it('reset clears user_settings + labels + device_settings for the caller', async () => {
        const dir = root(); process.env['DATA_ROOT'] = dir; Config.getInstance();
        const db = Db.getInstance(dir);
        db.userSettings.set(IMPLICIT_ADMIN_ID, 'theme', 'dark');
        db.devices.setLabel(IMPLICIT_ADMIN_ID, 'S1', 'TV');
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, 'UDID1', 'audio', { source: 'mic' });
        const api = new SettingsApi();
        const r = makeReqRes('POST', '/api/settings/reset', {});
        await api.handle(r.req, r.res);
        expect(db.userSettings.getAll(IMPLICIT_ADMIN_ID)).toEqual({});
        expect(db.devices.getAllLabels(IMPLICIT_ADMIN_ID)).toEqual({});
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, 'UDID1')).toEqual({}); // device_settings cleared too
    });
});
```

> `makeReqRes(method, url, body?)` is the body-capable shared helper defined in Phase 2 Task 2 (`src/server/__tests__/helpers/httpMock.ts`) — import it; do not re-invent it.

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/settingsApi.test.ts`

- [ ] **Step 3: Implement** `SettingsApi` following the `ApiHandler` interface (`handle(req, res): Promise<boolean>`) and the routing pattern of the existing `ConfigApi` (method + pathname switch; return `false` for unmatched paths so other handlers run). For each matched route, compute `userId = resolveUserId(req)` and `db = Db.getInstance(dbDir(Config.getInstance()))` (the canonical resolver, Phase 1 Task 12). **Parse bodies with `readJsonBody(req)` from `src/server/api/utils.ts`** (the real shared helper — there is no `ConfigApi.sendJson`; ConfigApi's reader is private). Respond as `ConfigApi` does: `res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(...))`.

- [ ] **Step 4: Register** in `index.ts`: `const settingsApi = new SettingsApi(); HttpServer.addApiHandler(settingsApi);` (next to the other `addApiHandler` calls).

- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit**

```bash
git add src/server/api/SettingsApi.ts src/server/index.ts src/server/__tests__/settingsApi.test.ts
git commit -m "feat(settings): SettingsApi (per-user global + per-device + reset)"
```

---

## Task 3: client SettingsService + one-time localStorage import

**Files:**
- Create: `src/app/client/SettingsService.ts`, `src/app/client/migrateLocalStorage.ts`
- Test: `src/app/client/__tests__/migrateLocalStorage.test.ts` (jsdom — see note)

> Browser-side tests: if the repo runs any `src/app` tests under jsdom, follow that config; otherwise keep `migrateLocalStorage` logic in a pure, injectable function (pass a `Storage` + a `patch` fn) so it is testable without a DOM. The plan uses the injectable form.

- [ ] **Step 1: Failing test** (pure, injected `Storage` + capture POSTs)

```ts
import { describe, it, expect } from 'vitest';
import { migrateLocalStorage, LEGACY_KEYS } from '../migrateLocalStorage';

class MemStorage {
    private m = new Map<string, string>();
    getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
    setItem(k: string, v: string) { this.m.set(k, v); }
    removeItem(k: string) { this.m.delete(k); }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    get length() { return this.m.size; }
}

describe('migrateLocalStorage', () => {
    it('maps legacy keys to settings patches, sets the marker, clears them', async () => {
        const ls = new MemStorage();
        ls.setItem('ws-scrcpy-web-theme', 'dark');
        ls.setItem('ws-scrcpy-web:scan-subnets', JSON.stringify(['10.0.0.0/24']));
        ls.setItem('ws-scrcpy-web:audio:UDID1', JSON.stringify({ source: 'output' }));
        const patches: Array<{ kind: string; payload: unknown }> = [];
        await migrateLocalStorage(ls as unknown as Storage, {
            patchGlobal: async (p) => { patches.push({ kind: 'global', payload: p }); },
            patchDevice: async (udid, p) => { patches.push({ kind: `device:${udid}`, payload: p }); },
        });
        expect(patches).toContainEqual({ kind: 'global', payload: { theme: 'dark', scanSubnets: ['10.0.0.0/24'] } });
        expect(patches).toContainEqual({ kind: 'device:UDID1', payload: { audio: { source: 'output' } } });
        expect(ls.getItem('ws-scrcpy-web-theme')).toBeNull();
        expect(ls.getItem(LEGACY_KEYS.migratedFlag)).toBe('1');
    });

    it('is a no-op when the marker is set', async () => {
        const ls = new MemStorage();
        ls.setItem(LEGACY_KEYS.migratedFlag, '1');
        ls.setItem('ws-scrcpy-web-theme', 'dark');
        let called = false;
        await migrateLocalStorage(ls as unknown as Storage, { patchGlobal: async () => { called = true; }, patchDevice: async () => { called = true; } });
        expect(called).toBe(false);
        expect(ls.getItem('ws-scrcpy-web-theme')).toBe('dark'); // untouched
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/app/client/__tests__/migrateLocalStorage.test.ts`

- [ ] **Step 3: Implement** the mapper + the service.

```ts
// src/app/client/migrateLocalStorage.ts
export const LEGACY_KEYS = {
    theme: 'ws-scrcpy-web-theme',
    iconSize: 'ws-scrcpy-web:icon-size',     // confirm exact ICON_SIZE_KEY string in ListFilesModal
    scanSubnets: 'ws-scrcpy-web:scan-subnets',
    audioPrefix: 'ws-scrcpy-web:audio:',     // ws-scrcpy-web:audio:<udid>
    videoPrefix: 'ws-scrcpy-web:video:',     // confirm BasePlayer's exact key shape (udid/display/window)
    migratedFlag: 'ws-scrcpy-web:migrated-to-sqlite',
} as const;

export interface SettingsSink {
    patchGlobal(patch: Record<string, unknown>): Promise<void>;
    patchDevice(udid: string, patch: Record<string, unknown>): Promise<void>;
}

export async function migrateLocalStorage(ls: Storage, sink: SettingsSink): Promise<void> {
    if (ls.getItem(LEGACY_KEYS.migratedFlag)) return;

    const global: Record<string, unknown> = {};
    const theme = ls.getItem(LEGACY_KEYS.theme);
    if (theme !== null) global['theme'] = theme;
    const icon = ls.getItem(LEGACY_KEYS.iconSize);
    if (icon !== null) global['iconSize'] = JSON.parse(icon);
    const subnets = ls.getItem(LEGACY_KEYS.scanSubnets);
    if (subnets !== null) global['scanSubnets'] = JSON.parse(subnets);

    const perDevice = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k) continue;
        if (k.startsWith(LEGACY_KEYS.audioPrefix)) {
            const udid = k.slice(LEGACY_KEYS.audioPrefix.length);
            (perDevice.get(udid) ?? perDevice.set(udid, {}).get(udid)!)['audio'] = JSON.parse(ls.getItem(k)!);
        } else if (k.startsWith(LEGACY_KEYS.videoPrefix)) {
            const rest = k.slice(LEGACY_KEYS.videoPrefix.length); // <udid>:<display>:<window>
            const [udid, ...scopeParts] = rest.split(':');
            (perDevice.get(udid) ?? perDevice.set(udid, {}).get(udid)!)[`video:${scopeParts.join(':')}`] = JSON.parse(ls.getItem(k)!);
        }
    }

    if (Object.keys(global).length) await sink.patchGlobal(global);
    for (const [udid, patch] of perDevice) await sink.patchDevice(udid, patch);

    // Clear legacy keys only after successful POSTs.
    [LEGACY_KEYS.theme, LEGACY_KEYS.iconSize, LEGACY_KEYS.scanSubnets].forEach((k) => ls.removeItem(k));
    for (let i = ls.length - 1; i >= 0; i--) {
        const k = ls.key(i);
        if (k && (k.startsWith(LEGACY_KEYS.audioPrefix) || k.startsWith(LEGACY_KEYS.videoPrefix))) ls.removeItem(k);
    }
    ls.setItem(LEGACY_KEYS.migratedFlag, '1');
}
```

> **Retry-safety + scope (audit finding).** The clear-keys + set-flag happen only AFTER all `patchGlobal`/`patchDevice` POSTs resolve, so a mid-sequence failure leaves the legacy keys intact and the flag unset → a clean re-run next load (KV writes are idempotent, so a re-POST of already-imported settings is harmless). The caller MUST `await migrateLocalStorage(...)` inside a `try` and proceed only on success; on throw, do not read settings yet (fall back to defaults for that session). The guard flag is **per-browser-origin** while the data lands **per-DB-user** — acceptable because each install is single-user (the implicit admin) until lockdown. Tracked edge: a *different* browser profile on the same machine that still holds stale legacy keys would import them into whichever user is active when it first loads post-lockdown; documented as a known low-risk edge (the keys are this-machine's own prefs).

```ts
// src/app/client/SettingsService.ts — the production SettingsSink + cache over /api/settings.
export class SettingsService {
    private globalCache: Record<string, unknown> | null = null;
    async loadGlobal(): Promise<Record<string, unknown>> {
        if (!this.globalCache) this.globalCache = await (await fetch('/api/settings')).json();
        return this.globalCache;
    }
    async patchGlobal(patch: Record<string, unknown>): Promise<void> {
        await fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
        this.globalCache = { ...(this.globalCache ?? {}), ...patch };
    }
    async getDevice(udid: string): Promise<Record<string, unknown>> {
        return (await fetch(`/api/settings/device?udid=${encodeURIComponent(udid)}`)).json();
    }
    async patchDevice(udid: string, patch: Record<string, unknown>): Promise<void> {
        await fetch(`/api/settings/device?udid=${encodeURIComponent(udid)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    }
    async reset(): Promise<void> { await fetch('/api/settings/reset', { method: 'POST' }); }
}
```

> **⚠ HARD PREREQUISITE — Step 0 (do this BEFORE writing `LEGACY_KEYS`).** The `videoPrefix`/`iconSize` literals above are **provisional and currently WRONG** (audit finding): the real `BasePlayer` video keys are **not** `ws-scrcpy-web:video:*` — they are prefixed by the **player class name** (`'WebCodecsPlayer'`, `'BaseCanvasBasedPlayer'`, etc.), shaped `<PlayerClass>:<udid>:<innerWxH>[:<displayId>:<WxH>]`, **plus a separate `<fullKey>:fit` boolean sibling**, plus a legacy short key `<PlayerClass>:<udid>`. A `ws-scrcpy-web:video:` `startsWith` filter matches **zero** keys and silently migrates nothing. So:
> 1. Open `src/app/googDevice/client/ListFilesModal.ts` and copy the literal `ICON_SIZE_KEY` string → set `LEGACY_KEYS.iconSize`.
> 2. Open `src/app/player/BasePlayer.ts` (+ the player subclasses) and copy the exact video-key construction (`get/putVideoSettingsToStorage`) and the `:fit` sibling key.
> 3. **Decide the video `device_settings` scope with the real scheme in hand.** Recommended: **collapse per-viewport video settings to one `video` scope per udid** (key `device_settings(user, udid, 'video')`), taking the most recent stored value — this preserves the user's codec/bitrate/encoder/fps choices and drops only the brittle viewport-dimension keying (which is re-learned on next view). Migrate the `:fit` flag into that same JSON value. Update the spec's localStorage table row to match.
> 4. Replace the `videoPrefix` branch in `migrateLocalStorage` to iterate **all** keys and match the player-class prefixes (not `ws-scrcpy-web:video:`), pairing each settings key with its `:fit` sibling. Add a migration test using a **real captured key string** so a future scheme change fails the test instead of silently dropping data.
>
> The audio (`ws-scrcpy-web:audio:<udid>`), scan-subnets (`ws-scrcpy-web:scan-subnets`), and theme (`ws-scrcpy-web-theme`) keys are confirmed accurate from the spec table and need no change.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/app/client/SettingsService.ts src/app/client/migrateLocalStorage.ts src/app/client/__tests__/migrateLocalStorage.test.ts
git commit -m "feat(settings): client SettingsService + one-time localStorage import"
```

---

## Task 4: retarget the localStorage call sites

Each sub-step replaces direct `localStorage` access with `SettingsService`. These are existing client files; the change is mechanical per the map. After all are retargeted, run the import once at app startup.

**Files & retargets:**
- `src/app/googDevice/client/ListFilesModal.ts` (`ICON_SIZE_KEY`, lines 122/287/310/312): read from `SettingsService.loadGlobal().iconSize` (default to current default), write via `patchGlobal({ iconSize })`.
- `src/app/client/ScanNetworkModal.ts` (`ws-scrcpy-web:scan-subnets`): read/write `scanSubnets` via global settings.
- `src/app/player/BasePlayer.ts` (`getVideoSettingFromStorage`/`putVideoSettingsToStorage`, ~233-299): read/write per-device scope `video:<display>:<window>` via `getDevice(udid)` / `patchDevice(udid, { ['video:'+display+':'+window]: settings })`.
- `src/app/client/AudioSettingsStore.ts` (`ws-scrcpy-web:audio:<udid>`): read/write per-device scope `audio` via `getDevice(udid)` / `patchDevice(udid, { audio })`.

- [ ] **Step 1: For each file**, replace the `localStorage.getItem/setItem` body of its existing getter/setter with a `SettingsService` call, preserving the **same return shape + defaults** the callers expect (so no caller changes). Where a getter was synchronous and the new read is async, hydrate the relevant settings once at component init (`await loadGlobal()` / `await getDevice(udid)`) and keep the per-frame getters reading the hydrated cache — do not make hot paths await per call.
- [ ] **Step 2: Add the one-time import** at app startup (where the app currently boots its client, e.g. the main client entry): `const settings = new SettingsService(); await migrateLocalStorage(window.localStorage, settings);` **before** the first settings read.
- [ ] **Step 3: Tests** — for any retargeted module with existing unit tests, update them to stub `SettingsService` instead of `localStorage`. Add a focused test per module asserting the read/write goes through the service (spy on `patchGlobal`/`patchDevice`).
- [ ] **Step 4: Gate** `npm run -s tsc && npx vitest run` → clean + green.
- [ ] **Step 5: Commit**

```bash
git add src/app/googDevice/client/ListFilesModal.ts src/app/client/ScanNetworkModal.ts src/app/player/BasePlayer.ts src/app/client/AudioSettingsStore.ts
git commit -m "feat(settings): retarget localStorage prefs to per-user SettingsService"
```

---

## Task 5: theme first-paint rework

**Files:**
- Modify: `src/app/public/themeEmbed.ts`
- Modify: the app's post-load theme application (where the theme is currently applied from the embed value)
- Test: `src/app/public/__tests__/themeEmbed.test.ts` (pure helper)

- [ ] **Step 1: Failing test** — extract the first-paint decision into a pure helper.

```ts
import { describe, it, expect } from 'vitest';
import { firstPaintTheme } from '../themeEmbed';

describe('firstPaintTheme', () => {
    it('uses the OS preference as the throwaway first paint (no localStorage read)', () => {
        expect(firstPaintTheme(true)).toBe('dark');   // prefers-color-scheme: dark
        expect(firstPaintTheme(false)).toBe('light');
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/app/public/__tests__/themeEmbed.test.ts`

- [ ] **Step 3: Implement** — `themeEmbed.ts` no longer reads `localStorage['ws-scrcpy-web-theme']`. The pre-app script sets the initial class from `window.matchMedia('(prefers-color-scheme: dark)').matches`; export `firstPaintTheme(prefersDark: boolean): 'dark'|'light'` for the test. After the app loads, it calls `SettingsService.loadGlobal()` and applies `theme` if present; on a user's first run (no stored theme), seed it from the OS reading via `patchGlobal({ theme })`.

- [ ] **Step 4: Run → PASS.** Confirm no remaining `localStorage` reference to the theme key (`grep "ws-scrcpy-web-theme" src/app` → only the legacy-import mapper).
- [ ] **Step 5: Commit**

```bash
git add src/app/public/themeEmbed.ts src/app/public/__tests__/themeEmbed.test.ts
git commit -m "feat(settings): theme first-paint via prefers-color-scheme; DB authoritative"
```

---

## Task 6: move prompt-dismissal flags off /api/config onto SettingsApi

Phase 1 parked the prompt flags (`bookmarkDismissedForPort`, `bookmarkDismissedGlobally`, `serviceFirstRunSeen`) in `Config`'s composition for compatibility. They are per-user, so they belong on `SettingsApi`.

**Files (corrected per audit — `ConfigEvents.ts` is a TYPES file, not a runtime consumer; the real third consumer is `ServiceFirstRunModal.ts`):**
- Modify: `src/server/Config.ts` — drop prompt keys from composition + `updateAppConfig` routing.
- Modify: `src/common/ConfigEvents.ts` — **type edit**: remove `bookmarkDismissedForPort`/`bookmarkDismissedGlobally`/`serviceFirstRunSeen` from the `AppConfig`/`FlatConfig` interfaces (they no longer ride `/api/config`).
- Modify the **runtime consumers** (read + write): `src/app/client/PortChangeModal.ts` (writes BOTH `bookmarkDismissedGlobally` and `bookmarkDismissedForPort`), `src/app/client/ServiceFirstRunModal.ts` (writes `serviceFirstRunSeen`), and **the boot gating in `src/server/index.ts` / the client that currently READS these flags from the `GET /api/config` envelope** to decide whether to show each modal — repoint reads to `SettingsService.loadGlobal()` and writes to `SettingsService.patchGlobal({...})`.
- Test: `src/server/__tests__/config.noPrompts.test.ts`

- [ ] **Step 1: Failing test** — `getAppConfig()` no longer carries prompt keys; they are served by `SettingsApi`.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Config } from '../Config';
import { Db } from '../db/Db';

const dirs: string[] = [];
afterEach(() => { Config._resetForTest(); Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); process.env['DATA_ROOT'] = ''; });

describe('Config without prompt flags', () => {
    it('does not expose bookmarkDismissed* via getAppConfig', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsnp-')); dirs.push(dir); process.env['DATA_ROOT'] = dir;
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000, installMode: 'user', firstRunComplete: false }));
        const cfg = Config.getInstance().getAppConfig() as Record<string, unknown>;
        expect(cfg).not.toHaveProperty('bookmarkDismissedGlobally');
        expect(cfg).not.toHaveProperty('serviceFirstRunSeen');
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/config.noPrompts.test.ts`
- [ ] **Step 3: Implement** — remove the prompt keys from `Config`'s composition + routing (Phase 1 Task 13) and from the `AppConfig`/`FlatConfig` interfaces (`ConfigEvents.ts`). Retarget the runtime consumers off the `/api/config` envelope: `PortChangeModal` (`patchGlobal({ bookmarkDismissedGlobally })` / `{ bookmarkDismissedForPort }`), `ServiceFirstRunModal` (`patchGlobal({ serviceFirstRunSeen: true })`), and **every place that READS these flags from the `GET /api/config` response to gate a modal** → read from `SettingsService.loadGlobal()` instead (the flags leave the config envelope entirely). The server-side reset (Task 2) already clears these (they are `user_settings` rows).
- [ ] **Step 4: Gate** `npm run -s tsc && npx vitest run` → clean + green (update any existing test that asserted prompt keys on `/api/config`).
- [ ] **Step 5: Commit**

```bash
git add src/server/Config.ts src/app/client/PortChangeModal.ts src/common/ConfigEvents.ts src/server/__tests__/config.noPrompts.test.ts
git commit -m "feat(settings): move prompt-dismissal flags to per-user SettingsApi"
```

---

## Task 7: reset-my-settings control

**Files:**
- Modify: the Settings modal reset control (`src/app/client/SettingsModal.ts` / the item-53 `buildResetControl` + `ResetConfirmModal`)
- Test: covered by Task 2 server reset test + a client spy test

> **Coordination:** the reset control lives in the Settings modal that **beta.62** restructures (item 53 shipped the reset overlay in beta.60). Rebase onto beta.62, then point its confirm action at `SettingsService.reset()` (which calls `POST /api/settings/reset`). The semantics widen from "reset prompts" to "reset all of my settings" (theme, device labels, per-device stream/audio, icon size, scan subnets, prompts) — copy in the modal updates to say so.

- [ ] **Step 1:** Repoint the reset modal's confirm handler from the old prompt-reset payload to `await new SettingsService().reset(); location.reload();` (preserve the existing reload-regardless `.catch(() => undefined)` behavior from beta.60).
- [ ] **Step 2:** Update the modal copy to reflect the wider scope.
- [ ] **Step 3:** Client spy test asserting confirm calls `reset()`. Gate `npm run -s tsc && npx vitest run`.
- [ ] **Step 4: Commit**

```bash
git add src/app/client/SettingsModal.ts <reset modal files>
git commit -m "feat(settings): reset control clears all of the current user settings"
```

---

## Self-review checklist

- [ ] **Spec coverage:** all 5 localStorage groups retargeted (icon size, video, audio, subnets, theme) ✓; HTTP `SettingsApi` (browser never touches SQLite) ✓; client one-time import + clear ✓; theme first-paint (prefers-color-scheme → DB, seed on first run) ✓; per-user `device_settings` + reset-my-settings (superset of item-53) ✓; prompt flags moved to per-user ✓.
- [ ] **Placeholder scan:** server + import code is concrete; client retargets name exact files + the exact transformation. The "confirm exact key string" notes are byte-accuracy checks against existing code, not deferred work.
- [ ] **Type consistency:** `SettingsService.{loadGlobal,patchGlobal,getDevice,patchDevice,reset}`, `migrateLocalStorage(ls, sink)`, `DeviceStore.{getDeviceSetting,setDeviceSetting,getDeviceSettings,clearForUser}`, `UserSettingsStore.clearForUser`, `resolveUserId` — all consistent with Phases 1–2.
- [ ] **Coordination flag:** Tasks 4/6/7 rebase onto beta.62 Settings restructure (recorded in the spec).
