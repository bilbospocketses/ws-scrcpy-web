# Settings Tabs, Staged Saves and a Durable Change Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Settings dialog into tabs where scalar settings accumulate as staged edits, confirmed through a change summary and applied server-side as one durably-recorded batch.

**Architecture:** A DOM-free `StagedSettingsStore` owns dirty state and the change list. Presentational tab modules register their stageable fields with it; action-only tabs register nothing, which makes "actions never appear in the summary" structurally impossible. A single `POST /api/settings/batch` writes a write-ahead-log row, applies non-restarting changes first and `webPort` last, and marks the row completed before the port PATCH ends the process.

**Tech Stack:** TypeScript (Node 24, `node:http` handlers, `node:sqlite`), Vitest, Biome, webpack-bundled vanilla DOM.

**Spec:** `docs/superpowers/specs/2026-09-10-settings-tabs-design.md`

## Global Constraints

- **Test runner:** `npm test` (`vitest run`). One file: `npx vitest run <path>`.
- **Lint:** `npm run lint` — **check the exit code**, do not eyeball the tail. `npm run lint > /dev/null; echo $?` must print `0`. If it fails on formatting only, `npm run format` then re-check.
- **`webPort` is applied LAST in every batch, always.** It is the only change that ends the process (`restartRequired` → exit 75 → supervisor restart). Anything applied after it can be lost.
- **The WAL row is marked `completed` BEFORE the `webPort` apply.** A stale `completed` is inert; a stale `pending` would re-apply settings the user already has on the next boot.
- **A `pending` row found at boot is marked `abandoned`, never auto-applied.**
- **Action-only tabs call `register()` zero times.** Do not add a "skip in summary" flag — absence from the store is the mechanism.
- **`fillBody` must keep rendering the body without awaiting the `/api/config` probe.** `SettingsModal.test.ts` stubs fetch as a never-resolving promise to pin this. A tab shell that awaits the probe before building reintroduces the empty-dialog bug.
- **`POST /api/settings/batch` is gated by `requireOperator`**, like every other admin route (item 81).
- **CHANGELOG entries go under `## [Unreleased]`**, never a pre-written version heading — `bump-version.mjs` aborts otherwise.
- **One `release:beta` PR** for the whole feature; no manual version bump.

---

### Task 1: Migration 002 and `PendingSettingsStore`

**Files:**
- Create: `src/server/db/migrations/002_pending_settings.ts`
- Modify: `src/server/db/migrations.ts` (add to `MIGRATIONS`)
- Create: `src/server/db/PendingSettingsStore.ts`
- Modify: `src/server/db/Db.ts` (expose the store)
- Create: `src/server/db/__tests__/pendingSettingsStore.test.ts`

**Interfaces:**
- Consumes: `Migration` (`src/server/db/migrations.ts`), `DatabaseSync` (`node:sqlite`), `Db.sqlite`.
- Produces:
  - `export const migration002: Migration`
  - `export type BatchStatus = 'pending' | 'completed' | 'failed' | 'abandoned'`
  - `export interface Change { id: string; label: string; from: unknown; to: unknown }`
  - `export interface BatchRow { id: number; userId: number; createdAt: number; status: BatchStatus; changes: Change[]; error: string | null }`
  - `export class PendingSettingsStore` with `create(userId: number, changes: Change[]): number`, `markCompleted(id: number): void`, `markFailed(id: number, error: string): void`, `markAbandoned(id: number): void`, `getPending(): BatchRow[]`, `pruneOlderThan(cutoffMs: number): number`

- [ ] **Step 1: Write the failing test**

Create `src/server/db/__tests__/pendingSettingsStore.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations';
import { PendingSettingsStore } from '../PendingSettingsStore';

let db: DatabaseSync;
let store: PendingSettingsStore;

beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new PendingSettingsStore(db);
});

const CHANGES = [
    { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
    { id: 'channel', label: 'Update channel', from: 'stable', to: 'beta' },
];

describe('PendingSettingsStore', () => {
    it('creates a pending row and reads it back with its changes intact', () => {
        const id = store.create(1, CHANGES);
        const pending = store.getPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]!.id).toBe(id);
        expect(pending[0]!.status).toBe('pending');
        expect(pending[0]!.userId).toBe(1);
        expect(pending[0]!.changes).toEqual(CHANGES);
    });

    it('a completed row is no longer pending', () => {
        const id = store.create(1, CHANGES);
        store.markCompleted(id);
        expect(store.getPending()).toHaveLength(0);
    });

    it('a failed row records why and stops being pending', () => {
        const id = store.create(1, CHANGES);
        store.markFailed(id, 'webPort must be an integer between 1024 and 65535');
        expect(store.getPending()).toHaveLength(0);
    });

    it('marks a row abandoned — the boot path for a batch nobody finished', () => {
        const id = store.create(1, CHANGES);
        store.markAbandoned(id);
        expect(store.getPending()).toHaveLength(0);
    });

    it('prunes only finished rows older than the cutoff, never pending ones', () => {
        const old = store.create(1, CHANGES);
        store.markCompleted(old);
        db.prepare('UPDATE pending_settings SET created_at = ? WHERE id = ?').run(1000, old);
        const live = store.create(1, CHANGES);

        expect(store.pruneOlderThan(2000)).toBe(1);
        expect(store.getPending().map((r) => r.id)).toEqual([live]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/db/__tests__/pendingSettingsStore.test.ts`
Expected: FAIL — `Cannot find module '../PendingSettingsStore'`.

- [ ] **Step 3: Write the migration**

Create `src/server/db/migrations/002_pending_settings.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrations';

// The write-ahead log for a staged settings batch (item 127).
//
// It lives in SQLite rather than browser storage because a webPort change moves
// the server to a new PORT, which is a different ORIGIN -- localStorage from the
// old origin is unreadable after the redirect. The data root survives both the
// restart and the origin change, so this table is the only place a batch can be
// recorded across it.
const DDL = `
CREATE TABLE pending_settings (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('pending','completed','failed','abandoned')),
    changes    TEXT    NOT NULL,
    error      TEXT
);
CREATE INDEX idx_pending_settings_status ON pending_settings(status);
`;

export const migration002: Migration = {
    version: 2,
    up(db: DatabaseSync): void {
        db.exec(DDL);
    },
};
```

In `src/server/db/migrations.ts`, add the import and the array entry:

```ts
import { migration002 } from './migrations/002_pending_settings';
```
```ts
export const MIGRATIONS: Migration[] = [migration001, migration002];
```

- [ ] **Step 4: Write the store**

Create `src/server/db/PendingSettingsStore.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';

export type BatchStatus = 'pending' | 'completed' | 'failed' | 'abandoned';

/** One staged edit, as the summary renders it and the batch applies it. */
export interface Change {
    id: string;
    label: string;
    from: unknown;
    to: unknown;
}

export interface BatchRow {
    id: number;
    userId: number;
    createdAt: number;
    status: BatchStatus;
    changes: Change[];
    error: string | null;
}

interface RawRow {
    id: number;
    user_id: number;
    created_at: number;
    status: BatchStatus;
    changes: string;
    error: string | null;
}

/**
 * The write-ahead log for staged settings batches.
 *
 * `create` before applying, then exactly one terminal mark. `getPending` is read
 * at boot: a row still pending means a previous instance died mid-batch.
 */
export class PendingSettingsStore {
    constructor(private readonly db: DatabaseSync) {}

    create(userId: number, changes: Change[]): number {
        const info = this.db
            .prepare('INSERT INTO pending_settings (user_id, created_at, status, changes) VALUES (?, ?, ?, ?)')
            .run(userId, Date.now(), 'pending', JSON.stringify(changes));
        return Number(info.lastInsertRowid);
    }

    markCompleted(id: number): void {
        this.setStatus(id, 'completed', null);
    }

    markFailed(id: number, error: string): void {
        this.setStatus(id, 'failed', error);
    }

    markAbandoned(id: number): void {
        this.setStatus(id, 'abandoned', null);
    }

    getPending(): BatchRow[] {
        const rows = this.db
            .prepare("SELECT * FROM pending_settings WHERE status = 'pending' ORDER BY id")
            .all() as unknown as RawRow[];
        return rows.map((r) => ({
            id: r.id,
            userId: r.user_id,
            createdAt: r.created_at,
            status: r.status,
            changes: JSON.parse(r.changes) as Change[],
            error: r.error,
        }));
    }

    /** Delete FINISHED rows older than the cutoff. Pending rows are never pruned. */
    pruneOlderThan(cutoffMs: number): number {
        const info = this.db
            .prepare("DELETE FROM pending_settings WHERE status != 'pending' AND created_at < ?")
            .run(cutoffMs);
        return Number(info.changes);
    }

    private setStatus(id: number, status: BatchStatus, error: string | null): void {
        this.db.prepare('UPDATE pending_settings SET status = ?, error = ? WHERE id = ?').run(status, error, id);
    }
}
```

- [ ] **Step 5: Expose it on `Db`**

In `src/server/db/Db.ts`, beside the other stores (`public readonly users: UserStore;` etc.), add the field and construct it wherever the sibling stores are constructed:

```ts
    public readonly pendingSettings: PendingSettingsStore;
```

Add the import:

```ts
import { PendingSettingsStore } from './PendingSettingsStore';
```

Read the constructor first and follow the exact shape the other stores use — they are all built from the same `DatabaseSync` handle.

- [ ] **Step 6: Run tests and lint**

Run: `npx vitest run src/server/db/__tests__/pendingSettingsStore.test.ts` → PASS, 5 tests.
Run: `npm test` → PASS. A migration-count or `user_version` assertion may need updating from 1 to 2; update it, do not weaken it.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/db
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(db): pending_settings write-ahead log for staged settings batches"
```

---

### Task 2: The batch endpoint

**Files:**
- Create: `src/server/api/SettingsBatchApi.ts`
- Create: `src/server/__tests__/settingsBatchApi.test.ts`
- Modify: `src/server/index.ts` (register the handler beside `settingsApi`, near line 171)

**Interfaces:**
- Consumes: `PendingSettingsStore`, `Change` (Task 1), `requireOperator` (`src/server/auth/requireOperator.ts`), `resolveUserId` (`src/server/auth/currentUser.ts`), `Config`.
- Produces:
  - `export const STAGEABLE_IDS: ReadonlySet<string>` — `'webPort'`, `'channel'`, `'autoUpdate'`, `'updateCheckIntervalMinutes'`
  - `export function orderChanges(changes: Change[]): Change[]` — `webPort` last
  - `export class SettingsBatchApi` with `handle(req, res): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `src/server/__tests__/settingsBatchApi.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { orderChanges, SettingsBatchApi, STAGEABLE_IDS } from '../api/SettingsBatchApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsbatch-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const LOOPBACK = { remoteAddress: '127.0.0.1' };

describe('orderChanges', () => {
    it('puts webPort last — it is the only change that ends the process', () => {
        const ordered = orderChanges([
            { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
            { id: 'channel', label: 'Channel', from: 'stable', to: 'beta' },
        ]);
        expect(ordered.map((c) => c.id)).toEqual(['channel', 'webPort']);
    });

    it('leaves a batch without webPort in its original order', () => {
        const ordered = orderChanges([
            { id: 'channel', label: 'Channel', from: 'stable', to: 'beta' },
            { id: 'autoUpdate', label: 'Auto update', from: true, to: false },
        ]);
        expect(ordered.map((c) => c.id)).toEqual(['channel', 'autoUpdate']);
    });
});

describe('STAGEABLE_IDS', () => {
    it('contains only settings, never actions', () => {
        expect(STAGEABLE_IDS.has('webPort')).toBe(true);
        expect(STAGEABLE_IDS.has('channel')).toBe(true);
        // Actions must never be stageable: they fire UAC, delete users, etc.
        expect(STAGEABLE_IDS.has('installService')).toBe(false);
        expect(STAGEABLE_IDS.has('deleteUser')).toBe(false);
    });
});

describe('POST /api/settings/batch', () => {
    it('records the batch and reports what it applied', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'autoUpdate', label: 'Auto update', from: true, to: false }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        const body = r.getJson() as { ok: boolean; applied: string[] };
        expect(body.ok).toBe(true);
        expect(body.applied).toContain('autoUpdate');
        // The WAL row reached a terminal state -- nothing left for boot to abandon.
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('refuses an unknown change id rather than writing it anywhere', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [{ id: 'installService', label: 'Install', from: false, to: true }] },
            {},
            LOOPBACK,
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('403s an off-box caller — the route is operator-gated like every admin route', async () => {
        setup();
        const r = makeReqRes(
            'POST',
            '/api/settings/batch',
            { changes: [] },
            {},
            { remoteAddress: '192.168.1.50' },
        );
        await new SettingsBatchApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual({ error: 'admin actions are limited to this machine' });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/settingsBatchApi.test.ts`
Expected: FAIL — `Cannot find module '../api/SettingsBatchApi'`.

- [ ] **Step 3: Write the handler**

Create `src/server/api/SettingsBatchApi.ts`. Read `src/server/api/ConfigApi.ts` first and mirror its shape — same `handle(req, res): Promise<boolean>` contract, same `readBodyCapped` usage, same `res.writeHead(...)` style.

```ts
import type { IncomingMessage, ServerResponse } from 'http';
import type { Change } from '../db/PendingSettingsStore';
import { resolveUserId } from '../auth/currentUser';
import { requireOperator } from '../auth/requireOperator';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { BodyTooLargeError, readBodyCapped } from './utils';

const log = Logger.for('SettingsBatchApi');

/**
 * The change ids a batch may carry.
 *
 * An allowlist, not a denylist: an id absent here is refused outright rather
 * than passed to a writer that might accept it. Actions (install service,
 * delete user, dependency install) are deliberately NOT here -- they fire UAC,
 * destroy data, or carry their own confirmations, and a summary screen that
 * implied Save would perform them would be lying.
 */
export const STAGEABLE_IDS: ReadonlySet<string> = new Set([
    'webPort',
    'channel',
    'autoUpdate',
    'updateCheckIntervalMinutes',
]);

/**
 * `webPort` LAST, always.
 *
 * It is the only change that ends the process: restartRequired -> exit 75 ->
 * the supervisor restarts on the new port. Anything applied after it can be
 * lost, so making it terminal is what guarantees nothing is stranded.
 */
export function orderChanges(changes: Change[]): Change[] {
    return [...changes.filter((c) => c.id !== 'webPort'), ...changes.filter((c) => c.id === 'webPort')];
}

export class SettingsBatchApi {
    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (req.url !== '/api/settings/batch' || req.method !== 'POST') return false;
        if (!requireOperator(req, res)) return true;

        let changes: Change[];
        try {
            const parsed = JSON.parse(await readBodyCapped(req)) as { changes?: Change[] };
            changes = parsed.changes ?? [];
        } catch (err) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'body too large' }));
                return true;
            }
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed body' }));
            return true;
        }

        const unknown = changes.find((c) => !STAGEABLE_IDS.has(c.id));
        if (unknown) {
            // Refuse BEFORE writing the WAL row: a rejected batch should leave
            // no trace to reason about later.
            log.warn(`refusing batch containing non-stageable id ${unknown.id}`);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `not a stageable setting: ${unknown.id}` }));
            return true;
        }

        const cfg = Config.getInstance();
        const batchId = cfg.db.pendingSettings.create(resolveUserId(req), changes);
        const ordered = orderChanges(changes);
        const applied: string[] = [];

        for (const change of ordered) {
            if (change.id === 'webPort') {
                // Mark completed BEFORE the change that ends the process. After
                // this apply we may never get another instruction in; a stale
                // 'completed' is inert, whereas a stale 'pending' would be
                // re-applied at the next boot.
                cfg.db.pendingSettings.markCompleted(batchId);
                const result = cfg.updateAppConfig({ webPort: change.to as number });
                applied.push(change.id);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        ok: true,
                        applied,
                        restartRequired: result.restartRequired,
                        redirectPort: result.restartRequired ? result.config.webPort : undefined,
                    }),
                );
                return true;
            }
            try {
                cfg.updateAppConfig({ [change.id]: change.to } as never);
                applied.push(change.id);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                cfg.db.pendingSettings.markFailed(batchId, `${change.id}: ${message}`);
                log.warn(`batch ${batchId} failed at ${change.id}: ${message}`);
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, applied, failed: { id: change.id, error: message } }));
                return true;
            }
        }

        cfg.db.pendingSettings.markCompleted(batchId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied }));
        return true;
    }
}
```

- [ ] **Step 4: Register the handler**

In `src/server/index.ts`, beside `const settingsApi = new SettingsApi();` (near line 171):

```ts
    const settingsBatchApi = new SettingsBatchApi();
    HttpServer.addApiHandler(settingsBatchApi);
```

Add the import alongside the other API imports at the top of the file.

- [ ] **Step 5: Run tests and lint**

Run: `npx vitest run src/server/__tests__/settingsBatchApi.test.ts` → PASS, 6 tests.
Run: `npm test` → PASS.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/SettingsBatchApi.ts src/server/__tests__/settingsBatchApi.test.ts src/server/index.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(api): POST /api/settings/batch applies a staged batch with webPort last"
```

---

### Task 3: Abandon a stranded batch at boot

**Files:**
- Modify: `src/server/index.ts` (boot sequence, after `Config.getInstance()` is available)
- Modify: `src/server/__tests__/settingsBatchApi.test.ts` (extend)
- Create: `src/server/db/reconcilePendingSettings.ts`

**Interfaces:**
- Consumes: `PendingSettingsStore` (Task 1).
- Produces: `export function reconcilePendingSettings(db: Db, retentionDays?: number): { abandoned: number; pruned: number }`

- [ ] **Step 1: Write the failing test**

Append to `src/server/__tests__/settingsBatchApi.test.ts`:

```ts
import { reconcilePendingSettings } from '../db/reconcilePendingSettings';

describe('reconcilePendingSettings', () => {
    it('abandons a pending row rather than re-applying it', () => {
        setup();
        const db = Config.getInstance().db;
        db.pendingSettings.create(1, [{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }]);

        const result = reconcilePendingSettings(db);

        expect(result.abandoned).toBe(1);
        expect(db.pendingSettings.getPending()).toHaveLength(0);
        // The port was NOT changed -- silently applying settings a user may not
        // remember confirming is worse than losing them.
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
    });

    it('reports nothing to do on a clean boot', () => {
        setup();
        expect(reconcilePendingSettings(Config.getInstance().db)).toEqual({ abandoned: 0, pruned: 0 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/settingsBatchApi.test.ts`
Expected: FAIL — `Cannot find module '../db/reconcilePendingSettings'`.

- [ ] **Step 3: Write it**

Create `src/server/db/reconcilePendingSettings.ts`:

```ts
import type { Db } from './Db';
import { Logger } from '../Logger';

const log = Logger.for('PendingSettings');
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Boot-time reconciliation of the staged-settings write-ahead log.
 *
 * A row still `pending` means a previous instance died mid-batch. We mark it
 * ABANDONED and never re-apply it: silently applying settings a user may not
 * remember confirming is worse than losing them, and the durable row still
 * explains what happened.
 *
 * Finished rows older than the retention window are pruned so the table stays
 * bounded on a long-lived install.
 */
export function reconcilePendingSettings(
    db: Db,
    retentionDays: number = DEFAULT_RETENTION_DAYS,
): { abandoned: number; pruned: number } {
    const stranded = db.pendingSettings.getPending();
    for (const row of stranded) {
        log.warn(
            `batch ${row.id} was still pending at boot (${row.changes.length} change(s)); ` +
                'marking abandoned and NOT applying it',
        );
        db.pendingSettings.markAbandoned(row.id);
    }
    const pruned = db.pendingSettings.pruneOlderThan(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    return { abandoned: stranded.length, pruned };
}
```

- [ ] **Step 4: Call it at boot**

In `src/server/index.ts`, after the config/db singleton is available and before the API handlers are registered:

```ts
    reconcilePendingSettings(config.db);
```

Read the surrounding lines to find the variable actually holding the config instance and match it.

- [ ] **Step 5: Run tests and lint**

Run: `npx vitest run src/server/__tests__/settingsBatchApi.test.ts` → PASS, 8 tests.
Run: `npm test` → PASS.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/db/reconcilePendingSettings.ts src/server/__tests__/settingsBatchApi.test.ts src/server/index.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(db): abandon a stranded settings batch at boot, never re-apply it"
```

---

### Task 4: `StagedSettingsStore`

**Files:**
- Create: `src/app/client/settings/StagedSettingsStore.ts`
- Create: `src/app/client/settings/__tests__/stagedSettingsStore.test.ts`

**Interfaces:**
- Consumes: `Change` — re-declared client-side to avoid importing a server module into the bundle.
- Produces:
  - `export interface StagedField { id: string; label: string; initial: unknown; format?(v: unknown): string }`
  - `export interface Change { id: string; label: string; from: unknown; to: unknown }`
  - `export class StagedSettingsStore` with `register(f: StagedField): void`, `set(id: string, value: unknown): void`, `get(id: string): unknown`, `isDirty(): boolean`, `changes(): Change[]`, `reset(): void`, `clear(): void`

- [ ] **Step 1: Write the failing test**

Create `src/app/client/settings/__tests__/stagedSettingsStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';

let store: StagedSettingsStore;

beforeEach(() => {
    store = new StagedSettingsStore();
    store.register({ id: 'webPort', label: 'Web port', initial: 8000 });
    store.register({ id: 'channel', label: 'Update channel', initial: 'stable' });
});

describe('StagedSettingsStore', () => {
    it('is clean before anything is edited', () => {
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
    });

    it('reports a change as from → to once edited', () => {
        store.set('webPort', 8010);
        expect(store.isDirty()).toBe(true);
        expect(store.changes()).toEqual([{ id: 'webPort', label: 'Web port', from: 8000, to: 8010 }]);
    });

    it('setting a value back to its initial clears the change', () => {
        store.set('webPort', 8010);
        store.set('webPort', 8000);
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
    });

    it('never reports a field nobody registered — this is what keeps ACTIONS out of the summary', () => {
        store.set('installService', true);
        expect(store.changes().map((c) => c.id)).toEqual([]);
        expect(store.isDirty()).toBe(false);
    });

    it('reset() restores every field to its initial', () => {
        store.set('webPort', 8010);
        store.set('channel', 'beta');
        store.reset();
        expect(store.isDirty()).toBe(false);
        expect(store.get('webPort')).toBe(8000);
    });

    it('applies format() to both sides of the summary when one is given', () => {
        store.register({
            id: 'autoUpdate',
            label: 'Automatic updates',
            initial: true,
            format: (v) => (v ? 'on' : 'off'),
        });
        store.set('autoUpdate', false);
        expect(store.changes()).toContainEqual({
            id: 'autoUpdate',
            label: 'Automatic updates',
            from: 'on',
            to: 'off',
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/settings/__tests__/stagedSettingsStore.test.ts`
Expected: FAIL — cannot resolve `../StagedSettingsStore`.

- [ ] **Step 3: Write it**

Create `src/app/client/settings/StagedSettingsStore.ts`:

```ts
/** One staged edit, exactly as the summary renders it and the batch applies it. */
export interface Change {
    id: string;
    label: string;
    from: unknown;
    to: unknown;
}

export interface StagedField {
    id: string;
    label: string;
    initial: unknown;
    /** Render a value for the summary — e.g. true -> "on". Identity when absent. */
    format?(v: unknown): string;
}

/**
 * Dirty state and the change list for the Settings dialog. No DOM, no network.
 *
 * The critical property is what it does NOT do: a field nobody registered can
 * never appear in `changes()`. Action-only tabs (Service, Users, Embedding)
 * register nothing, so "actions must not appear in the summary" is structural
 * rather than a rule someone has to remember -- and a future action cannot leak
 * into the summary by oversight.
 */
export class StagedSettingsStore {
    private fields = new Map<string, StagedField>();
    private values = new Map<string, unknown>();

    register(field: StagedField): void {
        this.fields.set(field.id, field);
        this.values.set(field.id, field.initial);
    }

    set(id: string, value: unknown): void {
        // Silently ignored for an unregistered id: see the class comment.
        if (!this.fields.has(id)) return;
        this.values.set(id, value);
    }

    get(id: string): unknown {
        return this.values.get(id);
    }

    isDirty(): boolean {
        return this.changes().length > 0;
    }

    changes(): Change[] {
        const out: Change[] = [];
        for (const [id, field] of this.fields) {
            const current = this.values.get(id);
            if (Object.is(current, field.initial)) continue;
            const render = field.format ?? ((v: unknown): unknown => v);
            out.push({ id, label: field.label, from: render(field.initial), to: render(current) });
        }
        return out;
    }

    reset(): void {
        for (const [id, field] of this.fields) this.values.set(id, field.initial);
    }

    clear(): void {
        this.fields.clear();
        this.values.clear();
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/client/settings/__tests__/stagedSettingsStore.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/settings
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): StagedSettingsStore — dirty tracking and the change list"
```

---

### Task 5: The summary modal and `SaveRunner`

**Files:**
- Create: `src/app/client/settings/SettingsSummaryModal.ts`
- Create: `src/app/client/settings/SaveRunner.ts`
- Create: `src/app/client/settings/__tests__/settingsSummaryModal.test.ts`

**Interfaces:**
- Consumes: `Change` (Task 4), `Modal` (`src/app/ui/Modal.ts`).
- Produces:
  - `export class SettingsSummaryModal` with `static confirm(changes: Change[]): Promise<boolean>`
  - `export interface BatchResult { ok: boolean; applied: string[]; failed?: { id: string; error: string }; restartRequired?: boolean; redirectPort?: number }`
  - `export async function runSave(changes: Change[]): Promise<BatchResult>`

- [ ] **Step 1: Write the failing test**

Create `src/app/client/settings/__tests__/settingsSummaryModal.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSummaryModal } from '../SettingsSummaryModal';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        if (this.hasAttribute('open')) {
            throw new DOMException('already open', 'InvalidStateError');
        }
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    document.body.replaceChildren();
});

const CHANGES = [
    { id: 'channel', label: 'Update channel', from: 'stable', to: 'beta' },
    { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
];

function button(label: string): HTMLButtonElement {
    const found = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
    expect(found, `button "${label}"`).toBeTruthy();
    return found as HTMLButtonElement;
}

describe('SettingsSummaryModal', () => {
    it('lists every change as label: from → to', () => {
        void SettingsSummaryModal.confirm(CHANGES);
        const text = document.querySelector('dialog')?.textContent ?? '';
        expect(text).toContain('Update channel');
        expect(text).toContain('stable');
        expect(text).toContain('beta');
    });

    it('warns that a webPort change restarts the server', () => {
        void SettingsSummaryModal.confirm(CHANGES);
        expect(document.querySelector('dialog')?.textContent).toContain('restart');
    });

    it('does NOT warn about a restart when the port did not change', () => {
        void SettingsSummaryModal.confirm([CHANGES[0]!]);
        expect(document.querySelector('dialog')?.textContent).not.toContain('restart');
    });

    it('resolves true only via Save', async () => {
        const p = SettingsSummaryModal.confirm(CHANGES);
        button('Save').click();
        await expect(p).resolves.toBe(true);
    });

    it('resolves false on Cancel', async () => {
        const p = SettingsSummaryModal.confirm(CHANGES);
        button('Cancel').click();
        await expect(p).resolves.toBe(false);
    });

    it('does not call showModal twice — the AdminConfirmModal trap', () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        void SettingsSummaryModal.confirm(CHANGES);
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/settings/__tests__/settingsSummaryModal.test.ts`
Expected: FAIL — cannot resolve `../SettingsSummaryModal`.

- [ ] **Step 3: Write the modal**

Read `src/app/client/RemoteAdminWarningModal.ts` first — it is the closest existing example and already handles the double-`showModal()` trap correctly.

Create `src/app/client/settings/SettingsSummaryModal.ts`:

```ts
import type { Change } from './StagedSettingsStore';
import { Modal } from '../../ui/Modal';

/**
 * The change summary shown before a staged batch is applied.
 *
 * Renders straight from `store.changes()`, so it cannot disagree with what will
 * actually be sent. Every node is built with createElement/textContent, never
 * innerHTML -- the values are user- and server-supplied.
 */
export class SettingsSummaryModal extends Modal {
    private resolveFn: ((v: boolean) => void) | null = null;
    private resolved = false;
    private readonly changes: Change[];

    public static confirm(changes: Change[]): Promise<boolean> {
        return new Promise((resolve) => {
            // The base Modal constructor already appends the dialog AND calls
            // showModal(). Doing either again throws InvalidStateError, which
            // rejects this promise and silently breaks the buttons while leaving
            // the dialog visible (AdminConfirmModal.ts:25-41).
            new SettingsSummaryModal(changes, resolve);
        });
    }

    private constructor(changes: Change[], resolve: (v: boolean) => void) {
        super({ title: 'Review changes' });
        this.changes = changes;
        this.resolveFn = resolve;
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // Rendered by fillBody() via queueMicrotask: the base constructor runs
        // before this subclass's fields exist.
    }

    private fillBody(container: HTMLElement): void {
        const list = document.createElement('ul');
        list.className = 'settings-summary__list';
        for (const c of this.changes) {
            const li = document.createElement('li');
            li.textContent = `${c.label}: ${String(c.from)} → ${String(c.to)}`;
            list.appendChild(li);
        }
        container.appendChild(list);

        if (this.changes.some((c) => c.id === 'webPort')) {
            const warning = document.createElement('p');
            warning.className = 'settings-summary__restart';
            warning.textContent =
                'Changing the web port will restart the server. This page will reload on the new port ' +
                'automatically — the app is not crashing.';
            container.appendChild(warning);
        }
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'modal-button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancel);

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'modal-button';
        save.textContent = 'Save';
        save.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(save);

        return footer;
    }

    protected override onEscapeKey(): void {
        this.resolveAndClose(false);
    }

    protected override onBackdropClick(): void {
        this.resolveAndClose(false);
    }

    protected override onCloseButtonClick(): void {
        this.resolveAndClose(false);
    }

    private resolveAndClose(value: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.resolveFn = null;
        this.close(value);
    }
}
```

- [ ] **Step 4: Write `SaveRunner`**

Create `src/app/client/settings/SaveRunner.ts`:

```ts
import type { Change } from './StagedSettingsStore';

export interface BatchResult {
    ok: boolean;
    applied: string[];
    failed?: { id: string; error: string };
    restartRequired?: boolean;
    redirectPort?: number;
}

/**
 * Send a staged batch. A thin client over ONE endpoint by design.
 *
 * Ordering, the write-ahead log and the apply sequence all live server-side
 * (SettingsBatchApi). Doing them here would put the "webPort last" guarantee in
 * browser JavaScript and spread the WAL transitions across separate round
 * trips, which makes the mark-completed-before-restart rule a race rather than
 * a fact.
 */
export async function runSave(changes: Change[]): Promise<BatchResult> {
    try {
        const res = await fetch('/api/settings/batch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ changes }),
        });
        return (await res.json()) as BatchResult;
    } catch {
        return { ok: false, applied: [], failed: { id: '', error: "couldn't reach server" } };
    }
}
```

- [ ] **Step 5: Run tests and lint**

Run: `npx vitest run src/app/client/settings/__tests__/settingsSummaryModal.test.ts` → PASS, 6 tests.
Run: `npm test` → PASS.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/settings
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): change-summary modal and the batch SaveRunner"
```

---

### Task 6: The tab shell

**Files:**
- Modify: `src/app/client/SettingsModal.ts` (`fillBody`, near `:621`)
- Create: `src/app/client/settings/TabStrip.ts`
- Create: `src/app/client/settings/__tests__/tabStrip.test.ts`
- Modify: `src/style/modal.css` (tab chrome)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface TabDef { id: string; label: string; build(): HTMLElement }`
  - `export class TabStrip` with `constructor(tabs: TabDef[])`, `getElement(): HTMLElement`, `getPanel(): HTMLElement`, `activate(id: string): void`, `activeId(): string`

**This task adds the shell only — sections stay where they are and are wrapped as single-tab content. Tasks 7–9 move them.** Splitting it this way means the shell's behaviour is reviewable before 2,000 lines move around it.

- [ ] **Step 1: Write the failing test**

Create `src/app/client/settings/__tests__/tabStrip.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { TabStrip } from '../TabStrip';

function makeTabs() {
    return [
        { id: 'a', label: 'Alpha', build: () => { const d = document.createElement('div'); d.textContent = 'A body'; return d; } },
        { id: 'b', label: 'Beta', build: () => { const d = document.createElement('div'); d.textContent = 'B body'; return d; } },
    ];
}

describe('TabStrip', () => {
    it('renders one button per tab and activates the first', () => {
        const strip = new TabStrip(makeTabs());
        const labels = [...strip.getElement().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).toEqual(['Alpha', 'Beta']);
        expect(strip.activeId()).toBe('a');
        expect(strip.getPanel().textContent).toContain('A body');
    });

    it('switching tabs swaps the panel', () => {
        const strip = new TabStrip(makeTabs());
        strip.activate('b');
        expect(strip.activeId()).toBe('b');
        expect(strip.getPanel().textContent).toContain('B body');
    });

    it('builds each tab body only once, so edits survive a round trip', () => {
        let builds = 0;
        const strip = new TabStrip([
            { id: 'a', label: 'Alpha', build: () => { builds++; return document.createElement('div'); } },
            { id: 'b', label: 'Beta', build: () => document.createElement('div') },
        ]);
        strip.activate('b');
        strip.activate('a');
        expect(builds).toBe(1);
    });

    it('marks the active button so CSS can style it', () => {
        const strip = new TabStrip(makeTabs());
        strip.activate('b');
        const active = [...strip.getElement().querySelectorAll('button')].filter(
            (b) => b.getAttribute('aria-selected') === 'true',
        );
        expect(active.map((b) => b.textContent)).toEqual(['Beta']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/settings/__tests__/tabStrip.test.ts`
Expected: FAIL — cannot resolve `../TabStrip`.

- [ ] **Step 3: Write `TabStrip`**

Create `src/app/client/settings/TabStrip.ts`:

```ts
export interface TabDef {
    id: string;
    label: string;
    build(): HTMLElement;
}

/**
 * The Settings tab strip and its panel.
 *
 * Each tab body is built ONCE and cached, so switching tabs preserves in-progress
 * edits without the store having to re-hydrate the DOM. Switching tabs never
 * prompts: prompting between tabs of a single dialog is hostile and trains
 * people to click through.
 *
 * Building is synchronous by design -- `SettingsModal.fillBody` must render
 * without awaiting the /api/config probe, or a hung probe leaves a permanently
 * empty dialog (a test pins this).
 */
export class TabStrip {
    private readonly strip: HTMLElement;
    private readonly panel: HTMLElement;
    private readonly built = new Map<string, HTMLElement>();
    private readonly buttons = new Map<string, HTMLButtonElement>();
    private active = '';

    constructor(private readonly tabs: TabDef[]) {
        this.strip = document.createElement('div');
        this.strip.className = 'settings-tabs';
        this.strip.setAttribute('role', 'tablist');
        this.panel = document.createElement('div');
        this.panel.className = 'settings-tab-panel';

        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-tab';
            btn.textContent = tab.label;
            btn.setAttribute('role', 'tab');
            btn.addEventListener('click', () => this.activate(tab.id));
            this.buttons.set(tab.id, btn);
            this.strip.appendChild(btn);
        }

        if (tabs.length > 0) this.activate(tabs[0]!.id);
    }

    getElement(): HTMLElement {
        return this.strip;
    }

    getPanel(): HTMLElement {
        return this.panel;
    }

    activeId(): string {
        return this.active;
    }

    activate(id: string): void {
        const tab = this.tabs.find((t) => t.id === id);
        if (!tab) return;
        this.active = id;
        let body = this.built.get(id);
        if (!body) {
            body = tab.build();
            this.built.set(id, body);
        }
        this.panel.replaceChildren(body);
        for (const [tabId, btn] of this.buttons) {
            btn.setAttribute('aria-selected', tabId === id ? 'true' : 'false');
            btn.classList.toggle('settings-tab--active', tabId === id);
        }
    }
}
```

- [ ] **Step 4: Mount it in `fillBody`**

In `src/app/client/SettingsModal.ts`, change `fillBody` so it appends the strip and panel instead of appending each section directly. Each existing `buildXSection()` becomes a `TabDef`:

```ts
        const strip = new TabStrip([
            { id: 'updates', label: 'Updates', build: () => this.buildUpdatesSection() },
            { id: 'service', label: 'Service', build: () => this.buildServiceSection() },
            { id: 'server', label: 'Server', build: () => this.buildServerSection() },
            { id: 'users', label: 'Users', build: () => this.buildUsersSection() },
            { id: 'embedding', label: 'Embedding', build: () => this.buildEmbedOriginsSection() },
        ]);
        container.append(strip.getElement(), strip.getPanel());
```

**Keep the existing `canSeeSection` guards** — filter the array before constructing the strip, so a non-admin sees no tab rather than an empty one. Do NOT await the probe here.

- [ ] **Step 5: Style the strip**

In `src/style/modal.css`, add `.settings-tabs`, `.settings-tab`, `.settings-tab--active` and `.settings-tab-panel`. Use the existing theme variables (see `reference_ws_scrcpy_theme_vars`); do not hard-code colours.

- [ ] **Step 6: Run tests, build and lint**

Run: `npx vitest run src/app/client/settings/__tests__/tabStrip.test.ts` → PASS, 4 tests.
Run: `npx vitest run src/app/client/__tests__/SettingsModal.test.ts` → PASS. **The never-resolving-fetch test must still pass** — if it does not, `fillBody` is awaiting the probe.
Run: `npm run build:dev` → succeeds.
Run: `npm test` → PASS.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client src/style
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): tab strip and panel; sections become tabs"
```

---

### Task 7: Extract the action-only tabs

**Files:**
- Create: `src/app/client/settings/tabs/EmbeddingTab.ts`, `tabs/UsersTab.ts`, `tabs/ServiceTab.ts`
- Create: `src/app/client/settings/__tests__/actionTabs.test.ts`
- Modify: `src/app/client/SettingsModal.ts` (delete the moved methods, import the tabs)
- Modify: `src/app/client/__tests__/SettingsModal.test.ts` (import paths for moved helpers)

**Interfaces:**
- Consumes: `TabDef` (Task 6), `StagedSettingsStore` (Task 4).
- Produces: `export function buildEmbeddingTab(ctx: TabContext): HTMLElement` and the same for `Users` and `Service`; `export interface TabContext { role: Role | null; authEnabled: boolean; docker: boolean; reload(): void }`

**These three register NOTHING with the store.** They are actions, and that absence is the mechanism keeping them out of the summary. Do not add fields here.

**⚠️ This is a ~700-line move, and a move is exactly where a silent behaviour change hides.** The characterization tests in Step 0 exist because the rest of this task has no new assertions of its own — they pin the properties that must survive the move, and they are written FIRST so they fail if a tab module does not exist yet and keep passing after each extraction.

- [ ] **Step 0: Write the characterization tests BEFORE moving anything**

Create `src/app/client/settings/__tests__/actionTabs.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildEmbeddingTab } from '../tabs/EmbeddingTab';
import { buildServiceTab } from '../tabs/ServiceTab';
import { buildUsersTab } from '../tabs/UsersTab';

function ctx(role: 'admin' | 'user' = 'admin') {
    return { role, authEnabled: false, docker: false, reload: () => undefined };
}

// A never-resolving fetch: these tabs refresh asynchronously, and the point of
// every test here is that the BODY renders regardless. Same discipline as
// SettingsModal's own probe test.
function stubHangingFetch(): void {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
}

describe('action-only tabs register nothing', () => {
    // THE structural guarantee of this design. If any of these ever fails, an
    // action has become stageable and can reach the change summary -- which
    // would make Save claim it is about to install a service or delete a user.
    it.each([
        ['Embedding', buildEmbeddingTab],
        ['Users', buildUsersTab],
        ['Service', buildServiceTab],
    ])('%s contributes no staged fields', (_name, build) => {
        stubHangingFetch();
        const store = new StagedSettingsStore();
        build(ctx(), store);
        expect(store.isDirty()).toBe(false);
        expect(store.changes()).toEqual([]);
        vi.unstubAllGlobals();
    });
});

describe('action-only tabs render without waiting on the network', () => {
    it.each([
        ['Embedding', buildEmbeddingTab],
        ['Users', buildUsersTab],
        ['Service', buildServiceTab],
    ])('%s builds a non-empty body while fetch hangs', (_name, build) => {
        stubHangingFetch();
        const el = build(ctx(), new StagedSettingsStore());
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.childElementCount).toBeGreaterThan(0);
        vi.unstubAllGlobals();
    });
});

describe('the controls that must survive the move', () => {
    it('Users still offers a way to add a user', () => {
        stubHangingFetch();
        const el = buildUsersTab(ctx(), new StagedSettingsStore());
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
        expect(labels.some((l) => /add|create/i.test(l))).toBe(true);
        vi.unstubAllGlobals();
    });

    it('Service still offers install and uninstall controls', () => {
        stubHangingFetch();
        const el = buildServiceTab(ctx(), new StagedSettingsStore());
        const text = el.textContent ?? '';
        expect(/install/i.test(text)).toBe(true);
        expect(/uninstall/i.test(text)).toBe(true);
        vi.unstubAllGlobals();
    });

    it('Embedding still offers a way to add an origin', () => {
        stubHangingFetch();
        const el = buildEmbeddingTab(ctx(), new StagedSettingsStore());
        const text = el.textContent ?? '';
        expect(/origin|embed/i.test(text)).toBe(true);
        vi.unstubAllGlobals();
    });
});

describe('role gating survives the move', () => {
    it('a non-admin gets no user-management controls', () => {
        stubHangingFetch();
        const el = buildUsersTab(ctx('user'), new StagedSettingsStore());
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent ?? '');
        expect(labels.some((l) => /delete|remove/i.test(l))).toBe(false);
        vi.unstubAllGlobals();
    });
});
```

**All three builders take `(ctx, store)`** even though these tabs ignore the store — a uniform signature is what lets the "registers nothing" test be written once as a table, and what stops a future author wondering whether this tab is allowed to stage.

- [ ] **Step 0b: Run the tests to verify they fail**

Run: `npx vitest run src/app/client/settings/__tests__/actionTabs.test.ts`
Expected: FAIL — cannot resolve `../tabs/EmbeddingTab`. All three modules are missing; they appear one at a time across the steps below.

- [ ] **Step 1: Move `EmbeddingTab`**

Move `buildEmbedOriginsSection` (`:723`) and `refreshEmbedOrigins` (`:731`) into `tabs/EmbeddingTab.ts`, converting `this.` references into `ctx.` ones. Move any exported helper used only by this section with it.

- [ ] **Step 2: Run the suite**

Run: `npm test`
Expected: PASS. Fix any import path the move broke; do not weaken an assertion to make it pass.

- [ ] **Step 3: Move `UsersTab`**

Same for `buildUsersSection` (`:806`).

- [ ] **Step 4: Run the suite**

Run: `npm test` → PASS.

- [ ] **Step 5: Move `ServiceTab`**

Same for `buildServiceSection` (`:1728`) and `refreshService` (`:1739`), plus the service-only exported helpers (`scopeRadioState`, `systemServiceInstallGate`, `applySystemInstallGate`, `lockScopeRadioControl`, `buildServiceInfoRow`, `buildInstallAllUsersControl`, `buildUninstallControl`, `classifyInstallPoll`, `uninstallFollowupMessage`).

- [ ] **Step 6: Run everything, including the characterization suite**

Run: `npx vitest run src/app/client/settings/__tests__/actionTabs.test.ts` → PASS, 9 tests. All three modules now exist, so every table row resolves.
Run: `npm test` → PASS.
Run: `npm run build:dev` → succeeds.
Run: `npm run lint > /dev/null; echo $?` → `0`

**If a characterization test fails here, the move changed behaviour — fix the move, not the test.** The one exception is a control whose label genuinely differs from the regex; widen the regex only after reading the moved code and confirming the control is really there.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "refactor(settings): extract the action-only tabs (Embedding, Users, Service)"
```

---

### Task 8: The Server tab, with `webPort` staged

**Files:**
- Create: `src/app/client/settings/tabs/ServerTab.ts`
- Modify: `src/app/client/SettingsModal.ts`
- Create: `src/app/client/settings/__tests__/serverTab.test.ts`

**Interfaces:**
- Consumes: `StagedSettingsStore` (Task 4), `TabContext` (Task 7).
- Produces: `export function buildServerTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement`

- [ ] **Step 1: Write the failing test**

Create `src/app/client/settings/__tests__/serverTab.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildServerTab } from '../tabs/ServerTab';

const ctx = { role: 'admin' as const, authEnabled: false, docker: false, reload: () => undefined };

describe('ServerTab', () => {
    it('registers webPort so it can be staged', () => {
        const store = new StagedSettingsStore();
        buildServerTab(ctx, store);
        expect(store.get('webPort')).toBeDefined();
    });

    it('typing a new port stages it instead of saving immediately', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.changes().map((c) => c.id)).toContain('webPort');
    });

    it('has no per-field Save button — Save lives on the dialog now', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const labels = [...el.querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).not.toContain('Save');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/settings/__tests__/serverTab.test.ts`
Expected: FAIL — cannot resolve `../tabs/ServerTab`.

- [ ] **Step 3: Move and convert**

Move `buildServerSection` (`:881`) and `refreshServer` (`:1182`) into `tabs/ServerTab.ts`. Then:
- Register the port field: `store.register({ id: 'webPort', label: 'Web port', initial: currentWebPort })`
- Replace the input's save handler with `store.set('webPort', Number(input.value))`
- **Delete the per-field Save button and its `PATCH /api/config` call** (`:1226-1257`) — the batch endpoint owns that now, including the `restartRequired` / `redirectPort` response.
- Keep the "stop server & exit" control and the reset control exactly as they are. **They are actions.**

- [ ] **Step 4: Run tests and lint**

Run: `npx vitest run src/app/client/settings/__tests__/serverTab.test.ts` → PASS, 3 tests.
Run: `npm test` → PASS. `configApi.redirectPort.test.ts` asserts the OLD per-field save; update it to drive the batch endpoint instead, keeping the redirect assertion.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client src/server
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): Server tab stages webPort instead of saving per-field"
```

---

### Task 9: The Updates tab — a real behaviour change

**Files:**
- Create: `src/app/client/settings/tabs/UpdatesTab.ts`
- Modify: `src/app/client/SettingsModal.ts`
- Create: `src/app/client/settings/__tests__/updatesTab.test.ts`

**Interfaces:**
- Consumes: `StagedSettingsStore`, `TabContext`.
- Produces: `export function buildUpdatesTab(ctx: TabContext, store: StagedSettingsStore): HTMLElement`

**⚠️ This changes behaviour users can see.** Today `patchUpdatesConfig()` (`:1538`) fires on **every** toggle. After this, a user who flips auto-update and closes without saving gets **no** change, where today they would have gotten one. That is the intended new model, but existing tests assert the old one and must be updated deliberately, not silenced.

- [ ] **Step 1: Write the failing test**

Create `src/app/client/settings/__tests__/updatesTab.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { buildUpdatesTab } from '../tabs/UpdatesTab';

const ctx = { role: 'admin' as const, authEnabled: false, docker: false, reload: () => undefined };

describe('UpdatesTab', () => {
    it('toggling auto-update stages it and sends NOTHING', () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const store = new StagedSettingsStore();
        const el = buildUpdatesTab(ctx, store);

        const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes().map((c) => c.id)).toContain('autoUpdate');
        const patched = fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
        expect(patched).toBe(false);
        vi.unstubAllGlobals();
    });

    it('the "check now" button is still an ACTION and is not staged', () => {
        const store = new StagedSettingsStore();
        const el = buildUpdatesTab(ctx, store);
        const check = [...el.querySelectorAll('button')].find((b) => /check/i.test(b.textContent ?? ''));
        expect(check).toBeTruthy();
        check?.click();
        expect(store.changes().map((c) => c.id)).not.toContain('checkNow');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/settings/__tests__/updatesTab.test.ts`
Expected: FAIL — cannot resolve `../tabs/UpdatesTab`.

- [ ] **Step 3: Move and convert**

Move `buildUpdatesSection` (`:1270`) and `refreshUpdates` (`:1281`) into `tabs/UpdatesTab.ts`. Then:
- Register the three fields:

```ts
store.register({ id: 'channel', label: 'Update channel', initial: cfg.channel });
store.register({ id: 'autoUpdate', label: 'Automatic updates', initial: cfg.autoUpdate,
                 format: (v) => (v ? 'on' : 'off') });
store.register({ id: 'updateCheckIntervalMinutes', label: 'Check interval (minutes)',
                 initial: cfg.updateCheckIntervalMinutes });
```

- Replace every `void this.patchUpdatesConfig({...})` call with the matching `store.set(...)`.
- **Delete `patchUpdatesConfig` entirely.** The batch endpoint owns these writes now.
- Keep "check for updates now" and "install update" as actions, unchanged and unregistered.

- [ ] **Step 4: Update the tests that asserted the old model**

`UpdatesApi.test.ts` covers the server endpoint and is unaffected. Any **client** test asserting a PATCH on toggle must be rewritten to assert staging. Do not delete the coverage — move it.

- [ ] **Step 5: Run tests, build and lint**

Run: `npx vitest run src/app/client/settings/__tests__/updatesTab.test.ts` → PASS, 2 tests.
Run: `npm test` → PASS.
Run: `npm run build:dev` → succeeds.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): Updates tab stages changes instead of saving on every toggle"
```

---

### Task 10: Wire Save, and the close-while-dirty prompt

**Files:**
- Modify: `src/app/client/SettingsModal.ts`
- Create: `src/app/client/settings/__tests__/settingsSave.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–9.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `src/app/client/settings/__tests__/settingsSave.test.ts`:

```ts
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { closeIntent } from '../closeIntent';

describe('closeIntent', () => {
    it('closes straight away when nothing is staged', () => {
        expect(closeIntent(new StagedSettingsStore())).toBe('close');
    });

    it('prompts when there are staged changes', () => {
        const store = new StagedSettingsStore();
        store.register({ id: 'channel', label: 'Channel', initial: 'stable' });
        store.set('channel', 'beta');
        expect(closeIntent(store)).toBe('prompt');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/settings/__tests__/settingsSave.test.ts`
Expected: FAIL — cannot resolve `../closeIntent`.

- [ ] **Step 3: Write `closeIntent`**

Create `src/app/client/settings/closeIntent.ts`:

```ts
import type { StagedSettingsStore } from './StagedSettingsStore';

/**
 * What closing the dialog should do.
 *
 * Deliberately a pure function of the store: the decision is testable without a
 * DOM, and the modal only has to act on the answer.
 */
export function closeIntent(store: StagedSettingsStore): 'close' | 'prompt' {
    return store.isDirty() ? 'prompt' : 'close';
}
```

- [ ] **Step 4: Wire Save and close in `SettingsModal`**

- Add a dialog-level **Save** button, enabled only when `store.isDirty()`.
- Save → `SettingsSummaryModal.confirm(store.changes())` → if true, `runSave(store.changes())`.
- On `ok`: if `restartRequired` and `redirectPort` is a number, keep the existing 4-second redirect via `sameOriginUrl(redirectPort)`. Otherwise close the dialog.
- On failure: leave the dialog open with the changes intact and show which change failed.
- Override the close paths so `closeIntent(store) === 'prompt'` raises a Save / Discard / Cancel choice, where **Cancel returns to the modal with changes intact**.

- [ ] **Step 5: Run everything**

Run: `npm test` → PASS.
Run: `npm run build:dev` → succeeds.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): dialog-level Save with summary confirm and a dirty-close prompt"
```

---

### Task 11: Dependencies tab and the home alert card

**Files:**
- Create: `src/app/client/settings/tabs/DependenciesTab.ts`
- Create: `src/app/client/DependencyAlertCard.ts`
- Create: `src/app/client/__tests__/dependencyAlertCard.test.ts`
- Modify: `src/app/index.ts` (drop the panel mount at `:406`, add the card)

**Interfaces:**
- Consumes: `DependencyPanel` (`src/app/client/DependencyPanel.ts`), `adminApiReachable` + `canSeeSection` (`src/app/client/adminGate.ts`), `FirstRunStatus`.
- Produces: `export class DependencyAlertCard` with `static create(runtime, role): Promise<DependencyAlertCard>`, `getElement(): HTMLElement`, `destroy(): void`

- [ ] **Step 1: Write the failing test**

Create `src/app/client/__tests__/dependencyAlertCard.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyAlertCard } from '../DependencyAlertCard';

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('DependencyAlertCard', () => {
    it('makes no request when the admin API will not answer this caller', async () => {
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: false }, 'admin');
        expect(fetch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(120_000);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('makes no request for a role that may not see dependencies', async () => {
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'user');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('polls for a loopback admin', async () => {
        await DependencyAlertCard.create({ adminScope: 'local', callerIsLocal: true }, 'admin');
        expect(fetch).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/__tests__/dependencyAlertCard.test.ts`
Expected: FAIL — cannot resolve `../DependencyAlertCard`.

- [ ] **Step 3: Write the card**

Create `src/app/client/DependencyAlertCard.ts`, modelled on `FirstRunBanner`. Build every node with `createElement`/`textContent`. The gate is **both** predicates:

```ts
    static async create(
        runtime: Pick<FirstRunStatus, 'adminScope' | 'callerIsLocal'>,
        role: Role | null,
    ): Promise<DependencyAlertCard> {
        const card = new DependencyAlertCard();
        // Two independent questions. `canSeeSection` asks whether this ROLE may
        // use the section; `adminApiReachable` asks whether the admin API will
        // answer THIS caller at all. GET /api/dependencies is gated at the top
        // of its handler, so failing either means mounting inert -- no fetch, no
        // interval. Polling anyway 403-spams a healthy app and renders an error
        // to a user who has done nothing wrong: finding 9.6.
        if (!canSeeSection(role, 'dependencies') || !adminApiReachable(runtime)) return card;
        await card.refresh();
        card.startPolling();
        return card;
    }
```

The card renders only when something needs updating, and its body links to the Dependencies tab.

- [ ] **Step 4: Move the panel into a tab**

Create `tabs/DependenciesTab.ts` wrapping the existing `DependencyPanel` unchanged, and add it to the `TabStrip` array in `SettingsModal` behind `canSeeSection(role, 'dependencies')`.

In `src/app/index.ts`, delete the `DependencyPanel.create()` mount at `:406` and mount `DependencyAlertCard` instead, passing the `runtime` already fetched by `runtimeFetch` and the resolved `role`. Add `dependencyAlertCard?.destroy()` to the `onPageTeardown` block.

- [ ] **Step 5: Run everything**

Run: `npx vitest run src/app/client/__tests__/dependencyAlertCard.test.ts` → PASS, 3 tests.
Run: `npm test` → PASS.
Run: `npm run build:dev` → succeeds.
Run: `npm run lint > /dev/null; echo $?` → `0`

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(settings): Dependencies tab; home page keeps an alert card only"
```

---

### Task 12: Docs, CHANGELOG and the release PR

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read what the docs currently claim**

Run: `grep -n "Settings\|webPort\|auto-update" README.md docs/TECHNICAL_GUIDE.md | head -40`

Read every hit. The claims to correct are any that describe Settings as one scrolling panel, or Updates as saving immediately.

- [ ] **Step 2: Document the new model**

Add a TECHNICAL_GUIDE section covering: the three layers, `POST /api/settings/batch`, the `pending_settings` WAL and its four statuses, why `webPort` is last, why `completed` is marked before the port PATCH, and why a `pending` row at boot is abandoned rather than applied.

README gets the short version: Settings is tabbed, changes are staged until Save, Save shows a summary first, and a port change restarts the server.

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]`:

```markdown
### Changed
- **Settings is now tabbed, and changes are staged until you press Save.** A summary lists every pending
  change as `setting: old → new` before anything is written. Switching tabs keeps your edits and never
  prompts; closing with unsaved changes asks whether to save, discard or go back.
- **Updates settings no longer save on every toggle.** Changing the channel, auto-update or the check
  interval now stages the change like every other setting — it takes effect when you press Save.
- **Dependencies moved into Settings.** The home page keeps a small alert card when something needs
  updating, linking to the new tab.

### Added
- Settings batches are recorded in the database before they are applied, so an interrupted save leaves a
  durable record instead of a half-applied guess. A batch that never finished is reported at the next
  start and deliberately not re-applied.
```

- [ ] **Step 4: Verify everything**

Run: `npm test` → PASS
Run: `npm run lint > /dev/null; echo $?` → `0`
Run: `npm run build` → succeeds

- [ ] **Step 5: Open the release PR**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add README.md docs/TECHNICAL_GUIDE.md CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs: tabbed settings, staged saves and the batch write-ahead log"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin <branch>
```

Open ONE PR labelled `release:beta`. Do not bump the version manually — auto-release cuts the bump PR.

- [ ] **Step 6: Close out item 127**

After the beta publishes and is verified (asset count + `:beta` digest match, RELEASING.md step 9): move item 127 to `archive/todo_ws_scrcpy_web_shipped.md`, drop the active count, and file the deferred **change-history UI** as its own item.

---

## Self-Review

**Spec coverage:** §3.1 store → Task 4. §3.2 SaveRunner → Task 5. §3.3 tab modules → Tasks 6–9, 11. §3.4 the probe constraint → Task 6 Step 4 + Step 6's regression check. §4.0 endpoint → Task 2. §4.1–4.3 ordering and failure → Task 2. §4.4 boot → Task 3. §4.5 rationale → carried in code comments. §4.6 mixed batches → allowed by construction in Task 2. §5 schema → Task 1. §6 dependencies → Task 11. §7 behaviour changes → Tasks 9 and 10. §8 error handling → Tasks 2, 3, 10. §9 testing → every task's test step. §10 out of scope → Task 12 Step 6 files the deferred item.

**Placeholder scan:** none. Three steps say "read the file first and follow its actual shape" — Task 1 Step 5 (`Db`'s constructor), Task 3 Step 4 (the config variable at boot), Task 7 Steps 1/3/5 (the section moves). Those are unread-file uncertainties with a named file and a stated thing to look for, not vague instructions.

**Type consistency:** `Change` is declared twice on purpose — server-side in Task 1, client-side in Task 4 — because importing a `node:sqlite` module into the browser bundle would be wrong. The shapes are identical and both are stated in full. `TabContext` is defined in Task 7 and consumed in Tasks 8, 9 and 11. `StagedSettingsStore`'s methods are used in Tasks 8–11 exactly as declared in Task 4. `BatchResult` is produced in Task 5 and consumed in Task 10.

**Task 7's risk is now covered.** It moves ~700 lines, which is exactly where a silent behaviour change hides, and it originally leaned entirely on the existing suite. It now opens with nine characterization tests written **before** the move (Step 0), pinning four properties: that all three tabs register nothing with the store (the structural guarantee that keeps actions out of the summary), that each renders a non-empty body while `fetch` hangs, that the install/uninstall/add-user/add-origin controls survive, and that role gating still hides destructive controls from a non-admin. They fail at Step 0b because no tab module exists yet, then go green module by module as each extraction lands.
