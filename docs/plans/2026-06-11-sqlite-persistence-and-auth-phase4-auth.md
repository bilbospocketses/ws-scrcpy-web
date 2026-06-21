# Auth Subsystem (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional, opt-in authentication — inert until the first real user is added, then locking the whole app (HTTP **and** WS) behind login, with `{user, admin}` roles, self-service password change, admin disable/unlock, brute-force lockout, and a reversible open-mode toggle.

**Architecture:** Enforcement is gated by `app_settings.authEnabled`. Login mints a DB-backed opaque session (httpOnly cookie holds a random token; the server stores its SHA-256). An `AuthGate` runs first in the HTTP handler chain; the WS `connection` handler validates the same cookie. The lockout state machine and password hashing are pure, injectable functions. `resolveUserId(req)` (Phase 2 seam) now returns the session user.

**Tech Stack:** TypeScript, `node:crypto` (`scrypt`, `randomBytes`, `createHash`, `timingSafeEqual` — all compiled into Node, Local-Deps clean), the Phase-1 `Db`/repos, vitest.

**Spec:** `docs/specs/2026-06-11-sqlite-persistence-and-auth-design.md` (Auth subsystem). **Depends on Phases 1–3.** **Coordination:** the Users modal, login page, admin-only section hiding, and change-password control land in the Settings modal area that **beta.62** restructures — the client tasks rebase onto post-beta.62.

> **⚠️ Phase 1 as-built (read first, PR #425).** (1) New `UserStore` auth methods that cast `.all()` rows MUST use a `type` / inline literal, NOT an `interface` (the existing `UserRow` is already a `type` for this reason). (2) The app has a request gate now — `src/server/security/requestGate.ts` (#367, origin/Host validation, **not** user-login) — so order `AuthGate` relative to it in the HTTP chain rather than assuming an empty chain; user-login itself is still greenfield. (3) The DB is reached via `Config.getInstance().db`; the `users` + `sessions` tables already exist in the v1 schema. (4) Re-pin the Settings-modal / `WebSocketServer` line targets against the current (post-beta.66) tree.

---

## File structure

| File | Responsibility |
|---|---|
| `src/server/auth/password.ts` | `hashPassword` / `verifyPassword` (scrypt PHC, timing-safe). |
| `src/server/auth/loginPolicy.ts` | Pure lockout state machine (`isLocked`/`applyFailure`/`clearedState`/`extendLock`). |
| `src/server/auth/session.ts` | Token mint/hash + `SessionStore` (DB-backed sessions). |
| `src/server/auth/authState.ts` | `isAuthEnabled`/`setAuthEnabled`; allow-list; cookie parse; `sessionUserId`. |
| `src/server/auth/loginService.ts` | `login()` orchestration (policy + password + sessions + user). |
| `src/server/auth/lockdown.ts` | `lockdown()` transaction (set admin pw + create first user + enable). |
| `src/server/auth/AuthGate.ts` | HTTP gate (ApiHandler, registered first). |
| `src/server/db/UserStore.ts` | **+** auth methods (`setPasswordHash`/`setRole`/`setDisabled`/`setUsername`/`delete`/`countEnabledAdmins`/`countEnabledAdminsWithPassword`/`setLastLogin`/`setLockout`/`clearLockout`). |
| `src/server/api/AuthApi.ts` | `login`/`logout`/`me`/`change-password`/`enable`/`disable`. |
| `src/server/api/UsersApi.ts` | `list`/`create`(lockdown)/`patch`(role/reset/disable/unlock)/`delete`. |
| `src/server/auth/currentUser.ts` | **Modify.** `resolveUserId(req)` → session user. |
| `src/server/services/WebSocketServer.ts` | **Modify.** Validate the session cookie in `connection`; per-recipient label overlay. |
| `src/server/services/HttpServer.ts` | **Modify.** `addApiHandler` must keep `AuthGate` first; or add `addFirstApiHandler`. |
| `src/server/index.ts` | **Modify.** Register `AuthGate` first; `AuthApi`/`UsersApi`. |
| `src/app/...` (login page, Users modal, change-pw, section hiding) | **Create/Modify** (rebase beta.62). |

---

## Task 1: password hashing (scrypt PHC)

**Files:** Create `src/server/auth/password.ts`; Test `src/server/auth/__tests__/password.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../password';

describe('password hashing', () => {
    it('verifies a correct password and rejects a wrong one', () => {
        const h = hashPassword('hunter2');
        expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
        expect(verifyPassword('hunter2', h)).toBe(true);
        expect(verifyPassword('Hunter2', h)).toBe(false);
    });
    it('produces a distinct salt per call', () => {
        expect(hashPassword('x')).not.toBe(hashPassword('x'));
    });
    it('returns false for a malformed stored hash', () => {
        expect(verifyPassword('x', 'not-a-phc-string')).toBe(false);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/password.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/auth/password.ts
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(plain: string): string {
    const salt = randomBytes(16);
    const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(auth): scrypt password hashing"`

---

## Task 2: lockout state machine (pure)

**Files:** Create `src/server/auth/loginPolicy.ts`; Test `src/server/auth/__tests__/loginPolicy.test.ts`

- [ ] **Step 1: Failing test** (exact spec rules: 5 fails / 5 min lock; 15-min inactivity unlock)

```ts
import { describe, it, expect } from 'vitest';
import { applyFailure, isLocked, clearedState, extendLock, WINDOW_MS, LOCK_MS } from '../loginPolicy';

const base = { failedAttempts: 0, lockoutWindowStart: null as number | null, lockedUntil: null as number | null };

describe('loginPolicy', () => {
    it('locks on the 5th failure inside the 5-minute window', () => {
        let s = base;
        for (let i = 0; i < 4; i++) s = applyFailure(s, 1000);
        expect(s.lockedUntil).toBeNull();
        s = applyFailure(s, 1000);
        expect(s.failedAttempts).toBe(5);
        expect(s.lockedUntil).toBe(1000 + LOCK_MS);
        expect(isLocked(s, 1000)).toBe(true);
    });
    it('resets the counter when the window has elapsed', () => {
        let s = applyFailure(base, 0);
        s = applyFailure(s, WINDOW_MS + 1); // new window
        expect(s.failedAttempts).toBe(1);
        expect(s.lockedUntil).toBeNull();
    });
    it('auto-unlocks after the lock expires', () => {
        const locked = { failedAttempts: 5, lockoutWindowStart: 0, lockedUntil: LOCK_MS };
        expect(isLocked(locked, LOCK_MS - 1)).toBe(true);
        expect(isLocked(locked, LOCK_MS)).toBe(false);
    });
    it('extendLock pushes the unlock 15 min from the latest attempt', () => {
        expect(extendLock(5000).lockedUntil).toBe(5000 + LOCK_MS);
    });
    it('clearedState zeroes everything', () => {
        expect(clearedState()).toEqual({ failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null });
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/loginPolicy.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/auth/loginPolicy.ts
export interface LockoutState {
    failedAttempts: number;
    lockoutWindowStart: number | null;
    lockedUntil: number | null;
}

export const MAX_FAILS = 5;
export const WINDOW_MS = 5 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

export function isLocked(s: LockoutState, now: number): boolean {
    return s.lockedUntil !== null && now < s.lockedUntil;
}

export function clearedState(): LockoutState {
    return { failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null };
}

export function extendLock(now: number): LockoutState {
    return { failedAttempts: MAX_FAILS, lockoutWindowStart: null, lockedUntil: now + LOCK_MS };
}

export function applyFailure(s: LockoutState, now: number): LockoutState {
    let windowStart = s.lockoutWindowStart;
    let fails = s.failedAttempts;
    if (windowStart === null || now - windowStart > WINDOW_MS) {
        windowStart = now;
        fails = 0;
    }
    fails += 1;
    const lockedUntil = fails >= MAX_FAILS ? now + LOCK_MS : null;
    return { failedAttempts: fails, lockoutWindowStart: windowStart, lockedUntil };
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(auth): brute-force lockout state machine"`

---

## Task 3: UserStore auth methods

**Files:** Modify `src/server/db/UserStore.ts`; Test `src/server/db/__tests__/userStoreAuth.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { UserStore } from '../UserStore';

let db: DatabaseSync; let store: UserStore;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); store = new UserStore(db); });

describe('UserStore auth methods', () => {
    it('sets password/role/disabled/username/lastLogin', () => {
        store.setPasswordHash(1, 'scrypt$...');
        store.setUsername(1, 'owner');
        store.setRole(1, 'admin');
        store.setDisabled(1, true);
        store.setLastLogin(1, 999);
        const u = store.getById(1)!;
        expect(u).toMatchObject({ username: 'owner', passwordHash: 'scrypt$...', disabled: true, lastLoginAt: 999 });
    });
    it('counts enabled admins and enabled-admins-with-password', () => {
        expect(store.countEnabledAdmins()).toBe(1);                 // seeded admin, no pw
        expect(store.countEnabledAdminsWithPassword()).toBe(0);
        store.setPasswordHash(1, 'scrypt$...');
        expect(store.countEnabledAdminsWithPassword()).toBe(1);
        store.setDisabled(1, true);
        expect(store.countEnabledAdmins()).toBe(0);
    });
    it('persists and clears lockout state', () => {
        store.setLockout(1, { failedAttempts: 5, lockoutWindowStart: 10, lockedUntil: 9000 });
        expect(store.getById(1)).toMatchObject({ failedAttempts: 5, lockedUntil: 9000 });
        store.clearLockout(1);
        expect(store.getById(1)).toMatchObject({ failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null });
    });
    it('deletes a user', () => {
        const u = store.create({ username: 'bob', role: 'user', passwordHash: null });
        store.delete(u.id);
        expect(store.getById(u.id)).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/db/__tests__/userStoreAuth.test.ts`

- [ ] **Step 3: Implement** (append to `UserStore`; import `LockoutState` from `../auth/loginPolicy`)

```ts
    setPasswordHash(id: number, hash: string): void {
        this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    }
    setUsername(id: number, username: string): void {
        this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    }
    setRole(id: number, role: Role): void {
        this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    setDisabled(id: number, disabled: boolean): void {
        this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    }
    setLastLogin(id: number, at: number): void {
        this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, id);
    }
    delete(id: number): void {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    countEnabledAdmins(): number {
        return (this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get() as { c: number }).c;
    }
    countEnabledAdminsWithPassword(): number {
        return (this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL").get() as { c: number }).c;
    }
    setLockout(id: number, s: { failedAttempts: number; lockoutWindowStart: number | null; lockedUntil: number | null }): void {
        this.db.prepare('UPDATE users SET failed_attempts = ?, lockout_window_start = ?, locked_until = ? WHERE id = ?')
            .run(s.failedAttempts, s.lockoutWindowStart, s.lockedUntil, id);
    }
    clearLockout(id: number): void {
        this.db.prepare('UPDATE users SET failed_attempts = 0, lockout_window_start = NULL, locked_until = NULL WHERE id = ?').run(id);
    }
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(db): UserStore auth methods"`

---

## Task 4: sessions (token mint/hash + SessionStore)

**Files:** Create `src/server/auth/session.ts`; Test `src/server/auth/__tests__/session.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../db/migrations';
import { SessionStore, hashToken } from '../session';

let db: DatabaseSync; let store: SessionStore;
beforeEach(() => { db = new DatabaseSync(':memory:'); runMigrations(db); store = new SessionStore(db); });

describe('SessionStore', () => {
    it('mints a token, stores only its hash, and validates it', () => {
        const token = store.create(1, 1000, 60_000);
        const stored = db.prepare('SELECT token_hash, user_id FROM sessions').get() as { token_hash: string; user_id: number };
        expect(stored.token_hash).toBe(hashToken(token));
        expect(stored.token_hash).not.toBe(token);             // raw token never stored
        expect(store.findValid(token, 2000)?.userId).toBe(1);
    });
    it('rejects + deletes an expired session', () => {
        const token = store.create(1, 0, 1000);
        expect(store.findValid(token, 1001)).toBeUndefined();
        expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    });
    it('slides the expiry on use', () => {
        const token = store.create(1, 0, 1000);
        store.findValid(token, 500); // slides to 500 + ttl
        const row = db.prepare('SELECT expires_at FROM sessions').get() as { expires_at: number };
        expect(row.expires_at).toBeGreaterThan(1000);
    });
    it('deletes by token and by user', () => {
        const t1 = store.create(1, 0, 10_000);
        store.create(1, 0, 10_000);
        store.delete(t1);
        expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1);
        store.deleteForUser(1);
        expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/session.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/auth/session.ts
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

export function newToken(): string {
    return randomBytes(32).toString('base64url');
}
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
    constructor(private readonly db: DatabaseSync) {}

    create(userId: number, now: number, ttlMs: number = SESSION_TTL_MS): string {
        const token = newToken();
        this.db
            .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
            .run(hashToken(token), userId, now, now + ttlMs, now);
        return token;
    }

    findValid(token: string, now: number, ttlMs: number = SESSION_TTL_MS): { userId: number } | undefined {
        const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
            { user_id: number; expires_at: number } | undefined;
        if (!row) return undefined;
        if (now >= row.expires_at) {
            this.delete(token);
            return undefined;
        }
        this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, now + ttlMs, hashToken(token));
        return { userId: row.user_id };
    }

    delete(token: string): void {
        this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }
    deleteForUser(userId: number): void {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(auth): DB-backed sessions (hashed opaque token, sliding expiry)"`

---

## Task 5: auth state helpers (enabled flag, cookie, allow-list)

**Files:** Create `src/server/auth/authState.ts`; Test `src/server/auth/__tests__/authState.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../../db/Db';
import { isAuthEnabled, setAuthEnabled, parseCookie, isAllowlisted, SESSION_COOKIE } from '../authState';

const dirs: string[] = [];
afterEach(() => { Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('authState', () => {
    it('reads/writes authEnabled (default false)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsas-')); dirs.push(dir);
        const db = Db.getInstance(dir);
        expect(isAuthEnabled(db)).toBe(false);
        setAuthEnabled(db, true);
        expect(isAuthEnabled(db)).toBe(true);
    });
    it('parses the session cookie', () => {
        expect(parseCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`)?.[SESSION_COOKIE]).toBe('abc.def');
        expect(parseCookie(undefined)).toEqual({});
    });
    it('allow-lists the login page + login endpoint only', () => {
        expect(isAllowlisted('/api/auth/login')).toBe(true);
        expect(isAllowlisted('/api/whoami')).toBe(true);   // install port-discovery handshake stays reachable under lockdown
        expect(isAllowlisted('/api/auth/me')).toBe(true);  // login page reads authEnabled pre-login
        expect(isAllowlisted('/api/devices')).toBe(false);
        expect(isAllowlisted('/')).toBe(false);            // app shell is gated → AuthGate serves the login page inline
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/authState.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/auth/authState.ts
import type { Db } from '../db/Db';
import { AUTH_ENABLED_KEY } from '../db/constants';

export const SESSION_COOKIE = 'wsscrcpy_sid';

// `/login` is NOT here: AuthGate serves the login page body itself (see Task 8) so it never
// falls through to the SPA catch-all (`createStaticHandler` serves index.html for any non-file
// path — Auditor finding: app-shell leak). whoami + me are public reads (no secret).
const ALLOWLIST_EXACT = new Set(['/api/auth/login', '/api/auth/me', '/api/whoami']);
const ALLOWLIST_PREFIX = ['/login-assets/']; // the login page's own self-contained assets

export function isAuthEnabled(db: Db): boolean {
    return db.appSettings.get(AUTH_ENABLED_KEY) === true;
}
export function setAuthEnabled(db: Db, on: boolean): void {
    db.appSettings.set(AUTH_ENABLED_KEY, on);
}

export function parseCookie(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

export function isAllowlisted(pathname: string): boolean {
    return ALLOWLIST_EXACT.has(pathname) || ALLOWLIST_PREFIX.some((p) => pathname.startsWith(p));
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(auth): authEnabled + cookie + allow-list helpers"`

---

## Task 6: login orchestration

**Files:** Create `src/server/auth/loginService.ts`; Test `src/server/auth/__tests__/loginService.test.ts`

Ties policy + password + sessions + user into one `login(db, username, password, now)` returning a discriminated result.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../../db/Db';
import { login } from '../loginService';
import { hashPassword } from '../password';
import { LOCK_MS } from '../loginPolicy';

let dir: string; let db: Db;
beforeEach(() => {
    Db._resetForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslog-'));
    db = Db.getInstance(dir);
    db.users.setPasswordHash(1, hashPassword('correct')); // admin id 1
});

describe('login', () => {
    it('succeeds with the right password and returns a session token', () => {
        const r = login(db, 'admin', 'correct', 1000);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.token.length).toBeGreaterThan(20);
    });
    it('rejects an unknown user generically', () => {
        expect(login(db, 'nobody', 'x', 1000)).toEqual({ ok: false, reason: 'invalid' });
    });
    it('rejects a disabled user', () => {
        db.users.setDisabled(1, true);
        expect(login(db, 'admin', 'correct', 1000)).toEqual({ ok: false, reason: 'disabled' });
    });
    it('locks after 5 failures and reports locked', () => {
        for (let i = 0; i < 5; i++) login(db, 'admin', 'wrong', 1000);
        const r = login(db, 'admin', 'correct', 1000);
        expect(r).toEqual({ ok: false, reason: 'locked' }); // correct pw ignored while locked
        // auto-unlock after the window
        const r2 = login(db, 'admin', 'correct', 1000 + LOCK_MS + 1);
        expect(r2.ok).toBe(true);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/loginService.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/auth/loginService.ts
import type { Db } from '../db/Db';
import { verifyPassword } from './password';
import { applyFailure, clearedState, extendLock, isLocked } from './loginPolicy';
import { SessionStore } from './session';

export type LoginResult =
    | { ok: true; token: string; userId: number }
    | { ok: false; reason: 'invalid' | 'disabled' | 'locked' };

export function login(db: Db, username: string, password: string, now: number): LoginResult {
    const user = db.users.getByUsername(username);
    if (!user) return { ok: false, reason: 'invalid' };
    if (user.disabled) return { ok: false, reason: 'disabled' };

    const state = { failedAttempts: user.failedAttempts, lockoutWindowStart: user.lockoutWindowStart, lockedUntil: user.lockedUntil };
    if (isLocked(state, now)) {
        db.users.setLockout(user.id, extendLock(now)); // inactivity timer resets on every attempt while locked
        return { ok: false, reason: 'locked' };
    }
    // Lock expired (or never locked): proceed; clear stale lock on expiry.
    if (state.lockedUntil !== null) db.users.clearLockout(user.id);

    if (user.passwordHash && verifyPassword(password, user.passwordHash)) {
        db.users.clearLockout(user.id);
        db.users.setLastLogin(user.id, now);
        const token = new SessionStore(db.sqlite).create(user.id, now);
        return { ok: true, token, userId: user.id };
    }

    const next = applyFailure({ ...state, lockedUntil: null }, now);
    db.users.setLockout(user.id, next);
    return { ok: false, reason: 'invalid' };
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(auth): login orchestration (policy + password + session)"`

---

## Task 7: lockdown transaction

**Files:** Create `src/server/auth/lockdown.ts`; Test `src/server/auth/__tests__/lockdown.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../../db/Db';
import { lockdown } from '../lockdown';
import { isAuthEnabled } from '../authState';
import { verifyPassword } from '../password';

let dir: string; let db: Db;
beforeEach(() => { Db._resetForTest(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslk-')); db = Db.getInstance(dir); });

describe('lockdown', () => {
    it('sets the admin password, creates the first user, and enables auth atomically', () => {
        lockdown(db, { adminUsername: 'owner', adminPassword: 'admin-pw', newUser: { username: 'bob', role: 'user', password: 'bob-pw' } });
        const admin = db.users.getById(1)!;
        expect(admin.username).toBe('owner');
        expect(verifyPassword('admin-pw', admin.passwordHash!)).toBe(true);
        const bob = db.users.getByUsername('bob')!;
        expect(verifyPassword('bob-pw', bob.passwordHash!)).toBe(true);
        expect(isAuthEnabled(db)).toBe(true);
    });
    it('rejects when an admin password already exists (not the first-user path)', () => {
        db.users.setPasswordHash(1, 'scrypt$...');
        expect(() => lockdown(db, { adminUsername: 'x', adminPassword: 'y', newUser: { username: 'z', role: 'user', password: 'p' } })).toThrow();
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/lockdown.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/server/auth/lockdown.ts
import type { Db } from '../db/Db';
import { hashPassword } from './password';
import { setAuthEnabled } from './authState';
import { IMPLICIT_ADMIN_ID } from '../db/constants';

export interface LockdownParams {
    adminUsername: string;
    adminPassword: string;
    newUser: { username: string; role: 'user' | 'admin'; password: string };
}

export function lockdown(db: Db, params: LockdownParams): void {
    const admin = db.users.getById(IMPLICIT_ADMIN_ID);
    if (!admin) throw new Error('implicit admin missing');
    if (admin.passwordHash !== null) throw new Error('admin password already set; not the first-user lockdown path');

    const sqlite = db.sqlite;
    sqlite.exec('BEGIN');
    try {
        db.users.setUsername(IMPLICIT_ADMIN_ID, params.adminUsername);
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword(params.adminPassword));
        db.users.create({ username: params.newUser.username, role: params.newUser.role, passwordHash: hashPassword(params.newUser.password) });
        setAuthEnabled(db, true);
        sqlite.exec('COMMIT');
    } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
    }
}
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `git commit -m "feat(auth): atomic lockdown transaction"`

---

## Task 8: AuthGate (HTTP) + resolveUserId extension

**Files:** Create `src/server/auth/AuthGate.ts`; Modify `src/server/auth/currentUser.ts`, `src/server/services/HttpServer.ts`, `src/server/index.ts`; Test `src/server/auth/__tests__/authGate.test.ts`

- [ ] **Step 1: Failing test** (decision logic; uses the repo HTTP mock helper)

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../../db/Db';
import { AuthGate } from '../AuthGate';
import { SessionStore, SESSION_TTL_MS } from '../session';
import { setAuthEnabled, SESSION_COOKIE } from '../authState';
import { makeReqRes } from '../../__tests__/helpers/httpMock';

const dirs: string[] = [];
afterEach(() => { Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function db(): Db { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsgate-')); dirs.push(d); return Db.getInstance(d); }

describe('AuthGate', () => {
    it('passes through entirely in open mode', async () => {
        const gate = new AuthGate(() => db());
        const { req, res, handled } = await runGate(gate, 'GET', '/api/devices', undefined);
        expect(handled).toBe(false); void req; void res;
    });
    it('401s an unauthenticated API request when locked', async () => {
        const d = db(); setAuthEnabled(d, true);
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/api/devices', undefined);
        expect(handled).toBe(true);
        expect(status).toBe(401);
    });
    it('passes a valid session through and attaches the user', async () => {
        const d = db(); setAuthEnabled(d, true);
        const token = new SessionStore(d.sqlite).create(1, Date.now(), SESSION_TTL_MS);
        const gate = new AuthGate(() => d);
        const { req, handled } = await runGate(gate, 'GET', '/api/devices', `${SESSION_COOKIE}=${token}`);
        expect(handled).toBe(false);
        expect((req as { user?: { id: number } }).user?.id).toBe(1);
    });
});

// runGate: build req/res via makeReqRes with a Cookie header, call gate.handle, capture handled + status.
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/auth/__tests__/authGate.test.ts`

- [ ] **Step 3: Implement** AuthGate (constructor takes a `() => Db` so tests inject; production passes `() => Db.getInstance(Config.getInstance().dataRoot ?? ...)`)

```ts
// src/server/auth/AuthGate.ts
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from '../db/Db';
import { isAuthEnabled, isAllowlisted, parseCookie, SESSION_COOKIE } from './authState';
import { SessionStore } from './session';

export class AuthGate {
    constructor(private readonly getDb: () => Db) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const db = this.getDb();
        if (!isAuthEnabled(db)) return false; // open mode → not our concern

        const url = new URL(req.url ?? '/', 'http://localhost');
        if (isAllowlisted(url.pathname)) return false;

        const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
        const session = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
        if (!session) {
            if (url.pathname.startsWith('/api/')) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
            } else {
                // Serve the self-contained login page INLINE — do NOT redirect to /login and
                // let it fall through to createStaticHandler's index.html SPA fallback (that
                // would leak the app shell at /login). The page pulls only /login-assets/*.
                serveLoginPage(res);
            }
            return true; // handled → short-circuit
        }
        (req as IncomingMessage & { user?: unknown }).user = db.users.getById(session.userId);
        return false; // authenticated → let the real handler run
    }
}

// Reads the bundled login page (its own HTML referencing only /login-assets/*) and writes it
// with 200. The login HTML + assets are emitted by webpack to <public>/login.html +
// <public>/login-assets/ (add a CopyFilePlugin/entry; mirror how favicon.png is emitted).
function serveLoginPage(res: ServerResponse): void {
    const html = readFileSync(join(__dirname, '..', 'public', 'login.html'), 'utf-8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
}
```

> Add the imports `readFileSync` (`fs`) + `join` (`path`) at the top of `AuthGate.ts`. The webpack build must emit `public/login.html` + `public/login-assets/*` (a standalone bundle, like the existing favicon copy) so the login page never depends on the main app bundle (which is gated). `GET /api/auth/me` returns `{ authEnabled, user: null }` when there is no session (it is allow-listed) so the login page can branch without a 401.

- [ ] **Step 4: Extend `resolveUserId`** (currentUser.ts):

```ts
export function resolveUserId(req?: IncomingMessage): number {
    const user = (req as (IncomingMessage & { user?: { id?: number } }) | undefined)?.user;
    return user?.id ?? IMPLICIT_ADMIN_ID;
}
```

- [ ] **Step 5: Register first.** Add `HttpServer.addFirstApiHandler(handler)` (unshift into `apiHandlers`) or document that `AuthGate` must be the first `addApiHandler` call. In `index.ts`, register `AuthGate` **before** every other `addApiHandler`. Confirm via a test that `apiHandlers[0]` is the gate.

- [ ] **Step 6: Run → PASS; full gate** `npm run -s tsc && npx vitest run`. **Step 7: Commit** `git commit -m "feat(auth): HTTP AuthGate + session-aware resolveUserId"`

---

## Task 9: AuthApi + UsersApi

**Files:** Create `src/server/api/AuthApi.ts`, `src/server/api/UsersApi.ts`; Modify `src/server/index.ts`; Tests `src/server/__tests__/authApi.test.ts`, `usersApi.test.ts`

Follow the `ConfigApi` handler pattern (method + pathname switch). **Parse request bodies with `readJsonBody(req)` from `src/server/api/utils.ts`** (the real shared helper — there is NO `ConfigApi.sendJson`; ConfigApi's body reader is private/duplicated). Respond as `ConfigApi` does: `res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(...))` (or add a `sendJson` to `utils.ts` in this task if you want it shared). All write the session cookie / read `resolveUserId(req)` as needed. Compute `db = Db.getInstance(dbDir(Config.getInstance()))` (the canonical resolver — Phase 1 Task 12).

**AuthApi routes:**
- `POST /api/auth/login` → `login(db, username, password, Date.now())`; on `ok`, `Set-Cookie: wsscrcpy_sid=<token>; HttpOnly; SameSite=Lax; Path=/[; Secure]` (Secure when the server is https) and `200`; on `locked`/`disabled`/`invalid` → `401` with a generic message (the body may say "locked" for UX, per spec).
- `POST /api/auth/logout` → delete the cookie's session + clear cookie.
- `GET /api/auth/me` → `{ username, role, authEnabled }` for `resolveUserId(req)`.
- `POST /api/auth/change-password` (any authed) → verify current via `verifyPassword`, then `db.users.setPasswordHash(resolveUserId(req), hashPassword(next))`; `400` on wrong current.
- `POST /api/auth/enable` (admin) → guard `db.users.countEnabledAdminsWithPassword() >= 1` else `409`; `setAuthEnabled(db, true)`.
- `POST /api/auth/disable` (admin) → `setAuthEnabled(db, false)`.

**UsersApi routes (admin-only — return 403 unless `resolveUserId`'s user is admin):**
- `GET /api/users` → list `{ id, username, role, hasPassword: !!passwordHash, disabled, lockedUntil, lastLogin }`.
- `POST /api/users` → **if `!isAuthEnabled(db)`**: this is the first-user path → require `adminUsername`+`adminPassword` in the body and call `lockdown(db, {...})`; **else** `db.users.create({ username, role, passwordHash: hashPassword(password) })`.
- `PATCH /api/users/:id` → any of: `role` (`setRole`), `password` (reset → `setPasswordHash(id, hashPassword(...))`), `disabled` (`setDisabled` + on disable `new SessionStore(db.sqlite).deleteForUser(id)`), `unlock:true` (`clearLockout(id)`). Guard: refuse to disable/demote the **last enabled admin** (`countEnabledAdmins() <= 1` and the target is that admin).
- `DELETE /api/users/:id` → refuse if it would remove the last enabled admin; else `delete` (sessions cascade via FK).

- [ ] **Step 1: Failing tests** — at minimum: login sets a cookie + me returns the user; `GET /api/auth/me` returns `{ authEnabled, user: null }` when unauthenticated (allow-listed); change-password rejects a wrong current; the first `POST /api/users` performs lockdown and flips `authEnabled`; disabling a user deletes their sessions; deleting the last enabled admin is refused; **demoting the last enabled admin to `user` (via `PATCH {role:'user'}`) is refused** (same guard as disable/delete); `enable` is refused with no admin-with-password; admin `unlock` clears a locked-out user.

```ts
// authApi.test.ts (representative)
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../db/Db';
import { Config } from '../Config';
import { UsersApi } from '../api/UsersApi';
import { isAuthEnabled } from '../auth/authState';
import { makeReqRes } from './helpers/httpMock';

const dirs: string[] = [];
afterEach(() => { Db._resetForTest(); Config._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); process.env['DATA_ROOT'] = ''; });

it('first POST /api/users runs lockdown and enables auth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsua-')); dirs.push(dir); process.env['DATA_ROOT'] = dir;
    Config.getInstance();
    const api = new UsersApi();
    const r = makeReqRes('POST', '/api/users', { adminUsername: 'owner', adminPassword: 'pw1', username: 'bob', role: 'user', password: 'pw2' });
    await api.handle(r.req, r.res);
    expect(isAuthEnabled(Db.getInstance(dir))).toBe(true);
    expect(Db.getInstance(dir).users.getByUsername('bob')).toBeTruthy();
});
```

> In open mode `resolveUserId` is the implicit admin (role admin), so the admin-only check passes for the first-user path — correct (only the local owner can be at the console before lockdown).

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/authApi.test.ts src/server/__tests__/usersApi.test.ts`
- [ ] **Step 3: Implement** both handlers per the route specs above; register both in `index.ts`.
- [ ] **Step 4: Run → PASS; full gate.** **Step 5: Commit** `git commit -m "feat(auth): AuthApi + UsersApi (login/users/lockdown/lockout/toggle)"`

---

## Task 9b: role-gate the EXISTING admin endpoints (server-side authorization)

> **Critical (audit finding).** `AuthGate` only authenticates; it attaches `req.user` but does not check role. Admin-only capabilities from the spec's capability map live in **pre-existing** handlers that have no role check. UI section-hiding (Task 11) is cosmetic — a logged-in regular `user` could still `curl` these. This task adds server-side authorization.

**Admin-only routes** (verified handlers): `ConfigApi` `PATCH /api/config` (port change → `process.exit(75)`); `DependencyApi` `/api/dependencies/*`; `ServiceApi` `/api/service/*` (incl. `uninstall-app`, `install-system-wide`); `UpdatesApi` `/api/updates/*` (incl. `/apply`, channel); `ServerShutdownApi` `/api/server/shutdown`. (`UsersApi` already self-checks; `SettingsApi`, the device-label writes, and `/api/auth/*` are per-user, not admin.)

**Files:** Create `src/server/auth/requireAdmin.ts`; Modify each admin handler above; Test `src/server/__tests__/adminAuthorization.test.ts`.

- [ ] **Step 1: Failing test** — each admin route returns 403 for a non-admin session and proceeds for an admin (drive through the handler with a `req.user` set to a `user` vs `admin`).

```ts
import { describe, it, expect } from 'vitest';
import { requireAdmin } from '../auth/requireAdmin';

describe('requireAdmin', () => {
    it('403s a non-admin and returns false (handled)', () => {
        let status = 0;
        const res = { writeHead: (s: number) => { status = s; }, end: () => {} } as unknown as import('http').ServerResponse;
        const req = { user: { id: 2, role: 'user' } } as unknown as import('http').IncomingMessage;
        expect(requireAdmin(req, res)).toBe(false);
        expect(status).toBe(403);
    });
    it('passes an admin (returns true) and open mode (no user → implicit admin)', () => {
        const res = { writeHead: () => {}, end: () => {} } as unknown as import('http').ServerResponse;
        expect(requireAdmin({ user: { id: 1, role: 'admin' } } as never, res)).toBe(true);
        expect(requireAdmin({} as never, res)).toBe(true); // open mode: resolveUserId → implicit admin (role admin)
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/adminAuthorization.test.ts`

- [ ] **Step 3: Implement the guard** (reads the role of `resolveUserId(req)`; in open mode that is the implicit admin → allowed):

```ts
// src/server/auth/requireAdmin.ts
import type { IncomingMessage, ServerResponse } from 'http';
import { Db } from '../db/Db';
import { Config } from '../Config';
import { dbDir } from '../db/Db';            // canonical resolver (Phase 1 Task 12 fix)
import { resolveUserId } from './currentUser';

/** Returns true if the request's acting user is an admin; otherwise writes 403 and returns false. */
export function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
    const db = Db.getInstance(dbDir(Config.getInstance()));
    const user = db.users.getById(resolveUserId(req));
    if (user?.role === 'admin') return true;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return false;
}
```

- [ ] **Step 4: Wire the guard** into each admin handler: at the very top of the matched-route branch (after method/path match, before doing the work), `if (!requireAdmin(req, res)) return true;` (return handled = true to short-circuit). Add a focused test per handler asserting a `user` session gets 403 and an `admin` session proceeds.

> Open-mode correctness: when `authEnabled=false`, `resolveUserId(req)` is the implicit admin (role `admin`), so `requireAdmin` passes — today's open behavior is preserved. Only once locked does a non-admin session hit 403.

- [ ] **Step 5: Run → PASS; full gate.** **Step 6: Commit** `git commit -m "feat(auth): server-side admin authorization on existing admin endpoints"`

---

## Task 10: WebSocket gating + per-user label delivery

**Files:** Modify `src/server/services/WebSocketServer.ts`; Test `src/server/__tests__/wsAuthGate.test.ts`

- [ ] **Step 1: Failing test** — extract the decision into a pure helper so it is testable without a live socket.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../db/Db';
import { wsSessionUserId } from '../services/WebSocketServer';
import { SessionStore } from '../auth/session';
import { setAuthEnabled, SESSION_COOKIE } from '../auth/authState';

const dirs: string[] = [];
afterEach(() => { Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('wsSessionUserId', () => {
    it('returns the implicit admin in open mode', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsws-')); dirs.push(dir);
        expect(wsSessionUserId(Db.getInstance(dir), undefined)).toBe(1);
    });
    it('returns undefined for a missing/invalid cookie when locked', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsws-')); dirs.push(dir);
        const db = Db.getInstance(dir); setAuthEnabled(db, true);
        expect(wsSessionUserId(db, undefined)).toBeUndefined();
        const token = new SessionStore(db.sqlite).create(1, Date.now());
        expect(wsSessionUserId(db, `${SESSION_COOKIE}=${token}`)).toBe(1);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `npx vitest run src/server/__tests__/wsAuthGate.test.ts`
- [ ] **Step 3: Implement** the helper + wire it into `attachToServer`'s `connection` handler. **The check MUST be the first thing after the `request.url` guard and BEFORE the `this.pathHandlers.get(url.pathname)` block** (`WebSocketServer.ts:51`) — `SCAN_WS_PATH` is a registered path handler that dispatches first, so a check placed after it would let an unauthenticated socket reach `ScanMw.attach` (audit finding: scan-path bypass).

```ts
// exported helper (add imports: Db, Config, dbDir, SessionStore, isAuthEnabled, parseCookie,
// SESSION_COOKIE, IMPLICIT_ADMIN_ID)
export function wsSessionUserId(db: Db, cookieHeader: string | undefined): number | undefined {
    if (!isAuthEnabled(db)) return IMPLICIT_ADMIN_ID;
    const token = parseCookie(cookieHeader)[SESSION_COOKIE];
    const s = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
    return s?.userId;
}

// inside wss.on('connection', (ws, request) => { ...
//   after:   if (!request.url) { ws.close(4001, ...); return; }
//            const url = new URL(request.url, 'https://example.org/');
//   and BEFORE: const pathHandler = this.pathHandlers.get(url.pathname);
const db = Db.getInstance(dbDir(Config.getInstance()));   // canonical resolver (Phase 1 Task 12)
const userId = wsSessionUserId(db, request.headers.cookie);
if (userId === undefined) { ws.close(4401, 'unauthorized'); return; }
(ws as WS & { userId?: number }).userId = userId; // stash for per-recipient label overlay (Step 4)
```

- [ ] **Step 4: Per-user label delivery** (resolves the Phase 2 flag). Where the device list is sent to a connection, overlay labels from `db.devices.getAllLabels(userId)` for **that** socket's `userId` rather than the shared `labelFor`. Exact site = the device-list emit in the goog `DeviceTracker` mw / `HostTracker`; pin at execution.
- [ ] **Step 5: Run → PASS; full gate.** **Step 6: Commit** `git commit -m "feat(auth): gate WebSocket upgrade + per-user label delivery"`

---

## Task 11: client — login page, Users modal, change-password, section hiding

**Files (rebase onto beta.62):** `src/app/client/SettingsModal.ts` (Users section + admin-only hiding + change-password control), a new login page + its client, the lockdown "Secure the admin account" flow, an `AuthClient` over `/api/auth/*` + `/api/users`.

> This task is **UI**, layered on the post-beta.62 Settings modal. Keep the testable logic in small pure helpers (e.g. `canSeeSection(role, section)`); drive the HTTP via an `AuthClient` mirroring `SettingsService`.

- [ ] **Step 1:** `AuthClient` — `me()`, `login(u,p)`, `logout()`, `changePassword(cur,next)`, `listUsers()`, `createUser(...)`, `patchUser(id, {...})`, `deleteUser(id)`, `enableAuth()`, `disableAuth()`. Unit test the request shapes (spy `fetch`).
- [ ] **Step 2:** Login page — a standalone route served at `/login` (server static + allow-listed) posting to `/api/auth/login`, reloading to `/` on success, showing the generic error (incl. "temporarily locked") on failure.
- [ ] **Step 3:** Users modal (admin) — list users with role + status (`disabled`, `locked`) and controls: add user, change role, reset password, **disable** checkbox, **unlock** button; "Add user" when `authEnabled === false` first shows **"Secure the admin account"** (confirm username + password, eye toggle) then creates the user (one `POST /api/users` carrying `adminUsername`/`adminPassword`).
- [ ] **Step 4:** Admin-only **section hiding** — gate Dependencies, Updates, Service, Users, webPort, uninstall on `me().role === 'admin'`; a non-admin never renders them. Pure helper `canSeeSection(role, section)` unit-tested.
- [ ] **Step 5:** Change-password control (any user) in Settings → `AuthClient.changePassword`.
- [ ] **Step 6:** Reversible toggle (admin) — an "require login" switch calling `enableAuth()`/`disableAuth()`; disabling returns to open mode.
- [ ] **Step 7: Gate** `npm run -s tsc && npx vitest run`. **Step 8: Commit** `git commit -m "feat(auth): login page, Users modal, change-password, admin section hiding"`

---

## Task 12: final integration gate

- [ ] **Step 1: Local-Deps verification (REQUIRED).** Confirm no auth code resolves a binary via system PATH / env var: hashing + sessions + tokens all use `node:crypto` (compiled into Node); `node:sqlite` is compiled in. No new external binary is introduced. Re-read each new/edited file for spawn/exec/PATH/env-binary patterns → none expected.
- [ ] **Step 2: Full gate** `npm run -s tsc && npx vitest run` → clean + green.
- [ ] **Step 3: Manual smoke checklist** (document in the PR, run on a dev instance): open mode unchanged → add first user (forces admin password) → app locks → login required for HTTP + a device stream (WS) → wrong password ×5 locks → admin unlock clears it → disable a user kicks their session → change own password → toggle auth off → app open again.
- [ ] **Step 4: Commit** any doc/CHANGELOG updates `git commit -m "docs: auth subsystem changelog"`

---

## Self-review checklist

- [ ] **Spec coverage:** sessions (hashed token, sliding) ✓; HTTP gate (allow-list, 401/redirect, admin 403 in APIs) ✓; WS gate (4401) ✓; roles + admin-only hiding ✓; lockdown (airtight, atomic, sets `authEnabled`) ✓; password hashing (scrypt, timing-safe) ✓; self-service change ✓; disable user + session revoke ✓; lockout (5/5min, 15-min unlock, admin override) ✓; reversible toggle + enable guard ✓; per-user label delivery ✓; service-mode orthogonality (identity is the users table) ✓.
- [ ] **Placeholder scan:** server/auth code concrete; client task names exact files + helpers (rebase note is a coordination fact, not a placeholder).
- [ ] **Type consistency:** `login()`/`LoginResult`, `SessionStore.{create,findValid,delete,deleteForUser}`, `hashToken`, `isAuthEnabled`/`setAuthEnabled`, `parseCookie`/`SESSION_COOKIE`, `resolveUserId`, `UserStore` auth methods, `lockdown()` — consistent across tasks and with Phases 1–3 (`Db`, `IMPLICIT_ADMIN_ID`, `AUTH_ENABLED_KEY`).
- [ ] **Security review:** raw token never stored; generic login errors; **server-side admin authorization on the existing admin endpoints (Task 9b — not just UI hiding)**; last-enabled-admin guard on disable/**demote**/delete; enable-auth guarded by an admin-with-password; **WS check before `pathHandlers` dispatch** (scan path not bypassable); login page served inline (no SPA-shell leak at `/login`); `/api/whoami` + `/api/auth/me` allow-listed (install handshake + login-page state). Open mode preserved: `resolveUserId` → implicit admin, so `requireAdmin` passes when `authEnabled=false`.
