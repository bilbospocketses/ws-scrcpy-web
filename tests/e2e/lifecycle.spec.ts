import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { type BrowserContext, expect, request, test } from '@playwright/test';
import {
    APP_TITLE,
    dismissPromptsFor,
    mintToken,
    newVisitorContext,
    openSettings,
    openSettingsTab,
} from './support/auth';
import { E2E_PORT } from './support/paths';
import {
    privateServerPaths,
    seedPrivateDataRoot,
    spawnServer,
    stopServer,
    waitForServer,
    withTimeout,
} from './support/privateServer';
import { selfSignedCert } from './support/selfSignedCert';

/**
 * Smoke module 12 — lifecycle (rows 12.1, 12.4, 12.6).
 *
 * Every row ends a server, so each runs one the spec owns: the shared 8123
 * server has no supervisor and "stop server & exit" would end the suite with
 * it. The log the rows read is the file the server writes under its data root
 * (`logs/ws-scrcpy-web.log`) — the console echo is TTY-only and a spawned
 * child has none.
 */
const LOG_REL = path.join('logs', 'ws-scrcpy-web.log');

/** The line `exitIfNothingCanServe()` writes just before `process.exit(1)` (HttpServer.ts, #718). */
const NOTHING_SERVES = 'no listener is serving: every configured listener failed to bind';

/**
 * Hold a port the way another program would. `listen(port)` with no host binds
 * the same dual-stack wildcard the app's own `server.listen(port)` does, so
 * the collision is real on Linux and Windows alike; a blocker on 127.0.0.1
 * alone would not stop a wildcard bind on Windows.
 */
async function holdPort(port: number): Promise<net.Server> {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, () => resolve());
    });
    return blocker;
}

function release(blocker: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
}

/** GET / over HTTPS, trusting exactly the throwaway certificate: verification stays ON. */
function httpsStatus(port: number, ca: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = https.get({ host: 'localhost', port, path: '/', ca, timeout: 2_000 }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

test.describe('lifecycle (smoke §12)', () => {
    let sharedBrowser: import('@playwright/test').Browser;
    test.beforeAll(async ({ browser }) => {
        sharedBrowser = browser;
    });

    test('12.1 "stop server & exit": confirm, the page blanks to the stopped notice, the process exits 0 with the adb teardown logged, and no restart is requested', async () => {
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-stop-exit', 8128);
        seedPrivateDataRoot(paths);
        const handle = spawnServer(paths);
        let ctx: BrowserContext | undefined;
        try {
            await waitForServer(handle, paths.baseURL);
            // A fresh data root has no dismissed prompts: global-setup's PATCH lives
            // in the shared server's database. Without this the bookmark reminder
            // sits over the Settings button and swallows the click.
            const seed = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(seed);
                await dismissPromptsFor(seed);
            } finally {
                await seed.dispose();
            }
            const visitor = await newVisitorContext(sharedBrowser, { baseURL: paths.baseURL });
            ctx = visitor.context;
            await expect(visitor.page).toHaveTitle(APP_TITLE);

            const settings = await openSettings(visitor.page);
            const stopBtn = (await openSettingsTab(settings, 'Server')).getByRole('button', {
                name: 'stop server & exit',
                exact: true,
            });
            await expect(stopBtn).toBeVisible();
            // Confirmation first, and cancel leaves the server running — the
            // gate in its failing direction before the affirmative path.
            await stopBtn.click();
            const confirm = visitor.page.locator('dialog.confirm-modal');
            await expect(confirm).toBeVisible();
            await expect(confirm).toContainText(
                'the app will shut down and this browser tab will try to close. any active device connections will end. continue?',
            );
            await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
            await expect(confirm).toBeHidden();
            expect((await visitor.context.request.get('/api/config')).status()).toBe(200);

            const shutdownRes = visitor.page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/server/shutdown',
            );
            await stopBtn.click();
            await expect(confirm).toBeVisible();
            await confirm.getByRole('button', { name: 'ok', exact: true }).click();
            const res = await shutdownRes;
            expect(res.status()).toBe(200);

            // "Tab self-closes or blanks to the notice": window.close() succeeds
            // on a page the automation opened, so here the tab closes; in a
            // user-opened tab the browser refuses and the notice is the fallback.
            // Accept either, and assert which one happened.
            const closed = new Promise<'closed'>((resolve) => visitor.page.once('close', () => resolve('closed')));
            const notice = visitor.page
                .getByText('app stopped — you can close this tab.')
                .waitFor({ timeout: 15_000 })
                .then(() => 'notice' as const)
                .catch(() => 'neither' as const);
            const outcome = await Promise.race([closed, notice]);
            expect(['closed', 'notice']).toContain(outcome);
            if (outcome === 'notice') {
                await expect(visitor.page.getByText('app stopped — you can close this tab.')).toBeVisible();
            } else {
                expect(visitor.page.isClosed()).toBe(true);
            }

            // The process tree exits clean: exit 0, not the restart sentinel.
            const exit = await withTimeout(
                handle.exited,
                60_000,
                () => `waiting for a clean exit:\n${handle.output()}`,
            );
            expect(exit.code).toBe(0);
            expect(existsSync(paths.restartMarkerPath), 'no .restart marker: a clean stop must not relaunch').toBe(
                false,
            );

            // The teardown is in the log, in order: the request, then adb.
            const log = readFileSync(path.join(paths.dataRoot, LOG_REL), 'utf8');
            const requested = log.indexOf('shutdown requested via /api/server/shutdown');
            const adb = log.indexOf('Stopping adb daemon (kill-server)');
            expect(requested, log.slice(-1500)).toBeGreaterThanOrEqual(0);
            expect(adb, log.slice(-1500)).toBeGreaterThan(requested);
        } finally {
            // The context may already be gone with its only page.
            try {
                if (ctx) await ctx.close();
            } catch {
                // closed by the app's own window.close()
            }
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`12.1 cleanup: ${String(err)}`);
            }
        }
    });

    test('12.4 the data-root override is honoured: config, database, dependencies and logs all land under it', async () => {
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-data-root', 8129);
        seedPrivateDataRoot(paths);
        const handle = spawnServer(paths);
        try {
            await waitForServer(handle, paths.baseURL);
            // Touch the store so the database exists, and give the log a line.
            const ctx = await newVisitorContext(sharedBrowser, { baseURL: paths.baseURL });
            try {
                await expect(ctx.page).toHaveTitle(APP_TITLE);
                expect((await ctx.context.request.get('/api/settings')).status()).toBe(200);
            } finally {
                await ctx.context.close();
            }
            // Everything the row names, under the override — and nothing under
            // the suite's own root, which proves the override was read rather than
            // the default reached for.
            for (const rel of ['config.json', 'wsscrcpy.db', 'dependencies', LOG_REL]) {
                await expect
                    .poll(() => existsSync(path.join(paths.dataRoot, rel)), { message: rel, timeout: 30_000 })
                    .toBe(true);
            }
            const log = readFileSync(path.join(paths.dataRoot, LOG_REL), 'utf8');
            expect(log.length).toBeGreaterThan(0);
            // And the server read ITS config from under the override — the port it
            // serves is the one seeded there, not the suite's default.
            const served = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(served);
                const cfg = (await (await served.get('/api/config')).json()) as { config: { webPort?: number } };
                expect(cfg.config.webPort).toBe(paths.port);
                expect(paths.port).not.toBe(E2E_PORT);
            } finally {
                await served.dispose();
            }
        } finally {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`12.4 cleanup: ${String(err)}`);
            }
        }
    });

    // Row 12.6 (#718). The server must EXIT when no listener can bind, and must
    // NOT exit while one still can. Every case pins the first listener's port
    // with WS_SCRCPY_WEB_PORT (spawnServer sets it to `paths.port`), which makes
    // reconcileWebPort demand that exact port instead of walking forward to a
    // free one. Without that, a busy port is auto-shifted and never fails.
    //
    // The two-listener cases use config.json's advanced `server` array: it
    // is the only way to choose which listener is started first, and the row
    // asks for both orders because #718's bug existed in one order only.

    test('12.6 HTTP only: with its port held by another program the server exits 1 and says why', async () => {
        test.setTimeout(150_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-no-listener-http', 8133);
        seedPrivateDataRoot(paths);
        const blocker = await holdPort(paths.port);
        const handle = spawnServer(paths);
        try {
            const exit = await withTimeout(handle.exited, 120_000, () => `waiting for the exit:\n${handle.output()}`);
            expect(exit.code, handle.output()).toBe(1);
            const log = readFileSync(path.join(paths.dataRoot, LOG_REL), 'utf8');
            expect(log, log.slice(-1500)).toContain(`HTTP listener on port ${paths.port} failed to bind (EADDRINUSE)`);
            expect(log, log.slice(-1500)).toContain(NOTHING_SERVES);
        } finally {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`12.6 cleanup: ${String(err)}`);
            }
            await release(blocker);
        }
    });

    for (const order of ['http-first', 'https-first'] as const) {
        test(`12.6 both listeners refused (${order}): the server exits 1, and both failures are named in that order`, async () => {
            test.setTimeout(150_000);
            const [plainPort, securePort] = order === 'http-first' ? [8134, 8135] : [8137, 8136];
            const tls = selfSignedCert();
            const plain = { secure: false, port: plainPort };
            const secure = { secure: true, port: securePort, options: { cert: tls.cert, key: tls.key } };
            const servers = order === 'http-first' ? [plain, secure] : [secure, plain];
            const paths = privateServerPaths(`ws-scrcpy-web-e2e-no-listener-${order}`, servers[0]!.port);
            seedPrivateDataRoot(paths, { server: servers });
            const blockers = [await holdPort(plainPort), await holdPort(securePort)];
            const handle = spawnServer(paths);
            try {
                const exit = await withTimeout(
                    handle.exited,
                    120_000,
                    () => `waiting for the exit:\n${handle.output()}`,
                );
                expect(exit.code, handle.output()).toBe(1);
                const log = readFileSync(path.join(paths.dataRoot, LOG_REL), 'utf8');
                const http = log.indexOf(`HTTP listener on port ${plainPort} failed to bind (EADDRINUSE)`);
                const tlsFail = log.indexOf(`HTTPS listener on port ${securePort} failed to bind (EADDRINUSE)`);
                const exitLine = log.indexOf(NOTHING_SERVES);
                expect(http, log.slice(-2000)).toBeGreaterThanOrEqual(0);
                expect(tlsFail, log.slice(-2000)).toBeGreaterThanOrEqual(0);
                // The order is the point of the row: it proves this case drove the
                // branch it names, and the exit line comes after the LAST failure.
                const [first, last] = order === 'http-first' ? [http, tlsFail] : [tlsFail, http];
                expect(first, log.slice(-2000)).toBeLessThan(last);
                expect(exitLine, log.slice(-2000)).toBeGreaterThan(last);
            } finally {
                try {
                    await stopServer(handle);
                } catch (err) {
                    console.warn(`12.6 cleanup: ${String(err)}`);
                }
                for (const b of blockers) await release(b);
            }
        });
    }

    test('12.6 one listener still binds: HTTP refused, HTTPS serves, and the server stays up', async () => {
        test.setTimeout(150_000);
        const [plainPort, securePort] = [8138, 8139];
        const tls = selfSignedCert();
        const paths = privateServerPaths('ws-scrcpy-web-e2e-no-listener-degrade', plainPort);
        seedPrivateDataRoot(paths, {
            server: [
                { secure: false, port: plainPort },
                { secure: true, port: securePort, options: { cert: tls.cert, key: tls.key } },
            ],
        });
        const blocker = await holdPort(plainPort);
        const handle = spawnServer(paths);
        try {
            // Serving over the listener that DID bind, verified against the cert.
            await expect
                .poll(() => httpsStatus(securePort, tls.cert).catch(() => 0), {
                    message: `HTTPS on ${securePort} never served:\n${handle.output()}`,
                    timeout: 90_000,
                })
                .toBe(200);
            const logPath = path.join(paths.dataRoot, LOG_REL);
            await expect
                .poll(
                    () =>
                        existsSync(logPath) &&
                        readFileSync(logPath, 'utf8').includes(`HTTP listener on port ${plainPort} failed to bind`),
                    {
                        message: 'the refused HTTP listener is logged by name',
                        timeout: 30_000,
                    },
                )
                .toBe(true);
            // Degrade, never exit: still alive after the failure has been handled.
            await new Promise((r) => setTimeout(r, 3_000));
            expect(handle.child.exitCode, handle.output()).toBeNull();
            expect(readFileSync(logPath, 'utf8')).not.toContain(NOTHING_SERVES);
            expect(await httpsStatus(securePort, tls.cert)).toBe(200);
        } finally {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`12.6 cleanup: ${String(err)}`);
            }
            await release(blocker);
        }
    });
});
