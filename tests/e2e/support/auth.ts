import {
    type APIRequestContext,
    type APIResponse,
    type Browser,
    type BrowserContext,
    type Cookie,
    expect,
    type Locator,
    type Page,
    type Route,
    request,
} from '@playwright/test';
import { E2E_BASE_URL, E2E_DB_PATH } from './paths';

/**
 * Helpers for the auth specs (smoke §18).
 *
 * Server and page constants are COPIED here, never imported from src/ — the
 * same convention playwright.config.ts uses for the decline-marker name, so
 * server modules stay out of the test process. Each one names its source.
 *
 * Two rules every helper honours, because the lockout policy is per user row
 * and the suite has exactly one admin: `loginAs` sends ONE request and never
 * retries, and nothing here ever types a wrong admin password. Five failures in
 * five minutes lock a row for fifteen, every attempt while locked re-arms the
 * lock, and unlocking needs the admin session you no longer have.
 */

// ---------------------------------------------------------------------------
// Credentials — the one set the whole state machine shares
// ---------------------------------------------------------------------------

export interface Credentials {
    username: string;
    password: string;
}

/** Typed into the lockdown block by 18.2; user id 1 is RENAMED to it. Its password never changes. */
export const ADMIN: Credentials = { username: 'e2e-owner', password: 'e2e-owner-pw' };
/** The lockdown's new user (role 'user'): locked by 18.4, unlocked by 18.5, the non-admin of 18.7/18.8. */
export const REGULAR: Credentials = { username: 'e2e-regular', password: 'e2e-regular-pw' };
/** 18.8 rotates REGULAR to this and back; exported so a died-mid-row run can be repaired. */
export const REGULAR_ALT_PASSWORD = 'e2e-regular-pw-2';
/** Created and deleted inside 18.6 only. */
export const TEMP_USER: Credentials = { username: 'e2e-temp', password: 'e2e-temp-pw-1' };
export const TEMP_USER_PASSWORD_2 = 'e2e-temp-pw-2';
/** Must never exist; 18.7 asserts the server refused to create it. */
export const PROBE_USERNAME = 'e2e-authz-probe';
/** Must not case-fold to any real user: usernames are COLLATE NOCASE UNIQUE. */
export const UNKNOWN_USERNAME = 'e2e-nobody';
export const WRONG_PASSWORD = 'definitely-not-the-password';

// ---------------------------------------------------------------------------
// Copied server/page constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'wsscrcpy_sid'; // src/server/auth/authState.ts
export const TOKEN_COOKIE = 'ws_scrcpy_token'; // src/server/security/instanceToken.ts
export const LOGIN_TITLE = 'Sign in'; // src/server/auth/AuthGate.ts
export const APP_TITLE = 'Android Power Tools'; // public/index.html
export const GENERIC_LOGIN_ERROR = 'Invalid credentials or the account is temporarily locked.'; // AuthGate.ts
export const LOCKDOWN_RELOAD_TEXT = 'Login is now required. Reloading…'; // src/app/client/UsersModal.ts (U+2026)
export const WS_PROBE_URLS = {
    scan: '/ws-scan', // src/common/ScanMessage.ts
    multiplex: '/?action=multiplex', // src/common/Action.ts
    stream: '/?action=stream&udid=e2e-no-such-device', // src/common/Action.ts
} as const;
export const MAX_FAILS = 5; // src/server/auth/loginPolicy.ts
export const LOCK_MS = 15 * 60 * 1000; // src/server/auth/loginPolicy.ts
/** Login's Set-Cookie: 32 random bytes base64url (43 chars). AuthApi.ts / session.ts. */
export const SID_SET_COOKIE_RE = /^wsscrcpy_sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/$/;
export const SID_CLEARED_COOKIE = 'wsscrcpy_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'; // AuthApi.ts
/** The instance token: 32 random bytes hex. instanceToken.ts. */
export const TOKEN_SET_COOKIE_RE = /^ws_scrcpy_token=[0-9a-f]{64}; Path=\/; SameSite=Strict; HttpOnly$/;
export const LOGIN_PAGE = {
    form: 'form#f',
    username: '#u',
    password: '#p',
    error: '#e',
    submit: 'form#f button[type="submit"]',
} as const; // AuthGate.ts

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeResponse {
    authEnabled: boolean;
    user: { username: string; role: 'user' | 'admin' } | null;
}

export interface UserRow {
    id: number;
    username: string;
    role: 'user' | 'admin';
    hasPassword: boolean;
    disabled: boolean;
    lockedUntil: number | null;
    lastLogin: number | null;
}

export type WsProbeResult =
    | { kind: 'closed'; code: number; reason: string; wasClean: boolean }
    | { kind: 'message'; data: string };

// ---------------------------------------------------------------------------
// Base URL and contexts
// ---------------------------------------------------------------------------

/** The same rule as global-setup.ts and both configs' `use.baseURL`. */
export function e2eBaseUrl(): string {
    return process.env['PLAYWRIGHT_BASE_URL'] || E2E_BASE_URL;
}

/**
 * A fresh browser context that has loaded '/' once, so its jar holds the
 * instance token and its page is same-origin for WebSocket probes. Cookie-less
 * otherwise, unless `cookies` seeds it (the replay contexts). Caller closes it.
 */
export async function newVisitorContext(
    browser: Browser,
    opts?: { baseURL?: string; cookies?: { name: string; value: string }[] },
): Promise<{ context: BrowserContext; page: Page }> {
    const baseURL = opts?.baseURL ?? e2eBaseUrl();
    const context = await browser.newContext({ baseURL });
    if (opts?.cookies) {
        await context.addCookies(opts.cookies.map((c) => ({ ...c, url: baseURL })));
    }
    const page = await context.newPage();
    await page.goto('/');
    return { context, page };
}

export async function sessionCookie(context: BrowserContext, baseURL?: string): Promise<Cookie | undefined> {
    return (await context.cookies(baseURL ?? e2eBaseUrl())).find((c) => c.name === SESSION_COOKIE);
}

export async function tokenCookie(context: BrowserContext, baseURL?: string): Promise<Cookie | undefined> {
    return (await context.cookies(baseURL ?? e2eBaseUrl())).find((c) => c.name === TOKEN_COOKIE);
}

// ---------------------------------------------------------------------------
// API wrappers — raw responses where the caller must judge status
// ---------------------------------------------------------------------------

/**
 * A document GET is the only thing that mints the instance token into a jar,
 * and it does so in locked mode too (the gate sets the cookie before AuthGate
 * serves the login page). Every standalone APIRequestContext must call this
 * before its first /api request, and again after a server restart.
 */
export async function mintToken(ctx: APIRequestContext): Promise<APIResponse> {
    const res = await ctx.get('/');
    expect(res.status(), 'document GET / (mints the instance token)').toBe(200);
    return res;
}

/** Status can never tell the two pages apart (both are 200) — the body is the subject. */
export function expectSpaHtml(html: string): void {
    expect(html).toContain(`<title>${APP_TITLE}</title>`);
    expect(html).not.toContain(`<title>${LOGIN_TITLE}</title>`);
    expect(html).not.toContain('id="f"');
}

export function expectLoginHtml(html: string): void {
    expect(html).toContain(`<title>${LOGIN_TITLE}</title>`);
    expect(html).toContain('id="f"');
    expect(html).not.toContain(`<title>${APP_TITLE}</title>`);
}

export async function me(ctx: APIRequestContext): Promise<MeResponse> {
    const res = await ctx.get('/api/auth/me');
    expect(res.status(), 'GET /api/auth/me').toBe(200);
    return (await res.json()) as MeResponse;
}

/** Exactly ONE login attempt. Never asserts, never retries: every failure counts against the row. */
export async function loginAs(ctx: APIRequestContext, creds: Credentials): Promise<APIResponse> {
    return ctx.post('/api/auth/login', { data: { username: creds.username, password: creds.password } });
}

export async function logoutViaApi(ctx: APIRequestContext): Promise<APIResponse> {
    return ctx.post('/api/auth/logout');
}

export async function changePassword(
    ctx: APIRequestContext,
    currentPassword: string,
    newPassword: string,
): Promise<APIResponse> {
    return ctx.post('/api/auth/change-password', { data: { currentPassword, newPassword } });
}

/** The first-user lockdown body. 201 {ok:true} on the lockdown branch; 201 {id} means it was NOT that branch. */
export async function lockdown(
    ctx: APIRequestContext,
    args: { adminUsername: string; adminPassword: string; username: string; password: string; role?: 'user' | 'admin' },
): Promise<APIResponse> {
    return ctx.post('/api/users', { data: { role: 'user', ...args } });
}

export async function listUsers(ctx: APIRequestContext): Promise<UserRow[]> {
    const res = await ctx.get('/api/users');
    expect(res.status(), 'GET /api/users (needs an admin: a session in locked mode, none in open mode)').toBe(200);
    return ((await res.json()) as { users: UserRow[] }).users;
}

/** Always resolve users by NAME, never by index — 18.6 adds and removes rows. */
export async function userByName(ctx: APIRequestContext, username: string): Promise<UserRow> {
    const matches = (await listUsers(ctx)).filter((u) => u.username.toLowerCase() === username.toLowerCase());
    if (matches.length !== 1) {
        throw new Error(`expected exactly one user named ${username}, found ${matches.length}`);
    }
    return matches[0] as UserRow;
}

export async function unlockUser(adminCtx: APIRequestContext, id: number): Promise<void> {
    const res = await adminCtx.patch(`/api/users/${id}`, { data: { unlock: true } });
    expect(res.status(), `PATCH /api/users/${id} {unlock:true}`).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
}

export async function setUserPassword(adminCtx: APIRequestContext, id: number, password: string): Promise<void> {
    const res = await adminCtx.patch(`/api/users/${id}`, { data: { password } });
    expect(res.status(), `PATCH /api/users/${id} {password}`).toBe(200);
}

/** DELETE by name, accepting 200 or 404 — the leftover guard for died-mid-row runs. */
export async function deleteUserIfPresent(adminCtx: APIRequestContext, username: string): Promise<void> {
    const found = (await listUsers(adminCtx)).find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!found) return;
    const res = await adminCtx.delete(`/api/users/${found.id}`);
    expect([200, 404], `DELETE /api/users/${found.id} (${username})`).toContain(res.status());
}

/**
 * The per-user twin of global-setup's PATCH. global-setup only dismissed the
 * prompts for user 1; a freshly logged-in REGULAR has no flags, so the bookmark
 * reminder would open on its first shell load and swallow the Settings click.
 * Call BEFORE the first page.goto('/') as that user.
 */
export async function dismissPromptsFor(ctx: APIRequestContext): Promise<void> {
    const res = await ctx.patch('/api/settings', {
        data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
    });
    expect(res.status(), 'PATCH /api/settings (dismiss the prompts for this user)').toBe(200);
}

/**
 * The fresh-install state, asserted rather than assumed. Unrestorable through the
 * API once 18.2 has run: nothing nulls a hash or renames user 1 back.
 */
export async function expectPristineAuthState(ctx: APIRequestContext): Promise<void> {
    const hint =
        `fresh-install precondition violated — delete ${E2E_DB_PATH} (and its -wal/-shm sidecars) and rerun; ` +
        'playwright.config.ts must wipe it at config-load';
    expect((await me(ctx)).authEnabled, hint).toBe(false);
    expect(await listUsers(ctx), hint).toEqual([
        {
            id: 1,
            username: 'admin',
            role: 'admin',
            hasPassword: false,
            disabled: false,
            lockedUntil: null,
            lastLogin: null,
        },
    ]);
}

/**
 * Idempotent admin session on the shared admin context: at most one login, and
 * a non-200 throws — a locked admin has no in-suite recovery, so never retry.
 */
export async function ensureAdminSession(page: Page, creds: Credentials = ADMIN): Promise<void> {
    if (!(await tokenCookie(page.context()))) await page.goto('/');
    let m = await me(page.request);
    if (m.user?.role !== 'admin') {
        const res = await loginAs(page.request, creds);
        if (res.status() !== 200) {
            throw new Error(
                `ensureAdminSession: login as ${creds.username} answered ${res.status()} ${await res.text()} — ` +
                    `a locked admin cannot be recovered in-suite; delete ${E2E_DB_PATH} (+ -wal/-shm) and rerun`,
            );
        }
        m = await me(page.request);
    }
    expect(m.user).toEqual({ username: creds.username, role: 'admin' });
}

/**
 * Return the server to open mode through a standalone request context. A no-op
 * when already open; otherwise ONE login (throws with the reason on 401) and a
 * POST /api/auth/disable. The file's afterAll belt.
 */
export async function ensureOpenMode(baseURL: string, admin: Credentials): Promise<void> {
    const ctx = await request.newContext({ baseURL });
    try {
        await mintToken(ctx);
        if ((await me(ctx)).authEnabled) {
            const login = await loginAs(ctx, admin);
            if (login.status() !== 200) {
                throw new Error(
                    `ensureOpenMode: login as ${admin.username} answered ${login.status()} ${await login.text()} — ` +
                        'the server stays LOCKED for the rest of this run; the next run is clean because ' +
                        `playwright.config.ts wipes ${E2E_DB_PATH} before webServer starts`,
                );
            }
            const disable = await ctx.post('/api/auth/disable');
            expect(disable.status(), 'POST /api/auth/disable').toBe(200);
            expect(await disable.json()).toEqual({ ok: true });
        }
        expect((await me(ctx)).authEnabled).toBe(false);
        expectSpaHtml(await (await ctx.get('/')).text());
    } finally {
        await ctx.dispose();
    }
}

// ---------------------------------------------------------------------------
// Page-level assertions and the inline login page
// ---------------------------------------------------------------------------

/** Both auto-wait across the app's own reloads — never page.goto between the app's navigation and this. */
export async function expectLoginPage(page: Page): Promise<void> {
    await expect(page).toHaveTitle(LOGIN_TITLE);
    await expect(page.locator(LOGIN_PAGE.form)).toBeVisible();
    await expect(page.locator('input#u[name="username"]')).toBeVisible();
    await expect(page.locator('input#p[name="password"][type="password"]')).toBeVisible();
    await expect(page.locator('div.err#e')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Open settings' })).toHaveCount(0);
}

export async function expectAppShell(page: Page): Promise<void> {
    await expect(page).toHaveTitle(APP_TITLE);
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await expect(page.locator(LOGIN_PAGE.form)).toHaveCount(0);
}

/**
 * Submit the inline login page. The response wait is armed BEFORE the click, and
 * the caller judges the result: the URL is '/' before and after, so waitForURL
 * would prove nothing.
 */
export async function submitLoginPage(page: Page, username: string, password: string): Promise<CapturedResponse> {
    await page.locator(LOGIN_PAGE.username).fill(username);
    await page.locator(LOGIN_PAGE.password).fill(password);
    // Captured inside the route: on success the inline page navigates at once,
    // and a body read from the page's side would then hang.
    const capture = await captureResponse(page, { method: 'POST', pathname: '/api/auth/login' });
    try {
        await page.locator(LOGIN_PAGE.submit).click();
        return await capture.captured;
    } finally {
        await capture.dispose();
    }
}

/**
 * One attempt from a freshly loaded login page. The reload is what keeps each
 * `#e` assertion fresh: the inline script clears it only inside its own submit
 * handler. The raw text is what 18.4 compares byte for byte.
 */
export async function submitLoginFresh(page: Page, username: string, password: string): Promise<CapturedResponse> {
    await page.goto('/');
    await expect(page.locator(LOGIN_PAGE.error)).toBeEmpty();
    return submitLoginPage(page, username, password);
}

// ---------------------------------------------------------------------------
// Settings and Users modals
// ---------------------------------------------------------------------------

export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function openSettings(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.locator('dialog.settings-modal');
    await expect(settings).toBeVisible();
    return settings;
}

export function settingsSection(
    settings: Locator,
    title: 'Users' | 'Embedding' | 'Updates' | 'Service' | 'Server',
): Locator {
    return settings.locator('section.settings-section').filter({
        has: settings
            .page()
            .locator('h3.settings-section-heading', { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
    });
}

/** Rows are `display: contents` — assert on a row's label or control, never on the row itself. */
export function settingsRow(section: Locator, label: string): Locator {
    return section.locator('.settings-row').filter({
        has: section.page().locator('.settings-label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }),
    });
}

/** The subject of the exact ordered-list assertions (five headings for an admin, ['Server'] for a user). */
export function sectionHeadings(settings: Locator): Locator {
    return settings.locator('section.settings-section > h3.settings-section-heading');
}

/** Settings → Users → manage users, resolved once the async list has rendered. */
export async function openUsersModal(page: Page): Promise<Locator> {
    const settings = await openSettings(page);
    await settingsSection(settings, 'Users').getByRole('button', { name: 'manage users', exact: true }).click();
    const usersModal = page.locator('dialog.users-modal');
    await expect(usersModal).toBeVisible();
    await expect(usersModal.locator('ul > li').first()).toBeVisible();
    return usersModal;
}

/** Lazy on purpose: refresh() replaces the whole modal body after every action. */
export function userRow(usersModal: Locator, username: string): Locator {
    return usersModal.locator('ul > li').filter({
        has: usersModal.page().locator('span', { hasText: new RegExp(`^${escapeRegExp(username)}$`) }),
    });
}

/** Anchored: every row's <select> also contains the words 'admin' and 'user', and the checkbox label is 'disable'. */
export function roleSpan(row: Locator, role: 'user' | 'admin'): Locator {
    return row.locator('span').filter({ hasText: new RegExp(`^${role}$`) });
}

export function disabledBadge(row: Locator): Locator {
    return row.locator('span').filter({ hasText: /^disabled$/ });
}

export function lockedBadge(row: Locator): Locator {
    return row.locator('span').filter({ hasText: /^locked$/ });
}

/**
 * Escape closes the top-most <dialog>; close() removes it after transitionend,
 * so wait for hidden rather than count. Never click `.modal-close` unfiltered —
 * the theme toggle shares that class and sits before the × button.
 */
export async function closeTopModal(page: Page, dialog: Locator): Promise<void> {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
}

export async function closeAllModals(page: Page): Promise<void> {
    const dialogs = page.locator('dialog.modal');
    for (let i = 0; i < 4; i++) {
        const open = await dialogs.count();
        if (open === 0) return;
        await page.keyboard.press('Escape');
        await expect(dialogs).toHaveCount(open - 1);
    }
    await expect(dialogs).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Holding a reload, WebSocket probes, page fetches, labels
// ---------------------------------------------------------------------------

/**
 * Record the Users modal's farewell text before the app reloads.
 *
 * The client writes "Login is now required. Reloading…" and calls
 * location.reload() in the same synchronous run, and that moment is not
 * assertable from outside: Playwright's locator assertions wait for a pending
 * navigation to finish before they evaluate, so the old document's DOM is
 * unreadable once the reload is in flight (holding the reload with a route
 * was tried, and that is exactly where it stalled). A mutation observer
 * planted before the click stashes what the modal body said, and how many
 * lockdown blocks remained, into sessionStorage — which survives a same-origin
 * reload — where the new document (the inline login page) hands it back.
 */
export const LOCKDOWN_FAREWELL_KEY = '__e2e_lockdown_farewell';

export async function watchLockdownFarewell(page: Page): Promise<void> {
    await page.evaluate((key) => {
        sessionStorage.removeItem(key);
        const body = document.querySelector('dialog.users-modal .modal-body');
        if (!body) throw new Error('no dialog.users-modal .modal-body to observe');
        const record = () => {
            sessionStorage.setItem(
                key,
                JSON.stringify({
                    text: body.textContent?.trim() ?? '',
                    lockdownSections: document.querySelectorAll('.lockdown-section').length,
                }),
            );
        };
        new MutationObserver(record).observe(body, { childList: true, subtree: true, characterData: true });
    }, LOCKDOWN_FAREWELL_KEY);
}

export async function readLockdownFarewell(page: Page): Promise<{ text: string; lockdownSections: number } | null> {
    const raw = await page.evaluate((key) => sessionStorage.getItem(key), LOCKDOWN_FAREWELL_KEY);
    return raw ? (JSON.parse(raw) as { text: string; lockdownSections: number }) : null;
}

export interface CapturedResponse {
    status: number;
    /** Parsed JSON, or the raw text when the body is not JSON. */
    body: unknown;
    /** The raw body, for byte-identical comparisons. */
    text: string;
    /** The Set-Cookie header, if the response carried one. */
    setCookie: string | undefined;
    contentType: string | undefined;
    postDataJSON: unknown;
}

/**
 * Capture one response from inside the route — fetch it, read it here, then
 * fulfil the page with the very same response — for the requests whose reply
 * the client answers with `location.reload()`. Reading such a response's body
 * from the page's side (`waitForResponse` then `json()`) hangs once the
 * navigation is pending; 18.2's trace showed exactly that. Registered last so
 * it runs first; everything else falls back to earlier handlers.
 */
export async function captureResponse(
    page: Page,
    match: { method: string; pathname: string },
): Promise<{ captured: Promise<CapturedResponse>; dispose(): Promise<void> }> {
    let resolveCaptured: (c: CapturedResponse) => void = () => {};
    let rejectCaptured: (e: Error) => void = () => {};
    const captured = new Promise<CapturedResponse>((resolve, reject) => {
        resolveCaptured = resolve;
        rejectCaptured = reject;
    });
    const handler = async (route: Route): Promise<void> => {
        const req = route.request();
        if (req.method() !== match.method || new URL(req.url()).pathname !== match.pathname) {
            await route.fallback();
            return;
        }
        try {
            const response = await route.fetch();
            const text = await response.text();
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
            const header = (name: string) => response.headersArray().find((h) => h.name.toLowerCase() === name)?.value;
            resolveCaptured({
                status: response.status(),
                body,
                text,
                setCookie: header('set-cookie'),
                contentType: header('content-type'),
                postDataJSON: req.postDataJSON(),
            });
            await route.fulfill({ response });
        } catch (err) {
            rejectCaptured(err as Error);
            throw err;
        }
    };
    await page.route('**/*', handler);
    return { captured, dispose: async () => page.unroute('**/*', handler) };
}

/**
 * Open an in-page WebSocket and report the first close, or the first message
 * (optionally the first whose JSON `type` equals `matchType`). Must run on a
 * page that loaded a same-origin document: without the token cookie and an
 * Origin the handshake itself is refused and the browser reports 1006 — a
 * different subject from the 4401 auth close.
 */
export async function probeWs(
    page: Page,
    pathAndQuery: string,
    opts?: { sendOnOpen?: string; matchType?: string; timeoutMs?: number },
): Promise<WsProbeResult> {
    return page.evaluate(
        ({ path, sendOnOpen, matchType, timeoutMs }) =>
            new Promise<WsProbeResult>((resolve, reject) => {
                const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
                const ws = new WebSocket(url);
                let settled = false;
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    try {
                        ws.close();
                    } catch {}
                    reject(new Error(`no close or matching message from ${url} within ${timeoutMs} ms`));
                }, timeoutMs);
                const done = (result: WsProbeResult) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(result);
                };
                ws.addEventListener('open', () => {
                    if (sendOnOpen !== undefined) ws.send(sendOnOpen);
                });
                ws.addEventListener('message', (event) => {
                    const data = String(event.data);
                    if (matchType !== undefined) {
                        try {
                            if ((JSON.parse(data) as { type?: string }).type !== matchType) return;
                        } catch {
                            return;
                        }
                    }
                    done({ kind: 'message', data });
                    try {
                        ws.close(1000);
                    } catch {}
                });
                ws.addEventListener('close', (event) =>
                    done({ kind: 'closed', code: event.code, reason: event.reason, wasClean: event.wasClean }),
                );
            }),
        {
            path: pathAndQuery,
            sendOnOpen: opts?.sendOnOpen,
            matchType: opts?.matchType,
            timeoutMs: opts?.timeoutMs ?? 10_000,
        },
    );
}

/**
 * A dev-tools style fetch from inside the page: same origin, browser cookies,
 * JSON when a body is given. Assert bodies with strict toEqual — the request
 * gate's 403 carries an extra `reason` that must not pass as an authz 403.
 */
export async function fetchFromPage(
    page: Page,
    path: string,
    init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
    return page.evaluate(
        async ({ path, method, body }) => {
            const init: RequestInit = { method: method ?? 'GET' };
            if (body !== undefined) {
                init.headers = { 'content-type': 'application/json' };
                init.body = JSON.stringify(body);
            }
            const res = await fetch(path, init);
            let parsed: unknown = null;
            try {
                parsed = await res.json();
            } catch {
                parsed = null;
            }
            return { status: res.status, body: parsed };
        },
        { path, method: init?.method, body: init?.body },
    );
}

/** Device labels are keyed per user — the per-user isolation negative in 18.7. Label '' deletes. */
export async function setLabel(ctx: APIRequestContext, serial: string, label: string): Promise<void> {
    const res = await ctx.put('/api/devices/labels', { data: { serial, label } });
    expect(res.status(), 'PUT /api/devices/labels').toBe(200);
    expect(await res.json()).toEqual({ success: true });
}

export async function labelsFor(ctx: APIRequestContext): Promise<Record<string, string>> {
    const res = await ctx.get('/api/devices/labels');
    expect(res.status(), 'GET /api/devices/labels').toBe(200);
    return (await res.json()) as Record<string, string>;
}
