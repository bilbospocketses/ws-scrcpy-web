# SQLite Store Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the single SQLite store (`<dataRoot>/wsscrcpy.db`), its migration framework, the repository layer, and the one-time import of the legacy `config.json` + `device-labels.json` data — with **no user-visible behavior change**.

**Architecture:** A `Db` singleton opens the file with WAL + foreign-keys, runs versioned migrations to the v1 schema, then runs a guarded one-time legacy import. Thin typed repositories (`UserStore`, `UserSettingsStore`, `AppSettingsStore`, `DeviceStore`) wrap prepared statements. `Config.ts` splits so the boot trio (`installMode`/`webPort`/`firstRunComplete`) stays in a trimmed `config.json` while all other settings are composed from SQLite — keeping `Config.getAppConfig()` / `updateAppConfig()` signatures unchanged so no consumer changes.

**Tech Stack:** TypeScript (Node 24.15.0), `node:sqlite` (`DatabaseSync`, compiled into Node — Local-Dependencies-Only compliant), vitest.

**Spec:** `docs/specs/2026-06-11-sqlite-persistence-and-auth-design.md`. This plan implements the **Store foundation** phase. The exact integration line-targets in `Config.ts`/`index.ts` pin against the post-beta.62 tree at execution time; the `db/` layer is greenfield and exact.

**Conventions (from the repo):**
- Tests live in `src/server/db/__tests__/`, import `{ describe, it, expect, beforeEach, afterEach } from 'vitest'` (globals are OFF).
- File-backed tests use `fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-'))` and `fs.rmSync(dir, { recursive: true, force: true })`.
- Singletons expose a `_resetForTest()` static (see `Config._resetForTest`).
- SQLite has no boolean type: store `0`/`1`; repositories convert at the boundary.
- Repositories take a `DatabaseSync` in their constructor (inject `new DatabaseSync(':memory:')` in tests).
- Gate after each task group: `npm run -s tsc` (alias for `tsc --noEmit`) and `npx vitest run <file>`. Full gate at the end.

---

## File structure

| File | Responsibility |
|---|---|
| `src/server/db/constants.ts` | Shared constants: `IMPLICIT_ADMIN_ID = 1`, `DB_FILENAME = 'wsscrcpy.db'`, `AUTH_ENABLED_KEY = 'authEnabled'`. |
| `src/server/db/openDatabase.ts` | `openDatabase(dbPath)`: open, set PRAGMAs, run migrations, integrity-check/recover. Pure-ish (path in, handle out). |
| `src/server/db/migrations.ts` | `Migration` type, `MIGRATIONS` list, `runMigrations(db)` (reads/sets `PRAGMA user_version`). |
| `src/server/db/migrations/001_initial.ts` | v1 schema DDL + implicit-admin + `authEnabled=false` seed. |
| `src/server/db/UserStore.ts` | `users` table: `create`/`getById`/`getByUsername`/`list` (auth-only methods added in Phase 4). |
| `src/server/db/UserSettingsStore.ts` | `user_settings` per-user KV: `get`/`getAll`/`set`/`delete`/`clearForUser`. |
| `src/server/db/AppSettingsStore.ts` | `app_settings` global KV: `get`/`getAll`/`set`. |
| `src/server/db/DeviceStore.ts` | `devices` (observed) + `device_labels` (per-user). Per-device `device_settings` methods added in Phase 3. |
| `src/server/db/Db.ts` | `Db` singleton: resolves `<dataRoot>/wsscrcpy.db`, holds the handle, runs the legacy import, exposes repos + `backup()`. |
| `src/server/db/import/importConfigJson.ts` | Map a parsed legacy `config.json` → `app_settings` (globals) + user-1 `user_settings` (prompt flags); compute the trimmed boot trio. |
| `src/server/db/import/importDeviceLabels.ts` | Map a parsed legacy `device-labels.json` → `device_labels` (user 1) + seed `devices`. |
| `src/server/db/import/importLegacy.ts` | `importLegacyIfNeeded(db, paths, now)`: guarded one-time orchestration; trims `config.json` on success. |
| `src/server/Config.ts` | **Modified.** Boot-trio read/write in JSON; everything else composed from the stores. |
| `config.example.json` | **Modified.** Trim to the boot trio + a comment. |
| `src/server/index.ts` | **Modified.** `Db.getInstance()` before `Config`; `gracefulShutdown` calls `Db.getInstance().backup(...)`. |
| `launcher/src/spawn.rs`, `scripts/dev-supervisor.mjs` | **Modified.** Add `--disable-warning=ExperimentalWarning` to the node argv (cosmetic; from the spike). |

---

## Task 1: node:sqlite verification spike

**Files:**
- Test: `src/server/db/__tests__/sqliteSmoke.test.ts`

- [ ] **Step 1: Write the smoke test that exercises the whole API we depend on**

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('node:sqlite smoke (verification spike)', () => {
    it('opens in-memory, execs DDL, prepares/run/get/all, reads pragmas', () => {
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

        const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
        const info = insert.run('alice');
        expect(Number(info.changes)).toBe(1);
        expect(Number(info.lastInsertRowid)).toBe(1);

        const one = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as { id: number; name: string };
        expect(one).toEqual({ id: 1, name: 'alice' });

        insert.run('bob');
        const all = db.prepare('SELECT name FROM t ORDER BY id').all() as Array<{ name: string }>;
        expect(all.map((r) => r.name)).toEqual(['alice', 'bob']);

        const ver = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(ver.user_version).toBe(0);
        db.exec('PRAGMA user_version = 3');
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);

        db.close();
    });
});
```

- [ ] **Step 2: Run it; confirm the API behaves on the bundled Node**

Run: `npx vitest run src/server/db/__tests__/sqliteSmoke.test.ts`
Expected: PASS. If the import itself fails (module missing) or any assertion fails, **stop**: `node:sqlite` is not viable on this Node — escalate the `better-sqlite3` fallback (spec Open items) before proceeding.

- [ ] **Step 3: Note the ExperimentalWarning**

Run: `node --input-type=module -e "import('node:sqlite').then(()=>console.error('loaded'))"`
Expected: prints an `ExperimentalWarning` on stderr but still loads. Confirms the warning is cosmetic; suppression is wired in Task 15.

- [ ] **Step 4: Commit**

```bash
git add src/server/db/__tests__/sqliteSmoke.test.ts
git commit -m "test(db): node:sqlite verification spike"
```

---

## Task 2: constants + openDatabase with PRAGMAs

**Files:**
- Create: `src/server/db/constants.ts`, `src/server/db/openDatabase.ts`
- Test: `src/server/db/__tests__/openDatabase.test.ts`

- [ ] **Step 1: constants**

```ts
// src/server/db/constants.ts
export const IMPLICIT_ADMIN_ID = 1;
export const DB_FILENAME = 'wsscrcpy.db';
export const AUTH_ENABLED_KEY = 'authEnabled';
```

- [ ] **Step 2: Write the failing test**

```ts
// src/server/db/__tests__/openDatabase.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase } from '../openDatabase';

const dirs: string[] = [];
function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdb-'));
    dirs.push(d);
    return path.join(d, 'wsscrcpy.db');
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('openDatabase', () => {
    it('creates the file, enables WAL + foreign_keys, migrates to v1', () => {
        const p = tmp();
        const db = openDatabase(p);
        expect(fs.existsSync(p)).toBe(true);
        expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
        expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
        db.close();
    });
});
```

- [ ] **Step 3: Run → FAIL** (`openDatabase` not defined).

Run: `npx vitest run src/server/db/__tests__/openDatabase.test.ts`

- [ ] **Step 4: Implement** (migrations/integrity are filled by Tasks 3–4 + 13; for now wire the call sites)

```ts
// src/server/db/openDatabase.ts
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations';

export function openDatabase(dbPath: string): DatabaseSync {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db);
    return db;
}
```

- [ ] **Step 5: Run → still failing until Task 3/4 provide `runMigrations`/migration 001.** Implement Tasks 3 and 4, then re-run Step 3's command → PASS.

- [ ] **Step 6: Commit** (after Task 4 makes it green)

```bash
git add src/server/db/constants.ts src/server/db/openDatabase.ts src/server/db/__tests__/openDatabase.test.ts
git commit -m "feat(db): openDatabase with WAL + foreign_keys + migrate-on-open"
```

---

## Task 3: migration framework

**Files:**
- Create: `src/server/db/migrations.ts`
- Test: `src/server/db/__tests__/migrations.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, MIGRATIONS } from '../migrations';

function userVersion(db: DatabaseSync): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('runMigrations', () => {
    it('applies all migrations once and is idempotent on re-run', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        expect(userVersion(db)).toBe(MIGRATIONS.length);
        // Re-run: no throw, version unchanged, tables still present (no double-create).
        runMigrations(db);
        expect(userVersion(db)).toBe(MIGRATIONS.length);
    });

    it('refuses a database newer than the binary supports', () => {
        const db = new DatabaseSync(':memory:');
        db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
        expect(() => runMigrations(db)).toThrow(/newer than supported/);
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/migrations.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/migrations.ts
import type { DatabaseSync } from 'node:sqlite';
import { migration001 } from './migrations/001_initial';

export interface Migration {
    version: number;
    up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [migration001];

export function runMigrations(db: DatabaseSync): void {
    const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > MIGRATIONS.length) {
        throw new Error(
            `wsscrcpy.db schema v${current} is newer than supported v${MIGRATIONS.length}; ` +
                `refusing to run (downgrade unsupported).`,
        );
    }
    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        db.exec('BEGIN');
        try {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`); // m.version is a trusted integer literal
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
}
```

- [ ] **Step 4: Run → PASS** (after Task 4 supplies `migration001`).

- [ ] **Step 5: Commit** (with Task 4).

---

## Task 4: migration 001 — v1 schema + seed

**Files:**
- Create: `src/server/db/migrations/001_initial.ts`
- Test: `src/server/db/__tests__/migration001.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';

function tables(db: DatabaseSync): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
        .map((r) => r.name);
}

describe('migration 001', () => {
    it('creates every v1 table', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        for (const t of ['users', 'sessions', 'user_settings', 'devices', 'device_labels', 'device_settings', 'app_settings']) {
            expect(tables(db)).toContain(t);
        }
    });

    it('seeds the implicit admin (id 1, role admin, no password) and authEnabled=false', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        const admin = db.prepare('SELECT id, username, role, password_hash, disabled FROM users WHERE id = 1').get() as
            { id: number; username: string; role: string; password_hash: string | null; disabled: number };
        expect(admin).toMatchObject({ id: 1, role: 'admin', password_hash: null, disabled: 0 });
        const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'authEnabled'").get() as { value: string };
        expect(flag.value).toBe('false');
    });

    it('enforces the role CHECK constraint', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        expect(() => db.exec("INSERT INTO users (username, role, created_at) VALUES ('x', 'superuser', 0)")).toThrow();
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/migration001.test.ts`

- [ ] **Step 3: Implement** (DDL verbatim from the spec's "Data model")

```ts
// src/server/db/migrations/001_initial.ts
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrations';
import { IMPLICIT_ADMIN_ID } from '../constants';

const DDL = `
CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    username             TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    role                 TEXT    NOT NULL CHECK (role IN ('user','admin')),
    password_hash        TEXT,
    disabled             INTEGER NOT NULL DEFAULT 0,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    lockout_window_start INTEGER,
    locked_until         INTEGER,
    created_at           INTEGER NOT NULL,
    last_login_at        INTEGER
);
CREATE TABLE sessions (
    token_hash   TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT    NOT NULL,
    value   TEXT    NOT NULL,
    PRIMARY KEY (user_id, key)
);
CREATE TABLE devices (
    serial       TEXT PRIMARY KEY,
    manufacturer TEXT,
    model        TEXT,
    address      TEXT,
    last_seen_at INTEGER
);
CREATE TABLE device_labels (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    serial  TEXT    NOT NULL,
    label   TEXT    NOT NULL,
    PRIMARY KEY (user_id, serial)
);
CREATE TABLE device_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    udid    TEXT    NOT NULL,
    scope   TEXT    NOT NULL,
    value   TEXT    NOT NULL,
    PRIMARY KEY (user_id, udid, scope)
);
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export const migration001: Migration = {
    version: 1,
    up(db: DatabaseSync): void {
        db.exec(DDL);
        // Date.now() is acceptable in app/runtime code (only workflow scripts forbid it).
        const now = Date.now();
        db.prepare(
            'INSERT INTO users (id, username, role, password_hash, created_at) VALUES (?, ?, ?, NULL, ?)',
        ).run(IMPLICIT_ADMIN_ID, 'admin', 'admin', now);
        db.prepare("INSERT INTO app_settings (key, value) VALUES ('authEnabled', 'false')").run();
    },
};
```

- [ ] **Step 4: Run → PASS** for migration001, migrations, and openDatabase tests.

Run: `npx vitest run src/server/db/__tests__/migration001.test.ts src/server/db/__tests__/migrations.test.ts src/server/db/__tests__/openDatabase.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/migrations.ts src/server/db/migrations/001_initial.ts src/server/db/openDatabase.ts src/server/db/constants.ts src/server/db/__tests__/migrations.test.ts src/server/db/__tests__/migration001.test.ts src/server/db/__tests__/openDatabase.test.ts
git commit -m "feat(db): v1 schema migration + framework + openDatabase"
```

---

## Task 5: UserStore (foundation methods)

**Files:**
- Create: `src/server/db/UserStore.ts`
- Test: `src/server/db/__tests__/userStore.test.ts`

> Auth-only methods (`setRole`/`setDisabled`/`setPasswordHash`/`delete`/`countEnabledAdmins`/`setLastLogin`/lockout) are added in **Phase 4**. Phase 1 needs only create/read.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { UserStore, type User } from '../UserStore';

let db: DatabaseSync;
let store: UserStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new UserStore(db);
});

describe('UserStore', () => {
    it('reads the seeded implicit admin by id and username (case-insensitive)', () => {
        const a = store.getById(1) as User;
        expect(a).toMatchObject({ id: 1, username: 'admin', role: 'admin', passwordHash: null, disabled: false });
        expect(store.getByUsername('ADMIN')?.id).toBe(1);
    });

    it('creates a user and lists all', () => {
        const u = store.create({ username: 'bob', role: 'user', passwordHash: 'scrypt$...' });
        expect(u).toMatchObject({ username: 'bob', role: 'user', disabled: false });
        expect(store.list().map((x) => x.username).sort()).toEqual(['admin', 'bob']);
    });

    it('rejects a duplicate username (case-insensitive)', () => {
        store.create({ username: 'bob', role: 'user', passwordHash: null });
        expect(() => store.create({ username: 'BOB', role: 'user', passwordHash: null })).toThrow();
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/userStore.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/UserStore.ts
import type { DatabaseSync } from 'node:sqlite';

export type Role = 'user' | 'admin';

export interface User {
    id: number;
    username: string;
    role: Role;
    passwordHash: string | null;
    disabled: boolean;
    failedAttempts: number;
    lockoutWindowStart: number | null;
    lockedUntil: number | null;
    createdAt: number;
    lastLoginAt: number | null;
}

interface UserRow {
    id: number; username: string; role: Role; password_hash: string | null;
    disabled: number; failed_attempts: number; lockout_window_start: number | null;
    locked_until: number | null; created_at: number; last_login_at: number | null;
}

function toUser(r: UserRow): User {
    return {
        id: r.id, username: r.username, role: r.role, passwordHash: r.password_hash,
        disabled: r.disabled === 1, failedAttempts: r.failed_attempts,
        lockoutWindowStart: r.lockout_window_start, lockedUntil: r.locked_until,
        createdAt: r.created_at, lastLoginAt: r.last_login_at,
    };
}

const COLS = 'id, username, role, password_hash, disabled, failed_attempts, lockout_window_start, locked_until, created_at, last_login_at';

export class UserStore {
    constructor(private readonly db: DatabaseSync) {}

    getById(id: number): User | undefined {
        const r = this.db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
        return r ? toUser(r) : undefined;
    }

    getByUsername(username: string): User | undefined {
        const r = this.db.prepare(`SELECT ${COLS} FROM users WHERE username = ?`).get(username) as UserRow | undefined;
        return r ? toUser(r) : undefined;
    }

    list(): User[] {
        return (this.db.prepare(`SELECT ${COLS} FROM users ORDER BY id`).all() as UserRow[]).map(toUser);
    }

    create(input: { username: string; role: Role; passwordHash: string | null }): User {
        const now = Date.now();
        const info = this.db
            .prepare('INSERT INTO users (username, role, password_hash, created_at) VALUES (?, ?, ?, ?)')
            .run(input.username, input.role, input.passwordHash, now);
        return this.getById(Number(info.lastInsertRowid))!;
    }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/UserStore.ts src/server/db/__tests__/userStore.test.ts
git commit -m "feat(db): UserStore foundation (create/getById/getByUsername/list)"
```

---

## Task 6: UserSettingsStore + AppSettingsStore (per-user + global KV)

**Files:**
- Create: `src/server/db/UserSettingsStore.ts`, `src/server/db/AppSettingsStore.ts`
- Test: `src/server/db/__tests__/settingsStores.test.ts`

- [ ] **Step 1: Failing test** (covers per-user isolation + JSON round-trip + reset)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { UserSettingsStore } from '../UserSettingsStore';
import { AppSettingsStore } from '../AppSettingsStore';
import { UserStore } from '../UserStore';

let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); });

describe('UserSettingsStore', () => {
    it('round-trips JSON values and isolates users', () => {
        const us = new UserStore(db);
        const bob = us.create({ username: 'bob', role: 'user', passwordHash: null });
        const s = new UserSettingsStore(db);
        s.set(1, 'theme', 'dark');
        s.set(bob.id, 'theme', 'light');
        s.set(1, 'scanSubnets', ['10.0.0.0/24']);
        expect(s.get(1, 'theme')).toBe('dark');
        expect(s.get(bob.id, 'theme')).toBe('light');
        expect(s.get(1, 'scanSubnets')).toEqual(['10.0.0.0/24']);
        expect(s.get(1, 'missing')).toBeUndefined();
        expect(s.getAll(1)).toEqual({ theme: 'dark', scanSubnets: ['10.0.0.0/24'] });
    });

    it('delete and clearForUser remove only that user rows', () => {
        const s = new UserSettingsStore(db);
        const us = new UserStore(db);
        const bob = us.create({ username: 'bob', role: 'user', passwordHash: null });
        s.set(1, 'a', 1); s.set(1, 'b', 2); s.set(bob.id, 'a', 9);
        s.delete(1, 'a');
        expect(s.get(1, 'a')).toBeUndefined();
        s.clearForUser(1);
        expect(s.getAll(1)).toEqual({});
        expect(s.get(bob.id, 'a')).toBe(9);
    });
});

describe('AppSettingsStore', () => {
    it('round-trips and upserts global values', () => {
        const a = new AppSettingsStore(db);
        a.set('autoUpdate', true);
        a.set('channel', 'beta');
        a.set('channel', 'stable'); // upsert
        expect(a.get('autoUpdate')).toBe(true);
        expect(a.get('channel')).toBe('stable');
        expect(a.getAll()).toMatchObject({ authEnabled: false, autoUpdate: true, channel: 'stable' });
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/settingsStores.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/UserSettingsStore.ts
import type { DatabaseSync } from 'node:sqlite';

export class UserSettingsStore {
    constructor(private readonly db: DatabaseSync) {}

    get(userId: number, key: string): unknown | undefined {
        const r = this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as
            { value: string } | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }

    getAll(userId: number): Record<string, unknown> {
        const rows = this.db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId) as
            Array<{ key: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.key] = JSON.parse(r.value);
        return out;
    }

    set(userId: number, key: string, value: unknown): void {
        this.db
            .prepare(
                'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ' +
                    'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
            )
            .run(userId, key, JSON.stringify(value));
    }

    delete(userId: number, key: string): void {
        this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
    }

    clearForUser(userId: number): void {
        this.db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
    }
}
```

```ts
// src/server/db/AppSettingsStore.ts
import type { DatabaseSync } from 'node:sqlite';

export class AppSettingsStore {
    constructor(private readonly db: DatabaseSync) {}

    get(key: string): unknown | undefined {
        const r = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }

    getAll(): Record<string, unknown> {
        const rows = this.db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.key] = JSON.parse(r.value);
        return out;
    }

    set(key: string, value: unknown): void {
        this.db
            .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
    }
}
```

> Note: the seed writes `authEnabled` as the **string** `'false'` (Task 4). `AppSettingsStore` stores JSON, so reads of `authEnabled` go through `JSON.parse('false') === false` — a boolean. The seed value `'false'` is valid JSON, so this is consistent. (Phase 4 writes it via `AppSettingsStore.set('authEnabled', true/false)`.)

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/UserSettingsStore.ts src/server/db/AppSettingsStore.ts src/server/db/__tests__/settingsStores.test.ts
git commit -m "feat(db): UserSettingsStore + AppSettingsStore (per-user + global KV)"
```

---

## Task 7: DeviceStore (devices + per-user labels)

**Files:**
- Create: `src/server/db/DeviceStore.ts`
- Test: `src/server/db/__tests__/deviceStore.test.ts`

> Per-device `device_settings` methods (`getDeviceSetting`/`setDeviceSetting`/`getDeviceSettings`/`clearForUser`) are added in **Phase 3**.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { DeviceStore } from '../DeviceStore';

let db: DatabaseSync;
let store: DeviceStore;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); store = new DeviceStore(db); });

describe('DeviceStore observed devices', () => {
    it('upserts and reads observed metadata (partial fields preserved)', () => {
        store.upsertDevice({ serial: 'S1', model: 'Pixel 7', lastSeenAt: 100 });
        store.upsertDevice({ serial: 'S1', address: '10.0.0.5:5555', lastSeenAt: 200 });
        expect(store.getDevice('S1')).toEqual({ serial: 'S1', manufacturer: null, model: 'Pixel 7', address: '10.0.0.5:5555', lastSeenAt: 200 });
        expect(store.listDevices().length).toBe(1);
    });
});

describe('DeviceStore per-user labels', () => {
    it('sets/gets/deletes labels scoped per user', () => {
        store.setLabel(1, 'S1', 'Living Room');
        store.setLabel(2, 'S1', 'Office'); // requires user 2 to exist? labels FK -> users
        expect(store.getLabel(1, 'S1')).toBe('Living Room');
        store.deleteLabel(1, 'S1');
        expect(store.getLabel(1, 'S1')).toBeUndefined();
        expect(store.getAllLabels(2)).toEqual({ S1: 'Office' });
    });
});
```

> The label test sets a label for `user 2`; `device_labels.user_id` has a FK to `users(id)`. Create user 2 first in the test (via `UserStore`) or set both labels under user 1. Implementer: add `new UserStore(db).create({username:'u2',role:'user',passwordHash:null})` before the `setLabel(2, ...)` call so the FK holds.

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/deviceStore.test.ts`

- [ ] **Step 3: Implement** (partial upsert preserves existing non-null columns via COALESCE)

```ts
// src/server/db/DeviceStore.ts
import type { DatabaseSync } from 'node:sqlite';

export interface DeviceRecord {
    serial: string; manufacturer: string | null; model: string | null; address: string | null; lastSeenAt: number | null;
}

export class DeviceStore {
    constructor(private readonly db: DatabaseSync) {}

    upsertDevice(rec: {
        serial: string; manufacturer?: string | null; model?: string | null; address?: string | null; lastSeenAt?: number | null;
    }): void {
        // COALESCE(excluded, existing): a field omitted (undefined→null bind) does not clobber a known value.
        this.db
            .prepare(
                `INSERT INTO devices (serial, manufacturer, model, address, last_seen_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(serial) DO UPDATE SET
                   manufacturer = COALESCE(excluded.manufacturer, devices.manufacturer),
                   model        = COALESCE(excluded.model,        devices.model),
                   address      = COALESCE(excluded.address,      devices.address),
                   last_seen_at = COALESCE(excluded.last_seen_at, devices.last_seen_at)`,
            )
            .run(rec.serial, rec.manufacturer ?? null, rec.model ?? null, rec.address ?? null, rec.lastSeenAt ?? null);
    }

    getDevice(serial: string): DeviceRecord | undefined {
        const r = this.db
            .prepare('SELECT serial, manufacturer, model, address, last_seen_at FROM devices WHERE serial = ?')
            .get(serial) as { serial: string; manufacturer: string | null; model: string | null; address: string | null; last_seen_at: number | null } | undefined;
        return r ? { serial: r.serial, manufacturer: r.manufacturer, model: r.model, address: r.address, lastSeenAt: r.last_seen_at } : undefined;
    }

    listDevices(): DeviceRecord[] {
        return (this.db.prepare('SELECT serial, manufacturer, model, address, last_seen_at FROM devices ORDER BY serial').all() as Array<{ serial: string; manufacturer: string | null; model: string | null; address: string | null; last_seen_at: number | null }>)
            .map((r) => ({ serial: r.serial, manufacturer: r.manufacturer, model: r.model, address: r.address, lastSeenAt: r.last_seen_at }));
    }

    getLabel(userId: number, serial: string): string | undefined {
        const r = this.db.prepare('SELECT label FROM device_labels WHERE user_id = ? AND serial = ?').get(userId, serial) as { label: string } | undefined;
        return r?.label;
    }

    setLabel(userId: number, serial: string, label: string): void {
        this.db
            .prepare('INSERT INTO device_labels (user_id, serial, label) VALUES (?, ?, ?) ON CONFLICT(user_id, serial) DO UPDATE SET label = excluded.label')
            .run(userId, serial, label);
    }

    deleteLabel(userId: number, serial: string): void {
        this.db.prepare('DELETE FROM device_labels WHERE user_id = ? AND serial = ?').run(userId, serial);
    }

    getAllLabels(userId: number): Record<string, string> {
        const rows = this.db.prepare('SELECT serial, label FROM device_labels WHERE user_id = ?').all(userId) as Array<{ serial: string; label: string }>;
        const out: Record<string, string> = {};
        for (const r of rows) out[r.serial] = r.label;
        return out;
    }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/DeviceStore.ts src/server/db/__tests__/deviceStore.test.ts
git commit -m "feat(db): DeviceStore (observed devices + per-user labels)"
```

---

## Task 8: legacy config.json import (pure mapper)

**Files:**
- Create: `src/server/db/import/importConfigJson.ts`
- Test: `src/server/db/__tests__/importConfigJson.test.ts`

The pure mapper takes a parsed legacy config object and writes the non-boot fields to the stores, returning the boot trio to persist back to a trimmed `config.json`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { AppSettingsStore } from '../AppSettingsStore';
import { UserSettingsStore } from '../UserSettingsStore';
import { importConfigJson } from '../import/importConfigJson';
import { IMPLICIT_ADMIN_ID } from '../constants';

let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); });

describe('importConfigJson', () => {
    it('routes globals to app_settings, prompt flags to user-1 settings, returns the boot trio', () => {
        const legacy = {
            installMode: 'user', webPort: 8123, firstRunComplete: true,
            autoUpdate: false, updateCheckIntervalMinutes: 30, channel: 'beta', githubOwner: 'x',
            adbPath: '/opt/adb', dependenciesPath: '/opt/deps',
            scanConcurrency: 32, scanTcpTimeoutMs: 200, scanAdbConnectTimeoutMs: 4000, scanProgressInterval: 5,
            bookmarkDismissedForPort: 8123, bookmarkDismissedGlobally: true, serviceFirstRunSeen: true,
        };
        const trio = importConfigJson(db, legacy);
        expect(trio).toEqual({ installMode: 'user', webPort: 8123, firstRunComplete: true });

        const app = new AppSettingsStore(db).getAll();
        expect(app).toMatchObject({ autoUpdate: false, channel: 'beta', githubOwner: 'x', adbPath: '/opt/adb', dependenciesPath: '/opt/deps', scanConcurrency: 32 });
        // Boot trio must NOT be duplicated into app_settings.
        expect(app).not.toHaveProperty('webPort');
        expect(app).not.toHaveProperty('installMode');

        const prompts = new UserSettingsStore(db).getAll(IMPLICIT_ADMIN_ID);
        expect(prompts).toMatchObject({ bookmarkDismissedForPort: 8123, bookmarkDismissedGlobally: true, serviceFirstRunSeen: true });
    });

    it('omits absent fields (no undefined rows written)', () => {
        const trio = importConfigJson(db, { webPort: 9000 });
        expect(trio).toEqual({ installMode: null, webPort: 9000, firstRunComplete: false });
        expect(new AppSettingsStore(db).getAll()).toEqual({ authEnabled: false });
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/importConfigJson.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/import/importConfigJson.ts
import type { DatabaseSync } from 'node:sqlite';
import { AppSettingsStore } from '../AppSettingsStore';
import { UserSettingsStore } from '../UserSettingsStore';
import { IMPLICIT_ADMIN_ID } from '../constants';

export interface BootTrio {
    installMode: string | null;
    webPort: number | undefined;
    firstRunComplete: boolean;
}

const GLOBAL_KEYS = [
    'autoUpdate', 'updateCheckIntervalMinutes', 'channel', 'githubOwner',
    'adbPath', 'dependenciesPath', 'scanConcurrency', 'scanTcpTimeoutMs',
    'scanAdbConnectTimeoutMs', 'scanProgressInterval',
] as const;

const PROMPT_KEYS = ['bookmarkDismissedForPort', 'bookmarkDismissedGlobally', 'serviceFirstRunSeen'] as const;

export function importConfigJson(db: DatabaseSync, legacy: Record<string, unknown>): BootTrio {
    const app = new AppSettingsStore(db);
    const userSettings = new UserSettingsStore(db);

    for (const k of GLOBAL_KEYS) {
        if (legacy[k] !== undefined) app.set(k, legacy[k]);
    }
    for (const k of PROMPT_KEYS) {
        if (legacy[k] !== undefined) userSettings.set(IMPLICIT_ADMIN_ID, k, legacy[k]);
    }

    return {
        installMode: (legacy['installMode'] as string | undefined) ?? null,
        webPort: legacy['webPort'] as number | undefined,
        firstRunComplete: (legacy['firstRunComplete'] as boolean | undefined) ?? false,
    };
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/import/importConfigJson.ts src/server/db/__tests__/importConfigJson.test.ts
git commit -m "feat(db): importConfigJson mapper (globals + prompts → stores)"
```

---

## Task 9: legacy device-labels.json import

**Files:**
- Create: `src/server/db/import/importDeviceLabels.ts`
- Test: `src/server/db/__tests__/importDeviceLabels.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { DeviceStore } from '../DeviceStore';
import { importDeviceLabels } from '../import/importDeviceLabels';
import { IMPLICIT_ADMIN_ID } from '../constants';

let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); });

describe('importDeviceLabels', () => {
    it('imports labels for the implicit admin and seeds devices', () => {
        importDeviceLabels(db, { S1: 'Living Room', S2: 'Office' });
        const ds = new DeviceStore(db);
        expect(ds.getAllLabels(IMPLICIT_ADMIN_ID)).toEqual({ S1: 'Living Room', S2: 'Office' });
        expect(ds.getDevice('S1')?.serial).toBe('S1');
        expect(ds.listDevices().length).toBe(2);
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/importDeviceLabels.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/import/importDeviceLabels.ts
import type { DatabaseSync } from 'node:sqlite';
import { DeviceStore } from '../DeviceStore';
import { IMPLICIT_ADMIN_ID } from '../constants';

export function importDeviceLabels(db: DatabaseSync, labels: Record<string, string>): void {
    const ds = new DeviceStore(db);
    for (const [serial, label] of Object.entries(labels)) {
        ds.upsertDevice({ serial });
        ds.setLabel(IMPLICIT_ADMIN_ID, serial, label);
    }
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/import/importDeviceLabels.ts src/server/db/__tests__/importDeviceLabels.test.ts
git commit -m "feat(db): importDeviceLabels (labels → user 1 + seed devices)"
```

---

## Task 10: guarded one-time legacy import orchestrator

**Files:**
- Create: `src/server/db/import/importLegacy.ts`
- Test: `src/server/db/__tests__/importLegacy.test.ts`

Runs once (guarded by an `app_settings['legacyImported']` marker), reads the legacy files if present, applies both mappers, and rewrites `config.json` trimmed to the boot trio.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMigrations } from '../migrations';
import { AppSettingsStore } from '../AppSettingsStore';
import { importLegacyIfNeeded } from '../import/importLegacy';

const dirs: string[] = [];
function tmpdir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsimp-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('importLegacyIfNeeded', () => {
    it('imports once, trims config.json to the boot trio, and is idempotent', () => {
        const dir = tmpdir();
        const configPath = path.join(dir, 'config.json');
        const labelsPath = path.join(dir, 'device-labels.json');
        fs.writeFileSync(configPath, JSON.stringify({ webPort: 8123, installMode: 'user', firstRunComplete: true, channel: 'beta', bookmarkDismissedGlobally: true }));
        fs.writeFileSync(labelsPath, JSON.stringify({ S1: 'TV' }));

        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        importLegacyIfNeeded(db, { configPath, deviceLabelsPath: labelsPath });

        // config.json trimmed to exactly the trio.
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ installMode: 'user', webPort: 8123, firstRunComplete: true });
        expect(new AppSettingsStore(db).get('channel')).toBe('beta');
        expect(new AppSettingsStore(db).get('legacyImported')).toBe(true);

        // Second call: marker present → no-op (mutate config.json to prove it is not re-trimmed/re-read).
        fs.writeFileSync(configPath, JSON.stringify({ webPort: 9999, installMode: 'user', firstRunComplete: true }));
        importLegacyIfNeeded(db, { configPath, deviceLabelsPath: labelsPath });
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).webPort).toBe(9999);
    });

    it('handles missing legacy files (fresh install) by marking imported', () => {
        const dir = tmpdir();
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        importLegacyIfNeeded(db, { configPath: path.join(dir, 'config.json'), deviceLabelsPath: path.join(dir, 'device-labels.json') });
        expect(new AppSettingsStore(db).get('legacyImported')).toBe(true);
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/importLegacy.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/import/importLegacy.ts
import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import { AppSettingsStore } from '../AppSettingsStore';
import { importConfigJson, type BootTrio } from './importConfigJson';
import { importDeviceLabels } from './importDeviceLabels';

const MARKER = 'legacyImported';

function readJson(p: string): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function writeTrimmedConfig(p: string, trio: BootTrio): void {
    const out: Record<string, unknown> = { installMode: trio.installMode, firstRunComplete: trio.firstRunComplete };
    if (trio.webPort !== undefined) out['webPort'] = trio.webPort;
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf-8');
}

export function importLegacyIfNeeded(db: DatabaseSync, paths: { configPath: string; deviceLabelsPath: string }): void {
    const app = new AppSettingsStore(db);
    if (app.get(MARKER) === true) return;

    db.exec('BEGIN');
    try {
        const legacyConfig = readJson(paths.configPath);
        if (legacyConfig) {
            const trio = importConfigJson(db, legacyConfig);
            writeTrimmedConfig(paths.configPath, trio);
        }
        const labels = readJson(paths.deviceLabelsPath);
        if (labels) importDeviceLabels(db, labels as Record<string, string>);
        app.set(MARKER, true);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
```

> The `config.json` rewrite is a side effect inside the DB transaction; if a crash occurs after `COMMIT` but before the file write completes, the marker is set so the trim won't retry — acceptable because the un-trimmed extra keys are simply ignored by the new `Config` (it only reads the trio from JSON). Documented as the one tolerated edge.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/import/importLegacy.ts src/server/db/__tests__/importLegacy.test.ts
git commit -m "feat(db): guarded one-time legacy import + config.json trim"
```

---

## Task 11: integrity check + corrupt-recovery on open

**Files:**
- Modify: `src/server/db/openDatabase.ts`
- Test: `src/server/db/__tests__/openDatabaseIntegrity.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase } from '../openDatabase';

const dirs: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsint-')); dirs.push(d); return d; }
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('openDatabase integrity recovery', () => {
    it('moves a corrupt file aside and recreates a fresh schema', () => {
        const dir = tmp();
        const p = path.join(dir, 'wsscrcpy.db');
        fs.writeFileSync(p, 'this is not a sqlite database header at all');
        const db = openDatabase(p);
        // Fresh DB is usable at v1 and the corrupt file was preserved with a .corrupt- suffix.
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
        const moved = fs.readdirSync(dir).filter((f) => f.startsWith('wsscrcpy.db.corrupt-'));
        expect(moved.length).toBe(1);
        db.close();
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/openDatabaseIntegrity.test.ts`

- [ ] **Step 3: Implement** (wrap open in an integrity guard)

```ts
// src/server/db/openDatabase.ts
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import { runMigrations } from './migrations';
import { Logger } from '../Logger';

function configure(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
}

function integrityOk(db: DatabaseSync): boolean {
    try {
        const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        return r.integrity_check === 'ok';
    } catch {
        return false;
    }
}

export function openDatabase(dbPath: string): DatabaseSync {
    let db: DatabaseSync;
    try {
        db = new DatabaseSync(dbPath);
        configure(db);
        if (!integrityOk(db)) throw new Error('integrity_check failed');
        runMigrations(db);
        return db;
    } catch (err) {
        // Corrupt or unreadable: move aside and recreate. Losing settings/users is recoverable.
        Logger.for('Db').error(`wsscrcpy.db unusable (${(err as Error).message}); moving aside and recreating`);
        try { db!.close(); } catch { /* best effort */ }
        if (fs.existsSync(dbPath)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.renameSync(dbPath, `${dbPath}.corrupt-${stamp}`);
        }
        const fresh = new DatabaseSync(dbPath);
        configure(fresh);
        runMigrations(fresh);
        return fresh;
    }
}
```

> Note: `new Date()` with no args is fine in app/runtime code. (Only Workflow scripts forbid `Date.now()`/`new Date()`.) The `:memory:` path used by repo tests never hits the rename branch.

- [ ] **Step 4: Run → PASS** (this test + the Task 2 `openDatabase.test.ts` still pass).
- [ ] **Step 5: Commit**

```bash
git add src/server/db/openDatabase.ts src/server/db/__tests__/openDatabaseIntegrity.test.ts
git commit -m "feat(db): integrity check + corrupt-file recovery on open"
```

---

## Task 12: Db singleton (wires open + import + repos + backup)

**Files:**
- Create: `src/server/db/Db.ts`
- Test: `src/server/db/__tests__/db.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../Db';

const dirs: string[] = [];
function dataRoot(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsroot-')); dirs.push(d); return d; }
afterEach(() => { Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('Db singleton', () => {
    it('opens <dataRoot>/wsscrcpy.db, runs the import, and exposes repos', () => {
        const root = dataRoot();
        fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ webPort: 8000, installMode: 'user', firstRunComplete: true, channel: 'beta' }));
        const db = Db.getInstance(root);
        expect(fs.existsSync(path.join(root, 'wsscrcpy.db'))).toBe(true);
        expect(db.appSettings.get('channel')).toBe('beta');
        expect(db.users.getById(1)?.role).toBe('admin');
    });

    it('backup() writes a .bak snapshot', () => {
        const root = dataRoot();
        const db = Db.getInstance(root);
        const bak = path.join(root, 'wsscrcpy.db.bak');
        db.backup(bak);
        expect(fs.existsSync(bak)).toBe(true);
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/db/__tests__/db.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/db/Db.ts
import type { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import { openDatabase } from './openDatabase';
import { importLegacyIfNeeded } from './import/importLegacy';
import { UserStore } from './UserStore';
import { UserSettingsStore } from './UserSettingsStore';
import { AppSettingsStore } from './AppSettingsStore';
import { DeviceStore } from './DeviceStore';
import { DB_FILENAME } from './constants';

export class Db {
    private static instance?: Db | undefined;

    public readonly users: UserStore;
    public readonly userSettings: UserSettingsStore;
    public readonly appSettings: AppSettingsStore;
    public readonly devices: DeviceStore;

    private constructor(private readonly handle: DatabaseSync, public readonly dbPath: string) {
        this.users = new UserStore(handle);
        this.userSettings = new UserSettingsStore(handle);
        this.appSettings = new AppSettingsStore(handle);
        this.devices = new DeviceStore(handle);
    }

    static getInstance(dataRoot: string): Db {
        if (!this.instance) {
            const dbPath = path.join(dataRoot, DB_FILENAME);
            const handle = openDatabase(dbPath);
            importLegacyIfNeeded(handle, {
                configPath: path.join(dataRoot, 'config.json'),
                deviceLabelsPath: path.join(dataRoot, 'device-labels.json'),
            });
            this.instance = new Db(handle, dbPath);
        }
        return this.instance;
    }

    static _resetForTest(): void {
        this.instance?.handle.close();
        this.instance = undefined;
    }

    get sqlite(): DatabaseSync {
        return this.handle;
    }

    backup(toPath: string): void {
        // VACUUM INTO writes a clean snapshot; the path must not already exist.
        this.handle.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
    }
}
```

> `Db.getInstance(dataRoot)` requires the dataRoot. In production it is `Config`/`resolveDataRoot`. On a host with a `null` dataRoot (non-Windows dev with no `DATA_ROOT`), `Config` falls back as today (Task 13); the Db path mirrors that fallback.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/server/db/Db.ts src/server/db/__tests__/db.test.ts
git commit -m "feat(db): Db singleton (open + import + repos + VACUUM backup)"
```

---

## Task 13: Config.ts split — compose AppConfig from JSON trio + stores

**Files:**
- Modify: `src/server/Config.ts`
- Test: `src/server/__tests__/config.storeBacked.test.ts`

**Behavior contract (must hold):** `Config.getAppConfig()` returns the same `AppConfig` shape as today, composed from the trimmed `config.json` (trio) + `AppSettingsStore` (globals) + user-1 `UserSettingsStore` (prompt flags). `updateAppConfig(partial)` routes each field to its store (trio → `config.json`; globals → `app_settings`; prompts → user-1 settings) and preserves the existing return `{ config, restartRequired }`. No consumer of `Config` changes.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Config } from '../Config';
import { Db } from '../db/Db';

const dirs: string[] = [];
function root(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wscfg-')); dirs.push(d); return d; }
afterEach(() => { Config._resetForTest(); Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); process.env['DATA_ROOT'] = ''; });

describe('Config store-backed composition', () => {
    it('composes AppConfig from the JSON trio + app_settings + user-1 prompts', () => {
        const dir = root();
        process.env['DATA_ROOT'] = dir;
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8200, installMode: 'user', firstRunComplete: true, channel: 'beta', bookmarkDismissedGlobally: true }));
        const cfg = Config.getInstance().getAppConfig();
        expect(cfg.webPort).toBe(8200);
        expect(cfg.installMode).toBe('user');
        expect(cfg.channel).toBe('beta');               // from app_settings (imported)
        expect(cfg.bookmarkDismissedGlobally).toBe(true); // from user-1 settings (imported)
    });

    it('updateAppConfig routes fields to the right store and keeps config.json trio-only', () => {
        const dir = root();
        process.env['DATA_ROOT'] = dir;
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8200, installMode: 'user', firstRunComplete: false }));
        const c = Config.getInstance();
        c.updateAppConfig({ channel: 'stable', firstRunComplete: true, bookmarkDismissedGlobally: true });
        // config.json holds ONLY the trio.
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
        expect(Object.keys(onDisk).sort()).toEqual(['firstRunComplete', 'installMode', 'webPort']);
        expect(onDisk.firstRunComplete).toBe(true);
        // Re-read composes the global + prompt from the stores.
        Config._resetForTest();
        const cfg2 = Config.getInstance().getAppConfig();
        expect(cfg2.channel).toBe('stable');
        expect(cfg2.bookmarkDismissedGlobally).toBe(true);
    });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx vitest run src/server/__tests__/config.storeBacked.test.ts`

- [ ] **Step 3: Implement the split.** In `Config.ts`:
  1. In `getInstance()`, after computing `dataRoot`, obtain `const db = Db.getInstance(dataRoot ?? <fallback>)`. (Use the same fallback the dependencies path uses for a null dataRoot — the repo-root in dev; pass that directory to `Db.getInstance`.)
  2. Replace the single `sanitizeAppConfig(fileConfig)` with a composition: read the **trio** from the JSON `fileConfig`, read globals from `db.appSettings.getAll()`, read prompts from `db.userSettings.getAll(IMPLICIT_ADMIN_ID)`, then build `AppConfig` by overlaying trio + globals + prompts onto `APP_CONFIG_DEFAULTS` (validate each via the existing `validateField`).
  3. `saveToDisk()` writes **only** the trio (`installMode`, `webPort`, `firstRunComplete`) to `config.json`.
  4. `updateAppConfig(partial)`: for each key, validate, then route — trio keys update the in-memory trio + `saveToDisk()`; `GLOBAL_KEYS` → `db.appSettings.set(key, value)`; `PROMPT_KEYS` → `db.userSettings.set(IMPLICIT_ADMIN_ID, key, value)`. Keep `restartRequired = merged.webPort !== previous.webPort`. Return `{ config: this.getAppConfig fresh, restartRequired }`.
  5. `setActualWebPort(actual)` continues to write the trio to `config.json` only.

  Reuse the `GLOBAL_KEYS` / `PROMPT_KEYS` arrays by exporting them from `src/server/db/import/importConfigJson.ts` (single source of truth — DRY). The trio keys are the complement.

```ts
// Sketch of the routing in updateAppConfig (full method written against the current Config.ts):
import { GLOBAL_KEYS, PROMPT_KEYS } from './db/import/importConfigJson';
import { Db } from './db/Db';
import { IMPLICIT_ADMIN_ID } from './db/constants';
// ...
const TRIO = new Set(['installMode', 'webPort', 'firstRunComplete']);
public updateAppConfig(partial: Partial<AppConfig>): { config: AppConfig; restartRequired: boolean } {
    const prevWebPort = this._appConfig.webPort;
    for (const key of Object.keys(partial) as (keyof AppConfig)[]) {
        const value = partial[key];
        if (value === undefined) continue;
        const r = validateField(key, value);
        if (!r.ok) throw new ConfigValidationError(r.error, key as string);
        (this._appConfig as Record<string, unknown>)[key] = r.value;
        if (TRIO.has(key as string)) { /* persisted by saveToDisk below */ }
        else if ((GLOBAL_KEYS as readonly string[]).includes(key as string)) this._db.appSettings.set(key as string, r.value);
        else if ((PROMPT_KEYS as readonly string[]).includes(key as string)) this._db.userSettings.set(IMPLICIT_ADMIN_ID, key as string, r.value);
    }
    this.saveToDisk(); // trio only
    const restartRequired = this._appConfig.webPort !== prevWebPort;
    return { config: this.getAppConfig(), restartRequired };
}
```

- [ ] **Step 4: Run → PASS** (the new test + the existing `Config` tests must all stay green).

Run: `npx vitest run src/server/__tests__/config.storeBacked.test.ts && npx vitest run src/server/__tests__/config.depsPath.test.ts`
Expected: PASS. If the existing `config.*` tests assumed extra fields in `config.json`, update those expectations to the trio-only file (the behavior change is intentional and covered).

- [ ] **Step 5: Commit**

```bash
git add src/server/Config.ts src/server/db/import/importConfigJson.ts src/server/__tests__/config.storeBacked.test.ts
git commit -m "feat(config): split boot trio (config.json) from store-backed settings"
```

---

## Task 14: wire backup-on-shutdown + trim config.example.json + node warning flag

**Files:**
- Modify: `src/server/index.ts` (the `gracefulShutdown` function), `config.example.json`, `launcher/src/spawn.rs`, `scripts/dev-supervisor.mjs`
- Test: `src/server/__tests__/gracefulShutdownBackup.test.ts` (light — assert the call is wired)

- [ ] **Step 1: Trim `config.example.json`** to the trio with a comment-free JSON (JSON has no comments; keep it minimal):

```json
{
  "installMode": null,
  "webPort": 8000,
  "firstRunComplete": false
}
```

- [ ] **Step 2: Add the backup call** in `index.ts` `gracefulShutdown()` (after services are released, best-effort):

```ts
// inside gracefulShutdown(), after runningServices.forEach(... release()):
try {
    const dataRoot = config.dataRoot;
    if (dataRoot) Db.getInstance(dataRoot).backup(require('path').join(dataRoot, 'wsscrcpy.db.bak'));
} catch (err) {
    serverLog.warn(`db backup on shutdown failed: ${(err as Error).message}`);
}
```

> `VACUUM INTO` fails if the target exists; delete a prior `.bak` first or write to a temp name then rename. Implementer: `fs.rmSync(bak, { force: true })` before `backup(bak)`.

- [ ] **Step 3: Local-Deps verification (REQUIRED).** Confirm no change in this task introduces a system-PATH or env-var binary lookup. `node:sqlite` is compiled into the bundled Node (no separate binary). The node-flag additions below pass an argument to the **already-locally-resolved** node binary — they do not change how node is located. Re-read each edited spawn site and confirm the node path still resolves to the app's local dependencies.

- [ ] **Step 4: Add the warning-suppression flag** to the node argv in `launcher/src/spawn.rs` (where the node child command is built) and `scripts/dev-supervisor.mjs`: insert `--disable-warning=ExperimentalWarning` as the first node argument (before the script path). This only quiets the cosmetic `node:sqlite` warning; it does not affect resolution.

- [ ] **Step 5: Run the full gate**

Run:
```bash
npm run -s tsc
npx vitest run
```
Expected: `tsc` clean; all vitest green (incl. the existing suite — no regressions). `config.rs` is untouched, so no Rust change is required; if `spawn.rs` was edited, run `cargo build -p launcher` (or the repo's `cross` invocation) to confirm it compiles.

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts config.example.json launcher/src/spawn.rs scripts/dev-supervisor.mjs src/server/__tests__/gracefulShutdownBackup.test.ts
git commit -m "feat(db): backup-on-shutdown + trim config.example + quiet node:sqlite warning"
```

---

## Self-review checklist (run before handing off)

- [ ] **Spec coverage:** store (`Db`/openDatabase/migrations) ✓; v1 schema incl. all 7 tables ✓; `node:sqlite` + spike ✓; boot skeleton (trio in JSON, `config.rs` untouched) ✓; repositories ✓; seed implicit admin + `authEnabled=false` ✓; server-side import (config.json + device-labels.json) ✓; integrity + backup ✓; WAL/busy_timeout/foreign_keys ✓. **Deferred to later phases (correctly):** SessionStore repo (P4), `device_settings` methods (P3), per-user prompt *consumer* retargeting beyond Config (P3), auth (P4).
- [ ] **Placeholder scan:** no "TODO"/"add error handling"/"similar to" — every task has concrete code + commands.
- [ ] **Type consistency:** `Db.getInstance(dataRoot)`, repo names (`users`/`userSettings`/`appSettings`/`devices`), `IMPLICIT_ADMIN_ID`, `GLOBAL_KEYS`/`PROMPT_KEYS`, `BootTrio` — used identically across Tasks 8/10/12/13.
- [ ] **No-behavior-change invariant:** `Config.getAppConfig()`/`updateAppConfig()` signatures unchanged; consumers untouched.
