import type net from 'node:net';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
    apiContext,
    disposePrivateServer,
    freshPage,
    PRIVATE_ROOT_PREFIX,
    type PrivateServer,
    startPrivateServer,
} from './support/ownedServer';
import { holdPort, releasePort } from './support/ports';
import {
    privateServerPaths,
    readConfigFile,
    removePrivateRoot,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopServer,
    waitForServer,
} from './support/privateServer';
import { PROMPT_FLAGS, recordApiWrites } from './support/settingsUi';

/**
 * Item 164, batch C: the welcome modal (smoke 1.11) and the reminder cards'
 * "dismiss for now" and service wording (13.10).
 *
 * Both rows are about first-run state the shared server deliberately has
 * switched off (seed `firstRunComplete: true`, global-setup's dismissed
 * reminders), and both write it back when a button is clicked. So each runs on
 * a server of its own with a fresh data root: ports 8176 (1.11), 8177/8178
 * (1.11 with the port shifted) and 8179 (13.10).
 */

/** The per-user settings store, read unrouted. */
async function userSettings(api: APIRequestContext): Promise<Record<string, unknown>> {
    const res = await api.get('/api/settings');
    expect(res.status(), 'GET /api/settings').toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

/**
 * Just the prompt flags from the store. The rest of it is not these rows'
 * business: a fresh user's every page load also stores the OS theme
 * (`isThemePersist`).
 */
async function promptFlags(api: APIRequestContext): Promise<Record<string, unknown>> {
    const all = await userSettings(api);
    return Object.fromEntries(PROMPT_FLAGS.filter((k) => k in all).map((k) => [k, all[k]]));
}

/**
 * Reload and wait until the first-run chain has had its say.
 *
 * A bare `toHaveCount(0)` after `reload()` proves nothing: reload resolves at
 * the load event, and the welcome modal and the reminder cards are decided at
 * the END of an async chain (service status, then /api/config, then the
 * settings, then a dynamic import). The chain's /api/config read is the SECOND
 * of the load (the first is the top bar's runtime read), so wait for that one,
 * then for the network to settle so the dynamic import has landed.
 */
async function reloadAndSettle(page: Page): Promise<void> {
    let configReads = 0;
    const onResponse = (r: import('@playwright/test').Response) => {
        if (r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/config') configReads += 1;
    };
    page.on('response', onResponse);
    try {
        await page.reload();
        await expect.poll(() => configReads, { message: 'the first-run chain read /api/config' }).toBeGreaterThan(1);
        await page.waitForLoadState('networkidle');
    } finally {
        page.off('response', onResponse);
    }
}

test.describe('first run: the welcome modal (smoke 1.11)', () => {
    let server: PrivateServer | undefined;
    let api: APIRequestContext | undefined;
    let context: BrowserContext | undefined;

    test.beforeAll(async () => {
        test.setTimeout(150_000);
        server = await startPrivateServer('welcome-111', 8176, { firstRunComplete: false });
        api = await apiContext(server.paths.baseURL);
    });

    test.afterAll(async () => {
        await api?.dispose();
        await disposePrivateServer(server);
    });

    test.afterEach(async () => {
        await context?.close();
        context = undefined;
    });

    async function openPage(browser: Browser): Promise<Page> {
        if (!server) throw new Error('private server not started');
        const fresh = await freshPage(browser, server.paths.baseURL);
        context = fresh.context;
        return fresh.page;
    }

    test('1.11 "no, run on demand": unticked it writes nothing and the modal returns; ticked it sets firstRunComplete and the modal stays away', async ({
        browser,
    }) => {
        if (!server || !api) throw new Error('private server not started');
        const page = await openPage(browser);
        const writes = recordApiWrites(page);
        await page.goto('/');

        const welcome = page.locator('dialog.welcome-modal[open]');
        await expect(welcome).toBeVisible();
        // The URL it shows is the bound port, on the browser's own host.
        await expect(welcome.locator('a').first()).toHaveText('http://localhost:8176');

        // The platform copy follows the server's own answer, unstubbed: the
        // scope fieldset is shown exactly when the service is a Linux one the
        // host supports (the stubbed test below proves that branch on any host).
        const status = (await (await api.get('/api/service/status')).json()) as {
            platform: string;
            supported: boolean;
        };
        const scope = welcome.getByRole('group', { name: 'scope' });
        if (status.platform === 'linux' && status.supported) await expect(scope).toBeVisible();
        else await expect(scope).toBeHidden();
        if (status.platform === 'win32') await expect(welcome).toContainText('run as a windows service?');

        // (a) The box unticked: local mode, nothing written, and it comes back.
        const dontShow = welcome.getByRole('checkbox', { name: "don't show this again on this browser" });
        await expect(dontShow).not.toBeChecked();
        await welcome.getByRole('button', { name: 'no, run on demand', exact: true }).click();
        await expect(welcome).toBeHidden();
        expect(writes).toEqual([]);
        expect(readConfigFile(server.paths)).toMatchObject({ installMode: 'user', firstRunComplete: false });

        await reloadAndSettle(page);
        await expect(welcome).toBeVisible();

        // (b) The box ticked: firstRunComplete follows it, and the modal stays away.
        const patched = page.waitForResponse(
            (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === '/api/config',
        );
        await welcome.getByRole('checkbox', { name: "don't show this again on this browser" }).check();
        await welcome.getByRole('button', { name: 'no, run on demand', exact: true }).click();
        expect((await patched).status()).toBe(200);
        await expect(welcome).toBeHidden();
        expect(writes.filter((w) => w.path === '/api/config')).toEqual([
            { method: 'PATCH', path: '/api/config', body: { installMode: 'user', firstRunComplete: true } },
        ]);
        expect(readConfigFile(server.paths)).toMatchObject({ installMode: 'user', firstRunComplete: true });
        // The port is acknowledged with it, so the bookmark card does not take
        // the modal's place on the next load.
        await expect.poll(async () => (await userSettings(api!))['bookmarkDismissedForPort']).toBe(8176);

        await reloadAndSettle(page);
        await expect(welcome).toHaveCount(0);
        await expect(page.locator('.bookmark-reminder')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    });

    test('1.11 on a Linux host that supports the service, the welcome modal offers the user / system scope', async ({
        browser,
    }) => {
        if (!server || !api) throw new Error('private server not started');
        // Back to a first run (the previous test completed it).
        expect((await api.patch('/api/config', { data: { firstRunComplete: false } })).status()).toBe(200);

        const page = await openPage(browser);
        // The service status answered as a supported Linux host would. The
        // system-wide offer is answered as already declined so it does not
        // stack in front (that modal has its own row).
        await page.route('**/api/service/status', async (route) => {
            const real = await route.fetch();
            const body = (await real.json()) as Record<string, unknown>;
            await route.fulfill({
                response: real,
                json: {
                    ...body,
                    platform: 'linux',
                    supported: true,
                    docker: false,
                    machineWideInstalled: true,
                    systemInstallDeclined: true,
                    optUpdateAvailable: false,
                },
            });
        });
        await page.goto('/');
        const welcome = page.locator('dialog.welcome-modal[open]');
        await expect(welcome).toBeVisible();
        await expect(welcome).toContainText('run as a systemd service?');
        const scope = welcome.getByRole('group', { name: 'scope' });
        await expect(scope).toBeVisible();
        await expect(scope.getByRole('radio', { name: 'just for me (no sudo)' })).toBeChecked();
        await expect(scope.getByRole('radio', { name: 'all users (requires sudo)' })).not.toBeChecked();

        // Leave it as found: first run complete.
        expect((await api.patch('/api/config', { data: { firstRunComplete: true } })).status()).toBe(200);
    });
});

test.describe('first run: the welcome modal with the port shifted (smoke 1.11 / 1.12)', () => {
    test('1.11 with the configured port taken, the modal shows the port the server actually bound and no separate note', async ({
        browser,
    }) => {
        test.setTimeout(180_000);
        // Configured for 8177, which another program holds: the server walks to
        // 8178. No WS_SCRCPY_WEB_PORT — that override is exact and never walks.
        const paths = privateServerPaths(`${PRIVATE_ROOT_PREFIX}welcome-shift`, 8177);
        seedPrivateDataRoot(paths, { firstRunComplete: false });
        let blocker: net.Server | undefined;
        let handle: ServerHandle | undefined;
        let context: BrowserContext | undefined;
        try {
            blocker = await holdPort(8177);
            handle = spawnServer(paths, { portOverride: false });
            const bound = 'http://localhost:8178';
            await waitForServer(handle, bound);

            const api = await apiContext(bound);
            const env = (await (await api.get('/api/config')).json()) as {
                runtime: { webPort: number; portWasAutoShifted: boolean };
            };
            await api.dispose();
            expect(env.runtime).toMatchObject({ webPort: 8178, portWasAutoShifted: true });
            expect(readConfigFile(paths)['webPort']).toBe(8178);

            const fresh = await freshPage(browser, bound);
            context = fresh.context;
            await fresh.page.goto('/');
            const welcome = fresh.page.locator('dialog.welcome-modal[open]');
            await expect(welcome).toBeVisible();
            await expect(welcome.locator('a').first()).toHaveText(bound);
            // The removed note (2026-05-21) said the default port was in use and
            // named both ports; the configured port appears nowhere now.
            await expect(welcome).not.toContainText('8177');
            await expect(welcome).not.toContainText(/auto-?picked|was in use/i);
        } finally {
            await context?.close();
            if (handle) await stopServer(handle);
            await releasePort(blocker);
            removePrivateRoot(paths);
        }
    });
});

test.describe('reminder cards: dismiss for now, and the service card (smoke 13.10)', () => {
    let server: PrivateServer | undefined;
    let api: APIRequestContext | undefined;
    let context: BrowserContext | undefined;

    test.beforeAll(async () => {
        test.setTimeout(150_000);
        server = await startPrivateServer('reminders-1310', 8179);
        api = await apiContext(server.paths.baseURL);
    });

    test.afterAll(async () => {
        await api?.dispose();
        await disposePrivateServer(server);
    });

    test.beforeEach(async () => {
        // Each test starts from a user who has dismissed nothing.
        expect((await api!.post('/api/settings/reset')).status()).toBe(200);
    });

    test.afterEach(async () => {
        await context?.close();
        context = undefined;
    });

    async function openPage(browser: Browser, opts: { serviceMode: boolean }): Promise<Page> {
        if (!server) throw new Error('private server not started');
        const fresh = await freshPage(browser, server.paths.baseURL);
        context = fresh.context;
        if (opts.serviceMode) {
            // The install mode stubbed, as the register line says: the real first
            // load after a service install needs the service, the guest tier.
            await fresh.page.route('**/api/config', async (route) => {
                if (route.request().method() !== 'GET') return route.continue();
                const real = await route.fetch();
                const env = (await real.json()) as { config: Record<string, unknown> };
                await route.fulfill({
                    response: real,
                    json: { ...env, config: { ...env.config, installMode: 'user-service' } },
                });
            });
        }
        return fresh.page;
    }

    test('13.10 × hides the bookmark card for this page view only and writes nothing', async ({ browser }) => {
        if (!api) throw new Error('private server not started');
        const page = await openPage(browser, { serviceMode: false });
        const writes = recordApiWrites(page);
        await page.goto('/');
        const card = page.locator('.bookmark-reminder[data-kind="bookmark"]');
        await expect(card).toBeVisible();
        await expect(card).toContainText('this app lives at http://localhost:8179');

        await card.getByRole('button', { name: 'dismiss for now', exact: true }).click();
        await expect(card).toHaveCount(0);
        expect(writes).toEqual([]);
        expect(await promptFlags(api)).toEqual({});

        await page.reload();
        await expect(card).toBeVisible();
        expect(writes).toEqual([]);
    });

    test('13.10 a service instance shows the service card until got it, which records serviceFirstRunSeen; × records nothing', async ({
        browser,
    }) => {
        if (!api) throw new Error('private server not started');
        const page = await openPage(browser, { serviceMode: true });
        const writes = recordApiWrites(page);
        await page.goto('/');

        const card = page.locator('.bookmark-reminder[data-kind="service"]');
        await expect(card).toBeVisible();
        // Worded for a service, not a bookmark.
        await expect(card).toContainText(
            'ws-scrcpy-web is running as a service and starts with your computer. this page lives at http://localhost:8179 — bookmark it.',
        );
        await expect(card).not.toContainText('this app lives at');
        await expect(page.locator('.bookmark-reminder[data-kind="bookmark"]')).toHaveCount(0);

        // It returns on reload.
        await page.reload();
        await expect(card).toBeVisible();

        // × records nothing, and it is back after the reload.
        await card.getByRole('button', { name: 'dismiss for now', exact: true }).click();
        await expect(card).toHaveCount(0);
        expect(writes).toEqual([]);
        expect(await promptFlags(api)).toEqual({});
        await page.reload();
        await expect(card).toBeVisible();

        // got it records serviceFirstRunSeen (and acknowledges the port).
        await card.getByRole('button', { name: 'got it', exact: true }).click();
        await expect(card).toHaveCount(0);
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0]).toEqual({
            method: 'PATCH',
            path: '/api/settings',
            body: { bookmarkDismissedForPort: 8179, serviceFirstRunSeen: true },
        });
        await expect.poll(async () => (await userSettings(api!))['serviceFirstRunSeen']).toBe(true);

        await reloadAndSettle(page);
        await expect(page.locator('.bookmark-reminder')).toHaveCount(0);
    });

    test('13.10 never again on the service card records serviceFirstRunSeen, and a user who chose never again never sees it', async ({
        browser,
    }) => {
        if (!api) throw new Error('private server not started');
        const page = await openPage(browser, { serviceMode: true });
        const writes = recordApiWrites(page);
        await page.goto('/');
        const card = page.locator('.bookmark-reminder[data-kind="service"]');
        await expect(card).toBeVisible();

        await card.getByRole('button', { name: 'never again', exact: true }).click();
        const confirm = page.locator('dialog.confirm-modal[open]');
        await expect(confirm).toBeVisible();
        await confirm.getByRole('button', { name: 'ok', exact: true }).click();
        await expect(card).toHaveCount(0);
        await expect.poll(() => writes.length).toBe(1);
        expect(writes[0]).toEqual({
            method: 'PATCH',
            path: '/api/settings',
            body: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
        });
        await expect.poll(async () => (await userSettings(api!))['serviceFirstRunSeen']).toBe(true);
        await reloadAndSettle(page);
        await expect(page.locator('.bookmark-reminder')).toHaveCount(0);

        // A user who said never again BEFORE the install: serviceFirstRunSeen was
        // never recorded, and still no service card. (The control is the test
        // above, where the same page with neither flag shows it.)
        expect((await api.post('/api/settings/reset')).status()).toBe(200);
        expect((await api.patch('/api/settings', { data: { bookmarkDismissedGlobally: true } })).status()).toBe(200);
        expect((await userSettings(api))['serviceFirstRunSeen']).toBeUndefined();
        await reloadAndSettle(page);
        await expect(page.locator('.bookmark-reminder')).toHaveCount(0);
    });
});
