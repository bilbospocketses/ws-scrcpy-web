import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { type BrowserContext, expect, request, test } from '@playwright/test';
import {
    APP_TITLE,
    dismissPromptsFor,
    fetchFromPage,
    mintToken,
    newVisitorContext,
    openSettings,
    openSettingsTab,
    settingsRow,
    tokenCookie,
} from './support/auth';
import { E2E_PORT } from './support/paths';
import { holdPort, releasePort } from './support/ports';
import {
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    sharedDependencies,
    spawnServer,
    stopQuietly,
    stopServer,
    waitForServer,
    withoutInheritedOverrides,
    withTimeout,
} from './support/privateServer';
import { json, lanAddress, raw } from './support/rawHttp';
import { selfSignedCert } from './support/selfSignedCert';
import { countOccurrences, LOG_REL, logOffset, logSince, NOTHING_SERVES, readServerLog } from './support/serverLog';
import { typeAndLeave } from './support/settingsUi';

/**
 * Smoke module 12 — lifecycle (rows 12.1, 12.4, 12.6, 12.10's double signal on
 * Linux, and 12.13's app half).
 *
 * Every row ends a server, so each runs one the spec owns: the shared 8123
 * server has no supervisor and "stop server & exit" would end the suite with
 * it. The log the rows read is the file the server writes under its data root
 * (`logs/ws-scrcpy-web.log`) — the console echo is TTY-only and a spawned
 * child has none.
 *
 * 12.13 (restart server, item 24) plays the supervisor: the launcher and Servy
 * restart the app on exit 75, and here the test boots the same root again on
 * the same port. The real supervisors, and "no second browser tab", stay on the
 * Windows guest. Ports 8243 (the restart) and 8244 (off-box).
 */

/** Copied app text, never imported from src/ (the suite's rule); each names its source. */
// src/app/client/settings/tabs/ServerTab.ts RESTARTING_MESSAGE (U+2026).
const RESTARTING_MESSAGE = 'restarting the server… this page will reload once it is back.';
// ServerTab.ts restartConfirmMessage(false).
const RESTART_CONFIRM =
    'the server will restart and this page will reload once it is back. any active device connections will end. continue?';
// ServerTab.ts restartConfirmMessage(true): an edit staged and not saved is named first.
const RESTART_CONFIRM_UNSAVED = `your unsaved settings changes will be lost. ${RESTART_CONFIRM}`;
// src/app/client/adminGate.ts ADMIN_UNREACHABLE_NOTE.
const ADMIN_UNREACHABLE_NOTE = 'admin changes are limited to the machine running the server.';
// src/common/remoteAdmin.ts OPERATOR_REFUSAL_ERROR, the body of requireOperator's 403.
const OPERATOR_REFUSAL = { error: 'admin actions are limited to this machine' };
// src/server/api/ServerRestartApi.ts.
const RESTART_LOGGED = 'restart requested via /api/server/restart';

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
            // The OPEN confirm only: a cancelled one stays in the DOM for its
            // 250 ms exit transition (src/app/ui/Modal.ts), and the second click
            // below reopens the dialog inside that window.
            const confirm = visitor.page.locator('dialog.confirm-modal[open]');
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
            await releasePort(blocker);
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
                for (const b of blockers) await releasePort(b);
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
            await releasePort(blocker);
        }
    });

    // POSIX signals: on Windows the harness can only TerminateProcess the child.
    test('12.10 one Ctrl+C is two signals (SIGINT, then the launcher SIGTERM): the repeat is ignored, the stop finishes and writes the backup, exit 0', async () => {
        test.skip(process.platform === 'win32', 'Windows has no SIGINT/SIGTERM to deliver to a child process');
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-double-signal', 8142);
        seedPrivateDataRoot(paths);
        const handle = spawnServer(paths);
        const bak = `${paths.dbPath}.bak`;
        try {
            await waitForServer(handle, paths.baseURL);
            const offset = logOffset(paths);
            const pid = handle.child.pid as number;
            const signalledAt = Date.now();
            // What a terminal Ctrl+C under the launcher delivers: the terminal's
            // SIGINT to the process group, and the launcher's SIGTERM
            // (launcher/src/supervisor.rs wait_with_signal) a moment later.
            process.kill(pid, 'SIGINT');
            await new Promise((r) => setTimeout(r, 50));
            process.kill(pid, 'SIGTERM');

            const exit = await withTimeout(handle.exited, 60_000, () => `waiting for the exit:\n${handle.output()}`);
            expect(exit, handle.output()).toEqual({ code: 0, signal: null });

            const log = logSince(paths, offset);
            expect(log).toContain('Received signal SIGINT');
            expect(log).toContain('Received signal SIGTERM');
            expect(log).toMatch(/Ignoring SIGTERM \d+ms after the first signal: graceful shutdown is already running/);
            expect(log, 'the repeat must not force the exit').not.toContain('Force exit');
            expect(log).toContain('Stopping adb daemon (kill-server)');
            // The backup is the teardown's LAST step, so a fresh one proves the stop ran to the end.
            expect(existsSync(bak), 'the graceful stop writes wsscrcpy.db.bak').toBe(true);
            expect(statSync(bak).mtimeMs, 'wsscrcpy.db.bak was written by this stop').toBeGreaterThanOrEqual(
                signalledAt - 2_000,
            );
        } finally {
            try {
                await stopServer(handle);
            } catch (err) {
                console.warn(`12.10 cleanup: ${String(err)}`);
            }
        }
    });

    test('12.13 restart server: the first Application row; cancel sends nothing; confirm exits 75 with the .restart marker, shows the overlay, and the page reloads onto a new instance token on the same port', async () => {
        test.setTimeout(300_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-restart-server', 8243);
        seedPrivateDataRoot(paths);
        // Nothing in this row installs a dependency: both boots run from the fast tier's.
        const spawnOptions = { env: withoutInheritedOverrides(), dependenciesPath: await sharedDependencies() };
        const handles: ServerHandle[] = [spawnServer(paths, spawnOptions)];
        let ctx: BrowserContext | undefined;
        try {
            await waitForServer(handles[0]!, paths.baseURL);
            const seed = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(seed);
                await dismissPromptsFor(seed);
            } finally {
                await seed.dispose();
            }
            // The context is built here, not with newVisitorContext, so the
            // device list's socket can be held open before the first load. On '/'
            // that socket (BaseDeviceTracker) closes when the old process exits,
            // probes the token and reloads the page on its own; mocked, it never
            // closes, so ServerTab's own wait for the new process is the only
            // thing left that can reload the page, and that wait is what this
            // row measures.
            ctx = await sharedBrowser.newContext({ baseURL: paths.baseURL });
            await ctx.routeWebSocket(/.*/, () => {});
            const page = await ctx.newPage();
            await page.goto('/');
            await expect(page).toHaveTitle(APP_TITLE);
            const tokenBefore = (await tokenCookie(ctx, paths.baseURL))?.value ?? '';
            expect(tokenBefore).toMatch(/^[0-9a-f]{64}$/);

            const settings = await openSettings(page);
            const server = await openSettingsTab(settings, 'Server');
            // The row: first in the Application card, one enabled button.
            const heading = server.locator('h4.settings-card-heading').filter({ hasText: /^Application$/ });
            await expect(heading).toBeVisible();
            const card = heading.locator('xpath=following-sibling::*[1]');
            await expect(card.locator('.settings-label').first()).toHaveText('restart the server');
            const restartBtn = server.getByRole('button', { name: 'restart server', exact: true });
            await expect(restartBtn).toHaveCount(1);
            await expect(restartBtn).toBeEnabled();

            // Every request that could change anything, from the first click on
            // (GETs are the page's own pollers), and anything on the restart route.
            const sent: string[] = [];
            page.on('request', (r) => {
                const method = r.method().toUpperCase();
                const route = new URL(r.url()).pathname;
                if (!['GET', 'HEAD', 'OPTIONS'].includes(method) || route === '/api/server/restart') {
                    sent.push(`${method} ${route}`);
                }
            });

            // Cancel first: the gate in its failing direction. The OPEN confirm
            // only, as 12.1 says why.
            const confirm = page.locator('dialog.confirm-modal[open]');
            await restartBtn.click();
            await expect(confirm).toBeVisible();
            await expect(confirm).toContainText('restart server');
            await expect(confirm).toContainText(RESTART_CONFIRM);
            await expect(confirm).not.toContainText('unsaved');
            await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
            await expect(confirm).toBeHidden();

            // With an http port edit staged and not saved, the confirm first says
            // the reload throws it away. Cancel again, then put the port back so
            // nothing is staged when the restart goes ahead.
            const portInput = settingsRow(server, 'http port').locator('input');
            await expect(portInput).toHaveValue(String(paths.port));
            await typeAndLeave(portInput, String(paths.port + 1));
            await restartBtn.click();
            await expect(confirm).toBeVisible();
            await expect(confirm).toContainText(RESTART_CONFIRM_UNSAVED);
            await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
            await expect(confirm).toBeHidden();
            await typeAndLeave(portInput, String(paths.port));

            expect((await ctx.request.get('/api/config')).status()).toBe(200);
            expect(handles[0]!.child.exitCode, handles[0]!.output()).toBeNull();
            await expect(restartBtn).toBeEnabled();
            await expect(restartBtn).toHaveText('restart server');
            expect(sent, 'a cancel sent a request').toEqual([]);

            const posted = page.waitForResponse(
                (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/server/restart',
            );
            await restartBtn.click();
            await expect(confirm).toBeVisible();
            await expect(confirm).toContainText(RESTART_CONFIRM);
            await expect(confirm, 'the port was put back: nothing is staged').not.toContainText('unsaved');
            // Main-frame navigations from the ok click on: the reload, and only it.
            let navigations = 0;
            page.on('framenavigated', (frame) => {
                if (frame === page.mainFrame()) navigations++;
            });
            await confirm.getByRole('button', { name: 'ok', exact: true }).click();
            const res = await posted;
            expect(res.status()).toBe(200);
            expect(await res.json()).toEqual({ ok: true });
            await expect(page.locator('[data-restarting-overlay] p[role="status"]')).toHaveText(RESTARTING_MESSAGE);

            // Exit 75 and the marker: the restart signal every supervisor reads.
            const first = handles[0]!;
            const exit = await withTimeout(first.exited, 30_000, () => `waiting for exit 75:\n${first.output()}`);
            expect(exit.code, first.output()).toBe(75);
            expect(readFileSync(paths.restartMarkerPath, 'utf8')).toMatch(/^restart-requested-\d+$/);
            // Neither cancel sent anything: the one request is the confirmed POST,
            // and the server logged exactly one restart request.
            expect(sent).toEqual(['POST /api/server/restart']);
            expect(countOccurrences(readServerLog(paths), RESTART_LOGGED)).toBe(1);
            // Nothing reloaded onto the old process in its exit window.
            expect(navigations, 'no reload before the new process is up').toBe(0);

            // The supervisor's part: it consumes the marker and boots the same root
            // on the same port. With the device list's socket held open, the load
            // below can only be ServerTab's reload, which waits for the NEW process
            // to refuse the page's old token (waitForServerRestart).
            unlinkSync(paths.restartMarkerPath);
            const reloaded = page.waitForEvent('load', { timeout: 90_000 });
            handles.push(spawnServer(paths, spawnOptions));
            await waitForServer(handles[1]!, paths.baseURL);
            await reloaded;
            expect(new URL(page.url()).port).toBe(String(paths.port));
            await expect(page.locator('[data-restarting-overlay]')).toHaveCount(0);
            await expect(page).toHaveTitle(APP_TITLE);
            const tokenAfter = (await tokenCookie(ctx, paths.baseURL))?.value ?? '';
            expect(tokenAfter).toMatch(/^[0-9a-f]{64}$/);
            expect(tokenAfter, 'a NEW instance token: a new server process').not.toBe(tokenBefore);
            // The reloaded page's own token-gated request is answered, by the new process.
            expect((await fetchFromPage(page, '/api/auth/me')).status).toBe(200);
            const who = await raw({
                port: paths.port,
                path: '/api/whoami',
                headers: { host: `localhost:${paths.port}` },
            });
            expect((json(who) as { pid: number }).pid).toBe(handles[1]!.child.pid);
            expect(navigations, 'exactly one reload').toBe(1);
            expect(sent.filter((s) => s === 'POST /api/server/restart')).toHaveLength(1);
        } finally {
            try {
                if (ctx) await ctx.close();
            } catch {
                // already closed
            }
            for (const handle of handles) await stopQuietly(handle, '12.13');
        }
    });

    test('12.13 off-box with remote admin off: the Application card is hidden with the note in its place, and POST /api/server/restart answers 403', async () => {
        const lan = lanAddress() ?? '';
        test.skip(!lan, 'no non-loopback IPv4 interface on this host to call from');
        test.setTimeout(270_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-restart-server-offbox', 8244);
        seedPrivateDataRoot(paths);
        // withoutInheritedOverrides removes WS_SCRCPY_ALLOW_REMOTE_ADMIN: a runner
        // exporting it would let the POST below restart the server.
        const handle = spawnServer(paths, {
            env: withoutInheritedOverrides(),
            dependenciesPath: await sharedDependencies(),
        });
        let ctx: BrowserContext | undefined;
        try {
            await waitForServer(handle, paths.baseURL);
            const seed = await request.newContext({ baseURL: paths.baseURL });
            try {
                await mintToken(seed);
                // Open mode has one user, so the dismissal follows it off-box too.
                await dismissPromptsFor(seed);
            } finally {
                await seed.dispose();
            }
            // Another machine, without a second one: a request to this host's own
            // LAN address arrives FROM that address, so isLoopback is false.
            const visitor = await newVisitorContext(sharedBrowser, { baseURL: `http://${lan}:${paths.port}` });
            ctx = visitor.context;
            const page = visitor.page;
            await expect(page).toHaveTitle(APP_TITLE);
            const cfg = await fetchFromPage(page, '/api/config');
            expect(cfg.status).toBe(200);
            expect((cfg.body as { runtime: { adminScope: string; callerIsLocal: boolean } }).runtime).toMatchObject({
                adminScope: 'local',
                callerIsLocal: false,
            });

            const settings = await openSettings(page);
            const server = await openSettingsTab(settings, 'Server');
            // Hidden, never absent (applyAdminUnreachable): the button disabled under it.
            const heading = server.locator('h4.settings-card-heading').filter({ hasText: /^Application$/ });
            await expect(heading).toHaveCount(1);
            await expect(heading).toBeHidden();
            const restartBtn = server.locator('button[data-action="restart-server"]');
            await expect(restartBtn).toHaveCount(1);
            await expect(restartBtn).toBeHidden();
            await expect(restartBtn).toBeDisabled();
            const note = server.locator('[data-admin-unreachable-note]').filter({ visible: true });
            await expect(note).toHaveCount(1);
            await expect(note).toHaveText(ADMIN_UNREACHABLE_NOTE);

            // A direct POST from that page: the token and the page's own Origin
            // pass the gate, so requireOperator is what answers.
            const refused = await fetchFromPage(page, '/api/server/restart', { method: 'POST' });
            expect(refused.status, JSON.stringify(refused.body)).toBe(403);
            expect(refused.body).toEqual(OPERATOR_REFUSAL);
            // Refused before the handler logs or schedules anything.
            expect(readServerLog(paths)).not.toContain(RESTART_LOGGED);
            expect(existsSync(paths.restartMarkerPath), 'no .restart marker: nothing was scheduled').toBe(false);
            expect(handle.child.exitCode, handle.output()).toBeNull();
            // Control: the same page still reads.
            expect((await fetchFromPage(page, '/api/config')).status).toBe(200);
        } finally {
            try {
                if (ctx) await ctx.close();
            } catch {
                // already closed
            }
            await stopQuietly(handle, '12.13 off-box');
        }
    });
});
