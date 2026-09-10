# Admin Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make admin routes require proof that the caller is the operator — loopback or a signed-in admin session — with an explicit, deliberately-taken opt-out for trusted LANs and automation.

**Architecture:** A new `requireOperator` wraps the existing `requireAdmin`, adding a pre-check that the caller is on loopback OR (when auth is on) signed in OR (when auth is off) covered by an explicit opt-out. Six admin handlers swap `requireAdmin` → `requireOperator`; `ServerShutdownApi` keeps its bespoke ladder and gains one clause. `GET /api/config` reports the resulting policy so a new banner can tell the user which state they are in and offer the two ways out — sign-in first, opt-out second behind a red confirmation.

**Tech Stack:** TypeScript (Node 24, `node:http` handlers, no framework), Vitest, Biome, webpack-bundled vanilla-DOM frontend.

**Spec:** `docs/superpowers/specs/2026-09-10-admin-authorization-design.md`

## Global Constraints

- **Test runner:** `npm test` (`vitest run`). A single file: `npx vitest run <path>`.
- **Lint:** `npm run lint` — **check the exit code**, do not eyeball the tail. `npm run lint > /dev/null; echo $?` must print `0`.
- **Opt-out env var name is exactly `WS_SCRCPY_ALLOW_REMOTE_ADMIN`, value exactly `'1'`.** `qa-harness` sets this literal; a typo silently disables the escape hatch.
- **Config key name is exactly `allowRemoteAdmin`.**
- **`GET /api/config` must stay reachable, 200, with no token, from off-box, in every state.** It is the launcher's readiness probe, the Docker image's `HEALTHCHECK`, and `qa-harness`'s `ReadyPath` (`config/linux.psd1:81`). Breaking it breaks all three at once.
- **`requireAdmin` always runs last** so a signed-in non-admin is still refused everywhere.
- **⚠️ The opt-out MUST stay inert when sign-in is enabled.** `requireOperator` uses a **ternary** —
  `isAuthEnabled(db) ? hasAuthenticatedUser(req) : allowRemoteAdmin()` — so `allowRemoteAdmin()` is
  never even called once auth is on. A flag left set from an earlier container run therefore does
  **not** open a route around the login. **Do not "simplify" that ternary into
  `hasAuthenticatedUser(req) || allowRemoteAdmin()`** — that reads as equivalent and is the exact
  bypass this design exists to prevent. Task 2's test pins the behaviour; `ServerShutdownApi`'s new
  clause guards on `!isAuthEnabled(...)` for the same reason.
- **Do not edit `docs/smoke-tests/`.** Todo task 28 will rewrite the register and its row markers. Smoke row 20.6 is affected; it goes to `qa-harness` as a relay request.
- **CHANGELOG entries go under `## [Unreleased]`**, never a pre-written version heading — `bump-version.mjs` aborts otherwise.
- **One `release:beta` PR** for the whole feature; no manual version bump.

### Deviation from the spec (deliberate)

The spec names the new module `src/server/security/requireOperator.ts`. This plan puts it at
**`src/server/auth/requireOperator.ts`** instead, beside the `requireAdmin` it wraps.
`security/loopback.ts` is a network *primitive*; this is an authorization *policy* and belongs with
the other one. `auth/requireAdmin.ts` already imports `../Config`, so the import direction is
established.

### Precondition — qa-harness lands first

**Do not start Task 3 until the `qa-harness` PR setting `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1` has merged.**
Tasks 1, 2 and 9's doc reading can proceed in parallel; Task 3 is the first one that changes
behaviour. Setting the variable in the harness is a no-op until this repo reads it, so it is safe
early and breaks the harness if late.

---

### Task 1: The `requireOperator` guard

**Files:**
- Create: `src/server/auth/requireOperator.ts`
- Create: `src/server/auth/__tests__/requireOperator.test.ts`
- Modify: `src/server/api/ServerShutdownApi.ts:10-12` (delete the local `hasAuthenticatedUser`, import it instead)

**Interfaces:**
- Consumes: `isLoopback` (`src/server/security/loopback.ts`), `requireAdmin` (`src/server/auth/requireAdmin.ts`), `isAuthEnabled` (`src/server/auth/authState.ts`), `Config` (`src/server/Config.ts`).
- Produces:
  - `export function hasAuthenticatedUser(req: IncomingMessage): boolean`
  - `export function requireOperator(req: IncomingMessage, res: ServerResponse): boolean`
  - `export function allowRemoteAdmin(): boolean` — **stubbed in this task, implemented in Task 2.** It returns `false` here so Task 1's tests pin the no-opt-out behaviour; Task 2 replaces the body and adds its own tests.

- [ ] **Step 1: Write the failing test**

Create `src/server/auth/__tests__/requireOperator.test.ts`:

```ts
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../../Config';
import { EnvName } from '../../EnvName';
import { setAuthEnabled } from '../authState';
import { requireOperator } from '../requireOperator';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsauth-oper-'));
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

function mkRes(): { res: ServerResponse; status: () => number; body: () => string } {
    let status = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        end(c?: string) {
            if (c) chunks.push(c);
        },
    } as unknown as ServerResponse;
    return { res, status: () => status, body: () => chunks.join('') };
}

function mkReq(remoteAddress: string | undefined, user?: { id: number }): IncomingMessage {
    const req = {} as IncomingMessage;
    if (remoteAddress !== undefined) {
        (req as { socket?: unknown }).socket = { remoteAddress };
    }
    if (user) (req as IncomingMessage & { user?: unknown }).user = user;
    return req;
}

describe('requireOperator — open mode', () => {
    it('allows a loopback caller (implicit admin)', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq('127.0.0.1'), r.res)).toBe(true);
    });

    it('allows an IPv4-mapped loopback caller', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq('::ffff:127.0.0.1'), r.res)).toBe(true);
    });

    it('403s an off-box caller with no opt-out', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
        expect(JSON.parse(r.body())).toEqual({ error: 'admin actions are limited to this machine' });
    });

    it('403s a caller with no socket at all — fail closed', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq(undefined), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });
});

describe('requireOperator — auth enabled', () => {
    it('allows a signed-in admin from off-box (loopback irrelevant)', () => {
        setup();
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const admin = db.users.create({ username: 'root', role: 'admin', passwordHash: 'x' });
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50', { id: admin.id }), r.res)).toBe(true);
    });

    it('403s a signed-in NON-admin from loopback — requireAdmin still runs last', () => {
        setup();
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const r = mkRes();
        expect(requireOperator(mkReq('127.0.0.1', { id: bob.id }), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });

    it('403s an unauthenticated off-box caller', () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/auth/__tests__/requireOperator.test.ts`
Expected: FAIL — `Failed to resolve import "../requireOperator"`.

- [ ] **Step 3: Write the implementation**

Create `src/server/auth/requireOperator.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'http';
import { Config } from '../Config';
import { isLoopback } from '../security/loopback';
import { isAuthEnabled } from './authState';
import { requireAdmin } from './requireAdmin';

/** True when AuthGate attached a session to this request. */
export function hasAuthenticatedUser(req: IncomingMessage): boolean {
    return (req as IncomingMessage & { user?: unknown }).user !== undefined;
}

/**
 * Has the operator deliberately allowed admin from off-box while running
 * without sign-in? Implemented in Task 2; false until then.
 */
export function allowRemoteAdmin(): boolean {
    return false;
}

/**
 * Admin AND proof that the caller is the operator.
 *
 * `requireAdmin` alone is not sufficient. In open mode (the default) it resolves to the implicit
 * admin, and the per-instance token that gates /api is handed to any unauthenticated GET of an
 * extensionless path — so a LAN client can mint a token and administer the server. This adds the
 * missing half: the caller must prove they ARE the operator.
 *
 * That proof is loopback (they are at the machine) or a signed-in admin session (they said who they
 * are). A container has neither by default — nobody is ever on loopback there — which is why the
 * explicit opt-out exists and why the banner leads with "set up sign-in".
 *
 * Fails closed: a request with no socket is not loopback.
 *
 * NOT applied to GET /api/config (the launcher probe, the image HEALTHCHECK and qa-harness's
 * ReadyPath all depend on it answering unauthenticated from off-box), and NOT applied wholesale to
 * ServerShutdownApi, whose cookieless tray caller needs its own ladder.
 */
export function requireOperator(req: IncomingMessage, res: ServerResponse): boolean {
    if (!isLoopback(req.socket?.remoteAddress ?? '')) {
        const proven = isAuthEnabled(Config.getInstance().db) ? hasAuthenticatedUser(req) : allowRemoteAdmin();
        if (!proven) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'admin actions are limited to this machine' }));
            return false;
        }
    }
    return requireAdmin(req, res);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/auth/__tests__/requireOperator.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: De-duplicate `hasAuthenticatedUser`**

In `src/server/api/ServerShutdownApi.ts`, delete the local definition at lines 10-12:

```ts
function hasAuthenticatedUser(req: IncomingMessage): boolean {
    return (req as IncomingMessage & { user?: unknown }).user !== undefined;
}
```

and add to its imports:

```ts
import { hasAuthenticatedUser } from '../auth/requireOperator';
```

- [ ] **Step 6: Run the full suite and lint**

Run: `npm test`
Expected: PASS, no new failures.
Run: `npm run lint > /dev/null; echo $?`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/auth/requireOperator.ts src/server/auth/__tests__/requireOperator.test.ts src/server/api/ServerShutdownApi.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(security): add requireOperator -- admin needs loopback or a signed-in session"
```

---

### Task 2: The opt-out — env var and config key

**Files:**
- Modify: `src/server/auth/requireOperator.ts` (replace the `allowRemoteAdmin` stub)
- Modify: `src/common/ConfigEvents.ts` (add `allowRemoteAdmin` to `AppConfig` + `APP_CONFIG_DEFAULTS`)
- Modify: `src/server/Config.ts` (validate + merge the new key)
- Modify: `src/server/auth/__tests__/requireOperator.test.ts` (add the opt-out cases)

**Interfaces:**
- Consumes: `requireOperator`'s stub from Task 1.
- Produces: `allowRemoteAdmin(): boolean` returning `true` when `process.env.WS_SCRCPY_ALLOW_REMOTE_ADMIN === '1'` **or** the effective app config has `allowRemoteAdmin: true`. `AppConfig.allowRemoteAdmin?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/server/auth/__tests__/requireOperator.test.ts`:

```ts
describe('requireOperator — explicit opt-out', () => {
    const savedFlag = process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    afterEach(() => {
        if (savedFlag === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = savedFlag;
    });

    it('allows an off-box caller when the env var is exactly "1"', () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(true);
    });

    it('does NOT accept "true" — the value must be exactly "1"', () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = 'true';
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });

    it('allows an off-box caller when config.json sets allowRemoteAdmin', () => {
        setup();
        Config.getInstance().updateAppConfig({ allowRemoteAdmin: true });
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(true);
    });

    it('is ignored when auth is enabled — a signed-in session is required regardless', () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/auth/__tests__/requireOperator.test.ts`
Expected: FAIL — three of the four fail (the "true" case passes for the wrong reason, because the stub returns `false` for everything).

- [ ] **Step 3: Add the config key**

In `src/common/ConfigEvents.ts`, add to the `AppConfig` interface:

```ts
    /**
     * Allow admin actions from off-box while running WITHOUT sign-in.
     *
     * Off by default: in open mode `requireAdmin` resolves to the implicit admin and the instance
     * token is handed to anything that can fetch a page, so without this guard any LAN host is an
     * administrator. Turning it on is a deliberate act taken at the machine (the banner's
     * confirmation modal) or by an operator who set WS_SCRCPY_ALLOW_REMOTE_ADMIN=1.
     *
     * Ignored entirely when sign-in is enabled — then a session is the proof, and this is moot.
     */
    allowRemoteAdmin?: boolean;
```

and to `APP_CONFIG_DEFAULTS`:

```ts
    allowRemoteAdmin: false,
```

- [ ] **Step 4: Validate and merge it in Config**

In `src/server/Config.ts`, add a case to the `validateField` switch (the switch beginning near line 271, alongside `case 'firstRunComplete':`):

```ts
        case 'allowRemoteAdmin':
            if (typeof value !== 'boolean') {
                return { ok: false, error: 'allowRemoteAdmin must be a boolean' };
            }
            return { ok: true, value };
```

and, in the `composeAppConfig` block that handles each optional key (alongside the `raw.firstRunComplete` block near line 316):

```ts
    if (raw.allowRemoteAdmin !== undefined) {
        const r = validateField('allowRemoteAdmin', raw.allowRemoteAdmin);
        if (r.ok) out.allowRemoteAdmin = r.value as boolean;
    }
```

**Do NOT add it to `TRIO_KEYS`** (near line 354) — it is not part of the first-run trio and must not
trigger the restart-required path.

- [ ] **Step 5: Implement `allowRemoteAdmin`**

In `src/server/auth/requireOperator.ts`, replace the stub body:

```ts
/**
 * Has the operator deliberately allowed admin from off-box while running without sign-in?
 *
 * The env var is first-class and checked first: a container or headless install has nobody at a
 * browser on loopback, so it is the only path that does not require `docker exec`. qa-harness sets
 * it. The value must be exactly '1' — a loose truthiness check would let an empty string or the
 * string 'false' through.
 *
 * The config key is what the banner's confirmation modal writes, and that PATCH is itself
 * operator-gated, so the switch cannot be thrown from off-box.
 */
export function allowRemoteAdmin(): boolean {
    if (process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] === '1') return true;
    return Config.getInstance().getAppConfig().allowRemoteAdmin === true;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/server/auth/__tests__/requireOperator.test.ts`
Expected: PASS, 11 tests.
Run: `npm test`
Expected: PASS. If `config.noPrompts.test.ts` or a config-schema test asserts an exact `AppConfig` shape, update it to include `allowRemoteAdmin: false`.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/common/ConfigEvents.ts src/server/Config.ts src/server/auth/requireOperator.ts src/server/auth/__tests__/requireOperator.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(config): add allowRemoteAdmin opt-out via WS_SCRCPY_ALLOW_REMOTE_ADMIN or config"
```

---

### Task 3: Wire the guard into the six admin handlers

**⚠ Do not start until the qa-harness PR has merged.** This is the task that changes behaviour.

**Files:**
- Modify: `src/server/api/UsersApi.ts:4,23`
- Modify: `src/server/api/ConfigApi.ts:3,31`
- Modify: `src/server/api/ServiceApi.ts:18,188`
- Modify: `src/server/api/DependencyApi.ts:3,16`
- Modify: `src/server/api/UpdatesApi.ts:10,46`
- Modify: `src/server/api/AuthApi.ts:6,134,145`
- Modify: `src/server/__tests__/adminAuthorization.test.ts` (the socket trap, below)

**Interfaces:**
- Consumes: `requireOperator` from Task 1, `allowRemoteAdmin` from Task 2.
- Produces: no new exports. After this task every admin route except shutdown enforces proof-of-operator.

- [ ] **Step 1: Fix the socket trap in the existing tests FIRST**

`makeReqRes` leaves `req.socket` **undefined** unless a 5th argument is passed
(`src/server/__tests__/helpers/httpMock.ts:38`). `requireOperator` reads
`req.socket?.remoteAddress ?? ''`, and `isLoopback('')` is `false` — so every existing test in
`adminAuthorization.test.ts` would keep asserting `403` while silently no longer testing
`requireAdmin` at all. Same status code, different reason, zero signal.

In `src/server/__tests__/adminAuthorization.test.ts`, give every `makeReqRes` call a loopback socket.
There are six, at lines 76, 86, 105, 119, 134 and 147. Each gains the same 5th argument:

```ts
const r = makeReqRes('PATCH', '/api/config', { webPort: 9000 }, {}, { remoteAddress: '127.0.0.1' });
```
```ts
const r = makeReqRes('GET', '/api/config', undefined, {}, { remoteAddress: '127.0.0.1' });
```
```ts
const r = makeReqRes('GET', '/api/dependencies', undefined, {}, { remoteAddress: '127.0.0.1' });
```
```ts
const r = makeReqRes('GET', '/api/service/status', undefined, {}, { remoteAddress: '127.0.0.1' });
```
```ts
const r = makeReqRes('GET', '/api/updates/status', undefined, {}, { remoteAddress: '127.0.0.1' });
```
```ts
const r = makeReqRes('POST', '/api/server/shutdown', undefined, {}, { remoteAddress: '127.0.0.1' });
```

- [ ] **Step 2: Write the failing test**

Append to `src/server/__tests__/adminAuthorization.test.ts`:

```ts
// ──────────────────────────────────────────────────────────────────────────
// Off-box refusal (requireOperator). Distinguished from the non-admin 403s
// above by the error BODY, so a test cannot pass for the wrong reason.

const OFF_BOX = { remoteAddress: '192.168.1.50' };
const OFF_BOX_ERROR = { error: 'admin actions are limited to this machine' };

describe('off-box callers are refused in open mode', () => {
    it('PATCH /api/config', async () => {
        setup();
        const r = makeReqRes('PATCH', '/api/config', { webPort: 9000 }, {}, OFF_BOX);
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/dependencies', async () => {
        setup();
        const r = makeReqRes('GET', '/api/dependencies', undefined, {}, OFF_BOX);
        await new DependencyApi({} as any).handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/service/status', async () => {
        setup();
        const r = makeReqRes('GET', '/api/service/status', undefined, {}, OFF_BOX);
        await new ServiceApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/updates/status', async () => {
        setup();
        const r = makeReqRes('GET', '/api/updates/status', undefined, {}, OFF_BOX);
        await new UpdatesApi({} as any).handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('POST /api/auth/enable', async () => {
        setup();
        const r = makeReqRes('POST', '/api/auth/enable', {}, {}, OFF_BOX);
        await new AuthApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/config stays 200 from off-box — probe, HEALTHCHECK, ReadyPath', async () => {
        setup();
        const r = makeReqRes('GET', '/api/config', undefined, {}, OFF_BOX);
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
    });
});
```

Add `AuthApi` to the imports at the top of the file:

```ts
import { AuthApi } from '../api/AuthApi';
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/adminAuthorization.test.ts`
Expected: FAIL — the five refusal tests return 200/other, because the handlers still call
`requireAdmin`, which passes the implicit admin. The `GET /api/config` test already passes.

- [ ] **Step 4: Swap the six call-sites**

In each of `UsersApi.ts`, `ConfigApi.ts`, `ServiceApi.ts`, `DependencyApi.ts`, `UpdatesApi.ts`,
`AuthApi.ts`: change the import

```ts
import { requireAdmin } from '../auth/requireAdmin';
```

to

```ts
import { requireOperator } from '../auth/requireOperator';
```

and change each guard call from `if (!requireAdmin(req, res)) return true;` to
`if (!requireOperator(req, res)) return true;`. There is one call in `UsersApi` (line 23),
`ConfigApi` (line 31, the PATCH branch **only** — leave GET ungated), `ServiceApi` (line 188),
`DependencyApi` (line 16), `UpdatesApi` (line 46), and **two** in `AuthApi` (lines 134 and 145).

Leave `ServerShutdownApi`'s `requireAdmin` at line 129 alone — Task 4 owns it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/adminAuthorization.test.ts`
Expected: PASS.
Run: `npm test`
Expected: PASS. Any other handler test that asserts a 2xx on an admin route now needs a loopback
socket for the same reason as Step 1 — likely `usersApi.test.ts`, `settingsApi.test.ts`,
`ServiceApi.test.ts`, `UpdatesApi.test.ts`, `dependencyApi.*.test.ts`, `authApi.test.ts`. Add
`{}, { remoteAddress: '127.0.0.1' }` to their `makeReqRes` calls; do not weaken the assertions.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint > /dev/null; echo $?` → `0`

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api src/server/__tests__
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(security): require proof of operator on the admin API"
```

---

### Task 4: `ServerShutdownApi` consults the opt-out

**Files:**
- Modify: `src/server/api/ServerShutdownApi.ts:38-62` (doc comment), `:109-124` (the off-box ladder)
- Modify: `src/server/__tests__/ServerShutdownApi.test.ts`

**Interfaces:**
- Consumes: `allowRemoteAdmin` from Task 2.
- Produces: no new exports.

Shutdown keeps its own ladder rather than adopting `requireOperator`: its off-box branch must stay
token-first (403) then session (401) for the cookieless tray helper, and smoke row 20.6 exists to
catch a regression there. The change is one added clause — in **open mode**, an off-box caller now
also needs the opt-out.

- [ ] **Step 1: Write the failing test**

Append to `src/server/__tests__/ServerShutdownApi.test.ts`:

```ts
describe('ServerShutdownApi off-box opt-out', () => {
    const savedFlag = process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    afterEach(() => {
        if (savedFlag === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = savedFlag;
    });

    it('403s an off-box caller in open mode without the opt-out, even with a valid token', async () => {
        setup();
        const r = makeReqRes('POST', '/api/server/shutdown', undefined, { cookie: validTokenCookie() }, {
            remoteAddress: '192.168.1.50',
        });
        await new ServerShutdownApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });

    it('allows the same caller once WS_SCRCPY_ALLOW_REMOTE_ADMIN=1', async () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const exits: number[] = [];
        const r = makeReqRes('POST', '/api/server/shutdown', undefined, { cookie: validTokenCookie() }, {
            remoteAddress: '192.168.1.50',
        });
        await new ServerShutdownApi({ schedule: () => undefined, exit: (c) => exits.push(c) }).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
    });

    it('still allows a loopback caller with no cookie — the tray helper', async () => {
        setup();
        const r = makeReqRes('POST', '/api/server/shutdown', undefined, {}, { remoteAddress: '127.0.0.1' });
        await new ServerShutdownApi({ schedule: () => undefined, exit: () => undefined }).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
    });
});
```

`validTokenCookie()` is the existing helper in that file for minting a valid `ws_scrcpy_token`
cookie; reuse it rather than writing a new one. If the file names it differently, use that name.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/__tests__/ServerShutdownApi.test.ts`
Expected: FAIL on the first case — it returns 200, because a valid token is currently sufficient
off-box in open mode.

- [ ] **Step 3: Add the clause**

In `src/server/api/ServerShutdownApi.ts`, inside the `if (!isLoopback(...))` block, after the
existing token check and before the `isAuthEnabled` check:

```ts
            if (!isAuthEnabled(Config.getInstance().db) && !allowRemoteAdmin()) {
                // Open mode: a token proves "a browser loaded our page", not "this
                // is the operator". Stopping the server from off-box now needs the
                // same explicit opt-out the rest of the admin API needs.
                log.warn(`refusing shutdown from ${req.socket?.remoteAddress ?? '<unknown>'}: remote admin not allowed`);
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'admin actions are limited to this machine' }));
                return true;
            }
```

Add the import:

```ts
import { allowRemoteAdmin, hasAuthenticatedUser } from '../auth/requireOperator';
```

(replacing the `hasAuthenticatedUser`-only import added in Task 1 Step 5).

- [ ] **Step 4: Update the file's doc comment**

In the block at lines 38-62, replace the second bullet ("**Off-box: unchanged from before the
exemptions.**") with:

```
 *   - **Off-box: token, then the operator test.** The caller must present
 *     the instance token (403 without it). In locked mode it must then be
 *     signed in (401). In OPEN mode a token is not enough — it proves a
 *     browser loaded the page, not that the caller is the operator — so
 *     `allowRemoteAdmin()` must also be set (403 otherwise).
 *     Note this is still NOT "loopback only": a browser reaching a
 *     containerised server comes through the Docker gateway and is never on
 *     loopback, which is why the opt-out exists and why qa-harness sets
 *     WS_SCRCPY_ALLOW_REMOTE_ADMIN=1. Row 20.6 covers that path.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/__tests__/ServerShutdownApi.test.ts`
Expected: PASS.
Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServerShutdownApi.ts src/server/__tests__/ServerShutdownApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(security): shutdown requires the remote-admin opt-out from off-box in open mode"
```

---

### Task 5: Report the policy on `GET /api/config`

**Files:**
- Modify: `src/common/ConfigEvents.ts` (`FirstRunStatus` gains two optional fields)
- Modify: `src/server/auth/requireOperator.ts` (add `resolveAdminScope`)
- Modify: `src/server/api/ConfigApi.ts:21-24`
- Modify: `src/server/auth/__tests__/requireOperator.test.ts`

**Interfaces:**
- Consumes: `allowRemoteAdmin`, `isAuthEnabled`, `isLoopback`.
- Produces:
  - `export type AdminScope = 'local' | 'remote' | 'authenticated'`
  - `export function resolveAdminScope(): AdminScope`
  - `export function callerIsLocal(req: IncomingMessage): boolean`
  - `FirstRunStatus.adminScope?: AdminScope` and `FirstRunStatus.callerIsLocal?: boolean` — consumed by Task 6.

Two fields, not one. `adminScope` is the **policy** in force; `callerIsLocal` is whether **this**
request can act under it. The banner needs both: a `local` policy shows buttons to a loopback caller
and instructions to everyone else.

- [ ] **Step 1: Write the failing test**

Append to `src/server/auth/__tests__/requireOperator.test.ts`:

```ts
import { callerIsLocal, resolveAdminScope } from '../requireOperator';

describe('resolveAdminScope', () => {
    const savedFlag = process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    afterEach(() => {
        if (savedFlag === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = savedFlag;
    });

    it("is 'local' in open mode with no opt-out", () => {
        setup();
        expect(resolveAdminScope()).toBe('local');
    });

    it("is 'remote' when the opt-out is set", () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        expect(resolveAdminScope()).toBe('remote');
    });

    it("is 'authenticated' when sign-in is on, opt-out or not", () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        expect(resolveAdminScope()).toBe('authenticated');
    });
});

describe('callerIsLocal', () => {
    it('is true for loopback and IPv4-mapped loopback', () => {
        expect(callerIsLocal(mkReq('127.0.0.1'))).toBe(true);
        expect(callerIsLocal(mkReq('::ffff:127.0.0.1'))).toBe(true);
    });

    it('is false for a LAN address and for a missing socket', () => {
        expect(callerIsLocal(mkReq('192.168.1.50'))).toBe(false);
        expect(callerIsLocal(mkReq(undefined))).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/auth/__tests__/requireOperator.test.ts`
Expected: FAIL — `resolveAdminScope is not a function`.

- [ ] **Step 3: Implement both helpers**

Append to `src/server/auth/requireOperator.ts`:

```ts
/** Which admin policy this deployment is running under, for the client to render. */
export type AdminScope = 'local' | 'remote' | 'authenticated';

/**
 * The policy in force — NOT a statement about the current caller.
 *
 * 'authenticated' outranks the opt-out: once sign-in is on, a session is the proof and
 * `allowRemoteAdmin` is moot (requireOperator ignores it in that branch too).
 */
export function resolveAdminScope(): AdminScope {
    if (isAuthEnabled(Config.getInstance().db)) return 'authenticated';
    if (allowRemoteAdmin()) return 'remote';
    return 'local';
}

/** Whether THIS request came from the machine the server runs on. */
export function callerIsLocal(req: IncomingMessage): boolean {
    return isLoopback(req.socket?.remoteAddress ?? '');
}
```

- [ ] **Step 4: Add the fields to the wire type**

In `src/common/ConfigEvents.ts`, add to `FirstRunStatus` (after `frameAncestors`):

```ts
    /**
     * The admin policy in force. Optional so an older server and a newer frontend interoperate — an
     * absent field means "this server predates the guard", and the banner stays hidden.
     */
    adminScope?: 'local' | 'remote' | 'authenticated';
    /**
     * Whether the request that fetched this envelope came from loopback. Per-request, so it is
     * composed by ConfigApi rather than snapshotted in Config. A browser cannot determine its own
     * source address, so this has to come from the server.
     */
    callerIsLocal?: boolean;
```

- [ ] **Step 5: Compose them per-request**

In `src/server/api/ConfigApi.ts`, change the GET branch (lines 20-24) to:

```ts
                const cfg = Config.getInstance();
                const envelope: AppConfigEnvelope = {
                    config: cfg.getAppConfig(),
                    runtime: {
                        ...cfg.getFirstRunStatus(),
                        adminScope: resolveAdminScope(),
                        callerIsLocal: callerIsLocal(req),
                    },
                };
```

and add the import:

```ts
import { callerIsLocal, requireOperator, resolveAdminScope } from '../auth/requireOperator';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/server/auth/__tests__/requireOperator.test.ts`
Expected: PASS, 16 tests.
Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/common/ConfigEvents.ts src/server/auth/requireOperator.ts src/server/api/ConfigApi.ts src/server/auth/__tests__/requireOperator.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(config): report adminScope and callerIsLocal on GET /api/config"
```

---

### Task 6: The `AdminScopeBanner`

**Files:**
- Create: `src/app/client/AdminScopeBanner.ts`
- Create: `src/app/client/AdminScopeBanner.test.ts`
- Modify: `src/app/index.ts` (mount beside `FirstRunBanner`, near lines 365-368; pass the runtime to both pollers)
- Modify: `src/app/client/adminGate.ts` (add `adminApiReachable`)
- Modify: `src/app/client/FirstRunBanner.ts` (do not poll an unreachable admin API)
- Modify: the dependency panel component (`grep -rn "api/dependencies" src/app/` to locate it) — same
- Modify: `src/app/client/__tests__/adminGate.test.ts` (or create it if absent)
- Modify: `src/style/` — the stylesheet that defines `.first-run-banner` gains `.admin-scope-banner`

**Interfaces:**
- Consumes: `FirstRunStatus.adminScope` / `.callerIsLocal` from Task 5.
- Produces:
  - `export class AdminScopeBanner` with `static create(): Promise<AdminScopeBanner>`, `getElement(): HTMLElement`, `destroy(): void`
  - `export function bannerStateFor(runtime: FirstRunStatus): 'hidden' | 'local-actionable' | 'local-readonly' | 'remote-warning'` — pure, exported for testing.
  - `export function adminApiReachable(runtime: Pick<FirstRunStatus, 'adminScope' | 'callerIsLocal'>): boolean` in `adminGate.ts` — consumed by Task 8's dismissal logic and by both pollers.

- [ ] **Step 1: Write the failing test**

Create `src/app/client/AdminScopeBanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FirstRunStatus } from '../../common/ConfigEvents';
import { bannerStateFor } from './AdminScopeBanner';

function runtime(over: Partial<FirstRunStatus>): FirstRunStatus {
    return { firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, ...over };
}

describe('bannerStateFor', () => {
    it('hides when sign-in is on', () => {
        expect(bannerStateFor(runtime({ adminScope: 'authenticated', callerIsLocal: true }))).toBe('hidden');
    });

    it('hides on a server that predates the guard (no adminScope)', () => {
        expect(bannerStateFor(runtime({}))).toBe('hidden');
    });

    it('offers the buttons to a loopback caller under the local policy', () => {
        expect(bannerStateFor(runtime({ adminScope: 'local', callerIsLocal: true }))).toBe('local-actionable');
    });

    it('offers instructions only to a remote caller under the local policy', () => {
        expect(bannerStateFor(runtime({ adminScope: 'local', callerIsLocal: false }))).toBe('local-readonly');
    });

    it('warns persistently once the opt-out is active', () => {
        expect(bannerStateFor(runtime({ adminScope: 'remote', callerIsLocal: false }))).toBe('remote-warning');
        expect(bannerStateFor(runtime({ adminScope: 'remote', callerIsLocal: true }))).toBe('remote-warning');
    });
});

describe('AdminScopeBanner rendering', () => {
    it('renders no buttons in the read-only state', async () => {
        const { AdminScopeBanner } = await import('./AdminScopeBanner');
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: false }));
        expect(banner.getElement().querySelectorAll('button').length).toBe(0);
        expect(banner.getElement().textContent).toContain('WS_SCRCPY_ALLOW_REMOTE_ADMIN=1');
    });

    it('renders both buttons in the actionable state, sign-in first', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        const labels = [...banner.getElement().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).toEqual(['Set up sign-in', 'Allow remote admin without sign-in']);
    });

    it('never uses innerHTML for server-supplied values', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        expect(banner.getElement().innerHTML).not.toContain('<script');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/AdminScopeBanner.test.ts`
Expected: FAIL — cannot resolve `./AdminScopeBanner`.

- [ ] **Step 3: Write the banner**

Create `src/app/client/AdminScopeBanner.ts`. Follow `FirstRunBanner`'s shape exactly — a container
`div` created in the constructor, `static create()` that builds + refreshes + starts polling,
`getElement()`, `destroy()` that clears the interval.

**Build every node with `document.createElement` and `textContent`, never `innerHTML`** — this is a
project convention (`feedback_html_tag_escaping`) and `FirstRunBanner` has an XSS test for exactly
this at `FirstRunBanner.test.ts:18`.

```ts
import type { FirstRunStatus } from '../../common/ConfigEvents';
import { sameOriginUrl } from '../sameOriginUrl';

const POLL_INTERVAL_MS = 30_000;

export type BannerState = 'hidden' | 'local-actionable' | 'local-readonly' | 'remote-warning';

/**
 * Which banner, if any, this envelope calls for.
 *
 * `adminScope` absent means a server older than the guard: show nothing rather than claim a posture
 * we cannot verify. Pure and exported so the decision is testable without a DOM.
 */
export function bannerStateFor(runtime: FirstRunStatus): BannerState {
    switch (runtime.adminScope) {
        case 'authenticated':
            return 'hidden';
        case 'remote':
            return 'remote-warning';
        case 'local':
            return runtime.callerIsLocal ? 'local-actionable' : 'local-readonly';
        default:
            return 'hidden';
    }
}

export class AdminScopeBanner {
    private container: HTMLElement;
    private pollHandle: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.className = 'admin-scope-banner';
        this.container.style.display = 'none';
    }

    static async create(): Promise<AdminScopeBanner> {
        const banner = new AdminScopeBanner();
        await banner.refresh();
        banner.startPolling();
        return banner;
    }

    getElement(): HTMLElement {
        return this.container;
    }

    destroy(): void {
        if (this.pollHandle !== null) {
            clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    private startPolling(): void {
        if (this.pollHandle !== null) return;
        this.pollHandle = setInterval(() => {
            void this.refresh();
        }, POLL_INTERVAL_MS);
    }

    private async refresh(): Promise<void> {
        try {
            const res = await fetch(sameOriginUrl('/api/config'));
            if (!res.ok) return;
            const envelope = (await res.json()) as { runtime: FirstRunStatus };
            this.render(envelope.runtime);
        } catch {
            // A transient fetch failure leaves the previous render in place.
        }
    }

    /** Exported behaviour for tests: render the banner for one envelope. */
    render(runtime: FirstRunStatus): void {
        const state = bannerStateFor(runtime);
        this.container.replaceChildren();
        if (state === 'hidden') {
            this.container.style.display = 'none';
            return;
        }
        this.container.style.display = '';
        this.container.dataset['state'] = state;

        const title = document.createElement('strong');
        const body = document.createElement('p');

        if (state === 'remote-warning') {
            this.container.classList.add('admin-scope-banner--warning');
            title.textContent = 'Remote admin is enabled without sign-in.';
            body.textContent =
                'Any device that can reach this server can administer it. Set up sign-in to close this.';
            this.container.append(title, body);
            return;
        }

        this.container.classList.remove('admin-scope-banner--warning');

        if (state === 'local-readonly') {
            title.textContent = 'Admin actions are disabled for remote clients.';
            body.textContent =
                'This server has no sign-in configured. To manage it, open this page on the machine ' +
                'running the server — or set WS_SCRCPY_ALLOW_REMOTE_ADMIN=1.';
            this.container.append(title, body);
            return;
        }

        title.textContent = 'Admin actions are limited to this machine.';
        body.textContent =
            'No sign-in is configured, so anyone on your network can reach this server. Admin ' +
            'actions — users, configuration, shutdown — are restricted to this machine as a result.';

        const actions = document.createElement('div');
        actions.className = 'admin-scope-banner__actions';

        const signIn = document.createElement('button');
        signIn.type = 'button';
        signIn.className = 'admin-scope-banner__primary';
        signIn.textContent = 'Set up sign-in';

        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'admin-scope-banner__secondary';
        allow.textContent = 'Allow remote admin without sign-in';

        actions.append(signIn, allow);
        this.container.append(title, body, actions);
    }
}
```

Button click handlers are wired in Task 7 — this task renders them inert.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/client/AdminScopeBanner.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mount it**

In `src/app/index.ts`, beside the existing `FirstRunBanner.create()` call (near line 368), add the
same shape:

```ts
    let adminScopeBanner: AdminScopeBanner | undefined;
    AdminScopeBanner.create().then((banner) => {
        adminScopeBanner = banner;
        // Insert above the first-run banner: a security posture outranks a
        // dependency-install notice.
        container.prepend(banner.getElement());
    });
```

Match the surrounding code's actual container variable and insertion call — read lines 360-380
before writing. Add `adminScopeBanner?.destroy()` wherever `firstRunBanner?.destroy()` already
appears (the §36 poll-teardown path near line 411).

Add the import beside the `FirstRunBanner` one at line 13:

```ts
import { AdminScopeBanner } from './client/AdminScopeBanner';
```

- [ ] **Step 6: Stop polling an admin API this caller cannot use**

Every admin handler gates at the **top of `handle`**, so the GETs are gated too — `DependencyApi.ts:16`
and `UpdatesApi.ts:46` both guard before any routing, and `ServiceApi.ts:188` is the same shape.
`FirstRunBanner` polls `GET /api/dependencies` every 15 s and the dependency panel polls on its own
interval, so a **flagless container produces a steady 403 stream and matching console errors on a
completely healthy app** — the exact shape qa-harness already wrote up at `docs/traps.md:1294` for
`/api/embed-request`.

**This is not a new principle.** `adminGate.ts:15-19` already makes this argument for the `role` case
and the repo already accepted it as **finding 9.6**:

> *"The dependency API answers 403 for a non-admin, so an ungated panel did not show less — it showed
> 'Failed to load dependencies'. An authorization boundary that manifests as an error message reads as
> a bug to the user and as coverage to the checklist."*

This step extends that same rule from `role` to `adminScope`.

Add to `src/app/client/adminGate.ts`:

```ts
import type { FirstRunStatus } from '../../common/ConfigEvents';

/**
 * Will the admin API answer THIS caller at all?
 *
 * Distinct from `canSeeSection`, which asks whether this ROLE may use a section. Both must hold: a
 * signed-in admin reaching a container without the opt-out is an admin whose calls still 403, and a
 * viewer on loopback is local but still not an admin.
 *
 * An absent `adminScope` is a server older than the guard, where the admin API always answered —
 * assume reachable so a new frontend does not blank sections on an old server.
 */
export function adminApiReachable(runtime: Pick<FirstRunStatus, 'adminScope' | 'callerIsLocal'>): boolean {
    if (runtime.adminScope === undefined) return true;
    if (runtime.adminScope === 'local') return runtime.callerIsLocal === true;
    return true;
}
```

Then, in `FirstRunBanner` and the dependency panel, accept the runtime and skip the poll entirely when
it is unreachable — do not start the interval, and render the "admin actions are limited to this
machine" state instead of an error. `src/app/index.ts` already fetches the config envelope at boot
(near lines 121-135), so pass `envelope.runtime` into `FirstRunBanner.create()` and the panel's
constructor rather than making them re-fetch.

In `SettingsModal`, compose the two predicates wherever `canSeeSection` is called:
`canSeeSection(role, section) && adminApiReachable(runtime)`.

- [ ] **Step 7: Test the suppression**

Create or extend `src/app/client/__tests__/adminGate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { adminApiReachable, canSeeSection } from '../adminGate';

describe('adminApiReachable', () => {
    it('is true on a server that predates the guard', () => {
        expect(adminApiReachable({})).toBe(true);
    });

    it('is true for a loopback caller under the local policy', () => {
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: true })).toBe(true);
    });

    it('is FALSE for a remote caller under the local policy — the flagless container', () => {
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: false })).toBe(false);
    });

    it('is true once the opt-out is set, or once sign-in is on', () => {
        expect(adminApiReachable({ adminScope: 'remote', callerIsLocal: false })).toBe(true);
        expect(adminApiReachable({ adminScope: 'authenticated', callerIsLocal: false })).toBe(true);
    });
});

describe('the two predicates are independent', () => {
    it('an admin whose calls would 403 is gated by reachability, not by role', () => {
        expect(canSeeSection('admin', 'dependencies')).toBe(true);
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: false })).toBe(false);
    });

    it('a viewer on loopback is reachable but still not permitted', () => {
        expect(adminApiReachable({ adminScope: 'local', callerIsLocal: true })).toBe(true);
        expect(canSeeSection('user', 'dependencies')).toBe(false);
    });
});
```

Add one lifecycle test asserting `FirstRunBanner` starts **no** interval when the runtime is
unreachable — `FirstRunBanner.test.ts:28` already has a "polling lifecycle (#36)" block to extend.

Run: `npx vitest run src/app/client/__tests__/adminGate.test.ts src/app/client/FirstRunBanner.test.ts`
Expected: PASS.

- [ ] **Step 8: Style it**

Find the stylesheet defining `.first-run-banner` (`grep -rn "first-run-banner" src/style/`) and add
`.admin-scope-banner` beside it, reusing the same layout tokens. The `--warning` modifier and the
secondary button use the existing theme variables — see `reference_ws_scrcpy_theme_vars`; do not
hard-code colours.

- [ ] **Step 9: Build, test, lint, commit**

Run: `npm run build:dev` → succeeds
Run: `npm test` → PASS
Run: `npm run lint > /dev/null; echo $?` → `0`

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client src/app/index.ts src/style
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): admin-scope banner, and stop polling an unreachable admin API"
```

---

### Task 7: The red confirmation modal and the two buttons

**Files:**
- Create: `src/app/client/RemoteAdminWarningModal.ts`
- Create: `src/app/client/__tests__/RemoteAdminWarningModal.test.ts`
- Modify: `src/app/client/AdminScopeBanner.ts` (wire the handlers)
- Modify: `src/app/client/AdminScopeBanner.test.ts`

**Interfaces:**
- Consumes: `Modal` (`src/app/ui/Modal.ts`), the banner from Task 6.
- Produces: `export class RemoteAdminWarningModal` with `static confirm(): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/client/__tests__/RemoteAdminWarningModal.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RemoteAdminWarningModal } from '../RemoteAdminWarningModal';

describe('RemoteAdminWarningModal', () => {
    it('resolves false when the recommended button is clicked', async () => {
        const p = RemoteAdminWarningModal.confirm();
        const dialog = document.querySelector('dialog');
        const buttons = [...dialog!.querySelectorAll('button')];
        const signIn = buttons.find((b) => b.textContent === 'Set up sign-in instead')!;
        signIn.click();
        await expect(p).resolves.toBe(false);
    });

    it('resolves true only via the explicit accept button', async () => {
        const p = RemoteAdminWarningModal.confirm();
        const dialog = document.querySelector('dialog');
        const accept = [...dialog!.querySelectorAll('button')].find(
            (b) => b.textContent === 'I understand — allow remote admin',
        )!;
        accept.click();
        await expect(p).resolves.toBe(true);
    });

    it('gives initial focus to the recommended button, not the risky one', () => {
        void RemoteAdminWarningModal.confirm();
        const dialog = document.querySelector('dialog');
        expect(document.activeElement?.textContent).toBe('Set up sign-in instead');
        expect(dialog).toBeTruthy();
    });

    it('does not call showModal twice — the AdminConfirmModal trap', () => {
        const spy = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
        void RemoteAdminWarningModal.confirm();
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/__tests__/RemoteAdminWarningModal.test.ts`
Expected: FAIL — cannot resolve `../RemoteAdminWarningModal`.

- [ ] **Step 3: Write the modal**

Read `src/app/client/ConfirmModal.ts` first and mirror its structure.

⚠️ **`Modal`'s constructor already appends the dialog to `document.body` AND calls `showModal()`.**
Calling either again throws `InvalidStateError`, which rejects the promise and silently breaks the
buttons while leaving the dialog visible. That is a real production bug, diagnosed 2026-05-21 and
documented at `AdminConfirmModal.ts:25-41`. Construct once inside the promise executor and do
nothing else.

Create `src/app/client/RemoteAdminWarningModal.ts`:

```ts
import { Modal } from '../ui/Modal';

/**
 * The red confirmation in front of "allow remote admin without sign-in".
 *
 * Resolves true ONLY for the explicit accept button. Every other exit — the recommended button,
 * Esc, backdrop, the X — resolves false, so a mis-click or a dismissal can never widen the
 * server's exposure. The recommended button takes initial focus for the same reason.
 */
export class RemoteAdminWarningModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;

    public static confirm(): Promise<boolean> {
        return new Promise((resolve) => {
            // See the AdminConfirmModal note: the base constructor already
            // appends and shows. Do not append or showModal again here.
            new RemoteAdminWarningModal(resolve);
        });
    }

    private constructor(resolve: (value: boolean) => void) {
        super();
        this.resolveFn = resolve;
        this.buildBody();
    }

    private buildBody(): void {
        const title = document.createElement('strong');
        title.className = 'remote-admin-warning__title';
        title.textContent = '⚠ This makes anyone on your network an administrator.';

        const body = document.createElement('p');
        body.textContent =
            'With no sign-in configured, allowing remote admin means any device that can reach this ' +
            'server can create and delete users, change configuration, and shut the server down. ' +
            'Nothing is protected by a password.';

        const scope = document.createElement('p');
        scope.textContent = 'Only do this on a network you fully control.';

        const signIn = document.createElement('button');
        signIn.type = 'button';
        signIn.textContent = 'Set up sign-in instead';
        signIn.addEventListener('click', () => this.resolveAndClose(false));

        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'remote-admin-warning__accept';
        accept.textContent = 'I understand — allow remote admin';
        accept.addEventListener('click', () => this.resolveAndClose(true));

        this.appendToBody(title, body, scope, signIn, accept);
        signIn.focus();
    }

    private resolveAndClose(value: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.close();
    }
}
```

`appendToBody` and `close` are the `Modal` base-class members — read `src/app/ui/Modal.ts` and use
its actual method names. If the base class routes cancellation (Esc/backdrop) through a hook, wire
`resolveAndClose(false)` into it so every dismissal path resolves false.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/client/__tests__/RemoteAdminWarningModal.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire the banner buttons**

In `AdminScopeBanner.render`, replace the inert buttons with wired ones:

```ts
        signIn.addEventListener('click', () => {
            void this.onSetUpSignIn();
        });
        allow.addEventListener('click', () => {
            void this.onAllowRemoteAdmin();
        });
```

and add the two methods:

```ts
    private async onSetUpSignIn(): Promise<void> {
        // The existing sign-in setup surface owns the password prompt; this
        // only opens it. POST /api/auth/enable is operator-gated, so a remote
        // caller could not reach it even if this button were forged.
        const { SettingsModal } = await import('./SettingsModal');
        SettingsModal.openAuthSection();
    }

    private async onAllowRemoteAdmin(): Promise<void> {
        const { RemoteAdminWarningModal } = await import('./RemoteAdminWarningModal');
        const accepted = await RemoteAdminWarningModal.confirm();
        if (!accepted) {
            void this.onSetUpSignIn();
            return;
        }
        await fetch(sameOriginUrl('/api/config'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ allowRemoteAdmin: true }),
        });
        await this.refresh();
    }
```

`SettingsModal.openAuthSection()` may not exist under that name — read `SettingsModal.ts` and call
whatever opens the auth/sign-in section. If there is no such entry point, open the Settings modal
and leave a one-line comment saying the auth section is not directly addressable yet.

- [ ] **Step 6: Add the wiring test**

Append to `src/app/client/AdminScopeBanner.test.ts`:

```ts
it('declining the warning routes to sign-in and does NOT patch config', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const banner = new AdminScopeBanner();
    banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
    const allow = [...banner.getElement().querySelectorAll('button')].find(
        (b) => b.textContent === 'Allow remote admin without sign-in',
    )!;
    allow.click();
    await Promise.resolve();
    const dialog = document.querySelector('dialog');
    [...dialog!.querySelectorAll('button')]
        .find((b) => b.textContent === 'Set up sign-in instead')!
        .click();
    await Promise.resolve();
    const patched = fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patched).toBe(false);
    fetchSpy.mockRestore();
});
```

- [ ] **Step 7: Run, lint, commit**

Run: `npm test` → PASS
Run: `npm run lint > /dev/null; echo $?` → `0`

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): red confirmation in front of the remote-admin opt-out"
```

---

### Task 8: Dismissal, registered in the reset payload

**Files:**
- Modify: `src/app/client/SettingsModal.ts:123-129`
- Modify: `src/app/client/__tests__/SettingsModal.test.ts:173-181`
- Modify: `src/app/client/AdminScopeBanner.ts` (dismiss control + honour the flag)
- Modify: `src/app/index.ts` (pass the prefs already read near lines 121-135)

**Interfaces:**
- Consumes: `/api/settings` per-user prefs, already fetched in `index.ts`.
- Produces: `resetPromptSettingsPayload()` returns a **fourth** key, `adminScopeBannerDismissed: false`.

The flag MUST join `resetPromptSettingsPayload()` or "don't show again" becomes one-way and Reset
Prompts cannot bring it back — the same trap already documented for `PortChangeModal`. The existing
test asserts the exact object, so both change together.

- [ ] **Step 1: Write the failing test**

In `src/app/client/__tests__/SettingsModal.test.ts`, update the assertion at lines 173-181:

```ts
describe('resetPromptSettingsPayload', () => {
    it('clears the four per-user prompt flags sent to /api/settings', () => {
        expect(resetPromptSettingsPayload()).toEqual({
            serviceFirstRunSeen: false,
            bookmarkDismissedForPort: null,
            bookmarkDismissedGlobally: false,
            adminScopeBannerDismissed: false,
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/__tests__/SettingsModal.test.ts`
Expected: FAIL — received object lacks `adminScopeBannerDismissed`.

- [ ] **Step 3: Add the flag**

In `src/app/client/SettingsModal.ts`, update the payload at lines 123-129 and its doc comment at
107-122 (which says "three per-user prompt-dismissal flags" — make it four):

```ts
export function resetPromptSettingsPayload(): Record<string, boolean | null> {
    return {
        serviceFirstRunSeen: false,
        bookmarkDismissedForPort: null,
        bookmarkDismissedGlobally: false,
        adminScopeBannerDismissed: false,
    };
}
```

- [ ] **Step 4: Add the dismiss control**

In `AdminScopeBanner.render`, for the `local-actionable` and `local-readonly` states only (**never**
`remote-warning` — an active exposure must not be dismissible), append:

```ts
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'admin-scope-banner__dismiss';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', () => {
            void this.dismiss();
        });
        actions.append(dismiss);
```

and the method:

```ts
    private async dismiss(): Promise<void> {
        this.dismissed = true;
        this.container.style.display = 'none';
        await fetch(sameOriginUrl('/api/settings'), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adminScopeBannerDismissed: true }),
        });
    }
```

Add `private dismissed = false;` to the class, seed it in `create()` from the prefs, and return
early from `render()` when `this.dismissed && state !== 'remote-warning'`.

- [ ] **Step 5: Add the dismissal tests**

Append to `src/app/client/AdminScopeBanner.test.ts`:

```ts
it('the remote-warning state has no dismiss control', () => {
    const banner = new AdminScopeBanner();
    banner.render(runtime({ adminScope: 'remote', callerIsLocal: true }));
    const labels = [...banner.getElement().querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Dismiss');
});

it('a dismissed banner still shows the remote-warning state', () => {
    const banner = new AdminScopeBanner();
    (banner as unknown as { dismissed: boolean }).dismissed = true;
    banner.render(runtime({ adminScope: 'remote', callerIsLocal: true }));
    expect(banner.getElement().style.display).not.toBe('none');
});
```

- [ ] **Step 6: Run, lint, commit**

Run: `npm test` → PASS
Run: `npm run lint > /dev/null; echo $?` → `0`

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): dismissible admin-scope banner, registered in the reset payload"
```

---

### Task 9: Documentation, CHANGELOG, and the release PR

**Files:**
- Modify: `SECURITY.md`
- Modify: `README.md` (the Access control section)
- Modify: `docs/TECHNICAL_GUIDE.md` (§24)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above. Produces the shipped feature.

All three doc surfaces already discuss the instance token and open mode (item 81's option (c)
shipped in beta.102). They currently say open mode trusts the whole LAN — **that stops being true**,
so each needs updating, not just appending.

- [ ] **Step 1: Read what each currently claims**

Run: `grep -n "open mode\|instance token\|authEnabled" SECURITY.md README.md docs/TECHNICAL_GUIDE.md`

Read every hit. The claim to correct is "open mode trusts the whole LAN": after this change, open
mode trusts the whole LAN for *viewing*, and the *machine* for administering.

- [ ] **Step 2: Update `SECURITY.md`**

State the new posture:

- Admin actions require proof of operator: loopback, or a signed-in admin session.
- The per-instance token is not an authenticator and never was; it distinguishes a browser that
  loaded a page from a script probing the port.
- `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1` (or `allowRemoteAdmin` in config) removes the restriction
  deliberately. Say plainly that it makes anyone who can reach the server an administrator, and that
  sign-in is the supported alternative.
- **Containers:** nobody is ever on loopback, so the paths are the env var or a one-time
  `docker exec <container> curl -X POST http://127.0.0.1:8000/api/auth/enable` to turn sign-in on
  from inside.

- [ ] **Step 3: Update `README.md` and TECHNICAL_GUIDE §24**

README gets the short version in the Access control section plus the env-var name. §24 gets the
mechanism: the guard, the three `adminScope` values, why shutdown keeps its own ladder, and why
`GET /api/config` is deliberately ungated.

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]` — **never a pre-written version heading**, `bump-version.mjs` aborts:

```markdown
### Security
- Admin actions now require proof that the caller is the operator — loopback, or a signed-in admin
  session. Previously, running without sign-in (the default) meant any host on the LAN could fetch a
  page, be handed the per-instance token, and reach the admin API: users, configuration, updates,
  service control and shutdown. The token was never an authenticator; parts of the app treated it as
  one.
- A banner now states which posture the server is in and offers the two ways out — set up sign-in
  (recommended) or allow remote admin explicitly. It is shown to every client but actionable only
  from the machine itself, so it cannot be used to widen access from off-box.
- New opt-out for trusted networks and automation: `WS_SCRCPY_ALLOW_REMOTE_ADMIN=1`, or
  `allowRemoteAdmin` in `config.json`. **In a container nobody is ever on loopback**, so one of these
  — or enabling sign-in — is required to administer a Dockerised deployment remotely.
```

- [ ] **Step 5: Verify the whole suite and lint**

Run: `npm test` → PASS
Run: `npm run lint > /dev/null; echo $?` → `0`
Run: `npm run build` → succeeds

- [ ] **Step 6: Commit and open the release PR**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add SECURITY.md README.md docs/TECHNICAL_GUIDE.md CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs: admin authorization posture and the remote-admin opt-out"
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin <branch>
```

Open ONE PR labelled `release:beta`. **Do not bump the version manually** — Mode 1 cuts the bump PR.
The PR body should name the qa-harness dependency and confirm it merged first.

- [ ] **Step 7: Close out item 81 and file the row 20.6 relay request**

After the beta publishes and is verified: move item 81 to `archive/todo_ws_scrcpy_web_shipped.md`,
drop the active count, and confirm the row 20.6 request reached `qa-harness` via the relay.

---

## Self-Review

**Spec coverage:** §3.2 guard → Task 1. §3.3 opt-out → Task 2. §3.4 route table → Tasks 3 and 4.
§3.5 `adminScope` → Task 5. §3.6 card → Task 6. §3.7 modal → Task 7. §3.8 dismissal → Task 8. §5
sequencing → the precondition plus Task 3's gate. §6 testing → the test steps in every task. §7 open
questions are deferred by design and need no task. §9 docs → Task 9.

**One spec item intentionally reshaped:** the spec's single `adminScope` field became two fields
(`adminScope` + `callerIsLocal`) in Task 5, because one value cannot express both "the policy is
local" and "you specifically are local" — and the card needs both to choose between buttons and
instructions.

**Placeholder scan:** no TBDs. Three steps deliberately say "read the file first and use its actual
names" — Task 6 Step 5 (the mount container), Task 7 Step 3 (`Modal` base-class method names) and
Task 7 Step 5 (`SettingsModal`'s auth entry point). Those are unread-file uncertainties, not vague
instructions; each names the file to read and what to look for.

**Type consistency:** `allowRemoteAdmin()` is defined in Task 1 (stub) and implemented in Task 2 —
same name, same signature. `AdminScope` is defined in Task 5 and consumed in Task 6 via
`FirstRunStatus.adminScope`. `bannerStateFor` returns the same four literals used in Task 6's render
switch and Task 8's dismissal guard. `hasAuthenticatedUser` is defined once in Task 1 and imported
by `ServerShutdownApi` in Tasks 1 and 4.
