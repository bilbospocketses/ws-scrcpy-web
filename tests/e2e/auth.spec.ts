import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { type BrowserContext, expect, type Page, request, test } from '@playwright/test';
import {
    ADMIN,
    APP_TITLE,
    captureResponse,
    changePassword,
    closeAllModals,
    closeTopModal,
    deleteUserIfPresent,
    disabledBadge,
    dismissPromptsFor,
    e2eBaseUrl,
    ensureAdminSession,
    ensureOpenMode,
    expectAppShell,
    expectLoginHtml,
    expectLoginPage,
    expectPristineAuthState,
    expectSpaHtml,
    fetchFromPage,
    GENERIC_LOGIN_ERROR,
    LOCK_MS,
    LOCKDOWN_RELOAD_TEXT,
    LOGIN_PAGE,
    LOGIN_TITLE,
    labelsFor,
    listUsers,
    lockdown,
    lockedBadge,
    loginAs,
    logoutViaApi,
    MAX_FAILS,
    me,
    mintToken,
    newVisitorContext,
    openSettings,
    openUsersModal,
    PROBE_USERNAME,
    probeWs,
    REGULAR,
    REGULAR_ALT_PASSWORD,
    readLockdownFarewell,
    roleSpan,
    SESSION_COOKIE,
    SID_CLEARED_COOKIE,
    SID_SET_COOKIE_RE,
    sectionHeadings,
    sessionCookie,
    setLabel,
    settingsRow,
    settingsSection,
    setUserPassword,
    submitLoginFresh,
    submitLoginPage,
    TEMP_USER,
    TEMP_USER_PASSWORD_2,
    TOKEN_COOKIE,
    TOKEN_SET_COOKIE_RE,
    tokenCookie,
    UNKNOWN_USERNAME,
    unlockUser,
    userByName,
    userRow,
    WRONG_PASSWORD,
    WS_PROBE_URLS,
    watchLockdownFarewell,
} from './support/auth';
import { gotoHome, readServerConfig } from './support/consent';
import { SEED_CONFIG } from './support/paths';
import {
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    sessionRow,
    spawnServer,
    stopServer,
    waitForServer,
    withTimeout,
} from './support/privateServer';

/**
 * Smoke module 18 — the opt-in login subsystem (rows 18.1–18.12).
 *
 * One serial state machine, not twelve independent specs: 18.2 secures the
 * admin account and turns login on, every row until 18.11 runs locked, and
 * 18.11 returns the server to open mode for the files that follow this one
 * alphabetically. Three consequences shape the file:
 *
 *   - `retries: 0`, because a serial-group retry would re-run 18.1 against a
 *     database 18.2 has already locked down, which can never pass; the run's
 *     fresh-install precondition comes from playwright.config.ts wiping the
 *     database before webServer starts, and no API call can restore it.
 *   - The `page` and `request` fixtures are never used. Their jars are empty,
 *     so every /api call would fail the instance-token gate with a 403 that
 *     reads like an auth bug — and 18.12 must never touch the shared server.
 *   - `afterAll` returns to open mode even when a row failed mid-way, because a
 *     locked 8123 makes every later file see the login page with HTTP 200 and
 *     fail on missing buttons that point nowhere near auth.
 *
 * The lockout policy is per user row and the suite has ONE admin: five failed
 * logins in five minutes lock a row for fifteen, every attempt while locked
 * re-arms the lock, and unlocking needs the admin session you would no longer
 * have. No row here types a wrong ADMIN password, and no helper retries a login.
 */
test.describe.configure({ mode: 'serial', retries: 0, timeout: 90_000 });

test.describe('auth / opt-in login (smoke §18)', () => {
    let admin: BrowserContext;
    let adminPage: Page;

    test.beforeAll(async ({ browser }) => {
        // Cookie-less. 18.2 drives the lockdown on it; 18.3 signs it in through
        // the real form; later rows re-establish the session idempotently.
        admin = await browser.newContext({ baseURL: e2eBaseUrl() });
        adminPage = await admin.newPage();
    });

    test.afterAll(async () => {
        // Runs even when serial mode skipped the remaining rows.
        const warn = (what: string, err: unknown) => console.warn(`auth.spec afterAll: ${what}: ${String(err)}`);
        try {
            await ensureOpenMode(e2eBaseUrl(), ADMIN);
        } catch (err) {
            warn('could not return to open mode', err);
        }
        // In open mode requireAdmin passes with no session (the implicit admin).
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(ctx);
            if (!(await me(ctx)).authEnabled) {
                for (const name of [TEMP_USER.username, PROBE_USERNAME]) {
                    try {
                        await deleteUserIfPresent(ctx, name);
                    } catch (err) {
                        warn(`could not delete ${name}`, err);
                    }
                }
                try {
                    const regular = (await listUsers(ctx)).find((u) => u.username === REGULAR.username);
                    if (regular) {
                        await unlockUser(ctx, regular.id);
                        await setUserPassword(ctx, regular.id, REGULAR.password);
                    }
                } catch (err) {
                    warn('could not repair the regular user', err);
                }
            }
        } catch (err) {
            warn('repair skipped', err);
        } finally {
            await ctx.dispose();
        }
        await admin.close();
    });

    test('18.1 default open mode: the app is served with no login prompt, and login cannot be switched on before an admin has a password', async () => {
        // Server-side first, from a context that holds no cookie at all: the
        // document GET must be the SPA (status can never tell the two pages
        // apart — both are 200) and must mint the instance token.
        const bare = await request.newContext({ baseURL: e2eBaseUrl() });
        const tokenless = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            const home = await mintToken(bare);
            expect(home.headers()['set-cookie']).toMatch(TOKEN_SET_COOKIE_RE);
            expectSpaHtml(await home.text());
            expect(await me(bare)).toEqual({ authEnabled: false, user: { username: 'admin', role: 'admin' } });
            await expectPristineAuthState(bare);

            // Open mode is not an open API: without the token, everything but
            // GET /api/config is refused before any handler runs.
            const config = await tokenless.get('/api/config');
            expect(config.status()).toBe(200);
            const gatedMe = await tokenless.get('/api/auth/me');
            expect(gatedMe.status()).toBe(403);
            expect(await gatedMe.json()).toEqual({ error: 'forbidden', reason: 'missing or invalid token' });
            const gatedEnable = await tokenless.post('/api/auth/enable');
            expect(gatedEnable.status()).toBe(403);
            expect(await gatedEnable.json()).toEqual({ error: 'forbidden', reason: 'missing or invalid token' });

            // The page a visitor actually renders.
            await gotoHome(adminPage);
            await expectAppShell(adminPage);
            await expect(adminPage.getByRole('heading', { name: LOGIN_TITLE })).toHaveCount(0);
            await expect(adminPage.locator('dialog.welcome-modal')).toHaveCount(0);

            // Capture the /api/auth/me the modal itself consumes: a rejected me()
            // fails OPEN to the identical admin view, so the DOM alone has no subject.
            const meSeen = adminPage.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/me');
            const settings = await openSettings(adminPage);
            const meRes = await meSeen;
            expect(meRes.status()).toBe(200);
            expect(await meRes.json()).toEqual({ authEnabled: false, user: { username: 'admin', role: 'admin' } });

            const users = settingsSection(settings, 'Users');
            await expect(users).toBeVisible();
            const enable = settingsRow(users, 'login').getByRole('button', { name: 'enable login', exact: true });
            await expect(enable).toBeVisible();
            await expect(settings.getByRole('button', { name: 'disable login (return to open mode)' })).toHaveCount(0);
            await expect(settings.locator('[data-action="change-password"]')).toHaveCount(0);
            await expect(settings.locator('[data-action="logout"]')).toHaveCount(0);

            // Auth is inert until a user is added: the real click, the real 409.
            const enableSeen = adminPage.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/enable',
            );
            await enable.click();
            const enableRes = await enableSeen;
            expect(enableRes.status()).toBe(409);
            expect(await enableRes.json()).toEqual({ error: 'set an admin password before enabling auth' });
            await expect(users.locator('p.settings-status')).toHaveText(
                'Add a user with an admin password first (Users → manage users)',
            );
            await expect(settings).toBeVisible();
            await expect(adminPage).toHaveTitle(APP_TITLE);
            // ...and the server did not flip anything on the way to that 409.
            expect((await me(bare)).authEnabled).toBe(false);
            expectSpaHtml(await (await bare.get('/')).text());

            // manage users lists the single seeded account.
            await settingsRow(users, 'user accounts')
                .getByRole('button', { name: 'manage users', exact: true })
                .click();
            const usersModal = adminPage.locator('dialog.users-modal');
            await expect(usersModal).toBeVisible();
            await expect(usersModal.locator('ul > li')).toHaveCount(1);
            await expect(usersModal.locator('ul > li').first()).toContainText('admin');
            await expect(lockedBadge(usersModal.locator('ul > li').first())).toHaveCount(0);
            await expect(disabledBadge(usersModal.locator('ul > li').first())).toHaveCount(0);
            await expect(usersModal.getByRole('button', { name: 'Add user', exact: true })).toBeVisible();
            await closeTopModal(adminPage, usersModal);
            await closeTopModal(adminPage, settings);

            // Baseline for 18.10: in open mode a live socket is served, never 4401.
            const ws = await probeWs(adminPage, WS_PROBE_URLS.scan, {
                sendOnOpen: 'this is not json',
                matchType: 'scan.error',
            });
            expect(ws.kind).toBe('message');
            if (ws.kind === 'message')
                expect(JSON.parse(ws.data)).toEqual({ type: 'scan.error', reason: 'invalid JSON' });
        } finally {
            await bare.dispose();
            await tokenless.dispose();
        }
    });

    test('18.2 secure the admin account: one POST renames and passwords user 1, creates the first user and enables login atomically', async () => {
        await gotoHome(adminPage);
        await expectPristineAuthState(adminPage.request);

        // Negatives first, and proven state-neutral: no password-less enable, no
        // admin-less first user.
        const enable = await adminPage.request.post('/api/auth/enable');
        expect(enable.status()).toBe(409);
        expect(await enable.json()).toEqual({ error: 'set an admin password before enabling auth' });
        const adminless = await adminPage.request.post('/api/users', {
            data: { username: REGULAR.username, role: 'user', password: REGULAR.password },
        });
        expect(adminless.status()).toBe(400);
        expect(await adminless.json()).toEqual({
            error: 'adminUsername and adminPassword are required to secure the admin account',
        });
        expect(await listUsers(adminPage.request)).toHaveLength(1);
        expect((await me(adminPage.request)).authEnabled).toBe(false);

        const usersModal = await openUsersModal(adminPage);
        await expect(usersModal.locator('ul > li')).toHaveCount(1);
        await usersModal.getByRole('button', { name: 'Add user', exact: true }).click();

        // The client read authEnabled:false, so it offers the lockdown block.
        const lock = usersModal.locator('.lockdown-section');
        await expect(lock).toBeVisible();
        await expect(lock).toContainText('Secure the admin account');
        await expect(lock).toContainText('Auth is currently disabled.');
        const adminUser = lock.locator('[data-field="admin-username"]');
        const adminPw = lock.locator('[data-field="admin-password"]');
        await expect(adminUser).toHaveValue('admin');
        await expect(adminPw).toHaveAttribute('type', 'password');
        const submit = usersModal.getByRole('button', { name: 'Secure & add user', exact: true });
        await expect(submit).toBeVisible();
        await expect(usersModal.getByRole('button', { name: 'Add user', exact: true })).toHaveCount(0);

        await adminUser.fill(ADMIN.username);
        await adminPw.fill(ADMIN.password);
        const fresh = usersModal.locator('.new-user-section');
        await fresh.locator('input[type="text"]').fill(REGULAR.username);
        await fresh.locator('select.modal-select').selectOption('user');
        await fresh.locator('input[type="password"]').fill(REGULAR.password);

        // The client announces the lockdown and reloads in one synchronous run, so
        // the farewell is recorded by an observer planted now and read back from
        // the login page; the lockdown response is captured inside the route
        // because a body read from the page's side hangs once the reload is
        // pending; and the reload's own document response is awaited by a
        // waiter armed before the click.
        await watchLockdownFarewell(adminPage);
        const capture = await captureResponse(adminPage, { method: 'POST', pathname: '/api/users' });
        try {
            const reloadRes = adminPage.waitForResponse(
                (r) => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/',
            );
            await submit.click();
            const res = await capture.captured;
            expect(res.postDataJSON).toEqual({
                adminUsername: ADMIN.username,
                adminPassword: ADMIN.password,
                username: REGULAR.username,
                role: 'user',
                password: REGULAR.password,
            });
            expect(res.status).toBe(201);
            // toEqual, not toMatchObject: the normal-create branch answers {id}.
            expect(res.body).toEqual({ ok: true });

            const doc = await reloadRes;
            // Inline, never a redirect: a 3xx to /login would fall through to
            // the SPA fallback and leak the shell.
            expect(doc.status()).toBe(200);
            expect(doc.headers()['content-type']).toContain('text/html');
        } finally {
            await capture.dispose();
        }

        await expectLoginPage(adminPage);
        // What the old document said on its way out, handed over by sessionStorage.
        expect(await readLockdownFarewell(adminPage)).toEqual({ text: LOCKDOWN_RELOAD_TEXT, lockdownSections: 0 });
        await expect(adminPage.locator(LOGIN_PAGE.submit)).toHaveText(LOGIN_TITLE);
        await expect(adminPage.locator(LOGIN_PAGE.error)).toHaveText('');
        await expect(adminPage.locator('dialog.settings-modal, dialog.users-modal')).toHaveCount(0);

        // Locked-mode gate from the session-less browser jar. The lockdown must
        // not have minted a session for the browser — 18.3 signs in for real.
        expect(await me(adminPage.request)).toEqual({ authEnabled: true, user: null });
        const gated = await adminPage.request.get('/api/users');
        expect(gated.status()).toBe(401);
        expect(await gated.json()).toEqual({ error: 'unauthorized' });
        expect(await tokenCookie(admin)).toBeDefined();
        expect(await sessionCookie(admin)).toBeUndefined();

        // The admin password landed in the SAME step — verified from a throwaway
        // context so the browser stays logged out.
        const verify = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            expectLoginHtml(await (await mintToken(verify)).text());
            const login = await loginAs(verify, ADMIN);
            expect(login.status()).toBe(200);
            expect(await login.json()).toEqual({ ok: true });
            expect(login.headers()['set-cookie']).toMatch(SID_SET_COOKIE_RE);

            const users = await listUsers(verify);
            expect(users).toHaveLength(2);
            expect(users[0]).toEqual({
                id: 1,
                username: ADMIN.username,
                role: 'admin',
                hasPassword: true,
                disabled: false,
                lockedUntil: null,
                lastLogin: expect.any(Number),
            });
            expect(users[1]).toMatchObject({
                username: REGULAR.username,
                role: 'user',
                hasPassword: true,
                disabled: false,
                lockedUntil: null,
                lastLogin: null,
            });
            expect(users[1]?.id).not.toBe(1);
            expect(await me(verify)).toEqual({ authEnabled: true, user: { username: ADMIN.username, role: 'admin' } });

            const out = await logoutViaApi(verify);
            expect(out.status()).toBe(200);
            expect(out.headers()['set-cookie']).toBe(SID_CLEARED_COOKIE);
            expect((await verify.get('/api/users')).status()).toBe(401);
        } finally {
            await verify.dispose();
        }

        // Lockdown writes the database only — config.json is untouched.
        const cfg = readServerConfig();
        expect(cfg.webPort).toBe(SEED_CONFIG.webPort);
        expect(cfg.installMode).toBe(SEED_CONFIG.installMode);
        expect(cfg.firstRunComplete).toBe(SEED_CONFIG.firstRunComplete);
    });

    test('18.3 login: the admin signs in on the inline page, reloads into the app, and sees every admin-only section', async () => {
        const t0 = Date.now();
        const nav = await adminPage.goto('/');
        expect(nav?.status()).toBe(200);
        // headerValue, not headers(): a page response's headers() omits cookie headers.
        expect(await nav?.headerValue('set-cookie')).toMatch(TOKEN_SET_COOKIE_RE);
        await expectLoginPage(adminPage);
        await expect(adminPage.locator('div.err#e')).toHaveText('');
        expect(await tokenCookie(admin)).toBeDefined();
        expect(await sessionCookie(admin)).toBeUndefined();

        // Exactly 401 through the page's own jar: a 403 here would be the token gate.
        const before = await adminPage.request.get('/api/users');
        expect(before.status()).toBe(401);
        expect(await before.json()).toEqual({ error: 'unauthorized' });
        expect(await me(adminPage.request)).toEqual({ authEnabled: true, user: null });

        const login = await submitLoginPage(adminPage, ADMIN.username, ADMIN.password);
        expect(login.status).toBe(200);
        expect(login.body).toEqual({ ok: true });
        expect(login.setCookie).toMatch(SID_SET_COOKIE_RE);

        await expectAppShell(adminPage);
        const sid = await sessionCookie(admin);
        expect(sid).toBeDefined();
        expect(sid?.httpOnly).toBe(true);
        expect(sid?.sameSite).toBe('Lax');
        expect(sid?.path).toBe('/');
        expect(sid?.secure).toBe(false);
        expect(sid?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

        expect(await me(adminPage.request)).toEqual({
            authEnabled: true,
            user: { username: ADMIN.username, role: 'admin' },
        });
        const adminRow = (await listUsers(adminPage.request)).find((u) => u.id === 1);
        expect(adminRow).toMatchObject({ username: ADMIN.username, role: 'admin', hasPassword: true, disabled: false });
        expect(adminRow?.lockedUntil).toBeNull();
        expect(typeof adminRow?.lastLogin).toBe('number');
        expect(adminRow?.lastLogin ?? 0).toBeGreaterThanOrEqual(t0);

        const settings = await openSettings(adminPage);
        await expect(sectionHeadings(settings)).toHaveText(['Users', 'Embedding', 'Updates', 'Service', 'Server']);
        // Rules out the fail-open path: 'disable login' renders only when a
        // SUCCESSFUL me() came back with authEnabled:true.
        await expect(settings.getByRole('button', { name: 'disable login (return to open mode)' })).toBeVisible();
        await expect(settings.getByRole('button', { name: 'enable login', exact: true })).toHaveCount(0);
        await expect(settings.getByRole('button', { name: 'manage users', exact: true })).toBeVisible();
        const server = settingsSection(settings, 'Server');
        await expect(settingsRow(server, 'web port').locator('input[type="number"]')).toHaveCount(1);
        await expect(settings.getByRole('button', { name: 'stop server & exit' })).toBeAttached();
        await expect(settings.locator('[data-action="change-password"]')).toHaveCount(1);
        await expect(settings.locator('[data-action="logout"]')).toHaveCount(1);
        await closeTopModal(adminPage, settings);
    });

    test('18.4 brute-force lockout: five wrong passwords lock the account, every failure answers identically, and the correct password is refused while locked', async () => {
        await ensureAdminSession(adminPage);
        // Repair first: a run that died between 18.4 and 18.5 leaves the row locked.
        const regular = await userByName(adminPage.request, REGULAR.username);
        expect(regular.disabled).toBe(false);
        expect(regular.hasPassword).toBe(true);
        await unlockUser(adminPage.request, regular.id);
        expect((await userByName(adminPage.request, REGULAR.username)).lockedUntil).toBeNull();

        const attacker = await newVisitorContext(
            test.info().project.use.browserName ? await browserOf() : await browserOf(),
        );
        try {
            await expectLoginPage(attacker.page);
            await expect(attacker.page.locator('form#f h1')).toHaveText(LOGIN_TITLE);
            expect(await me(attacker.context.request)).toEqual({ authEnabled: true, user: null });

            // Control login: proves the constant is right and clears stale counters.
            const control = await loginAs(attacker.context.request, REGULAR);
            expect(control.status()).toBe(200);
            expect(await control.json()).toEqual({ ok: true });
            expect(control.headers()['set-cookie']).toMatch(SID_SET_COOKIE_RE);
            expect(await sessionCookie(attacker.context)).toBeDefined();
            // ...and the smoke row's first step: log out.
            const out = await logoutViaApi(attacker.context.request);
            expect(out.status()).toBe(200);
            expect(out.headers()['set-cookie']).toBe(SID_CLEARED_COOKIE);
            expect(await sessionCookie(attacker.context)).toBeUndefined();
            expect(await me(attacker.context.request)).toEqual({ authEnabled: true, user: null });

            // Unknown user vs wrong password: byte-identical bodies, identical UI text.
            const unknown = await submitLoginFresh(attacker.page, UNKNOWN_USERNAME, 'anything-at-all');
            expect(unknown.status).toBe(401);
            expect(unknown.body).toEqual({ ok: false, reason: 'invalid' });
            await expect(attacker.page.locator(LOGIN_PAGE.error)).toHaveText(GENERIC_LOGIN_ERROR);
            expect((await userByName(adminPage.request, REGULAR.username)).lockedUntil).toBeNull();

            const wrong1 = await submitLoginFresh(attacker.page, REGULAR.username, WRONG_PASSWORD);
            expect(wrong1.status).toBe(401);
            expect(wrong1.text).toBe(unknown.text);
            expect(wrong1.text).toBe('{"ok":false,"reason":"invalid"}');
            expect(wrong1.contentType).toBe(unknown.contentType);
            await expect(attacker.page.locator(LOGIN_PAGE.error)).toHaveText(GENERIC_LOGIN_ERROR);

            // Failures 2..5 — the fifth locks silently: the response is still 'invalid'.
            for (let i = 2; i <= MAX_FAILS; i++) {
                const r = await submitLoginFresh(attacker.page, REGULAR.username, WRONG_PASSWORD);
                expect(r.status, `wrong password #${i}`).toBe(401);
                expect(r.body, `wrong password #${i}`).toEqual({ ok: false, reason: 'invalid' });
                await expect(attacker.page.locator(LOGIN_PAGE.error)).toHaveText(GENERIC_LOGIN_ERROR);
            }

            // The lock is real and server-side, and it is per user row.
            const lockedRow = await userByName(adminPage.request, REGULAR.username);
            expect(typeof lockedRow.lockedUntil).toBe('number');
            const lockedUntil1 = lockedRow.lockedUntil ?? 0;
            const delta = lockedUntil1 - Date.now();
            expect(delta).toBeGreaterThan(LOCK_MS - 30_000);
            expect(delta).toBeLessThanOrEqual(LOCK_MS);
            expect((await listUsers(adminPage.request)).find((u) => u.id === 1)?.lockedUntil).toBeNull();

            // The correct password, refused while locked — same generic text.
            const locked = await submitLoginFresh(attacker.page, REGULAR.username, REGULAR.password);
            expect(locked.status).toBe(401);
            expect(locked.body).toEqual({ ok: false, reason: 'locked' });
            await expect(attacker.page.locator(LOGIN_PAGE.error)).toHaveText(GENERIC_LOGIN_ERROR);
            await expect(attacker.page).toHaveTitle(LOGIN_TITLE);
            await expect(attacker.page.locator(LOGIN_PAGE.form)).toBeVisible();
            expect(await sessionCookie(attacker.context)).toBeUndefined();
            expect((await me(attacker.context.request)).user).toBeNull();

            // Every attempt while locked re-arms the deadline.
            const rearmed = (await userByName(adminPage.request, REGULAR.username)).lockedUntil ?? 0;
            expect(rearmed).toBeGreaterThanOrEqual(lockedUntil1);
            expect(rearmed - Date.now()).toBeLessThanOrEqual(LOCK_MS);
            expect((await listUsers(adminPage.request)).find((u) => u.id === 1)?.lockedUntil).toBeNull();
            expect((await me(adminPage.request)).user).toEqual({ username: ADMIN.username, role: 'admin' });
        } finally {
            await attacker.context.close();
        }
    });

    test('18.5 admin clears a lockout: unlock in the Users modal clears the lock server-side and the same password is accepted again', async () => {
        await ensureAdminSession(adminPage);
        const victimBefore = await userByName(adminPage.request, REGULAR.username);
        expect(victimBefore.role).toBe('user');
        expect(victimBefore.disabled).toBe(false);
        expect(typeof victimBefore.lockedUntil, '18.4 must have left the regular user locked').toBe('number');
        expect(victimBefore.lockedUntil ?? 0).toBeGreaterThan(Date.now());
        const lastLoginBefore = victimBefore.lastLogin;

        const victim = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            // The lock blocks the CORRECT password — and this probe re-arms the
            // deadline, so the badge below cannot race the expiry.
            await mintToken(victim);
            const stillLocked = await loginAs(victim, REGULAR);
            expect(stillLocked.status()).toBe(401);
            expect(await stillLocked.json()).toEqual({ ok: false, reason: 'locked' });
            expect(stillLocked.headers()['set-cookie']).toBeUndefined();

            await gotoHome(adminPage);
            const usersModal = await openUsersModal(adminPage);
            const victimRow = userRow(usersModal, REGULAR.username);
            await expect(victimRow).toHaveCount(1);
            await expect(lockedBadge(victimRow)).toBeVisible();
            const unlockBtn = victimRow.locator('button[data-action="unlock"]');
            await expect(unlockBtn).toBeVisible();
            await expect(unlockBtn).toHaveText('unlock');
            // Per row, not a global banner: the admin row shows neither.
            const adminRow = userRow(usersModal, ADMIN.username);
            await expect(adminRow).toHaveCount(1);
            await expect(adminRow.locator('button[data-action="unlock"]')).toHaveCount(0);
            await expect(lockedBadge(adminRow)).toHaveCount(0);

            // Watch the wire: {} and {unlock:false} also answer 200.
            const patched = adminPage.waitForResponse(
                (r) =>
                    r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/users/${victimBefore.id}`,
            );
            await unlockBtn.click();
            const patch = await patched;
            expect(patch.request().postDataJSON()).toEqual({ unlock: true });
            expect(patch.status()).toBe(200);
            expect(await patch.json()).toEqual({ ok: true });

            // Presence before absence, so a closed modal cannot pass.
            await expect(victimRow).toHaveCount(1);
            await expect(victimRow.locator('select.modal-select')).toBeVisible();
            await expect(victimRow.locator('button[data-action="unlock"]')).toHaveCount(0);
            await expect(lockedBadge(victimRow)).toHaveCount(0);
            await expect(usersModal.locator('.users-modal-status')).toBeEmpty();

            const victimAfter = await userByName(adminPage.request, REGULAR.username);
            expect(victimAfter.id).toBe(victimBefore.id);
            expect(victimAfter.lockedUntil).toBeNull();
            expect(victimAfter).toMatchObject({ role: 'user', disabled: false, hasPassword: true });

            // Counters were reset, not just the deadline: one wrong attempt lands
            // on a clean counter, then the correct password works.
            const wrong = await loginAs(victim, { username: REGULAR.username, password: WRONG_PASSWORD });
            expect(wrong.status()).toBe(401);
            expect(await wrong.json()).toEqual({ ok: false, reason: 'invalid' });
            const t0 = Date.now();
            const ok = await loginAs(victim, REGULAR);
            expect(ok.status()).toBe(200);
            expect(await ok.json()).toEqual({ ok: true });
            expect(ok.headers()['set-cookie']).toMatch(SID_SET_COOKIE_RE);
            expect(await me(victim)).toEqual({ authEnabled: true, user: { username: REGULAR.username, role: 'user' } });

            const loggedIn = await userByName(adminPage.request, REGULAR.username);
            expect(typeof loggedIn.lastLogin).toBe('number');
            expect(loggedIn.lastLogin ?? 0).toBeGreaterThanOrEqual(t0 - 5_000);
            expect(loggedIn.lastLogin).not.toBe(lastLoginBefore);
            expect(loggedIn.lockedUntil).toBeNull();
        } finally {
            const out = await logoutViaApi(victim);
            expect([200, 401]).toContain(out.status());
            await victim.dispose();
            await closeAllModals(adminPage);
        }
    });

    test('18.6 manage users: role, disable, reset and delete apply on the server and in the list; the last admin cannot be deleted, demoted or disabled', async () => {
        await ensureAdminSession(adminPage);
        expect((await listUsers(adminPage.request)).find((u) => u.id === 1)).toMatchObject({
            role: 'admin',
            disabled: false,
            hasPassword: true,
        });
        expect((await userByName(adminPage.request, REGULAR.username)).role).toBe('user');
        await deleteUserIfPresent(adminPage.request, TEMP_USER.username);

        // Normal-create shape ({id}, not {ok:true}) proves the lockdown branch is behind us.
        const created = await adminPage.request.post('/api/users', {
            data: { username: TEMP_USER.username, password: TEMP_USER.password, role: 'user' },
        });
        expect(created.status()).toBe(201);
        const createdBody = (await created.json()) as { id?: number; ok?: boolean };
        expect(typeof createdBody.id).toBe('number');
        expect(createdBody.ok).toBeUndefined();
        const tempId = createdBody.id as number;
        expect(await userByName(adminPage.request, TEMP_USER.username)).toMatchObject({
            id: tempId,
            role: 'user',
            hasPassword: true,
            disabled: false,
            lockedUntil: null,
        });

        const viewer = await newVisitorContext(await browserOf());
        try {
            await expectLoginPage(viewer.page);
            const viewerLogin = await loginAs(viewer.context.request, TEMP_USER);
            expect(viewerLogin.status()).toBe(200);
            expect((await sessionCookie(viewer.context))?.httpOnly).toBe(true);
            expect(await me(viewer.context.request)).toEqual({
                authEnabled: true,
                user: { username: TEMP_USER.username, role: 'user' },
            });

            await gotoHome(adminPage);
            const usersModal = await openUsersModal(adminPage);
            const tempRow = userRow(usersModal, TEMP_USER.username);
            await expect(tempRow).toHaveCount(1);
            await expect(roleSpan(tempRow, 'user')).toBeVisible();
            const roleOf = async () => (await userByName(adminPage.request, TEMP_USER.username)).role;
            const disabledOf = async () => (await userByName(adminPage.request, TEMP_USER.username)).disabled;

            // Role, both directions — demoting a NON-last admin succeeds.
            await tempRow.getByRole('combobox').selectOption('admin');
            await expect.poll(roleOf).toBe('admin');
            await expect(roleSpan(tempRow, 'admin')).toBeVisible();
            await tempRow.getByRole('combobox').selectOption('user');
            await expect.poll(roleOf).toBe('user');
            await expect(roleSpan(tempRow, 'user')).toBeVisible();
            await expect(roleSpan(tempRow, 'admin')).toHaveCount(0);

            // Disable: the live session dies, and the correct password is refused.
            await tempRow.getByRole('checkbox', { name: 'disable' }).check();
            await expect.poll(disabledOf).toBe(true);
            await expect(disabledBadge(tempRow)).toBeVisible();
            await expect(tempRow.getByRole('checkbox', { name: 'disable' })).toBeChecked();
            expect((await me(viewer.context.request)).user).toBeNull();
            const gone = await viewer.context.request.get('/api/users');
            expect(gone.status()).toBe(401);
            expect(await gone.json()).toEqual({ error: 'unauthorized' });
            const disabledLogin = await loginAs(viewer.context.request, TEMP_USER);
            expect(disabledLogin.status()).toBe(401);
            expect(await disabledLogin.json()).toEqual({ ok: false, reason: 'disabled' });
            await viewer.page.goto('/');
            await expectLoginPage(viewer.page);
            const uiRefused = await submitLoginPage(viewer.page, TEMP_USER.username, TEMP_USER.password);
            expect(uiRefused.status).toBe(401);
            await expect(viewer.page.locator(LOGIN_PAGE.error)).toHaveText(GENERIC_LOGIN_ERROR);
            await expect(viewer.page).toHaveTitle(LOGIN_TITLE);
            await expect(viewer.page.locator(LOGIN_PAGE.form)).toBeVisible();

            // Re-enable: a toggle, not a one-way switch.
            await tempRow.getByRole('checkbox', { name: 'disable' }).uncheck();
            await expect.poll(disabledOf).toBe(false);
            await expect(disabledBadge(tempRow)).toHaveCount(0);
            const reenabled = await loginAs(viewer.context.request, TEMP_USER);
            expect(reenabled.status()).toBe(200);

            // Reset password through the inline confirm. The PATCH status proves
            // nothing (an empty password is a silent 200 no-op) — the logins do.
            await tempRow.getByRole('button', { name: 'reset password', exact: true }).click();
            await tempRow.getByPlaceholder('new password').fill(TEMP_USER_PASSWORD_2);
            await tempRow.getByRole('button', { name: 'confirm', exact: true }).click();
            await expect(tempRow.getByPlaceholder('new password')).toHaveCount(0);
            await expect(tempRow.getByRole('button', { name: 'reset password', exact: true })).toBeVisible();
            const oldPw = await loginAs(viewer.context.request, TEMP_USER);
            expect(oldPw.status()).toBe(401);
            expect(await oldPw.json()).toEqual({ ok: false, reason: 'invalid' });
            const newPw = await loginAs(viewer.context.request, {
                username: TEMP_USER.username,
                password: TEMP_USER_PASSWORD_2,
            });
            expect(newPw.status()).toBe(200);
            expect(await userByName(adminPage.request, TEMP_USER.username)).toMatchObject({
                hasPassword: true,
                lockedUntil: null,
            });

            // The last-admin guard, UI and API, for delete / demote / disable.
            // temp is 'user' again and REGULAR is 'user', so user 1 is the only enabled admin.
            const adminRow = userRow(usersModal, ADMIN.username);
            const status = usersModal.locator('.users-modal-status');
            await adminRow.getByRole('button', { name: 'delete', exact: true }).click();
            await expect(status).toHaveText('Cannot delete: HTTP 409 (last admin)');
            await expect(adminRow).toHaveCount(1);
            const del = await adminPage.request.delete('/api/users/1');
            expect(del.status()).toBe(409);
            expect(await del.json()).toEqual({ error: 'cannot delete the last enabled admin' });

            await adminRow.getByRole('combobox').selectOption('user');
            await expect(status).toHaveText('Failed to change role (HTTP 409)');
            const demote = await adminPage.request.patch('/api/users/1', { data: { role: 'user' } });
            expect(demote.status()).toBe(409);
            expect(await demote.json()).toEqual({ error: 'cannot demote the last enabled admin' });
            expect((await me(adminPage.request)).user?.role).toBe('admin');

            // click(), not check(): the UI reverts the box after the 409.
            await adminRow.getByRole('checkbox', { name: 'disable' }).click();
            await expect(status).toHaveText('Failed to update disabled state (HTTP 409)');
            await expect(adminRow.getByRole('checkbox', { name: 'disable' })).not.toBeChecked();
            const disable = await adminPage.request.patch('/api/users/1', { data: { disabled: true } });
            expect(disable.status()).toBe(409);
            expect(await disable.json()).toEqual({ error: 'cannot disable the last enabled admin' });
            expect((await listUsers(adminPage.request)).find((u) => u.id === 1)).toMatchObject({
                role: 'admin',
                disabled: false,
            });

            // Delete the throwaway: gone from the list, the server, and its session.
            await tempRow.getByRole('button', { name: 'delete', exact: true }).click();
            await expect(tempRow).toHaveCount(0);
            expect((await listUsers(adminPage.request)).some((u) => u.username === TEMP_USER.username)).toBe(false);
            const again = await adminPage.request.delete(`/api/users/${tempId}`);
            expect(again.status()).toBe(404);
            expect(await again.json()).toEqual({ error: 'no such user' });
            expect((await me(viewer.context.request)).user).toBeNull();
            const deletedLogin = await loginAs(viewer.context.request, {
                username: TEMP_USER.username,
                password: TEMP_USER_PASSWORD_2,
            });
            const unknownLogin = await loginAs(viewer.context.request, { username: UNKNOWN_USERNAME, password: 'x' });
            expect(deletedLogin.status()).toBe(401);
            expect(unknownLogin.status()).toBe(401);
            expect(await deletedLogin.text()).toBe(await unknownLogin.text());
        } finally {
            await viewer.context.close();
            await closeAllModals(adminPage);
        }

        const finalUsers = await listUsers(adminPage.request);
        expect(finalUsers.map((u) => [u.username, u.role, u.disabled])).toEqual([
            [ADMIN.username, 'admin', false],
            [REGULAR.username, 'user', false],
        ]);
    });

    test('18.7 non-admin authz: admin sections hidden in the UI and admin requests refused by the server, while user-level calls still work', async () => {
        await ensureAdminSession(adminPage);
        const before = await listUsers(adminPage.request);
        const regular = before.find((u) => u.username === REGULAR.username);
        expect(regular).toMatchObject({ role: 'user', disabled: false, hasPassword: true });
        expect(regular?.lockedUntil === null || (regular?.lockedUntil ?? 0) < Date.now()).toBe(true);
        await deleteUserIfPresent(adminPage.request, PROBE_USERNAME);
        const countBefore = (await listUsers(adminPage.request)).length;

        const user = await newVisitorContext(await browserOf());
        const serial = 'e2e-18-7-authz-serial';
        try {
            await expect(user.page.locator('form#f h1')).toHaveText(LOGIN_TITLE);
            expect(await tokenCookie(user.context)).toBeDefined();
            const login = await loginAs(user.context.request, REGULAR);
            expect(login.status(), `login as ${REGULAR.username}: ${await login.text()}`).toBe(200);
            expect((await sessionCookie(user.context))?.httpOnly).toBe(true);
            // The subject guard: everything below is about a NON-admin session.
            expect(await me(user.context.request)).toEqual({
                authEnabled: true,
                user: { username: REGULAR.username, role: 'user' },
            });
            await dismissPromptsFor(user.context.request);

            await user.page.goto('/');
            await expect(user.page.locator(LOGIN_PAGE.form)).toHaveCount(0);
            await expect(user.page.getByRole('button', { name: 'Open settings' })).toBeEnabled();

            // The smoke row's dev-tools request, verbatim: strict toEqual keeps a
            // token-gate 403 (which carries a `reason`) from passing as authz.
            const probe = await fetchFromPage(user.page, '/api/users', {
                method: 'POST',
                body: { username: PROBE_USERNAME, password: 'e2e-authz-probe-pw', role: 'admin' },
            });
            expect(probe.status).toBe(403);
            expect(probe.body).toEqual({ error: 'forbidden' });
            const list = await user.context.request.get('/api/users');
            expect(list.status()).toBe(403);
            expect(await list.json()).toEqual({ error: 'forbidden' });
            const disable = await fetchFromPage(user.page, '/api/auth/disable', { method: 'POST' });
            expect(disable.status).toBe(403);
            expect(disable.body).toEqual({ error: 'forbidden' });
            expect((await me(user.context.request)).authEnabled).toBe(true);

            // The users table is the subject, not the status code.
            const after = await listUsers(adminPage.request);
            expect(after.some((u) => u.username === PROBE_USERNAME)).toBe(false);
            expect(after).toHaveLength(countBefore);
            expect(after.find((u) => u.id === 1)?.role).toBe('admin');

            // User-level surface still works, and is isolated per user.
            expect((await user.context.request.get('/api/config')).status()).toBe(200);
            await setLabel(user.context.request, serial, 'e2e 18.7 non-admin label');
            expect((await labelsFor(user.context.request))[serial]).toBe('e2e 18.7 non-admin label');
            expect((await labelsFor(adminPage.request))[serial]).toBeUndefined();
            const ws = await probeWs(user.page, WS_PROBE_URLS.scan, {
                sendOnOpen: JSON.stringify({ type: 'scan.start' }),
                matchType: 'scan.error',
            });
            expect(ws.kind).toBe('message');
            if (ws.kind === 'message') {
                expect(JSON.parse(ws.data)).toEqual({
                    type: 'scan.error',
                    reason: 'subnets must be an array of strings',
                });
            }

            const settings = await openSettings(user.page);
            await expect(sectionHeadings(settings)).toHaveText(['Server']);
            await expect(settings.getByRole('button', { name: 'manage users', exact: true })).toHaveCount(0);
            await expect(settings.getByRole('button', { name: 'disable login (return to open mode)' })).toHaveCount(0);
            await expect(settings.getByText('web port', { exact: true })).toHaveCount(0);
            await expect(settings.getByRole('button', { name: 'stop server & exit' })).toHaveCount(0);
            await expect(settings.locator('[data-action="change-password"]')).toBeVisible();
            await expect(settings.locator('[data-action="logout"]')).toBeVisible();
            await expect(settings.getByText('reset all my settings', { exact: true })).toBeVisible();

            // Selector contrast on the admin page: the count-0 checks above are
            // meaningful only if the same selectors find things for an admin.
            await gotoHome(adminPage);
            const adminSettings = await openSettings(adminPage);
            await expect(sectionHeadings(adminSettings)).toHaveText([
                'Users',
                'Embedding',
                'Updates',
                'Service',
                'Server',
            ]);
            await expect(adminSettings.getByRole('button', { name: 'manage users', exact: true })).toHaveCount(1);
            await closeTopModal(adminPage, adminSettings);
        } finally {
            try {
                await setLabel(user.context.request, serial, '');
                expect((await labelsFor(user.context.request))[serial]).toBeUndefined();
            } catch (err) {
                console.warn(`18.7 cleanup: label: ${String(err)}`);
            }
            await deleteUserIfPresent(adminPage.request, PROBE_USERNAME);
            if (!(await me(adminPage.request)).authEnabled) {
                expect((await adminPage.request.post('/api/auth/enable')).status()).toBe(200);
            }
            await logoutViaApi(user.context.request);
            await user.context.close();
        }
    });

    test('18.8 change own password: the new password signs in and the old one is refused', async () => {
        const user = await newVisitorContext(await browserOf());
        let changed = false;
        let restored = false;
        let repairNote: string | undefined;
        // The safety net for a row that died between the change and the inline
        // restore: log in with the rotated password and change it back. Returns a
        // message instead of throwing so the finally below stays throw-free.
        const repairRegularPassword = async (): Promise<string | undefined> => {
            const repair = await request.newContext({ baseURL: e2eBaseUrl() });
            try {
                await mintToken(repair);
                const alt = await loginAs(repair, { username: REGULAR.username, password: REGULAR_ALT_PASSWORD });
                if (alt.status() === 200) {
                    expect((await changePassword(repair, REGULAR_ALT_PASSWORD, REGULAR.password)).status()).toBe(200);
                } else if (((await alt.json()) as { reason?: string }).reason === 'locked') {
                    return `${REGULAR.username} is locked; as ADMIN run PATCH /api/users/<id> {unlock:true, password: REGULAR.password}`;
                }
                expect((await loginAs(repair, REGULAR)).status()).toBe(200);
                return undefined;
            } finally {
                await repair.dispose();
            }
        };
        try {
            await expectLoginPage(user.page);
            const login = await loginAs(user.context.request, REGULAR);
            expect(login.status(), `login as ${REGULAR.username}: ${await login.text()}`).toBe(200);
            expect(login.headers()['set-cookie']).toMatch(SID_SET_COOKIE_RE);
            const sid0 = await sessionCookie(user.context);
            expect(sid0?.httpOnly).toBe(true);
            expect(await me(user.context.request)).toEqual({
                authEnabled: true,
                user: { username: REGULAR.username, role: 'user' },
            });
            await dismissPromptsFor(user.context.request);

            // Server-side negatives, and proof they wrote nothing.
            const wrongCurrent = await changePassword(user.context.request, 'not-the-password', REGULAR_ALT_PASSWORD);
            expect(wrongCurrent.status()).toBe(400);
            expect(await wrongCurrent.json()).toEqual({ error: 'current password incorrect' });
            const emptyNew = await changePassword(user.context.request, REGULAR.password, '');
            expect(emptyNew.status()).toBe(400);
            expect(await emptyNew.json()).toEqual({ error: 'newPassword required' });
            const notYet = await loginAs(user.context.request, {
                username: REGULAR.username,
                password: REGULAR_ALT_PASSWORD,
            });
            expect(notYet.status()).toBe(401);
            expect(await notYet.json()).toEqual({ ok: false, reason: 'invalid' });

            await user.page.goto('/');
            await expect(user.page.getByRole('button', { name: 'Open settings' })).toBeVisible();
            await expect(user.page.locator('dialog.port-change-modal')).toHaveCount(0);
            const settings = await openSettings(user.page);
            const server = settingsSection(settings, 'Server');
            const cpRow = server
                .locator('.settings-row')
                .filter({ has: user.page.locator('button[data-action="change-password"]') });
            await cpRow.getByRole('button', { name: 'change password', exact: true }).click();
            const current = cpRow.locator('input[data-field="cp-current"]');
            const next = cpRow.locator('input[data-field="cp-new"]');
            await expect(current).toBeVisible();
            const changeSeen = () =>
                user.page.waitForResponse(
                    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/change-password',
                );

            // UI negative: wrong current password, form stays open.
            await current.fill('not-the-password');
            await next.fill(REGULAR_ALT_PASSWORD);
            const badSeen = changeSeen();
            // 'save' is scoped to the row: an admin's Server section has a second one.
            await cpRow.getByRole('button', { name: 'save', exact: true }).click();
            expect((await badSeen).status()).toBe(400);
            await expect(server.getByText('current password incorrect', { exact: true })).toBeVisible();
            await expect(current).toBeVisible();

            // UI positive.
            await current.fill(REGULAR.password);
            await next.fill(REGULAR_ALT_PASSWORD);
            const goodSeen = changeSeen();
            await cpRow.getByRole('button', { name: 'save', exact: true }).click();
            const good = await goodSeen;
            expect(good.status()).toBe(200);
            expect(await good.json()).toEqual({ ok: true });
            changed = true;
            await expect(server.getByText('password changed', { exact: true })).toBeVisible();
            await expect(current).toBeHidden();
            await expect(cpRow.getByRole('button', { name: 'change password', exact: true })).toBeVisible();
            // Changing one's password does not revoke the session that did it.
            expect((await me(user.context.request)).user).toEqual({ username: REGULAR.username, role: 'user' });

            // Log out through Settings; the click reloads into the login page.
            const logoutSeen = user.page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/logout',
            );
            await server.getByRole('button', { name: 'log out', exact: true }).click();
            const out = await logoutSeen;
            expect(out.status()).toBe(200);
            expect(await out.headerValue('set-cookie')).toBe(SID_CLEARED_COOKIE);
            await expectLoginPage(user.page);
            expect(await sessionCookie(user.context)).toBeUndefined();

            // No session may rotate a password.
            const gated = await changePassword(user.context.request, REGULAR_ALT_PASSWORD, REGULAR.password);
            expect(gated.status()).toBe(401);
            expect(await gated.json()).toEqual({ error: 'unauthorized' });

            // Old refused (reason 'invalid', never 'locked'), new accepted — on the real page.
            const old = await submitLoginPage(user.page, REGULAR.username, REGULAR.password);
            expect(old.status).toBe(401);
            expect(old.body).toEqual({ ok: false, reason: 'invalid' });
            await expect(user.page.locator(LOGIN_PAGE.error)).toHaveText(GENERIC_LOGIN_ERROR);
            await expect(user.page.locator(LOGIN_PAGE.form)).toBeVisible();
            await expect(user.page).toHaveTitle(LOGIN_TITLE);
            const fresh = await submitLoginPage(user.page, REGULAR.username, REGULAR_ALT_PASSWORD);
            expect(fresh.status).toBe(200);
            expect(fresh.body).toEqual({ ok: true });
            expect(fresh.setCookie).toMatch(SID_SET_COOKIE_RE);
            await expectAppShell(user.page);
            const sid1 = await sessionCookie(user.context);
            expect(sid1?.value).toBeDefined();
            expect(sid1?.value).not.toBe(sid0?.value);
            expect(await me(user.context.request)).toEqual({
                authEnabled: true,
                user: { username: REGULAR.username, role: 'user' },
            });

            // WHICH row was rewritten: the admin's hash is untouched.
            const adminProbe = await request.newContext({ baseURL: e2eBaseUrl() });
            try {
                await mintToken(adminProbe);
                const adminLogin = await loginAs(adminProbe, ADMIN);
                expect(adminLogin.status(), `admin login: ${await adminLogin.text()}`).toBe(200);
                expect((await me(adminProbe)).user).toEqual({ username: ADMIN.username, role: 'admin' });
            } finally {
                await adminProbe.dispose();
            }

            // Restore inline, so later rows keep one set of constants.
            const back = await changePassword(user.context.request, REGULAR_ALT_PASSWORD, REGULAR.password);
            expect(back.status()).toBe(200);
            expect(await back.json()).toEqual({ ok: true });
            restored = true;
            expect((await loginAs(user.context.request, REGULAR)).status()).toBe(200);
        } finally {
            // No throw in a finally: a repair failure is recorded and raised after,
            // so it can never mask the assertion that actually failed.
            if (changed && !restored) repairNote = await repairRegularPassword();
            await user.context.close();
        }
        if (repairNote) throw new Error(repairNote);
    });

    test('18.9 log out: the session is revoked server-side and the browser returns to the login page until sign-in', async () => {
        await ensureAdminSession(adminPage);
        const sid = await sessionCookie(admin);
        expect(sid).toBeDefined();
        expect(sid?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const sidBefore = sid?.value ?? '';

        // Positive control for the negative half: the copied cookie authenticates
        // BEFORE logout, so a user:null afterwards is attributable to the logout.
        const replay = await newVisitorContext(await browserOf(), {
            cookies: [{ name: SESSION_COOKIE, value: sidBefore }],
        });
        try {
            await expectAppShell(replay.page);
            expect(await me(replay.context.request)).toEqual({
                authEnabled: true,
                user: { username: ADMIN.username, role: 'admin' },
            });

            await gotoHome(adminPage);
            await expectAppShell(adminPage);
            const settings = await openSettings(adminPage);
            const server = settingsSection(settings, 'Server');
            const logoutBtn = server.locator('button[data-action="logout"]');
            await expect(logoutBtn).toBeVisible();
            await expect(logoutBtn).toHaveText('log out');
            // The inner `has` locator is resolved relative to each row, so it must
            // be rooted at the page, not chained from the section.
            await expect(
                server
                    .locator('.settings-row')
                    .filter({ has: adminPage.locator('button[data-action="logout"]') })
                    .locator('.settings-label'),
            ).toHaveText('session');

            // Arm BEFORE the click: the reload follows the response synchronously.
            const logoutRes = adminPage.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/logout',
            );
            const reloadDoc = adminPage.waitForResponse(
                (r) => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/',
            );
            await logoutBtn.click();
            const lr = await logoutRes;
            // Status and headers only — the page reloads at once, so the body of
            // a resource from the navigated-away document may be unreadable.
            expect(lr.status()).toBe(200);
            const cleared = (await lr.headerValue('set-cookie')) ?? '';
            expect(cleared).toContain('wsscrcpy_sid=;');
            expect(cleared).toContain('Max-Age=0');
            expect(cleared).toContain('Path=/');
            const rd = await reloadDoc;
            expect(rd.status()).toBe(200);
            expect(rd.headers()['content-type']).toContain('text/html');
            expect(await rd.headerValue('set-cookie')).toContain(`${TOKEN_COOKIE}=`);

            await expectLoginPage(adminPage);
            expect(await sessionCookie(admin)).toBeUndefined();
            expect(await tokenCookie(admin)).toBeDefined();
            const users = await adminPage.request.get('/api/users');
            expect(users.status()).toBe(401);
            expect(await users.json()).toEqual({ error: 'unauthorized' });
            expect(await me(adminPage.request)).toEqual({ authEnabled: true, user: null });
            expect((await logoutViaApi(adminPage.request)).status()).toBe(401);

            // The negative half: the sessions row is gone, not just the cookie.
            expect((await me(replay.context.request)).user).toBeNull();
            expect((await replay.context.request.get('/api/users')).status()).toBe(401);
            await replay.page.goto('/');
            await expectLoginPage(replay.page);

            const ws = await probeWs(adminPage, WS_PROBE_URLS.scan);
            expect(ws).toEqual({ kind: 'closed', code: 4401, reason: 'unauthorized', wasClean: true });

            // '...until sign-in': one attempt through the served page.
            const again = await submitLoginPage(adminPage, ADMIN.username, ADMIN.password);
            expect(again.status).toBe(200);
            await expectAppShell(adminPage);
            expect((await me(adminPage.request)).user).toEqual({ username: ADMIN.username, role: 'admin' });
        } finally {
            await replay.context.close();
        }
    });

    test('18.10 live WebSockets close 4401 without a session and are served with one, in the same context', async () => {
        const own = await newVisitorContext(await browserOf());
        try {
            await expectLoginPage(own.page);
            expect(await me(own.context.request)).toEqual({ authEnabled: true, user: null });

            // Token but no session: every live channel is refused BEFORE dispatch.
            // A 1006 here would be the handshake gate (token/Origin) — a different subject.
            for (const url of [WS_PROBE_URLS.scan, WS_PROBE_URLS.multiplex, WS_PROBE_URLS.stream]) {
                expect(await probeWs(own.page, url), url).toEqual({
                    kind: 'closed',
                    code: 4401,
                    reason: 'unauthorized',
                    wasClean: true,
                });
            }

            // A well-formed but unknown session cookie is not trusted without the row.
            await own.context.addCookies([
                { name: SESSION_COOKIE, value: 'e2e-bogus-session-token', url: e2eBaseUrl() },
            ]);
            expect(await probeWs(own.page, WS_PROBE_URLS.scan)).toEqual({
                kind: 'closed',
                code: 4401,
                reason: 'unauthorized',
                wasClean: true,
            });
            expect((await me(own.context.request)).user).toBeNull();
            await own.context.clearCookies({ name: SESSION_COOKIE });

            // The SAME jar, now with a session: the only thing that changed.
            const login = await loginAs(own.context.request, ADMIN);
            if (login.status() !== 200) {
                throw new Error(
                    `login as ${ADMIN.username} answered ${login.status()} ${await login.text()} — never retry`,
                );
            }
            const sid = await sessionCookie(own.context);
            expect(sid?.httpOnly).toBe(true);
            expect(sid?.sameSite).toBe('Lax');
            expect((await me(own.context.request)).user).toEqual({ username: ADMIN.username, role: 'admin' });

            // A frame the handler can only send after the gate admitted the socket.
            const served = await probeWs(own.page, WS_PROBE_URLS.scan, {
                sendOnOpen: 'this is not json',
                matchType: 'scan.error',
            });
            expect(served.kind).toBe('message');
            if (served.kind === 'message') {
                expect(JSON.parse(served.data)).toEqual({ type: 'scan.error', reason: 'invalid JSON' });
            }
        } finally {
            const out = await logoutViaApi(own.context.request);
            expect([200, 401]).toContain(out.status());
            await own.context.close();
        }
    });

    test('18.11 return to open mode: disable login reloads, and a client with no session is served the app it was refused a moment earlier', async () => {
        // The anon context is the row's real subject: the admin sees the app in
        // BOTH modes, so it cannot prove 'login no longer required'.
        const anon = await newVisitorContext(await browserOf());
        try {
            await expectLoginPage(anon.page);
            expect(await me(anon.context.request)).toEqual({ authEnabled: true, user: null });
            const gated = await anon.context.request.get('/api/users');
            expect(gated.status(), 'must start LOCKED — an upstream row should have left it so').toBe(401);
            expect(await gated.json()).toEqual({ error: 'unauthorized' });

            await ensureAdminSession(adminPage);
            await gotoHome(adminPage);
            await expectAppShell(adminPage);
            const settings = await openSettings(adminPage);
            const users = settingsSection(settings, 'Users');
            const disableBtn = users.getByRole('button', { name: 'disable login (return to open mode)' });
            await expect(disableBtn).toBeVisible();
            await expect(users.getByRole('button', { name: 'enable login', exact: true })).toHaveCount(0);
            await expect(settings.getByRole('button', { name: 'log out', exact: true })).toBeVisible();
            await expect(settings.getByRole('button', { name: 'change password', exact: true })).toBeVisible();

            // A sentinel global survives a dialog close but not a real reload.
            await adminPage.evaluate(() => {
                (window as unknown as { __e2e_18_11?: string }).__e2e_18_11 = 'armed';
            });
            // Captured inside the route: the client reloads on this response, and
            // a body read from the page's side would hang (see 18.2).
            const capture = await captureResponse(adminPage, { method: 'POST', pathname: '/api/auth/disable' });
            const reloaded = adminPage.waitForEvent('load');
            await disableBtn.click();
            const res = await capture.captured;
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ ok: true });
            await reloaded;
            await capture.dispose();
            expect(
                await adminPage.evaluate(() => (window as unknown as { __e2e_18_11?: string }).__e2e_18_11),
            ).toBeUndefined();
            await expect(adminPage.locator('dialog.settings-modal')).toHaveCount(0);
            await expectAppShell(adminPage);

            // The row's claim, session-less: document, me, users, live socket.
            await anon.page.goto('/');
            await expectAppShell(anon.page);
            expect(await me(anon.context.request)).toEqual({
                authEnabled: false,
                user: { username: ADMIN.username, role: 'admin' },
            });
            const open = await anon.context.request.get('/api/users');
            expect(open.status()).toBe(200);
            expect(((await open.json()) as { users: { id: number }[] }).users.find((u) => u.id === 1)).toMatchObject({
                username: ADMIN.username,
                role: 'admin',
                hasPassword: true,
                disabled: false,
            });
            const ws = await probeWs(anon.page, WS_PROBE_URLS.scan, {
                sendOnOpen: 'this is not json',
                matchType: 'scan.error',
            });
            expect(ws.kind).toBe('message');
            if (ws.kind === 'message')
                expect(JSON.parse(ws.data)).toEqual({ type: 'scan.error', reason: 'invalid JSON' });

            // UI after, admin and anonymous alike.
            const after = await openSettings(adminPage);
            const usersAfter = settingsSection(after, 'Users');
            await expect(usersAfter.getByRole('button', { name: 'enable login', exact: true })).toBeVisible();
            await expect(usersAfter.getByRole('button', { name: 'disable login (return to open mode)' })).toHaveCount(
                0,
            );
            await expect(after.getByRole('button', { name: 'log out', exact: true })).toHaveCount(0);
            await expect(after.getByRole('button', { name: 'change password', exact: true })).toHaveCount(0);
            await expect(after.locator('h3.settings-section-heading', { hasText: /^Users$/ })).toBeVisible();
            await closeTopModal(adminPage, after);
            const anonSettings = await openSettings(anon.page);
            await expect(anonSettings.locator('h3.settings-section-heading', { hasText: /^Users$/ })).toBeVisible();
            await closeTopModal(anon.page, anonSettings);

            // The parenthetical: re-enabling still works because the password
            // survived. API-only and inside try/finally so the shared server is
            // never left locked by this step.
            try {
                const enable = await adminPage.request.post('/api/auth/enable');
                expect(enable.status()).toBe(200);
                expect(await enable.json()).toEqual({ ok: true });
                expect(await me(anon.context.request)).toEqual({ authEnabled: true, user: null });
            } finally {
                const disable = await adminPage.request.post('/api/auth/disable');
                expect(disable.status()).toBe(200);
            }
            expect((await me(anon.context.request)).authEnabled).toBe(false);
            await ensureOpenMode(e2eBaseUrl(), ADMIN);
        } finally {
            await anon.context.close();
        }
        // NOTE, deliberately not asserted either way: after this row the client
        // (UsersModal, keyed on me().authEnabled) offers the "Secure the admin
        // account" block while the server (keyed on whether an enabled admin has
        // a password) would take the normal-create branch — a latent product
        // bug recorded in docs/smoke-tests/automation-coverage.md.
    });

    test('18.12 sessions survive a server restart (spec-owned server on 8124)', async () => {
        test.setTimeout(240_000);
        // Never the shared server: the fast tier's webServer has no supervisor,
        // and POST /api/dependencies/restart exits the process with code 75.
        const paths = privateServerPaths('ws-scrcpy-web-e2e-restart', 8124);
        const RESTART_ADMIN = { username: 'restart-admin', password: 'restart-admin-pw' };
        const RESTART_USER = { username: 'restart-user', password: 'restart-user-pw' };
        seedPrivateDataRoot(paths);
        const handles: ServerHandle[] = [];
        let ctxA: BrowserContext | undefined;
        let ctxB: BrowserContext | undefined;
        let ctxC: BrowserContext | undefined;
        try {
            handles.push(spawnServer(paths));
            await waitForServer(handles[0] as ServerHandle, paths.baseURL);

            // Setup: boot mode, prompts for user 1 (lockdown RENAMES user 1, so the
            // admin inherits them), then the lockdown itself.
            const setup = await request.newContext({ baseURL: paths.baseURL });
            try {
                expectSpaHtml(await (await mintToken(setup)).text());
                await dismissPromptsFor(setup);
                const boot = await me(setup);
                expect(boot.authEnabled, 'the private root must boot as a fresh install').toBe(false);
                expect(boot.user?.role).toBe('admin');
                const locked = await lockdown(setup, {
                    adminUsername: RESTART_ADMIN.username,
                    adminPassword: RESTART_ADMIN.password,
                    username: RESTART_USER.username,
                    password: RESTART_USER.password,
                    role: 'user',
                });
                expect(locked.status()).toBe(201);
                expect(await locked.json()).toEqual({ ok: true });
                expect(await me(setup)).toEqual({ authEnabled: true, user: null });
            } finally {
                await setup.dispose();
            }

            // Context A: the admin session that must survive.
            const a = await newVisitorContext(await browserOf(), { baseURL: paths.baseURL });
            ctxA = a.context;
            await expectLoginPage(a.page);
            const login = await loginAs(a.context.request, RESTART_ADMIN);
            expect(login.status(), `login: ${await login.text()}`).toBe(200);
            expect(await login.json()).toEqual({ ok: true });
            const setCookies = login.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
            const sidHeader = setCookies.find((h) => h.value.startsWith(`${SESSION_COOKIE}=`));
            expect(sidHeader?.value).toContain('HttpOnly');
            expect(sidHeader?.value).toContain('SameSite=Lax');
            const sidBefore = (await sessionCookie(a.context, paths.baseURL))?.value ?? '';
            expect(sidBefore).toMatch(/^[A-Za-z0-9_-]{43}$/);
            const tokenBefore = (await tokenCookie(a.context, paths.baseURL))?.value ?? '';
            expect(tokenBefore).toMatch(/^[0-9a-f]{64}$/);
            expect(sessionRow(paths.dbPath, sidBefore)).toEqual({ user_id: 1 });
            await gotoHome(a.page);
            await expectAppShell(a.page);
            expect(await me(a.context.request)).toEqual({
                authEnabled: true,
                user: { username: RESTART_ADMIN.username, role: 'admin' },
            });

            // Context B: no session, only the pre-restart token; frozen until after.
            const b = await newVisitorContext(await browserOf(), { baseURL: paths.baseURL });
            ctxB = b.context;
            await expectLoginPage(b.page);
            const tokenBBefore = (await tokenCookie(b.context, paths.baseURL))?.value ?? '';

            // Restart the product's way. Cookies on A and B are not touched.
            const restart = await a.context.request.post('/api/dependencies/restart');
            expect(restart.status()).toBe(200);
            expect(await restart.json()).toEqual({ message: 'Restarting...' });
            const exit = await withTimeout(
                (handles[0] as ServerHandle).exited,
                30_000,
                () => `waiting for process #1 to exit:\n${(handles[0] as ServerHandle).output()}`,
            );
            expect(exit.code).toBe(75);
            expect(existsSync(paths.restartMarkerPath)).toBe(true);
            expect(readFileSync(paths.restartMarkerPath, 'utf8').startsWith('restart-requested-')).toBe(true);
            unlinkSync(paths.restartMarkerPath);

            handles.push(spawnServer(paths));
            await waitForServer(handles[1] as ServerHandle, paths.baseURL);

            // The restart's fingerprint — B's FIRST post-restart request, before
            // any document GET could re-mint the token.
            const stale = await b.context.request.get('/api/auth/me');
            expect(stale.status()).toBe(403);
            expect(await stale.json()).toEqual({ error: 'forbidden', reason: 'missing or invalid token' });
            await b.page.goto('/');
            await expectLoginPage(b.page);
            expect((await tokenCookie(b.context, paths.baseURL))?.value).not.toBe(tokenBBefore);
            expect(await me(b.context.request)).toEqual({ authEnabled: true, user: null });
            expect((await b.context.request.get('/api/users')).status()).toBe(401);

            // A's jar is untouched; its first request is a document GET.
            expect((await sessionCookie(a.context, paths.baseURL))?.value).toBe(sidBefore);
            await gotoHome(a.page);
            await expectAppShell(a.page);
            expect(await me(a.context.request)).toEqual({
                authEnabled: true,
                user: { username: RESTART_ADMIN.username, role: 'admin' },
            });
            const users = await listUsers(a.context.request);
            expect(users).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ username: RESTART_ADMIN.username, role: 'admin', hasPassword: true }),
                    expect.objectContaining({ username: RESTART_USER.username, role: 'user' }),
                ]),
            );
            const tokenAfter = (await tokenCookie(a.context, paths.baseURL))?.value ?? '';
            expect(tokenAfter).toMatch(/^[0-9a-f]{64}$/);
            expect(tokenAfter).not.toBe(tokenBefore);
            expect((await sessionCookie(a.context, paths.baseURL))?.value).toBe(sidBefore);
            expect(sessionRow(paths.dbPath, sidBefore)).toEqual({ user_id: 1 });

            // Negative half: the cookie is valid BECAUSE of the row.
            const out = await logoutViaApi(a.context.request);
            expect(out.status()).toBe(200);
            expect(await out.json()).toEqual({ ok: true });
            expect(out.headers()['set-cookie']).toContain('Max-Age=0');
            expect(sessionRow(paths.dbPath, sidBefore)).toBeUndefined();
            const c = await newVisitorContext(await browserOf(), {
                baseURL: paths.baseURL,
                cookies: [{ name: SESSION_COOKIE, value: sidBefore }],
            });
            ctxC = c.context;
            await expectLoginPage(c.page);
            expect(await me(c.context.request)).toEqual({ authEnabled: true, user: null });
        } finally {
            for (const ctx of [ctxC, ctxB, ctxA]) {
                if (ctx) await ctx.close();
            }
            for (const handle of handles) {
                try {
                    await stopServer(handle);
                } catch (err) {
                    console.warn(`18.12 cleanup: ${String(err)}`);
                }
            }
            try {
                if (existsSync(paths.restartMarkerPath)) unlinkSync(paths.restartMarkerPath);
                rmSync(paths.programData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            } catch (err) {
                // EBUSY on the WAL sidecars is tolerated: the next run re-wipes.
                console.warn(`18.12 cleanup: ${String(err)}`);
            }
        }
    });

    /** The worker's browser, for rows that create their own contexts. */
    async function browserOf() {
        return admin.browser() as NonNullable<ReturnType<BrowserContext['browser']>>;
    }
});
