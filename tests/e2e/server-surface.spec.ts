import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { type Browser, type BrowserContext, expect, request, test } from '@playwright/test';
import { APP_TITLE, e2eBaseUrl, fetchFromPage, mintToken, newVisitorContext, tokenCookie } from './support/auth';
import { E2E_PORT } from './support/paths';
import {
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopServer,
    waitForDependencies,
    waitForServer,
    withTimeout,
} from './support/privateServer';

/**
 * Smoke module 10 — the server surface (rows 10.1, 10.4, 10.5, 10.6).
 *
 * Request-level rows, mostly: what the server answers on the wire, not what a
 * page renders. Two of them need a server the spec owns — 10.4 restarts one
 * and 10.6 needs `allowedHosts` in config.json at boot — because the shared
 * 8123 server has no supervisor and reads that key once. The framing headers
 * themselves are `framing-headers.spec.ts`'s subject; 10.5 asserts the 404 /
 * fallback split those headers ride on.
 */

/** A raw request with a forged Host header. Playwright's request context owns its Host; node's does not. */
async function rawGet(
    port: number,
    path: string,
    headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
            );
        });
        req.on('error', reject);
        req.end();
    });
}

function setCookieFrom(headers: Record<string, string | string[] | undefined>): string {
    const raw = headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((c) => c.split(';')[0] ?? '').join('; ');
}

test.describe('server surface (smoke §10)', () => {
    test('10.1 /api/service/status answers 200 with the platform, support flag and status of this host', async () => {
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(ctx);
            const res = await ctx.get('/api/service/status');
            expect(res.status()).toBe(200);
            const body = (await res.json()) as {
                platform?: string;
                supported?: boolean;
                status?: string;
                unsupportedReason?: string;
                docker?: boolean;
            };
            // The platform is the server's, which in the fast tier is this process's.
            expect(body.platform).toBe(process.platform);
            expect(typeof body.supported).toBe('boolean');
            // "Unsupported" is a first-class state carried in the body, never a
            // non-200: on a host without a service manager the reason is named.
            if (body.supported) {
                expect(typeof body.status).toBe('string');
                expect(body.status?.length ?? 0).toBeGreaterThan(0);
            } else {
                expect(typeof body.unsupportedReason).toBe('string');
            }
            // The container flag is an env implication; the fast tier has none.
            expect(body.docker).toBeUndefined();
        } finally {
            await ctx.dispose();
        }
    });

    test('10.3 the log is clean: the teardown lines are present on stop and no error line appears that is not on the allow-list', async () => {
        test.setTimeout(180_000);
        // Made falsifiable: (a) the teardown line must be present after a stop;
        // (b) zero lines matching the error pattern, except an allow-list where
        // every entry justifies itself in a comment. An allow-list that grows
        // without comments is how this assertion stops meaning anything.
        const ERROR_LINE = /\bERROR\b|Error:/;
        // A tree that has never run `npm run stage-seed` (CI's `npm ci` + build:
        // nothing there fires the `prestart` hook) has no node-pty seed. The
        // resolver says so at ERROR level and the shell feature stays off, the
        // same condition /api/capabilities reports as `no-seed-package` (row 9.5).
        // The seed root is <repo>/seed/node-pty-pkg, anchored on dist/, not on
        // the data root, so a spec-owned server sees whatever this checkout has.
        const configFile = test.info().config.configFile;
        const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
        const seedPresent = existsSync(path.join(repoRoot, 'seed', 'node-pty-pkg'));
        const ALLOWED: { pattern: RegExp; why: string }[] = [
            // Add an entry only with the line it matches and why it is cosmetic.
            // This one is tolerated only while the seed really is absent: on a
            // tree that has it, the line is a regression. Register finding 10.9
            // (ERROR level for an optional feature's documented absence).
            ...(seedPresent
                ? []
                : [
                      {
                          pattern: /\[NodePtyResolver\] ERROR no seed node-pty package found/,
                          why: 'no node-pty seed in this checkout',
                      },
                  ]),
        ];
        const paths = privateServerPaths('ws-scrcpy-web-e2e-logs-clean', 8130);
        seedPrivateDataRoot(paths);
        const handle = spawnServer(paths);
        try {
            await waitForServer(handle, paths.baseURL);
            // Let the first-run install finish: stopping mid-download would put
            // that abort in the log and blame it on the stop.
            await waitForDependencies(paths.baseURL);
            // A representative run: a document, the token, a few API reads, and
            // the store — enough for the server to have said something.
            const ctx = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(ctx);
                expect((await ctx.get('/api/config')).status()).toBe(200);
                expect((await ctx.get('/api/service/status')).status()).toBe(200);
                expect((await ctx.get('/api/settings')).status()).toBe(200);
                // The clean stop: the same route the UI's "stop server & exit" calls.
                const stop = await ctx.post('/api/server/shutdown');
                expect(stop.status()).toBe(200);
                expect(await stop.json()).toEqual({ ok: true });
            } finally {
                await ctx.dispose();
            }
            const exit = await withTimeout(handle.exited, 60_000, () => `waiting for the stop:\n${handle.output()}`);
            expect(exit.code).toBe(0);

            const logPath = path.join(paths.dataRoot, 'logs', 'ws-scrcpy-web.log');
            const log = readFileSync(logPath, 'utf8');
            expect(log, 'teardown line on stop').toContain('Stopping adb daemon (kill-server)');
            const offending = log
                .split(/\r?\n/)
                .filter((line) => ERROR_LINE.test(line) && !ALLOWED.some((a) => a.pattern.test(line)));
            expect(offending, `error lines not on the allow-list:\n${offending.join('\n')}`).toEqual([]);
        } finally {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`10.3 cleanup: ${String(err)}`);
            }
        }
    });

    test('10.4 a restart rotates the per-instance token: the open tab must reload, and a cookie-less caller is refused', async () => {
        test.setTimeout(240_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-token-restart', 8126);
        seedPrivateDataRoot(paths);
        const handles: ServerHandle[] = [];
        let ctx: BrowserContext | undefined;
        try {
            handles.push(spawnServer(paths));
            await waitForServer(handles[0] as ServerHandle, paths.baseURL);

            // Normal browser use: the document GET minted the token, the API answers.
            const visitor = await newVisitorContext(await browserOf(), { baseURL: paths.baseURL });
            ctx = visitor.context;
            await expect(visitor.page).toHaveTitle(APP_TITLE);
            const tokenBefore = (await tokenCookie(ctx, paths.baseURL))?.value ?? '';
            expect(tokenBefore).toMatch(/^[0-9a-f]{64}$/);
            expect((await fetchFromPage(visitor.page, '/api/service/status')).status).toBe(200);

            // Restart the product's way (the admin route; open mode resolves the
            // implicit admin), await the exit, respawn.
            const restart = await visitor.context.request.post('/api/dependencies/restart');
            expect(restart.status()).toBe(200);
            const exit = await withTimeout(
                (handles[0] as ServerHandle).exited,
                30_000,
                () => `waiting for the first process to exit:\n${(handles[0] as ServerHandle).output()}`,
            );
            expect(exit.code).toBe(75);
            handles.push(spawnServer(paths));
            await waitForServer(handles[1] as ServerHandle, paths.baseURL);

            // The tab that was open across the restart: its token is the OLD
            // process's, so the sensitive API refuses it until the page reloads.
            const stale = await fetchFromPage(visitor.page, '/api/service/status');
            expect(stale.status).toBe(403);
            expect(stale.body).toEqual({ error: 'forbidden', reason: 'missing or invalid token' });
            await visitor.page.reload();
            await expect(visitor.page).toHaveTitle(APP_TITLE);
            const tokenAfter = (await tokenCookie(ctx, paths.baseURL))?.value ?? '';
            expect(tokenAfter).toMatch(/^[0-9a-f]{64}$/);
            expect(tokenAfter).not.toBe(tokenBefore);
            expect((await fetchFromPage(visitor.page, '/api/service/status')).status).toBe(200);

            // curl with no cookie: refused on the sensitive API, served on /api/config.
            const bare = await request.newContext({ baseURL: paths.baseURL });
            try {
                const refused = await bare.get('/api/service/status');
                expect(refused.status()).toBe(403);
                expect(await refused.json()).toEqual({ error: 'forbidden', reason: 'missing or invalid token' });
                expect((await bare.get('/api/config')).status()).toBe(200);
            } finally {
                await bare.dispose();
            }
        } finally {
            if (ctx) await ctx.close();
            for (const handle of handles) {
                try {
                    await stopServer(handle);
                } catch (err) {
                    console.warn(`10.4 cleanup: ${String(err)}`);
                }
            }
        }
    });

    test('10.5 a missing asset and an unknown API route 404, a deep in-app route falls back to the shell, and every static response carries the security headers', async () => {
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(ctx);
            const expectSecurityHeaders = (headers: Record<string, string>, what: string) => {
                expect(headers['x-content-type-options'], what).toBe('nosniff');
                expect(headers['x-frame-options'], what).toBe('SAMEORIGIN');
            };

            // The shell, with the headers.
            const home = await ctx.get('/');
            expect(home.status()).toBe(200);
            expect(await home.text()).toContain(`<title>${APP_TITLE}</title>`);
            expectSecurityHeaders(home.headers(), 'GET /');

            // A missing asset is a 404, not the shell with 200 — and still headered.
            for (const method of ['GET', 'HEAD'] as const) {
                const missing = await ctx.fetch('/no-such-asset.js', { method });
                expect(missing.status(), `${method} /no-such-asset.js`).toBe(404);
                expectSecurityHeaders(missing.headers(), `${method} /no-such-asset.js`);
                if (method === 'GET') expect(await missing.text()).not.toContain(APP_TITLE);
            }
            // ...even when asked for as a document. The fallback keys on BOTH the
            // Accept header and the path having no extension; a fallback keyed on
            // Accept alone served the shell for every mistyped asset URL (#24).
            const missingAsDoc = await ctx.get('/no-such-asset.js', { headers: { accept: 'text/html' } });
            expect(missingAsDoc.status()).toBe(404);
            expect(await missingAsDoc.text()).not.toContain(APP_TITLE);

            // An unknown API route asked for as JSON is a 404, not the shell.
            const api = await ctx.get('/api/no-such-route', { headers: { accept: 'application/json' } });
            expect(api.status()).toBe(404);
            expect(await api.text()).not.toContain(APP_TITLE);

            // A deep in-app route, navigated to as a document, still falls back to the shell.
            const deep = await ctx.get('/devices/some/deep/route', { headers: { accept: 'text/html' } });
            expect(deep.status()).toBe(200);
            expect(await deep.text()).toContain(`<title>${APP_TITLE}</title>`);
            expectSecurityHeaders(deep.headers(), 'GET deep route');

            // The same route asked for as JSON is not the shell either: the split is
            // by what the caller accepts, which is what keeps a broken asset from
            // being served as HTML.
            const deepJson = await ctx.get('/devices/some/deep/route', { headers: { accept: 'application/json' } });
            expect(deepJson.status()).toBe(404);
        } finally {
            await ctx.dispose();
        }
    });

    test('10.6 allowedHosts: a listed Host is served, an unlisted domain is refused, and unset means localhost and IP literals only', async () => {
        test.setTimeout(120_000);
        // The negative first, on the shared server whose config lists nothing.
        const shared = await rawGet(E2E_PORT, '/', { host: 'devices.example.com' });
        expect(shared.status).toBe(403);
        expect(JSON.parse(shared.body)).toEqual({
            error: 'forbidden',
            reason: 'host not allowed (possible DNS rebinding)',
        });
        expect((await rawGet(E2E_PORT, '/', { host: `localhost:${E2E_PORT}` })).status).toBe(200);
        expect((await rawGet(E2E_PORT, '/', { host: `127.0.0.1:${E2E_PORT}` })).status).toBe(200);

        // The positive needs the key in config.json at boot: a spec-owned server.
        const paths = privateServerPaths('ws-scrcpy-web-e2e-allowed-hosts', 8127);
        seedPrivateDataRoot(paths, { allowedHosts: ['devices.example.com'] });
        const handle = spawnServer(paths);
        try {
            await waitForServer(handle, paths.baseURL);

            // Listed: the document GET is served and mints the token; the sensitive
            // API then answers with the cookie and the same Host.
            const doc = await rawGet(paths.port, '/', { host: 'devices.example.com' });
            expect(doc.status).toBe(200);
            expect(doc.body).toContain(`<title>${APP_TITLE}</title>`);
            const cookie = setCookieFrom(doc.headers);
            expect(cookie).toContain('ws_scrcpy_token=');
            const listed = await rawGet(paths.port, '/api/service/status', { host: 'devices.example.com', cookie });
            expect(listed.status).toBe(200);
            expect((JSON.parse(listed.body) as { platform?: string }).platform).toBe(process.platform);

            // Unlisted domain, same server, same cookie: still the rebinding guard.
            const evil = await rawGet(paths.port, '/api/service/status', { host: 'evil.example.net', cookie });
            expect(evil.status).toBe(403);
            expect(JSON.parse(evil.body)).toEqual({
                error: 'forbidden',
                reason: 'host not allowed (possible DNS rebinding)',
            });
            // And the defaults still hold alongside the opt-in.
            expect((await rawGet(paths.port, '/', { host: 'localhost' })).status).toBe(200);
        } finally {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`10.6 cleanup: ${String(err)}`);
            }
        }
    });

    /** The worker's browser, for the rows that own their contexts. */
    let sharedBrowser: Browser;
    test.beforeAll(async ({ browser }) => {
        sharedBrowser = browser;
    });
    async function browserOf(): Promise<Browser> {
        return sharedBrowser;
    }
});
