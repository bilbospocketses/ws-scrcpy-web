import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, request, test } from '@playwright/test';
import { e2eBaseUrl, mintToken, SID_SET_COOKIE_RE, TOKEN_SET_COOKIE_RE } from './support/auth';
import { holdPort, isListening, releasePort } from './support/ports';
import {
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopQuietly,
    waitForDependencies,
    waitForServer,
    withoutInheritedOverrides,
    withTimeout,
} from './support/privateServer';
import {
    cookiePair,
    json,
    lanAddress,
    type RawResponse,
    raw,
    setCookieNamed,
    TOKEN_REFUSAL,
    tokenCookieFor,
    wsHandshake,
} from './support/rawHttp';
import { countOccurrences, LOG_REL, logOffset, logSince, readServerLog } from './support/serverLog';

/**
 * Item 164, batch A: the server and API surface rows the coverage register
 * listed as "automatable: no spec yet" — 1.12, 1.14, 3.9, 7.9, 9.8, 10.12,
 * 10.13, 10.17 and 10.18 (12.9 and 10.14 are `config-overrides.spec.ts`).
 *
 * 3.9, 7.9 and 9.8 are request-level and change nothing, so they run on the
 * shared server. Everything that reads the server log, restarts or stops a
 * server, corrupts its store or locks it runs on a server of its own, on ports
 * 8151–8157, under a data root named `ws-scrcpy-web-e2e-164a-*`.
 */

/** The shared server's port, from the same URL every other spec uses. */
function sharedPort(): number {
    return Number(new URL(e2eBaseUrl()).port);
}

function repoVersion(): string {
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    return (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
}

/**
 * The three good address forms of 7.9 — a bare host, host:port and a bracketed
 * IPv6 literal. None names anything that listens: the host is under `.invalid`
 * (RFC 6761, never resolves) and the port is in this batch's own range, with no
 * server up while these rows run.
 */
const GOOD_ADDRESSES = ['e2e-164a.invalid', '127.0.0.1:8159', '[::1]:8159'];

function expectJson(res: RawResponse, status: number, body: unknown, what: string): void {
    expect(res.status, `${what}: ${res.body}`).toBe(status);
    expect(json(res), what).toEqual(body);
}

test.describe('server and API surface (item 164, batch A)', () => {
    test('1.12 a busy web port moves to the next free one: bound, persisted, reported as shifted, shown on the page, logged', async ({
        browser,
    }) => {
        test.setTimeout(120_000);
        const configured = 8151;
        const next = 8152;
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-busy-port', configured);
        seedPrivateDataRoot(paths);
        expect(await isListening(next), `precondition: ${next} must be free`).toBe(false);
        // Another program holds the configured port. No WS_SCRCPY_WEB_PORT: that
        // override is exact and never walks forward (12.6 / 12.9), so with it set
        // this row would test the opposite rule.
        const blocker = await holdPort(configured);
        const handle = spawnServer(paths, { env: withoutInheritedOverrides(), portOverride: false });
        const shiftedURL = `http://localhost:${next}`;
        try {
            await waitForServer(handle, shiftedURL);

            // Persisted: config.json now names the port this boot serves.
            const file = JSON.parse(readFileSync(paths.configPath, 'utf8')) as { webPort?: number };
            expect(file.webPort).toBe(next);

            // Reported as a shift, not as a chosen port.
            const ctx = await request.newContext({ baseURL: shiftedURL });
            try {
                const res = await ctx.get('/api/config');
                expect(res.status()).toBe(200);
                const envelope = (await res.json()) as {
                    config: { webPort: number };
                    runtime: { webPort: number; portWasAutoShifted: boolean };
                };
                expect(envelope.config.webPort).toBe(next);
                expect(envelope.runtime.webPort).toBe(next);
                expect(envelope.runtime.portWasAutoShifted).toBe(true);
            } finally {
                await ctx.dispose();
            }

            // Logged in the row's words.
            await expect
                .poll(() => readServerLog(paths), { message: 'the auto-shift line' })
                .toContain(`webPort ${configured} busy; auto-shifted to ${next}`);

            // The page's own URL shows the new port, and nothing on the page
            // announces the move. A fresh store has no bookmark dismissal, so the
            // reminder card is up; firstRunComplete is seeded, so the welcome
            // modal is not (and no browser tab is opened on the developer's desktop).
            const context = await browser.newContext({ baseURL: shiftedURL });
            try {
                const page = await context.newPage();
                await page.goto('/');
                const card = page.locator('.bookmark-reminder');
                await expect(card).toBeVisible();
                const link = card.locator('a');
                await expect(link).toHaveText(shiftedURL);
                await expect(link).toHaveAttribute('href', shiftedURL);
                const text = await page.locator('body').innerText();
                expect(text).not.toContain(String(configured));
                expect(text).not.toMatch(/shift|busy|in use|port changed/i);
            } finally {
                await context.close();
            }
        } finally {
            await stopQuietly(handle, '1.12');
            await releasePort(blocker);
        }
    });

    test('1.14 with no xdg-open on the host the failed browser open is logged and the server keeps serving', async () => {
        test.skip(
            process.platform !== 'linux',
            '[Linux] row: the first-run browser open goes through xdg-open only on Linux (Windows uses cmd.exe start)',
        );
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-no-xdg-open', 8153);
        // firstRunComplete:false with no launcher in the environment is the one
        // state in which a hand-run server opens a tab itself (shouldAutoOpenBrowser).
        seedPrivateDataRoot(paths, { firstRunComplete: false });

        // "No xdg-open reachable", from the app's point of view. resolveSystemTool
        // probes /usr/bin, /bin, /usr/sbin and /sbin with fs.existsSync and then
        // falls back to the bare name through PATH. The CI runner has
        // /usr/bin/xdg-open and the tier cannot remove a system file, so a
        // preload hides it from those probes and PATH loses every directory that
        // holds one: the spawn then fails with ENOENT exactly as on a host
        // without xdg-utils. Nothing in the app is patched; only what it sees.
        const preload = path.join(paths.programData, 'hide-xdg-open.cjs');
        writeFileSync(
            preload,
            [
                "'use strict';",
                "const fs = require('fs');",
                "const path = require('path');",
                'const realExistsSync = fs.existsSync;',
                'fs.existsSync = function existsSync(p) {',
                "    if (typeof p === 'string' && path.basename(p) === 'xdg-open') return false;",
                '    return realExistsSync.apply(fs, arguments);',
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        const pathWithoutXdgOpen = (process.env['PATH'] ?? '')
            .split(path.delimiter)
            .filter((dir) => dir.length > 0 && !existsSync(path.join(dir, 'xdg-open')))
            .join(path.delimiter);

        const handle = spawnServer(paths, {
            env: withoutInheritedOverrides({
                NODE_OPTIONS: `--require ${preload}`,
                PATH: pathWithoutXdgOpen,
                // The open ATTEMPT is this row's subject, so the harness's
                // suppression comes off; with xdg-open hidden, no tab can open.
                WS_SCRCPY_NO_BROWSER: undefined,
            }),
        });
        try {
            await waitForServer(handle, paths.baseURL);
            const failure = `browser open failed for http://localhost:${paths.port} (best-effort):`;
            await expect
                .poll(() => readServerLog(paths), { message: 'the failed browser open is logged', timeout: 30_000 })
                .toContain(failure);
            const line = readServerLog(paths)
                .split(/\r?\n/)
                .find((l) => l.includes(failure));
            expect(line, 'the failure names the missing opener').toMatch(/ENOENT/);

            // Still up and still serving, after the failure was handled.
            expect(handle.child.exitCode, handle.output()).toBeNull();
            const ctx = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(ctx);
                const cfg = await ctx.get('/api/config');
                expect(cfg.status()).toBe(200);
                expect(((await cfg.json()) as { config: { webPort: number } }).config.webPort).toBe(paths.port);
            } finally {
                await ctx.dispose();
            }
            expect(readServerLog(paths)).not.toMatch(/Uncaught exception|Unhandled rejection/);
            expect(handle.child.exitCode, handle.output()).toBeNull();
        } finally {
            await stopQuietly(handle, '1.14');
        }
    });

    test('3.9 /api/whoami answers this machine with its identity and no token; POST is gated, and 405 once it carries the token', async () => {
        const port = sharedPort();
        const host = `localhost:${port}`;

        const who = await raw({ port, path: '/api/whoami', headers: { host } });
        expect(who.status, who.body).toBe(200);
        const body = json(who) as { app: string; pid: number; installMode: string; version: string };
        expect(Object.keys(body).sort()).toEqual(['app', 'installMode', 'pid', 'version']);
        expect(body.app).toBe('ws-scrcpy-web');
        expect(Number.isInteger(body.pid) && body.pid > 0).toBe(true);
        expect(body.pid).not.toBe(process.pid);
        expect(body.installMode).toBe('user');
        expect(body.version).toBe(repoVersion());

        // POST with no cookie: the request gate runs first (only GET is exempt).
        expectJson(
            await raw({ port, path: '/api/whoami', method: 'POST', headers: { host } }),
            403,
            TOKEN_REFUSAL,
            'POST /api/whoami, no cookie',
        );
        // POST with the page's token cookie reaches the handler, which allows GET only.
        const cookie = await tokenCookieFor(port);
        expectJson(
            await raw({ port, path: '/api/whoami', method: 'POST', headers: { host, cookie } }),
            405,
            { error: 'method not allowed' },
            'POST /api/whoami, with the token',
        );
    });

    test('3.9 /api/whoami asked from the LAN address of this machine (not loopback) answers 403, while a token-exempt route there still serves', async () => {
        const lan = lanAddress() ?? '';
        test.skip(!lan, 'no non-loopback IPv4 interface on this host to call from');
        const port = sharedPort();
        const host = `${lan}:${port}`;
        // The off-box half of the row, without a second machine: a request to
        // this host's own LAN address arrives FROM that address, so the
        // server's isLoopback(remoteAddress) is false — the same test another
        // machine fails.
        expectJson(
            await raw({ host: lan, port, path: '/api/whoami', headers: { host } }),
            403,
            { error: 'this endpoint answers this machine only' },
            'GET /api/whoami via the LAN address',
        );
        // Control: the same path to the same server serves a token-exempt route,
        // so the 403 above is whoami's own refusal and not a network failure.
        const cfg = await raw({ host: lan, port, path: '/api/config', headers: { host } });
        expect(cfg.status, cfg.body).toBe(200);
        expect((json(cfg) as { config: { webPort: number } }).config.webPort).toBe(port);
    });

    test('7.9 connect and disconnect refuse -H, host:port;rm and an empty address with 400 before adb, and the three good forms pass validation', async () => {
        test.setTimeout(300_000);
        // The good forms reach adb; on a cold data root it may still be downloading.
        await waitForDependencies(e2eBaseUrl(), 240_000);
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(ctx);
            for (const route of ['/api/devices/connect', '/api/devices/disconnect']) {
                for (const bad of ['-H', '127.0.0.1:5555;rm']) {
                    const res = await ctx.post(route, { data: { address: bad } });
                    expect(res.status(), `${route} ${bad}`).toBe(400);
                    const text = await res.text();
                    expect(JSON.parse(text), `${route} ${bad}`).toEqual({
                        error: 'address must be a host or host:port',
                    });
                    // Nothing echoes the value: it is attacker-controlled and the
                    // caller renders the error.
                    expect(text, `${route} ${bad}`).not.toContain(bad);
                }
                // Empty is refused too, but by the presence check that precedes the
                // shape check, so its message is the presence message (see report).
                const empty = await ctx.post(route, { data: { address: '' } });
                expect(empty.status(), `${route} empty`).toBe(400);
                expect(await empty.json(), `${route} empty`).toEqual({ error: 'address is required' });
            }

            // The three good forms pass validation on both routes (what adb then
            // makes of them is not this row's subject).
            for (const route of ['/api/devices/connect', '/api/devices/disconnect']) {
                for (const address of GOOD_ADDRESSES) {
                    const res = await ctx.post(route, { data: { address } });
                    const text = await res.text();
                    expect(res.status(), `${route} ${address} must pass validation: ${text}`).not.toBe(400);
                    expect(text, `${route} ${address}`).not.toContain('address must be a host or host:port');
                }
            }
        } finally {
            await ctx.dispose();
        }
    });

    test('7.9 disconnecting an address that was never connected answers 200 not connected', async () => {
        // Finding 7.8 (reopened by this row, fixed 2026-10-05): adb 37.0.1
        // prints `error: no such device '<addr>'` AND exits 1, and the route
        // answered 500 because the exit hid the text from
        // classifyDisconnectResult. AdbClient.disconnect now hands that text on.
        test.setTimeout(300_000);
        await waitForDependencies(e2eBaseUrl(), 240_000);
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        try {
            await mintToken(ctx);
            for (const address of GOOD_ADDRESSES) {
                const res = await ctx.post('/api/devices/disconnect', { data: { address } });
                const text = await res.text();
                expect(res.status(), `disconnect ${address}: ${text}`).toBe(200);
                expect(JSON.parse(text), `disconnect ${address}`).toEqual({ success: true, message: 'not connected' });
            }
        } finally {
            await ctx.dispose();
        }
    });

    test('9.8 file deletes refuse protected roots, traversal and an unbounded list with 400 before adb; a valid list reaches adb and names each failed path', async () => {
        test.setTimeout(300_000);
        await waitForDependencies(e2eBaseUrl(), 240_000);
        const ctx = await request.newContext({ baseURL: e2eBaseUrl() });
        // A well-formed serial that no adb will ever report: nothing can be
        // deleted on any real device, whatever the route does.
        const udid = 'e2e-164a-no-such-device';
        try {
            await mintToken(ctx);
            const del = (paths: unknown) => ctx.post('/api/devices/files/delete', { data: { udid, paths } });
            const refusals: { paths: unknown; error: string }[] = [
                { paths: ['/sdcard'], error: 'refusing to delete a protected root: /sdcard' },
                { paths: ['/data/'], error: 'refusing to delete a protected root: /data' },
                {
                    paths: ['/sdcard/Download/../../data'],
                    error: 'path may not contain "." or ".." segments: "/sdcard/Download/../../data"',
                },
                {
                    paths: Array.from({ length: 1001 }, (_, i) => `/sdcard/Download/e2e-164a-${i}.txt`),
                    error: 'too many paths: 1001 (max 1000)',
                },
                // One bad entry refuses the whole list: nothing in it is deleted.
                {
                    paths: ['/sdcard/Download/e2e-164a-ok.txt', '/sdcard'],
                    error: 'refusing to delete a protected root: /sdcard',
                },
            ];
            for (const r of refusals) {
                const res = await del(r.paths);
                const label =
                    Array.isArray(r.paths) && r.paths.length > 3 ? `${r.paths.length} paths` : JSON.stringify(r.paths);
                expect(res.status(), label).toBe(400);
                expect(await res.json(), label).toEqual({ error: r.error });
            }

            // Control: a valid list passes validation and reaches adb. With no such
            // device every delete fails, and each failure names its path — the
            // 207 shape the device tier asserts for a genuinely partial failure.
            const valid = ['/sdcard/Download/e2e-164a-a.txt', '/sdcard/Download/e2e-164a-b.txt'];
            const res = await del(valid);
            const body = (await res.json()) as { success: boolean; errors?: { path: string; error: string }[] };
            expect(res.status(), JSON.stringify(body)).toBe(207);
            expect(body.success).toBe(false);
            expect(body.errors?.map((e) => e.path)).toEqual(valid);
            for (const e of body.errors ?? []) expect(e.error.length).toBeGreaterThan(0);
        } finally {
            await ctx.dispose();
        }
    });

    test('10.12 a foreign Origin is refused even with the token, on the API and on the WebSocket (logged); without a token only five routes answer', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-gate', 8154);
        seedPrivateDataRoot(paths);
        const port = paths.port;
        const host = `localhost:${port}`;
        const handle = spawnServer(paths, { env: withoutInheritedOverrides() });
        try {
            await waitForServer(handle, paths.baseURL);
            const cookie = await tokenCookieFor(port);
            const labelBody = { serial: 'e2e-164a-probe', label: '' };

            // A non-GET API request from a foreign origin: refused even with the token.
            expectJson(
                await raw({
                    port,
                    path: '/api/devices/labels',
                    method: 'PUT',
                    headers: { host, cookie, origin: 'http://evil.test' },
                    body: labelBody,
                }),
                403,
                { error: 'forbidden', reason: 'cross-origin request rejected' },
                'PUT with Origin http://evil.test',
            );
            // Control: the same request from the app's own origin is served.
            expectJson(
                await raw({
                    port,
                    path: '/api/devices/labels',
                    method: 'PUT',
                    headers: { host, cookie, origin: `http://${host}` },
                    body: labelBody,
                }),
                200,
                { success: true },
                'PUT with the same Origin',
            );

            // The WebSocket: refused with the foreign Origin, upgraded with our own.
            const wsPath = '/?action=multiplex';
            expect(
                await wsHandshake({ port, path: wsPath, headers: { host, cookie, origin: 'http://evil.test' } }),
            ).toBe(403);
            expect(await wsHandshake({ port, path: wsPath, headers: { host, cookie, origin: `http://${host}` } })).toBe(
                101,
            );
            await expect
                .poll(() => readServerLog(paths), { message: 'the WS refusal is logged' })
                .toContain(
                    `rejected WS connection (origin="http://evil.test" host="${host}"): cross-origin request rejected`,
                );

            // Without a token, everything but the five exempt routes is the gate's
            // 403. Routes whose handler would act on this machine (the service
            // installers, the app uninstaller) are probed with GET: the gate keys on
            // the path, so it refuses them all the same, and a broken gate could
            // then only reach a 404 instead of an installer.
            const gated: [string, string][] = [
                ['PATCH', '/api/config'],
                ['GET', '/api/whoami/'],
                ['POST', '/api/whoami'],
                ['GET', '/api/capabilities'],
                ['GET', '/api/settings'],
                ['PATCH', '/api/settings'],
                ['GET', '/api/settings/device'],
                ['POST', '/api/settings/reset'],
                ['POST', '/api/settings/batch'],
                ['GET', '/api/dependencies'],
                ['POST', '/api/dependencies/check'],
                ['POST', '/api/dependencies/restart'],
                ['POST', '/api/dependencies/retry-install'],
                ['POST', '/api/devices/scan'],
                ['GET', '/api/devices/scan/subnet'],
                ['POST', '/api/devices/connect'],
                ['POST', '/api/devices/disconnect'],
                ['GET', '/api/devices/screen-state?udid=e2e-164a'],
                ['POST', '/api/devices/sleep-wake'],
                ['GET', '/api/devices/labels'],
                ['PUT', '/api/devices/labels'],
                ['POST', '/api/devices/files/delete'],
                ['POST', '/api/devices/pair/qr'],
                ['POST', '/api/devices/pair/code'],
                ['GET', '/api/devices/pair/status'],
                ['POST', '/api/devices/pair/cancel'],
                ['GET', '/api/tls/state'],
                ['POST', '/api/tls/generate'],
                ['POST', '/api/tls/revoke'],
                ['POST', '/api/tls/exposure'],
                ['POST', '/api/tls/https-port'],
                ['GET', '/api/service/status'],
                ['GET', '/api/service/install'],
                ['GET', '/api/service/uninstall'],
                ['GET', '/api/service/install-system-wide'],
                ['POST', '/api/service/decline-system-wide'],
                ['GET', '/api/service/uninstall-app'],
                ['POST', '/api/updates/check'],
                ['POST', '/api/updates/apply'],
                ['PATCH', '/api/updates/config'],
                ['GET', '/api/embed-request'],
                ['POST', '/api/embed-request/decision'],
                ['GET', '/api/embed-origins'],
                ['POST', '/api/embed-origins/revoke'],
                ['POST', '/api/auth/login'],
                ['POST', '/api/auth/logout'],
                ['GET', '/api/auth/me'],
                ['POST', '/api/auth/change-password'],
                ['POST', '/api/auth/enable'],
                ['POST', '/api/auth/disable'],
                ['GET', '/api/users'],
                ['POST', '/api/users'],
                ['PATCH', '/api/users/1'],
                ['DELETE', '/api/users/1'],
                ['GET', '/api/no-such-route'],
            ];
            for (const [method, route] of gated) {
                const res = await raw({
                    port,
                    path: route,
                    method,
                    headers: { host },
                    ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }),
                });
                expectJson(res, 403, TOKEN_REFUSAL, `${method} ${route} with no token`);
            }

            // The five that answer with no token.
            const cfg = await raw({ port, path: '/api/config', headers: { host } });
            expect(cfg.status, cfg.body).toBe(200);
            expect((json(cfg) as { config: { webPort: number } }).config.webPort).toBe(port);

            const who = await raw({ port, path: '/api/whoami', headers: { host } });
            expect(who.status, who.body).toBe(200);
            const version = (json(who) as { app: string; version: string }).version;
            expect((json(who) as { app: string }).app).toBe('ws-scrcpy-web');

            // No certificate in this private root, so the handler's own 404 — which
            // it could only send because the gate let the request through.
            expectJson(
                await raw({ port, path: '/api/tls/ca-root', headers: { host } }),
                404,
                { error: 'no certificate has been generated yet' },
                'GET /api/tls/ca-root with no token',
            );
            // The running version and nothing else.
            expectJson(
                await raw({ port, path: '/api/updates/status', headers: { host } }),
                200,
                { currentVersion: version },
                'GET /api/updates/status with no token',
            );
            // Last, because it works: 12.8's checks pass a loopback caller, and the
            // server stops cleanly.
            expectJson(
                await raw({ port, path: '/api/server/shutdown', method: 'POST', headers: { host } }),
                200,
                { ok: true },
                'POST /api/server/shutdown with no token',
            );
            const exit = await withTimeout(handle.exited, 60_000, () => `waiting for the stop:\n${handle.output()}`);
            expect(exit.code).toBe(0);
            expect(readServerLog(paths)).toContain('shutdown requested via /api/server/shutdown');
        } finally {
            await stopQuietly(handle, '10.12');
        }
    });

    test('10.13 with an approved embedder, https cookies are SameSite=None; Secure; Partitioned; plain http, no embedder and after revoking they are Strict / Lax', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-cookies', 8155);
        seedPrivateDataRoot(paths);
        const port = paths.port;
        const host = `localhost:${port}`;
        const embedder = 'http://localhost:5159';
        const admin = { username: 'e2e-164a-admin', password: 'e2e-164a-admin-pw' };
        const https = { 'x-forwarded-proto': 'https' };
        const WARN = 'frameAncestors is configured but this request is not https';
        const handle = spawnServer(paths, { env: withoutInheritedOverrides() });
        try {
            await waitForServer(handle, paths.baseURL);
            const token = await tokenCookieFor(port);

            // Both cookies need to exist, so secure the admin account: the login
            // cookie is only ever issued to a password.
            expectJson(
                await raw({
                    port,
                    path: '/api/users',
                    method: 'POST',
                    headers: { host, cookie: token },
                    body: {
                        role: 'user',
                        adminUsername: admin.username,
                        adminPassword: admin.password,
                        username: 'e2e-164a-user',
                        password: 'e2e-164a-user-pw',
                    },
                }),
                201,
                { ok: true },
                'secure the admin account',
            );

            /** The token cookie a document GET issues, and the session cookie a login issues. */
            const cookies = async (extra: Record<string, string>) => {
                const doc = await raw({ port, path: '/', headers: { host, ...extra } });
                expect(doc.status).toBe(200);
                const login = await raw({
                    port,
                    path: '/api/auth/login',
                    method: 'POST',
                    headers: { host, cookie: token, ...extra },
                    body: admin,
                });
                expect(login.status, login.body).toBe(200);
                return {
                    token: setCookieNamed(doc, 'ws_scrcpy_token') ?? '',
                    sid: setCookieNamed(login, 'wsscrcpy_sid') ?? '',
                };
            };
            const TOKEN_HTTPS_RE = /^ws_scrcpy_token=[0-9a-f]{64}; Path=\/; SameSite=Strict; HttpOnly; Secure$/;
            const SID_HTTPS_RE = /^wsscrcpy_sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/; Secure$/;

            // No embedder: site-scoped either way (https only adds Secure).
            let c = await cookies({});
            expect(c.token).toMatch(TOKEN_SET_COOKIE_RE);
            expect(c.sid).toMatch(SID_SET_COOKIE_RE);
            c = await cookies(https);
            expect(c.token).toMatch(TOKEN_HTTPS_RE);
            expect(c.sid).toMatch(SID_HTTPS_RE);
            expect(readServerLog(paths), 'no framing warning while nothing is allowed to frame').not.toContain(WARN);

            // Approve an embedder the product's way (10.10): the app asks from this
            // machine, an admin approves.
            const sid = cookiePair(c.sid);
            const ask = await raw({
                port,
                path: '/embed-request',
                method: 'POST',
                headers: { host },
                body: { origin: embedder, appName: 'e2e-164a-embedder' },
            });
            expect(ask.status, ask.body).toBe(200);
            const id = (json(ask) as { id: string }).id;
            expectJson(
                await raw({
                    port,
                    path: '/api/embed-request/decision',
                    method: 'POST',
                    headers: { host, cookie: `${token}; ${sid}` },
                    body: { id, approved: true },
                }),
                200,
                { status: 'approved', origin: embedder },
                'approve the embedder',
            );

            // Over https (X-Forwarded-Proto from loopback): both cookies cross-site.
            c = await cookies(https);
            expect(c.token).toMatch(
                /^ws_scrcpy_token=[0-9a-f]{64}; Path=\/; SameSite=None; HttpOnly; Secure; Partitioned$/,
            );
            expect(c.sid).toMatch(
                /^wsscrcpy_sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=None; Path=\/; Secure; Partitioned$/,
            );

            // Over plain http: still Strict / Lax, and the misconfiguration is
            // logged once, not per response.
            c = await cookies({});
            expect(c.token).toMatch(TOKEN_SET_COOKIE_RE);
            expect(c.sid).toMatch(SID_SET_COOKIE_RE);
            c = await cookies({});
            expect(c.token).toMatch(TOKEN_SET_COOKIE_RE);
            await expect
                .poll(() => countOccurrences(readServerLog(paths), WARN), { message: 'the framing WARN' })
                .toBe(1);
            expect(readServerLog(paths)).toMatch(new RegExp(`WARN ${WARN}`));

            // Revoke: back to site-scoped, even over https.
            expectJson(
                await raw({
                    port,
                    path: '/api/embed-origins/revoke',
                    method: 'POST',
                    headers: { host, cookie: `${token}; ${sid}` },
                    body: { origin: embedder },
                }),
                200,
                { origins: [] },
                'revoke the embedder',
            );
            c = await cookies(https);
            expect(c.token).toMatch(TOKEN_HTTPS_RE);
            expect(c.sid).toMatch(SID_HTTPS_RE);
            expect(countOccurrences(readServerLog(paths), WARN)).toBe(1);
        } finally {
            await stopQuietly(handle, '10.13');
        }
    });

    test('10.13 X-Forwarded-Proto: https from the LAN address of this machine (not loopback) changes nothing', async () => {
        const lan = lanAddress() ?? '';
        test.skip(!lan, 'no non-loopback IPv4 interface on this host to call from');
        test.setTimeout(120_000);
        const embedder = 'http://localhost:5159';
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-cookies-lan', 8155);
        // An embedder approved in config.json, so loopback https WOULD relax the cookie.
        seedPrivateDataRoot(paths, { frameAncestors: [embedder] });
        const port = paths.port;
        const handle = spawnServer(paths, { env: withoutInheritedOverrides() });
        try {
            await waitForServer(handle, paths.baseURL);
            const https = { 'x-forwarded-proto': 'https' };
            // Control: from loopback the header is trusted and the cookie relaxes.
            const local = await raw({ port, path: '/', headers: { host: `localhost:${port}`, ...https } });
            expect(setCookieNamed(local, 'ws_scrcpy_token')).toMatch(
                /^ws_scrcpy_token=[0-9a-f]{64}; Path=\/; SameSite=None; HttpOnly; Secure; Partitioned$/,
            );
            // From a non-loopback peer the same header is ignored: plain http's cookie.
            const remote = await raw({ host: lan, port, path: '/', headers: { host: `${lan}:${port}`, ...https } });
            expect(remote.status, remote.body.slice(0, 200)).toBe(200);
            expect(setCookieNamed(remote, 'ws_scrcpy_token')).toMatch(TOKEN_SET_COOKIE_RE);
        } finally {
            await stopQuietly(handle, '10.13 lan');
        }
    });

    test('10.17 a corrupt store is moved aside and restored from its backup with users and labels intact; with no backup the app starts on a fresh store', async () => {
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-corrupt-db', 8156);
        seedPrivateDataRoot(paths);
        const port = paths.port;
        const host = `localhost:${port}`;
        const admin = { username: 'e2e-164a-admin', password: 'e2e-164a-admin-pw' };
        const user = { username: 'e2e-164a-user', password: 'e2e-164a-user-pw' };
        const serial = 'e2e-164a-serial';
        const bak = `${paths.dbPath}.bak`;
        let handle: ServerHandle | undefined;

        /** A graceful stop, the way that writes wsscrcpy.db.bak. */
        const stopGracefully = async () => {
            const h = handle as ServerHandle;
            expectJson(
                await raw({ port, path: '/api/server/shutdown', method: 'POST', headers: { host } }),
                200,
                { ok: true },
                'graceful stop',
            );
            expect((await withTimeout(h.exited, 60_000, () => h.output())).code).toBe(0);
            // The stop closes the store, so SQLite has checkpointed the WAL into
            // wsscrcpy.db: the data is in the main file, not the sidecar (finding
            // 10.21 — before the fix this was a 4 KB header beside a ~119 KB -wal,
            // and junk over the main file alone was masked by the WAL).
            const wal = `${paths.dbPath}-wal`;
            expect(existsSync(wal) ? statSync(wal).size : 0, 'wsscrcpy.db-wal after a graceful stop').toBe(0);
        };
        /** Junk over the start of wsscrcpy.db, as a torn write or a bad disk would leave it. */
        const corrupt = () => {
            const junk = Buffer.alloc(4096, 0x5a);
            const db = readFileSync(paths.dbPath);
            junk.copy(db, 0);
            writeFileSync(paths.dbPath, db);
        };
        const corruptMovedAside = () => readdirSync(paths.dataRoot).filter((f) => /^wsscrcpy\.db\.corrupt-/.test(f));

        try {
            handle = spawnServer(paths, { env: withoutInheritedOverrides() });
            await waitForServer(handle, paths.baseURL);
            const token = await tokenCookieFor(port);
            expectJson(
                await raw({
                    port,
                    path: '/api/users',
                    method: 'POST',
                    headers: { host, cookie: token },
                    body: { role: 'user', adminUsername: admin.username, adminPassword: admin.password, ...user },
                }),
                201,
                { ok: true },
                'secure the admin account and add a user',
            );
            const login = async (cookie: string) => {
                const res = await raw({
                    port,
                    path: '/api/auth/login',
                    method: 'POST',
                    headers: { host, cookie },
                    body: admin,
                });
                expect(res.status, res.body).toBe(200);
                return `${cookie}; ${cookiePair(setCookieNamed(res, 'wsscrcpy_sid'))}`;
            };
            let session = await login(token);
            expectJson(
                await raw({
                    port,
                    path: '/api/devices/labels',
                    method: 'PUT',
                    headers: { host, cookie: session },
                    body: { serial, label: 'kept-164a' },
                }),
                200,
                { success: true },
                'set a device label',
            );
            await stopGracefully();
            expect(existsSync(bak), 'a graceful stop writes wsscrcpy.db.bak').toBe(true);

            // Case 1: corrupt, with the backup present.
            corrupt();
            const offset1 = logOffset(paths);
            handle = spawnServer(paths, { env: withoutInheritedOverrides() });
            await waitForServer(handle, paths.baseURL);
            const boot1 = logSince(paths, offset1);
            expect(boot1).toContain('restored wsscrcpy.db from wsscrcpy.db.bak');
            expect(corruptMovedAside().length, readdirSync(paths.dataRoot).join(', ')).toBeGreaterThanOrEqual(1);
            session = await login(await tokenCookieFor(port));
            const users = await raw({ port, path: '/api/users', headers: { host, cookie: session } });
            expect(users.status, users.body).toBe(200);
            const names = (json(users) as { users: { username: string; role: string }[] }).users
                .map((u) => `${u.username}:${u.role}`)
                .sort();
            expect(names).toEqual([`${admin.username}:admin`, `${user.username}:user`]);
            const labels = await raw({ port, path: '/api/devices/labels', headers: { host, cookie: session } });
            expect(labels.status, labels.body).toBe(200);
            expect(json(labels)).toEqual({ [serial]: 'kept-164a' });
            const me = await raw({ port, path: '/api/auth/me', headers: { host, cookie: session } });
            expect((json(me) as { authEnabled: boolean }).authEnabled).toBe(true);

            // Case 2: the same, with the backup deleted first.
            await stopGracefully();
            rmSync(bak, { force: true });
            corrupt();
            const before = corruptMovedAside().length;
            const offset2 = logOffset(paths);
            handle = spawnServer(paths, { env: withoutInheritedOverrides() });
            await waitForServer(handle, paths.baseURL);
            const boot2 = logSince(paths, offset2);
            expect(boot2).toContain('wsscrcpy.db unusable');
            expect(boot2).not.toContain('restored wsscrcpy.db');
            expect(corruptMovedAside().length).toBeGreaterThan(before);
            const fresh = await tokenCookieFor(port);
            const freshMe = await raw({ port, path: '/api/auth/me', headers: { host, cookie: fresh } });
            expect(freshMe.status, freshMe.body).toBe(200);
            expect((json(freshMe) as { authEnabled: boolean }).authEnabled).toBe(false);
            const freshUsers = await raw({ port, path: '/api/users', headers: { host, cookie: fresh } });
            expect(freshUsers.status, freshUsers.body).toBe(200);
            expect(
                (json(freshUsers) as { users: { id: number; username: string; hasPassword: boolean }[] }).users.map(
                    (u) => ({ id: u.id, username: u.username, hasPassword: u.hasPassword }),
                ),
            ).toEqual([{ id: 1, username: 'admin', hasPassword: false }]);
            expect(json(await raw({ port, path: '/api/devices/labels', headers: { host, cookie: fresh } }))).toEqual(
                {},
            );
        } finally {
            await stopQuietly(handle, '10.17');
        }
    });

    test('10.18 ws-scrcpy-web.log past 10 MB rotates on the next start to exactly one ws-scrcpy-web.log.1', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-log-rotation', 8157);
        seedPrivateDataRoot(paths);
        const logsDir = path.dirname(path.join(paths.dataRoot, LOG_REL));
        const live = path.join(paths.dataRoot, LOG_REL);
        const backup = `${live}.1`;
        const MAX = 10 * 1024 * 1024; // Logger.ts MAX_LOG_SIZE
        // A log pushed past 10 MB while the app was stopped, and a stale backup
        // from an earlier rotation that must be replaced, not kept beside it.
        const oldHead = 'E2E-164A OLD LOG HEAD\n';
        const filler = Buffer.alloc(MAX + 1024 - oldHead.length, 0x2e);
        mkdirSync(logsDir, { recursive: true });
        writeFileSync(live, Buffer.concat([Buffer.from(oldHead), filler]));
        writeFileSync(backup, 'E2E-164A STALE BACKUP\n');
        const oldSize = statSync(live).size;
        expect(oldSize).toBeGreaterThan(MAX);

        const handle = spawnServer(paths, { env: withoutInheritedOverrides() });
        try {
            await waitForServer(handle, paths.baseURL);
            // The old file became the single backup, whole.
            await expect.poll(() => readFileSync(backup).subarray(0, oldHead.length).toString()).toBe(oldHead);
            expect(statSync(backup).size).toBe(oldSize);
            // The live log is new and holds this boot's lines.
            const fresh = readFileSync(live, 'utf8');
            expect(fresh.startsWith(oldHead)).toBe(false);
            expect(fresh.length).toBeLessThan(MAX);
            expect(fresh).toMatch(/\[Config\] adbPath=/);
            // Exactly one backup: no .2, nothing else beside the two.
            expect(readdirSync(logsDir).sort()).toEqual(['ws-scrcpy-web.log', 'ws-scrcpy-web.log.1']);
        } finally {
            await stopQuietly(handle, '10.18');
        }
    });
});
