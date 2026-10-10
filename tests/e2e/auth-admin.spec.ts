import {
    type APIRequestContext,
    type APIResponse,
    type BrowserContext,
    expect,
    type Page,
    request,
    test,
} from '@playwright/test';
import {
    APP_TITLE,
    type Credentials,
    captureResponse,
    closeAllModals,
    closeTopModal,
    dismissPromptsFor,
    expectAppShell,
    expectLoginHtml,
    expectLoginPage,
    expectSpaHtml,
    listUsers,
    logoutViaApi,
    me,
    meNeedsLockdown,
    openSettings,
    openSettingsTab,
    openUsersModal,
    settingsRow,
    settingsSection,
    settingsTabLine,
    userByName,
    userRow,
} from './support/auth';
import { apiContext, lockDown, OwnedServer, REMOTE_ADMIN_ENV } from './support/ownedServer';
import { readConfigFile, withTimeout } from './support/privateServer';
import { lanAddress } from './support/rawHttp';
import { readServerLog } from './support/serverLog';
import {
    backdateSession,
    expectSocketServed,
    openLiveSocket,
    REVOKED,
    readSession,
    sidOf,
    signedInVisitor,
    signIn,
    socketState,
} from './support/sessions';
import { footerSave, reviewDialog, reviewLines } from './support/settingsUi';

/**
 * Smoke rows 12.8, 18.13 and 18.16–18.22 — who may administer the server, and what
 * happens to a login's live surfaces when it ends. Fast tier only.
 *
 * Every row runs on a server this file owns (`OwnedServer`, support/ownedServer.ts), one port per
 * test in 8161–8169, 8196 and 8199, never on the shared server: these rows lock servers down,
 * stop them, rewrite their session clocks and flip their admin posture, and the
 * shared server must stay in open mode with its users untouched for every spec
 * file that runs after this one. (8169 is the second 18.17 test's, 8196 the
 * off-box 12.8 test's, 8199 18.13's, remote admin on the Users tab.)
 *
 * The same lockout rules as `auth.spec.ts` hold here: no row ever sends a wrong
 * password and no login is retried (`signIn` sends one request and throws on
 * anything but 200).
 *
 * The OFF-BOX halves of 12.8 (a, c, d), 18.16 (the 403s, `callerIsLocal: false`)
 * and 18.22 (the read-only banner) need a caller the server sees as another
 * machine. They get one without a second machine: a request to this host's own
 * LAN address arrives FROM that address, so the server's
 * `isLoopback(remoteAddress)` is false, the same test another machine fails
 * (`offBoxURL`, as server-api.spec.ts 3.9 and embed-trust.spec.ts 10.15 do).
 * What stays with the container tier is the container's DEFAULT: nobody on its
 * loopback, and `WS_SCRCPY_ALLOW_REMOTE_ADMIN` forwarded by compose.
 */

const PORT = {
    r12_8: 8161,
    r18_16: 8162,
    r18_17: 8163,
    r18_18: 8164,
    r18_19: 8165,
    r18_20: 8166,
    r18_21: 8167,
    r18_22: 8168,
    r18_17_open: 8169,
    r12_8_offbox: 8196,
    r18_13: 8199,
} as const;

/**
 * The same spec-owned server as another machine reaches it: this host's own
 * LAN address. Fails rather than skips when the host has none, so a missing
 * interface can never read as a covered row.
 */
function offBoxURL(port: number): string {
    const ip = lanAddress();
    expect(
        ip,
        'this host needs a non-loopback IPv4 address to stand in for another machine (none found in os.networkInterfaces())',
    ).toBeTruthy();
    return `http://${ip}:${port}`;
}

/**
 * `refusing shutdown from <address>: <reason>`, with the address as the server
 * saw it: a dual-stack listener reports an IPv4 peer as `::ffff:a.b.c.d`.
 */
function shutdownRefusal(offBox: string, reason: string): RegExp {
    const ip = new URL(offBox).hostname.replaceAll('.', '\\.');
    return new RegExp(`^refusing shutdown from (?:::ffff:)?${ip}: ${reason}$`);
}

const OWNER: Credentials = { username: 'e2e164b-owner', password: 'e2e164b-owner-pw' };
const MEMBER: Credentials = { username: 'e2e164b-member', password: 'e2e164b-member-pw' };
const BYSTANDER: Credentials = { username: 'e2e164b-bystander', password: 'e2e164b-bystander-pw' };
const THROWAWAY: Credentials = { username: 'e2e164b-throwaway', password: 'e2e164b-throwaway-pw' };

/** session.ts: SESSION_TTL_MS, sliding. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ConfigEnvelope {
    config: { webPort?: number; allowRemoteAdmin?: boolean; [key: string]: unknown };
    runtime: { adminScope?: string; callerIsLocal?: boolean; [key: string]: unknown };
}

async function readConfig(ctx: APIRequestContext): Promise<ConfigEnvelope> {
    const res = await ctx.get('/api/config');
    expect(res.status(), 'GET /api/config').toBe(200);
    return (await res.json()) as ConfigEnvelope;
}

async function closeAll(...contexts: (BrowserContext | APIRequestContext | undefined)[]): Promise<void> {
    for (const ctx of contexts) {
        if (!ctx) continue;
        try {
            if ('dispose' in ctx) await ctx.dispose();
            else await ctx.close();
        } catch {
            // already gone with its page or its server
        }
    }
}

function isNavigationTo(pathname: string) {
    return (r: import('@playwright/test').Response) =>
        r.request().isNavigationRequest() && new URL(r.url()).pathname === pathname;
}

test.describe('auth and admin scope (smoke 12.8, 18.13, 18.16–18.22)', () => {
    test('12.8 shutdown from this machine with login on: a signed-in non-admin is refused 403 forbidden, logs nothing and the server stays up; a signed-in admin is the control that stops it', async () => {
        test.setTimeout(150_000);
        // Finding 12.12 (fixed 2026-10-05): /api/server/shutdown is allow-listed,
        // and AuthGate used to return before reading the session there, so
        // requireAdmin took this signed-in non-admin for the implicit admin and
        // the server exited. The gate now attaches `req.user` on allow-listed
        // paths too.
        const server = await OwnedServer.start('12-8', PORT.r12_8);
        let member: APIRequestContext | undefined;
        let owner: APIRequestContext | undefined;
        try {
            await lockDown(server.baseURL, OWNER, MEMBER);
            member = await apiContext(server.baseURL);
            await signIn(member, MEMBER);
            expect(await me(member)).toEqual({
                authEnabled: true,
                user: { username: MEMBER.username, role: 'user' },
            });

            // (b), from loopback: the admin check is the only thing that can
            // refuse it here, and its body is the plain authz 403.
            const refused = await member.post('/api/server/shutdown');
            expect(refused.status(), `non-admin shutdown answered: ${await refused.text()}`).toBe(403);
            expect(await refused.json()).toEqual({ error: 'forbidden' });

            // "The server stays up throughout." A granted shutdown exits 100 ms
            // after its 200 (ServerShutdownApi SHUTDOWN_DELAY_MS); proving an
            // exit did NOT happen needs a bounded wait, there is nothing to poll.
            const outcome = await Promise.race([
                server.handle.exited.then(() => 'exited' as const),
                new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 2_000)),
            ]);
            expect(outcome, server.handle.output()).toBe('alive');
            // Still serving, and still serving THIS caller the app: it is signed
            // in, so `/` is the app shell, not the login page. (This read
            // `expectLoginHtml` while the row was a `test.fail` and never got
            // this far.)
            expectSpaHtml(await (await member.get('/')).text());
            expect((await me(member)).user, 'the refused caller keeps its session').toEqual({
                username: MEMBER.username,
                role: 'user',
            });

            // The control: the same route, the same machine, an admin session.
            owner = await apiContext(server.baseURL);
            await signIn(owner, OWNER);
            const granted = await owner.post('/api/server/shutdown');
            expect(granted.status()).toBe(200);
            expect(await granted.json()).toEqual({ ok: true });
            const exit = await withTimeout(
                server.handle.exited,
                60_000,
                () => `waiting for the admin's shutdown to exit the server:\n${server.handle.output()}`,
            );
            expect(exit.code).toBe(0);

            // Read once the process has exited, so nothing is still buffered.
            // (b) logs nothing: no refusal line at all, and exactly one granted
            // request — the admin's.
            const log = readServerLog(server.paths);
            expect(log, 'the server log must exist').not.toBe('');
            expect(log).not.toContain('refusing shutdown');
            expect(log.match(/shutdown requested via \/api\/server\/shutdown/g) ?? []).toHaveLength(1);
        } finally {
            await closeAll(member, owner);
            await server.dispose('12.8');
        }
    });

    test('12.8 shutdown from another machine: in open mode (c) with no token and (d) with a token but remote admin off answer 403, with login on (a) signed out answers 401; each logs its refusal and the server stays up', async () => {
        test.setTimeout(150_000);
        const server = await OwnedServer.start('12-8-offbox', PORT.r12_8_offbox);
        const offBox = offBoxURL(server.paths.port);
        let bare: APIRequestContext | undefined;
        let visitor: APIRequestContext | undefined;
        let owner: APIRequestContext | undefined;
        try {
            // (c) open mode, no token at all: the ladder's first rung.
            bare = await request.newContext({ baseURL: offBox });
            const noToken = await bare.post('/api/server/shutdown');
            expect(noToken.status(), `(c) answered: ${await noToken.text()}`).toBe(403);
            expect(await noToken.json()).toEqual({ error: 'this endpoint answers this machine only' });

            // (d) open mode, carrying the token the page hands out, remote admin off.
            visitor = await apiContext(offBox);
            const env = await readConfig(visitor);
            expect(env.runtime.adminScope).toBe('local');
            expect(env.runtime.callerIsLocal, 'the LAN address must read as another machine').toBe(false);
            const noOptOut = await visitor.post('/api/server/shutdown');
            expect(noOptOut.status(), `(d) answered: ${await noOptOut.text()}`).toBe(403);
            expect(await noOptOut.json()).toEqual({ error: 'admin actions are limited to this machine' });

            // (a) login on, the same browser, still carrying its token, signed out.
            await lockDown(server.baseURL, OWNER, MEMBER);
            const signedOut = await visitor.post('/api/server/shutdown');
            expect(signedOut.status(), `(a) answered: ${await signedOut.text()}`).toBe(401);
            expect(await signedOut.json()).toEqual({ error: 'unauthorized' });

            // "The server stays up throughout." A granted shutdown exits 100 ms
            // after its 200, so a bounded wait is the only way to see it did not.
            const outcome = await Promise.race([
                server.handle.exited.then(() => 'exited' as const),
                new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 2_000)),
            ]);
            expect(outcome, server.handle.output()).toBe('alive');

            // The control, and the way to a log with nothing still buffered: an
            // admin's shutdown from this machine stops it.
            owner = await apiContext(server.baseURL);
            await signIn(owner, OWNER);
            const granted = await owner.post('/api/server/shutdown');
            expect(granted.status()).toBe(200);
            expect(await granted.json()).toEqual({ ok: true });
            const exit = await withTimeout(
                server.handle.exited,
                60_000,
                () => `waiting for the admin's shutdown to exit the server:\n${server.handle.output()}`,
            );
            expect(exit.code).toBe(0);

            // (a), (c) and (d) each log `refusing shutdown from …`, in order, from
            // the LAN address; only the admin's request was granted.
            const log = readServerLog(server.paths);
            expect(log, 'the server log must exist').not.toBe('');
            const refusals = log.match(/refusing shutdown from [^\r\n]*/g) ?? [];
            expect(refusals, log).toHaveLength(3);
            expect(refusals[0]).toMatch(shutdownRefusal(offBox, 'no instance token'));
            expect(refusals[1]).toMatch(shutdownRefusal(offBox, 'remote admin not allowed'));
            expect(refusals[2]).toMatch(shutdownRefusal(offBox, 'not signed in'));
            expect(log.match(/shutdown requested via \/api\/server\/shutdown/g) ?? []).toHaveLength(1);
        } finally {
            await closeAll(bare, visitor, owner);
            await server.dispose('12.8 off-box');
        }
    });

    test('18.16 every admin write named in the row is refused 403 from another machine and passes from this machine; under WS_SCRCPY_ALLOW_REMOTE_ADMIN=1, and signed in as an admin, it passes from both, and /api/config reports adminScope local, remote, authenticated with callerIsLocal false off-box', async () => {
        test.setTimeout(240_000);
        const server = await OwnedServer.start('18-16', PORT.r18_16);
        const PROBE_USER: Credentials = { username: 'e2e164b-probe', password: 'e2e164b-probe-pw' };
        let ctx: APIRequestContext | undefined;
        let owner: APIRequestContext | undefined;

        /**
         * Each route named in the row, with the answer its OWN handler gives once
         * the operator gate has let the caller through. Every expected body is
         * exact, so the gate's 403 `admin actions are limited to this machine`
         * can never pass for one of them.
         *
         * Two routes are reached through a sibling on the same handler rather
         * than called as named, because calling them for real from loopback is
         * not a test: POST /api/service/install installs a real OS service (UAC
         * on Windows, pkexec on Linux), and POST /api/dependencies/check goes to
         * the network for every dependency. ServiceApi and DependencyApi both run
         * `requireOperator` BEFORE routing (ServiceApi.ts, DependencyApi.ts), so a
         * POST to an unknown route under the same prefix crosses the identical
         * gate and then answers the handler's own 404.
         */
        const probeAdminWrites = async (
            c: APIRequestContext,
            locked: boolean,
            phase: string,
            probeUser: Credentials = PROBE_USER,
        ): Promise<void> => {
            const patch = await c.patch('/api/config', { data: {} });
            expect(patch.status(), `${phase}: PATCH /api/config ${await patch.text()}`).toBe(200);
            const patched = (await patch.json()) as { config: { webPort: number }; restartRequired: boolean };
            expect(patched.config.webPort).toBe(server.paths.port);
            expect(patched.restartRequired).toBe(false);

            const users = await c.post('/api/users', {
                data: { username: probeUser.username, password: probeUser.password, role: 'user' },
            });
            if (locked) {
                // Signed in as an admin: an ordinary create.
                expect(users.status(), `${phase}: POST /api/users ${await users.text()}`).toBe(201);
                expect(Object.keys((await users.json()) as object)).toEqual(['id']);
            } else {
                // A fresh store takes the lockdown branch, which needs the admin
                // fields: the handler's own refusal, past the gate, nothing created.
                expect(users.status(), `${phase}: POST /api/users`).toBe(400);
                expect(await users.json()).toEqual({
                    error: 'adminUsername and adminPassword are required to secure the admin account',
                });
            }

            const batch = await c.post('/api/settings/batch', { data: { changes: [] } });
            expect(batch.status(), `${phase}: POST /api/settings/batch`).toBe(200);
            expect(await batch.json()).toEqual({ ok: true, applied: [] });

            const service = await c.post('/api/service/e2e-164b-no-such-route');
            expect(service.status(), `${phase}: POST under /api/service/`).toBe(404);
            expect(await service.json()).toEqual({ error: 'Not found' });

            const deps = await c.post('/api/dependencies/e2e-164b-no-such-route');
            expect(deps.status(), `${phase}: POST under /api/dependencies/`).toBe(404);
            expect(await deps.json()).toEqual({ error: 'Not found' });

            const updates = await c.post('/api/updates/check');
            expect(updates.status(), `${phase}: POST /api/updates/check`).toBe(503);
            expect(await updates.json()).toEqual({ ok: false, error: 'dev mode — packaging features disabled' });

            const enable = await c.post('/api/auth/enable');
            if (locked) {
                expect(enable.status(), `${phase}: POST /api/auth/enable`).toBe(200);
                expect(await enable.json()).toEqual({ ok: true });
            } else {
                expect(enable.status(), `${phase}: POST /api/auth/enable`).toBe(409);
                expect(await enable.json()).toEqual({ error: 'set an admin password before enabling auth' });
            }
        };

        /**
         * The row's subject: the same writes from another machine, each refused by
         * the operator gate with the row's exact body before its handler runs.
         */
        const probeRefusedWrites = async (c: APIRequestContext, phase: string): Promise<void> => {
            const writes: [string, () => Promise<APIResponse>][] = [
                ['PATCH /api/config', () => c.patch('/api/config', { data: {} })],
                [
                    'POST /api/users',
                    () =>
                        c.post('/api/users', {
                            data: { username: PROBE_USER.username, password: PROBE_USER.password, role: 'user' },
                        }),
                ],
                ['POST /api/settings/batch', () => c.post('/api/settings/batch', { data: { changes: [] } })],
                ['POST under /api/service/', () => c.post('/api/service/e2e-164b-no-such-route')],
                ['POST under /api/dependencies/', () => c.post('/api/dependencies/e2e-164b-no-such-route')],
                ['POST /api/updates/check', () => c.post('/api/updates/check')],
                ['POST /api/auth/enable', () => c.post('/api/auth/enable')],
            ];
            for (const [route, send] of writes) {
                const res = await send();
                expect(res.status(), `${phase}: ${route} ${await res.text()}`).toBe(403);
                expect(await res.json(), `${phase}: ${route}`).toEqual({
                    error: 'admin actions are limited to this machine',
                });
            }
        };
        const OFFBOX_PROBE_USER: Credentials = {
            username: 'e2e164b-probe-offbox',
            password: 'e2e164b-probe-offbox-pw',
        };
        let offBox: APIRequestContext | undefined;

        try {
            // --- open mode, remote admin off (the env var explicitly ABSENT).
            ctx = await apiContext(server.baseURL);
            let env = await readConfig(ctx);
            expect(env.runtime.adminScope).toBe('local');
            expect(env.runtime.callerIsLocal).toBe(true);
            expect(env.config.allowRemoteAdmin).not.toBe(true);

            // The row's subject, from another machine: every write refused,
            // nothing changed, and the envelope says the caller is not local.
            offBox = await apiContext(offBoxURL(server.paths.port));
            env = await readConfig(offBox);
            expect(env.runtime.adminScope).toBe('local');
            expect(env.runtime.callerIsLocal, 'the LAN address must read as another machine').toBe(false);
            await probeRefusedWrites(offBox, 'off-box, open, remote admin off');
            expect((await me(ctx)).authEnabled).toBe(false);
            expect((await listUsers(ctx)).map((u) => u.username)).toEqual(['admin']);
            await offBox.dispose();
            offBox = undefined;

            // The same writes from this machine pass the gate.
            await probeAdminWrites(ctx, false, 'open, remote admin off');
            expect((await me(ctx)).authEnabled).toBe(false);
            expect((await listUsers(ctx)).map((u) => u.username)).toEqual(['admin']);
            await ctx.dispose();
            ctx = undefined;

            // --- restart with the opt-out set: the scope reads remote, and the
            // config key is still off, so it is the variable that did it.
            await server.restart({ [REMOTE_ADMIN_ENV]: '1' });
            ctx = await apiContext(server.baseURL);
            env = await readConfig(ctx);
            expect(env.runtime.adminScope).toBe('remote');
            expect(env.runtime.callerIsLocal).toBe(true);
            expect(env.config.allowRemoteAdmin).not.toBe(true);
            await probeAdminWrites(ctx, false, 'open, WS_SCRCPY_ALLOW_REMOTE_ADMIN=1');
            // And from another machine, which is what the variable is for.
            offBox = await apiContext(offBoxURL(server.paths.port));
            env = await readConfig(offBox);
            expect(env.runtime.adminScope).toBe('remote');
            expect(env.runtime.callerIsLocal).toBe(false);
            await probeAdminWrites(offBox, false, 'off-box, open, WS_SCRCPY_ALLOW_REMOTE_ADMIN=1');
            await offBox.dispose();
            offBox = undefined;

            // --- turn login on (still under the variable) and repeat signed in
            // as an admin: 'authenticated' outranks the opt-out.
            await dismissPromptsFor(ctx);
            const locked = await ctx.post('/api/users', {
                data: {
                    adminUsername: OWNER.username,
                    adminPassword: OWNER.password,
                    username: MEMBER.username,
                    password: MEMBER.password,
                    role: 'user',
                },
            });
            expect(locked.status(), await locked.text()).toBe(201);
            expect(await locked.json()).toEqual({ ok: true });
            expect(await me(ctx)).toEqual({ authEnabled: true, user: null });
            owner = await apiContext(server.baseURL);
            await signIn(owner, OWNER);
            env = await readConfig(owner);
            expect(env.runtime.adminScope).toBe('authenticated');
            expect(env.runtime.callerIsLocal).toBe(true);
            await probeAdminWrites(owner, true, 'locked, signed in as admin');
            expect((await userByName(owner, PROBE_USER.username)).role).toBe('user');

            // --- a signed-in admin from another machine, with the variable GONE:
            // the session alone is what lets it through.
            await server.restart();
            offBox = await apiContext(offBoxURL(server.paths.port));
            await signIn(offBox, OWNER);
            env = await readConfig(offBox);
            expect(env.runtime.adminScope).toBe('authenticated');
            expect(env.runtime.callerIsLocal).toBe(false);
            await probeAdminWrites(offBox, true, 'off-box, locked, signed in as admin', OFFBOX_PROBE_USER);
            expect((await userByName(offBox, OFFBOX_PROBE_USER.username)).role).toBe('user');
        } finally {
            await closeAll(ctx, owner, offBox);
            await server.dispose('18.16');
        }
        // NOT covered here: a container refusing by default, where nobody is on
        // its loopback and compose forwards the variable. That is the container tier.
    });

    test('18.17 an already-open socket closes 4401 when its session ends — by logout, by disabling the user, by deleting the user — and another user’s session and socket are untouched', async ({
        browser,
    }) => {
        test.setTimeout(150_000);
        const server = await OwnedServer.start('18-17', PORT.r18_17);
        let admin: APIRequestContext | undefined;
        let a: { context: BrowserContext; page: Page } | undefined;
        let c: { context: BrowserContext; page: Page } | undefined;
        try {
            await lockDown(server.baseURL, OWNER, MEMBER);
            admin = await apiContext(server.baseURL);
            await signIn(admin, OWNER);
            const bystander = await admin.post('/api/users', {
                data: { username: BYSTANDER.username, password: BYSTANDER.password, role: 'user' },
            });
            expect(bystander.status(), await bystander.text()).toBe(201);

            // Browser C: another user's session, with a live socket, throughout.
            c = await signedInVisitor(browser, server.baseURL, BYSTANDER);
            await openLiveSocket(c.page, 'c');
            const expectBystanderUntouched = async (when: string) => {
                const cp = c?.page as Page;
                await expectSocketServed(cp, 'c');
                expect((await me(c?.context.request as APIRequestContext)).user, when).toEqual({
                    username: BYSTANDER.username,
                    role: 'user',
                });
            };

            // (a) Log out in A: A's open socket closes with 4401.
            a = await signedInVisitor(browser, server.baseURL, MEMBER);
            await openLiveSocket(a.page, 'a-logout');
            const out = await logoutViaApi(a.context.request);
            expect(out.status()).toBe(200);
            expect(await out.json()).toEqual({ ok: true });
            await expect.poll(() => socketState((a as { page: Page }).page, 'a-logout')).toEqual(REVOKED);
            await expectBystanderUntouched('after (a) logout');

            // (b) Reopen as the same user; the admin disables that user.
            await signIn(a.context.request, MEMBER);
            await openLiveSocket(a.page, 'a-disable');
            const memberId = (await userByName(admin, MEMBER.username)).id;
            const disable = await admin.patch(`/api/users/${memberId}`, { data: { disabled: true } });
            expect(disable.status()).toBe(200);
            expect(await disable.json()).toEqual({ ok: true });
            await expect.poll(() => socketState((a as { page: Page }).page, 'a-disable')).toEqual(REVOKED);
            expect((await me(a.context.request)).user).toBeNull();
            await expectBystanderUntouched('after (b) disable');

            // (c) A throwaway user in A; the admin deletes it.
            const created = await admin.post('/api/users', {
                data: { username: THROWAWAY.username, password: THROWAWAY.password, role: 'user' },
            });
            expect(created.status(), await created.text()).toBe(201);
            const throwawayId = ((await created.json()) as { id: number }).id;
            await signIn(a.context.request, THROWAWAY);
            await openLiveSocket(a.page, 'a-delete');
            const del = await admin.delete(`/api/users/${throwawayId}`);
            expect(del.status()).toBe(200);
            expect(await del.json()).toEqual({ ok: true });
            await expect.poll(() => socketState((a as { page: Page }).page, 'a-delete')).toEqual(REVOKED);
            expect((await me(a.context.request)).user).toBeNull();
            await expectBystanderUntouched('after (c) delete');
        } finally {
            await closeAll(a?.context, c?.context, admin);
            await server.dispose('18.17');
        }
    });

    test('18.17 in open mode a logout closes nothing: a socket opened after login was turned off survives a logout from the same browser', async ({
        browser,
    }) => {
        test.setTimeout(150_000);
        // Finding 18.23 (fixed 2026-10-05): the handshake registered every socket
        // under the cookie's session token whatever the mode, so this browser's
        // open-mode socket was closed 4401 by the logout. A socket now carries a
        // token only when auth is on and the session is valid (wsSession).
        const server = await OwnedServer.start('18-17-open', PORT.r18_17_open);
        let owner: { context: BrowserContext; page: Page } | undefined;
        let anon: BrowserContext | undefined;
        try {
            await lockDown(server.baseURL, OWNER, MEMBER);
            // The state 18.11 leaves: the admin turned login off from a browser
            // that is still signed in, so that browser still carries its cookie.
            owner = await signedInVisitor(browser, server.baseURL, OWNER);
            const off = await owner.context.request.post('/api/auth/disable');
            expect(off.status()).toBe(200);
            expect(await off.json()).toEqual({ ok: true });
            expect((await me(owner.context.request)).authEnabled).toBe(false);
            await sidOf(owner.context); // the cookie is still there — the case under test

            await owner.page.goto('/');
            await openLiveSocket(owner.page, 'open-mode');
            anon = await browser.newContext({ baseURL: server.baseURL });
            const anonPage = await anon.newPage();
            await anonPage.goto('/');
            await openLiveSocket(anonPage, 'anon');

            const out = await logoutViaApi(owner.context.request);
            expect(out.status()).toBe(200);
            expect(await out.json()).toEqual({ ok: true });

            // The server closes revoked sockets BEFORE it answers the logout, and
            // frames on one socket arrive in order, so a reply here is proof the
            // socket was not closed.
            // The cookie-less browser first (it passes today), then the subject.
            await expectSocketServed(anonPage, 'anon');
            expect((await me(owner.context.request)).authEnabled).toBe(false);
            await expectSocketServed(owner.page, 'open-mode');
        } finally {
            await closeAll(owner?.context, anon);
            await server.dispose('18.17 open mode');
        }
    });

    test('18.18 a session idle for over 30 days answers 401 and its row is deleted; a session used inside the window slides its 30-day deadline forward', async () => {
        test.setTimeout(150_000);
        const server = await OwnedServer.start('18-18', PORT.r18_18);
        let stale: APIRequestContext | undefined;
        let fresh: APIRequestContext | undefined;
        try {
            await lockDown(server.baseURL, OWNER, MEMBER);
            stale = await apiContext(server.baseURL);
            fresh = await apiContext(server.baseURL);
            await signIn(stale, MEMBER);
            await signIn(fresh, MEMBER);
            const staleSid = await sidOf(stale);
            const freshSid = await sidOf(fresh);
            expect(staleSid).not.toBe(freshSid);

            // Both are good sessions before the clock moves: the 401 below is
            // attributable to the age, nothing else.
            for (const c of [stale, fresh]) {
                const ok = await c.get('/api/settings');
                expect(ok.status()).toBe(200);
            }
            const before = readSession(server.paths.dbPath, staleSid);
            expect(before, 'the stale session row').toBeDefined();
            const userId = before?.user_id as number;

            const now = Date.now();
            const staleLastUse = now - SESSION_TTL_MS - DAY_MS; // 31 days ago
            const freshLastUse = now - SESSION_TTL_MS + DAY_MS; // 29 days ago
            backdateSession(server.paths.dbPath, staleSid, staleLastUse, SESSION_TTL_MS);
            backdateSession(server.paths.dbPath, freshSid, freshLastUse, SESSION_TTL_MS);
            expect(readSession(server.paths.dbPath, staleSid)).toEqual({
                user_id: userId,
                created_at: staleLastUse,
                last_seen_at: staleLastUse,
                expires_at: staleLastUse + SESSION_TTL_MS,
            });
            expect(readSession(server.paths.dbPath, freshSid)).toEqual({
                user_id: userId,
                created_at: freshLastUse,
                last_seen_at: freshLastUse,
                expires_at: freshLastUse + SESSION_TTL_MS,
            });

            // The stale session: 401, and the row is gone.
            const t0 = Date.now();
            const refused = await stale.get('/api/settings');
            expect(refused.status()).toBe(401);
            expect(await refused.json()).toEqual({ error: 'unauthorized' });
            expect(readSession(server.paths.dbPath, staleSid)).toBeUndefined();
            expect(await me(stale)).toEqual({ authEnabled: true, user: null });

            // The session in the window: served, and its deadline slid forward
            // to a full 30 days from this use.
            const served = await fresh.get('/api/settings');
            expect(served.status()).toBe(200);
            const slid = readSession(server.paths.dbPath, freshSid);
            expect(slid?.user_id).toBe(userId);
            expect(slid?.created_at).toBe(freshLastUse);
            expect(slid?.last_seen_at ?? 0).toBeGreaterThanOrEqual(t0);
            expect(slid?.expires_at).toBe((slid?.last_seen_at ?? 0) + SESSION_TTL_MS);
            expect(slid?.expires_at ?? 0).toBeGreaterThan(freshLastUse + SESSION_TTL_MS + 28 * DAY_MS);
            expect((await me(fresh)).user).toEqual({ username: MEMBER.username, role: 'user' });
        } finally {
            await closeAll(stale, fresh);
            await server.dispose('18.18');
        }
    });

    test('18.19 with login on, a signed-out request under /login-assets/ is refused exactly like any other unauthenticated path, and the same path is served once signed in', async () => {
        test.setTimeout(120_000);
        const server = await OwnedServer.start('18-19', PORT.r18_19);
        let owner: APIRequestContext | undefined;
        try {
            await lockDown(server.baseURL, OWNER, MEMBER);

            // `curl -i`: a fresh client per request, no cookie of any kind.
            const signedOut = async (p: string) => {
                const ctx = await request.newContext({ baseURL: server.baseURL });
                try {
                    const res = await ctx.get(p, { maxRedirects: 0 });
                    return { status: res.status(), contentType: res.headers()['content-type'], body: await res.text() };
                } finally {
                    await ctx.dispose();
                }
            };
            const pairs: [string, string][] = [
                ['/login-assets/x', '/e2e-164b-not-exempt/x'],
                ['/login-assets/', '/e2e-164b-not-exempt/'],
                ['/login-assets/app.js', '/e2e-164b-not-exempt/app.js'],
            ];
            for (const [subject, control] of pairs) {
                expect(await signedOut(subject), `${subject} vs ${control}`).toEqual(await signedOut(control));
            }
            const x = await signedOut('/login-assets/x');
            expect(x.status).toBe(200);
            expect(x.contentType).toContain('text/html');
            expectLoginHtml(x.body);

            // Signed in, the same path reaches the static handler: a navigation
            // gets the SPA shell (StaticFileServer's fallback keys on an HTML
            // Accept), anything else its plain 404. What answered above was the
            // gate, not a missing file.
            owner = await apiContext(server.baseURL);
            await signIn(owner, OWNER);
            const served = await owner.get('/login-assets/x', { headers: { accept: 'text/html' } });
            expect(served.status()).toBe(200);
            expectSpaHtml(await served.text());
            const asset = await owner.get('/login-assets/x');
            expect(asset.status()).toBe(404);
            expect(await asset.text()).toBe('Not Found');
        } finally {
            await closeAll(owner);
            await server.dispose('18.19');
        }
    });

    test('18.20 Users → enable login: on a store with no admin password it says to add one and changes nothing; with a passworded admin it reloads behind the login page; then back to open mode', async ({
        browser,
    }) => {
        test.setTimeout(150_000);
        const server = await OwnedServer.start('18-20', PORT.r18_20);
        let probe: APIRequestContext | undefined;
        let owner: APIRequestContext | undefined;
        let context: BrowserContext | undefined;
        try {
            probe = await apiContext(server.baseURL);
            await dismissPromptsFor(probe);
            expect((await me(probe)).authEnabled).toBe(false);
            expect(await meNeedsLockdown(probe), 'a fresh store has no passworded admin').toBe(true);

            context = await browser.newContext({ baseURL: server.baseURL });
            const page = await context.newPage();
            await page.goto('/');
            await expectAppShell(page);

            // --- no passworded admin: the message, and nothing changes.
            let settings = await openSettings(page);
            let users = await openSettingsTab(settings, 'Users');
            let enable = settingsRow(users, 'login').getByRole('button', { name: 'enable login', exact: true });
            await expect(enable).toBeVisible();
            await page.evaluate(() => {
                (window as unknown as { __e2e_18_20?: string }).__e2e_18_20 = 'armed';
            });
            const refusedSeen = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/enable',
            );
            await enable.click();
            const refused = await refusedSeen;
            expect(refused.status()).toBe(409);
            expect(await refused.json()).toEqual({ error: 'set an admin password before enabling auth' });
            // The result is on the tab's ONE status line (0.5.5): below the
            // card, outside it, in the error tone, and gone again after an
            // error's 10 s. Not beside the button any more.
            const line = settingsTabLine(users);
            await expect(line).toHaveText('Add a user with an admin password first (Users → manage users)');
            await expect(line).toBeVisible();
            await expect(line).toHaveAttribute('role', 'status');
            await expect(line).toHaveClass(/settings-status-error/);
            await expect(users.locator('.settings-card [data-settings-alert]')).toHaveCount(0);
            const lineBox = await line.boundingBox();
            const cardBox = await users.locator('.settings-card').boundingBox();
            expect(lineBox && cardBox && lineBox.y >= cardBox.y + cardBox.height, 'the line is below the card').toBe(
                true,
            );
            expect(
                await line.evaluate((el) => el.parentElement?.lastElementChild === el),
                'the last thing in the tab',
            ).toBe(true);
            await expect(line).toBeHidden({ timeout: 15_000 });
            await expect(settings).toBeVisible();
            expect(await page.evaluate(() => (window as unknown as { __e2e_18_20?: string }).__e2e_18_20)).toBe(
                'armed',
            );
            expect((await me(probe)).authEnabled).toBe(false);
            expectSpaHtml(await (await probe.get('/')).text());
            await closeTopModal(page, settings);

            // --- a passworded admin with login off (the state 18.11 leaves).
            await lockDown(server.baseURL, OWNER, MEMBER);
            owner = await apiContext(server.baseURL);
            await signIn(owner, OWNER);
            const off = await owner.post('/api/auth/disable');
            expect(off.status()).toBe(200);
            expect((await me(probe)).authEnabled).toBe(false);
            expect(await meNeedsLockdown(probe)).toBe(false);

            await page.goto('/');
            await expectAppShell(page);
            settings = await openSettings(page);
            users = await openSettingsTab(settings, 'Users');
            enable = settingsRow(users, 'login').getByRole('button', { name: 'enable login', exact: true });
            await expect(enable).toBeVisible();
            // Captured inside the route: the client reloads on this response.
            const capture = await captureResponse(page, { method: 'POST', pathname: '/api/auth/enable' });
            try {
                const reloaded = page.waitForResponse(isNavigationTo('/'));
                await enable.click();
                const res = await capture.captured;
                expect(res.status).toBe(200);
                expect(res.body).toEqual({ ok: true });
                const doc = await reloaded;
                expect(doc.status()).toBe(200);
            } finally {
                await capture.dispose();
            }
            await expectLoginPage(page);
            expect(await me(probe)).toEqual({ authEnabled: true, user: null });

            // --- afterwards, return to open mode.
            const back = await owner.post('/api/auth/disable');
            expect(back.status()).toBe(200);
            expect(await back.json()).toEqual({ ok: true });
            expect((await me(probe)).authEnabled).toBe(false);
            await page.goto('/');
            await expectAppShell(page);
        } finally {
            await closeAll(context, probe, owner);
            await server.dispose('18.20');
        }
    });

    test('18.21 with login turned off and the admin still passworded, Users → Add user is an ordinary create: no secure-the-admin block, no "Login is now required", no reload', async ({
        browser,
    }) => {
        test.setTimeout(150_000);
        const server = await OwnedServer.start('18-21', PORT.r18_21);
        const NEW_USER: Credentials = { username: 'e2e164b-added', password: 'e2e164b-added-pw' };
        let probe: APIRequestContext | undefined;
        let owner: APIRequestContext | undefined;
        let context: BrowserContext | undefined;
        try {
            await lockDown(server.baseURL, OWNER, MEMBER);
            owner = await apiContext(server.baseURL);
            await signIn(owner, OWNER);
            const off = await owner.post('/api/auth/disable');
            expect(off.status()).toBe(200);
            probe = await apiContext(server.baseURL);
            expect((await me(probe)).authEnabled).toBe(false);
            expect(await meNeedsLockdown(probe), 'the admin is still passworded').toBe(false);
            const countBefore = (await listUsers(probe)).length;

            context = await browser.newContext({ baseURL: server.baseURL });
            const page = await context.newPage();
            await page.goto('/');
            await expectAppShell(page);
            let navigations = 0;
            page.on('framenavigated', (frame) => {
                if (frame === page.mainFrame()) navigations++;
            });
            await page.evaluate(() => {
                (window as unknown as { __e2e_18_21?: string }).__e2e_18_21 = 'armed';
            });

            const usersModal = await openUsersModal(page);
            await usersModal.getByRole('button', { name: 'Add user', exact: true }).click();
            const fresh = usersModal.locator('.new-user-section');
            await expect(fresh).toBeVisible();
            // No lockdown block, in any form.
            await expect(usersModal.locator('.lockdown-section')).toHaveCount(0);
            await expect(usersModal).not.toContainText('Secure the admin account');
            await expect(usersModal.getByRole('button', { name: 'Secure & add user' })).toHaveCount(0);

            await fresh.locator('input[type="text"]').fill(NEW_USER.username);
            await fresh.locator('select.modal-select').selectOption('user');
            await fresh.locator('input[type="password"]').fill(NEW_USER.password);
            const createdSeen = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/users',
            );
            await usersModal.getByRole('button', { name: 'Add user', exact: true }).click();
            const created = await createdSeen;
            const sent = created.request().postDataJSON() as Record<string, unknown>;
            expect(sent).toMatchObject({ username: NEW_USER.username, role: 'user', password: NEW_USER.password });
            expect(sent).not.toHaveProperty('adminUsername');
            expect(sent).not.toHaveProperty('adminPassword');
            expect(created.status()).toBe(201);
            // The normal-create shape: {id}, never the lockdown branch's {ok:true}.
            const body = (await created.json()) as Record<string, unknown>;
            expect(Object.keys(body)).toEqual(['id']);
            expect(typeof body['id']).toBe('number');

            // The modal refreshed into the list, with the new user in it.
            await expect(userRow(usersModal, NEW_USER.username)).toHaveCount(1);
            await expect(usersModal).not.toContainText('Login is now required');
            expect(await page.evaluate(() => (window as unknown as { __e2e_18_21?: string }).__e2e_18_21)).toBe(
                'armed',
            );
            expect(navigations, 'no reload').toBe(0);
            await expect(page).toHaveTitle(APP_TITLE);

            // And the server stayed open.
            expect((await me(probe)).authEnabled).toBe(false);
            expectSpaHtml(await (await probe.get('/')).text());
            const after = await listUsers(probe);
            expect(after).toHaveLength(countBefore + 1);
            expect(after.find((u) => u.username === NEW_USER.username)).toMatchObject({
                role: 'user',
                hasPassword: true,
                disabled: false,
            });
            await closeAllModals(page);
        } finally {
            await closeAll(context, probe, owner);
            await server.dispose('18.21');
        }
    });

    test('18.22 admin-scope banner: on this machine three actions, from another machine read-only with Dismiss only; Dismiss persists per user and reset brings it back, only the explicit accept widens exposure, and with remote admin on the home page shows no banner on either', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        const server = await OwnedServer.start('18-22', PORT.r18_22);
        let probe: APIRequestContext | undefined;
        let context: BrowserContext | undefined;
        let second: BrowserContext | undefined;
        let remote: BrowserContext | undefined;
        try {
            probe = await apiContext(server.baseURL);
            await dismissPromptsFor(probe);
            const scope = async () => {
                const env = await readConfig(probe as APIRequestContext);
                return {
                    adminScope: env.runtime.adminScope,
                    callerIsLocal: env.runtime.callerIsLocal,
                    allowRemoteAdmin: env.config.allowRemoteAdmin === true,
                };
            };
            const dismissedFlag = async () => {
                const res = await (probe as APIRequestContext).get('/api/settings');
                expect(res.status()).toBe(200);
                return ((await res.json()) as Record<string, unknown>)['adminScopeBannerDismissed'];
            };
            expect(await scope()).toEqual({ adminScope: 'local', callerIsLocal: true, allowRemoteAdmin: false });

            context = await browser.newContext({ baseURL: server.baseURL });
            const page = await context.newPage();
            const banner = page.locator('.admin-scope-banner');
            const expectLocalActionable = async () => {
                await expect(banner).toBeVisible();
                await expect(banner).toHaveAttribute('data-state', 'local-actionable');
                await expect(banner.locator('strong')).toHaveText('Admin actions are limited to this machine.');
                await expect(banner.getByRole('button')).toHaveText([
                    'Set up sign-in',
                    'Allow remote admin without sign-in',
                    'Dismiss',
                ]);
            };
            /**
             * A load whose banner must stay HIDDEN. Hidden is also the state
             * before the banner's async chain (settings read, then /api/config)
             * has run, so an immediate check would pass on any build: anchor to
             * the config read and let the page settle first, as 13.1 does.
             */
            const loadSettled = async (p: Page, how: 'goto' | 'reload') => {
                const config = p.waitForResponse(
                    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/config',
                );
                if (how === 'goto') await p.goto('/');
                else await p.reload();
                await config;
                await p.waitForLoadState('networkidle');
            };

            await page.goto('/');
            await expectLocalActionable();

            // --- the same server from another machine: read-only, Dismiss only.
            // Instructions, never buttons: a working control here would render
            // for an attacker too.
            remote = await browser.newContext({ baseURL: offBoxURL(server.paths.port) });
            const remotePage = await remote.newPage();
            const remoteBanner = remotePage.locator('.admin-scope-banner');
            const expectRemoteReadOnly = async () => {
                await expect(remoteBanner).toBeVisible();
                await expect(remoteBanner).toHaveAttribute('data-state', 'local-readonly');
                await expect(remoteBanner.locator('strong')).toHaveText(
                    'Admin actions are disabled for remote clients.',
                );
                await expect(remoteBanner.getByRole('button')).toHaveText(['Dismiss']);
            };
            await remotePage.goto('/');
            await expectRemoteReadOnly();

            // --- Dismiss persists per user (server-side, so a second browser sees it too).
            const dismissSent = page.waitForRequest(
                (r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/settings',
            );
            await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
            await expect(banner).toBeHidden();
            expect((await dismissSent).postDataJSON()).toEqual({ adminScopeBannerDismissed: true });
            await expect.poll(dismissedFlag).toBe(true);
            await loadSettled(page, 'reload');
            await expect(banner).toBeHidden();
            await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
            second = await browser.newContext({ baseURL: server.baseURL });
            const secondPage = await second.newPage();
            await loadSettled(secondPage, 'goto');
            await expect(secondPage.locator('.admin-scope-banner')).toBeHidden();
            await expect(secondPage.getByRole('button', { name: 'Open settings' })).toBeVisible();
            // Open mode has one user, so the dismissal follows it off-box too.
            await loadSettled(remotePage, 'reload');
            await expect(remoteBanner).toBeHidden();
            await expect(remotePage.getByRole('button', { name: 'Open settings' })).toBeVisible();

            // --- reset all my settings brings it back.
            const settings = await openSettings(page);
            const serverTab = await openSettingsTab(settings, 'Server');
            await settingsRow(serverTab, 'reset all my settings')
                .getByRole('button', { name: 'reset', exact: true })
                .click();
            const confirm = page.locator('dialog.reset-confirm-modal[open]');
            await expect(confirm).toBeVisible();
            const reloaded = page.waitForResponse(isNavigationTo('/'));
            await confirm.getByRole('button', { name: 'confirm reset', exact: true }).click();
            await reloaded;
            await expectLocalActionable();
            expect(await dismissedFlag()).not.toBe(true);
            // The reset also re-arms first run (the welcome dialog) and the
            // reminders; put those back so the dialog does not sit over the
            // banner's buttons.
            const firstRun = await probe.patch('/api/config', { data: { firstRunComplete: true } });
            expect(firstRun.status()).toBe(200);
            await dismissPromptsFor(probe);
            await page.reload();
            await expectLocalActionable();
            await expect(page.locator('dialog.welcome-modal[open]')).toHaveCount(0);
            await remotePage.reload();
            await expectRemoteReadOnly();

            // --- every way out of the red modal except the accept leaves exposure unchanged.
            const configWrites: unknown[] = [];
            page.on('request', (r) => {
                if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/config') {
                    configWrites.push(r.postDataJSON());
                }
            });
            const warning = page.locator('dialog.remote-admin-warning-modal[open]');
            const openWarning = async () => {
                await banner.getByRole('button', { name: 'Allow remote admin without sign-in', exact: true }).click();
                await expect(warning).toBeVisible();
                await expect(warning.locator('.modal-title')).toHaveText('Allow remote admin without sign-in?');
                await expect(
                    warning.getByRole('button', { name: 'I understand — allow remote admin', exact: true }),
                ).toBeVisible();
            };
            const exits: [string, () => Promise<void>][] = [
                ['Esc', () => page.keyboard.press('Escape')],
                // Outside the centred frame: the ::backdrop, whose clicks target the dialog itself.
                ['the backdrop', () => page.mouse.click(4, 4)],
                ['×', () => warning.locator('button.modal-close').filter({ hasText: '×' }).click()],
                [
                    'Set up sign-in instead',
                    () => warning.getByRole('button', { name: 'Set up sign-in instead', exact: true }).click(),
                ],
            ];
            for (const [how, leave] of exits) {
                await openWarning();
                await leave();
                await expect(warning, `leaving by ${how}`).toBeHidden();
                // Declining routes to the recommended path: Settings opens.
                await expect(page.locator('dialog.settings-modal[open]'), `leaving by ${how}`).toBeVisible();
                await closeAllModals(page);
                expect(configWrites, `leaving by ${how} must write nothing`).toEqual([]);
                expect(await scope(), `leaving by ${how}`).toEqual({
                    adminScope: 'local',
                    callerIsLocal: true,
                    allowRemoteAdmin: false,
                });
                await expectLocalActionable();
            }

            // --- the explicit accept widens it, and the banner goes away: the
            // warning lives on Settings -> Users since 0.5.5, under the
            // checkbox that turns it off (18.13).
            await openWarning();
            const accepted = page.waitForResponse(
                (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/config',
            );
            await warning.getByRole('button', { name: 'I understand — allow remote admin', exact: true }).click();
            const acceptRes = await accepted;
            expect(acceptRes.status()).toBe(200);
            expect(configWrites).toEqual([{ allowRemoteAdmin: true }]);
            expect(await scope()).toEqual({ adminScope: 'remote', callerIsLocal: true, allowRemoteAdmin: true });
            const expectNoBanner = async (p: Page) => {
                const b = p.locator('.admin-scope-banner');
                await expect(b).toBeHidden();
                await expect(b).not.toHaveAttribute('data-state');
                await expect(b.locator('strong')).toHaveCount(0);
                await expect(p.getByText('Remote admin is enabled without sign-in.')).toHaveCount(0);
            };
            await expectNoBanner(page);
            // On reload, in both browsers and on the other machine: anchored to
            // the config read, since hidden is also the state before it.
            await loadSettled(page, 'reload');
            await expectNoBanner(page);
            await loadSettled(secondPage, 'reload');
            await expectNoBanner(secondPage);
            await loadSettled(remotePage, 'reload');
            await expectNoBanner(remotePage);

            // --- and off again.
            const offRes = await probe.patch('/api/config', { data: { allowRemoteAdmin: false } });
            expect(offRes.status()).toBe(200);
            expect(await scope()).toEqual({ adminScope: 'local', callerIsLocal: true, allowRemoteAdmin: false });
            await page.reload();
            await expectLocalActionable();
            await remotePage.reload();
            await expectRemoteReadOnly();
        } finally {
            await closeAll(remote, second, context, probe);
            await server.dispose('18.22');
        }
    });

    test('18.13 remote admin without sign-in is a checkbox on Settings → Users: turning it on goes through the warning and Save, it survives a restart and an unrelated save, another machine turning it off is warned and loses admin, and an environment that forces it shows it checked and disabled', async ({
        browser,
    }) => {
        test.setTimeout(240_000);
        const server = await OwnedServer.start('18-13', PORT.r18_13);
        let probe: APIRequestContext | undefined;
        let offBox: APIRequestContext | undefined;
        let context: BrowserContext | undefined;
        let remote: BrowserContext | undefined;
        let forcedContext: BrowserContext | undefined;
        try {
            probe = await apiContext(server.baseURL);
            await dismissPromptsFor(probe);
            const scope = async (ctx: APIRequestContext) => {
                const env = await readConfig(ctx);
                return {
                    adminScope: env.runtime.adminScope,
                    callerIsLocal: env.runtime.callerIsLocal,
                    allowRemoteAdmin: env.config.allowRemoteAdmin === true,
                };
            };
            expect(await scope(probe)).toEqual({ adminScope: 'local', callerIsLocal: true, allowRemoteAdmin: false });
            const batchSeen = (p: Page) =>
                p.waitForResponse(
                    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/settings/batch',
                );
            const remoteAdminBox = (section: ReturnType<typeof settingsSection>) =>
                section.getByRole('checkbox', { name: 'remote admin without sign-in', exact: true });

            // --- on this machine: the box is off, with what holds.
            context = await browser.newContext({ baseURL: server.baseURL });
            const page = await context.newPage();
            const writes: string[] = [];
            page.on('request', (r) => {
                const path = new URL(r.url()).pathname;
                // The two routes that write allowRemoteAdmin. (A per-user
                // PATCH /api/settings, the theme, may go by; it is not this.)
                if (
                    (r.method() === 'POST' && path === '/api/settings/batch') ||
                    (r.method() === 'PATCH' && path === '/api/config')
                ) {
                    writes.push(`${r.method()} ${path}`);
                }
            });
            await page.goto('/');
            let settings = await openSettings(page);
            let users = await openSettingsTab(settings, 'Users');
            let box = remoteAdminBox(users);
            let note = users.locator('[data-remote-admin-note]');
            await expect(box).not.toBeChecked();
            await expect(box).toBeEnabled();
            await expect(note).toHaveText('admin actions are limited to this machine unless sign-in is set up.');

            // --- checking it raises the warning; leaving it any other way stages nothing.
            const warning = page.locator('dialog.remote-admin-warning-modal[open]');
            await box.click();
            await expect(warning).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(warning).toBeHidden();
            await expect(box).not.toBeChecked();
            await expect(footerSave(settings)).toBeDisabled();
            // "Set up sign-in instead" opens manage users over Settings, not a second Settings.
            await box.click();
            await expect(warning).toBeVisible();
            await warning.getByRole('button', { name: 'Set up sign-in instead', exact: true }).click();
            const usersModal = page.locator('dialog.users-modal[open]');
            await expect(usersModal).toBeVisible();
            await expect(page.locator('dialog.settings-modal[open]')).toHaveCount(1);
            await closeTopModal(page, usersModal);
            await expect(box).not.toBeChecked();
            await expect(footerSave(settings)).toBeDisabled();
            // The accept STAGES it: nothing is written until Save.
            await box.click();
            await warning.getByRole('button', { name: 'I understand — allow remote admin', exact: true }).click();
            await expect(warning).toBeHidden();
            await expect(box).toBeChecked();
            await expect(note).toHaveText(
                'any device that can reach this server can administer it. set up sign-in, or uncheck this, to close it.',
            );
            // Checked but not yet saved: the item takes the home page banner's look,
            // its title saying it applies on save; the note reads as the box's body.
            const item = users.locator('.settings-item:has(input[data-remote-admin])');
            await expect(item).toHaveClass(/settings-item--alert/);
            await expect(users.locator('[data-remote-admin-title]')).toHaveText(
                'remote admin will be enabled without sign-in when you save.',
            );
            await expect(note).not.toHaveClass(/settings-status-warning/);
            expect(writes).toEqual([]);
            expect((await scope(probe)).allowRemoteAdmin).toBe(false);

            // --- Save: the review lists it, and the batch applies it.
            let batch = batchSeen(page);
            await footerSave(settings).click();
            let review = reviewDialog(page);
            await expect(review).toBeVisible();
            await expect(reviewLines(review)).toHaveText(['Remote admin without sign-in: off → on']);
            await review.getByRole('button', { name: 'Save', exact: true }).click();
            let res = await batch;
            expect(res.status()).toBe(200);
            expect(await res.json()).toEqual({ ok: true, applied: ['allowRemoteAdmin'] });
            await expect(settings).toBeHidden();
            expect(await scope(probe)).toEqual({ adminScope: 'remote', callerIsLocal: true, allowRemoteAdmin: true });
            expect(readConfigFile(server.paths)['allowRemoteAdmin']).toBe(true);
            // ...and the home page says nothing about it (18.22).
            const configRead = page.waitForResponse(
                (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/config',
            );
            await page.reload();
            await configRead;
            await page.waitForLoadState('networkidle');
            await expect(page.locator('.admin-scope-banner')).toBeHidden();

            // --- 18.13 (a): it survives a restart, read from another machine.
            await probe.dispose();
            probe = undefined;
            await context.close();
            context = undefined;
            await server.restart();
            probe = await apiContext(server.baseURL);
            offBox = await apiContext(offBoxURL(server.paths.port));
            expect(await scope(offBox)).toEqual({ adminScope: 'remote', callerIsLocal: false, allowRemoteAdmin: true });
            expect(readConfigFile(server.paths)['allowRemoteAdmin']).toBe(true);
            // (b) ...and an unrelated config save, which rewrites config.json.
            const unrelated = await probe.patch('/api/config', { data: { firstRunComplete: true } });
            expect(unrelated.status()).toBe(200);
            expect(readConfigFile(server.paths)['allowRemoteAdmin']).toBe(true);
            expect((await scope(offBox)).adminScope).toBe('remote');

            // --- another machine turns it off from the Users tab, warned that
            // saving ends its admin access, and Settings reopens without it.
            remote = await browser.newContext({ baseURL: offBoxURL(server.paths.port) });
            const remotePage = await remote.newPage();
            // A controllable clock, installed before the page loads so every
            // poller's timer is on it. Time still runs as normal until
            // `runFor` jumps it past their ticks below.
            await remotePage.clock.install();
            // Every request this page makes, and every refusal it gets, from
            // the moment the batch goes out: the transition must produce none.
            let batchSent = false;
            const afterSave: string[] = [];
            const refusedAfterSave: string[] = [];
            remotePage.on('request', (r) => {
                const path = new URL(r.url()).pathname;
                if (batchSent) afterSave.push(`${r.method()} ${path}`);
                if (r.method() === 'POST' && path === '/api/settings/batch') batchSent = true;
            });
            remotePage.on('response', (r) => {
                if (batchSent && r.status() === 403) refusedAfterSave.push(new URL(r.url()).pathname);
            });
            await remotePage.goto('/');
            settings = await openSettings(remotePage);
            users = await openSettingsTab(settings, 'Users');
            box = remoteAdminBox(users);
            note = users.locator('[data-remote-admin-note]');
            await expect(box).toBeChecked();
            await expect(box).toBeEnabled();
            await box.click();
            // Unchecking asks nothing.
            await expect(remotePage.locator('dialog.remote-admin-warning-modal[open]')).toHaveCount(0);
            await expect(box).not.toBeChecked();
            await expect(note).toHaveText('you are on another device: saving this ends your admin access from here.');
            batch = batchSeen(remotePage);
            await footerSave(settings).click();
            review = reviewDialog(remotePage);
            await expect(reviewLines(review)).toHaveText(['Remote admin without sign-in: on → off']);
            await expect(review.locator('.settings-summary__warning')).toHaveText(
                'you are on another device: saving this ends your admin access from here.',
            );
            await review.getByRole('button', { name: 'Save', exact: true }).click();
            res = await batch;
            expect(res.status()).toBe(200);
            // Back to the local policy, and the key is gone from config.json.
            expect(await scope(probe)).toEqual({ adminScope: 'local', callerIsLocal: true, allowRemoteAdmin: false });
            expect(readConfigFile(server.paths)).not.toHaveProperty('allowRemoteAdmin');
            expect((await scope(offBox)).callerIsLocal).toBe(false);
            // Settings opens again on Users, in the view that cannot act from
            // here: the note and nothing else (0.5.8). The box, manage users
            // and the login toggle are hidden, and still disabled underneath.
            // Found by CSS, not by role: a hidden control has no role to find.
            const reopened = remotePage.locator('dialog.settings-modal[open]');
            await expect(reopened).toHaveCount(1);
            const reUsers = settingsSection(reopened, 'Users');
            await expect(reUsers).toBeVisible();
            const reNote = reUsers.locator('[data-admin-unreachable-note]');
            await expect(reNote).toBeVisible();
            await expect(reNote).toHaveText('admin changes are limited to the machine running the server.');
            const reBox = reUsers.locator('input[data-remote-admin]');
            await expect(reBox).toBeHidden();
            await expect(reBox).not.toBeChecked();
            await expect(reBox).toBeDisabled();
            // manage users and enable login (sign-in is off here).
            await expect(reUsers.locator('.settings-card button')).toHaveCount(2);
            for (const control of await reUsers.locator('.settings-card button').all()) {
                await expect(control).toBeHidden();
                await expect(control).toBeDisabled();
            }
            await expect(reUsers.locator('.settings-card .settings-item:visible')).toHaveCount(1);
            // Past every poller's next tick: the home page's dependency badge
            // and first-run banner (15 s), the update pill (30 s), the
            // embed-request watch (5 s). Each was told to stop before the batch
            // went out (adminAccess.ts), so none of them asks.
            await remotePage.clock.runFor(31_000);
            await remotePage.waitForLoadState('networkidle');
            // Nothing operator-gated was asked after the batch, and nothing was refused.
            const gated =
                /^(GET|POST|PATCH|PUT|DELETE) \/api\/(service|updates|tls|dependencies|embed-origins|embed-request|users|settings\/batch)(\/|$)/;
            expect(afterSave.filter((r) => gated.test(r))).toEqual([]);
            expect(refusedAfterSave).toEqual([]);
            // The control: the page did keep talking to the server meanwhile.
            expect(afterSave).toContain('GET /api/config');

            // --- forced on by the environment: checked and disabled, and the
            // server refuses an attempt to turn it off.
            await closeAll(offBox, remote, probe);
            offBox = undefined;
            remote = undefined;
            probe = undefined;
            await server.restart({ [REMOTE_ADMIN_ENV]: '1' });
            probe = await apiContext(server.baseURL);
            const forcedEnv = await readConfig(probe);
            expect(forcedEnv.runtime['remoteAdminForced']).toBe(true);
            expect(forcedEnv.runtime.adminScope).toBe('remote');
            forcedContext = await browser.newContext({ baseURL: server.baseURL });
            const forcedPage = await forcedContext.newPage();
            await forcedPage.goto('/');
            settings = await openSettings(forcedPage);
            users = await openSettingsTab(settings, 'Users');
            await expect(remoteAdminBox(users)).toBeChecked();
            await expect(remoteAdminBox(users)).toBeDisabled();
            await expect(users.locator('[data-remote-admin-note]')).toHaveText(
                'forced on by WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 on the server; remove the variable to turn it off.',
            );
            const forcedOff = await probe.post('/api/settings/batch', {
                data: {
                    changes: [{ id: 'allowRemoteAdmin', label: 'Remote admin without sign-in', from: true, to: false }],
                },
            });
            expect(forcedOff.status()).toBe(409);
            expect(await forcedOff.json()).toEqual({
                ok: false,
                applied: [],
                failed: {
                    id: 'allowRemoteAdmin',
                    error: 'forced on by WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 on the server; remove the variable to turn it off.',
                },
            });
        } finally {
            await closeAll(forcedContext, remote, context, offBox, probe);
            await server.dispose('18.13');
        }
    });
});
