import type net from 'node:net';
import type { APIResponse, BrowserContext, Locator, Page, Request, Response } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { ADMIN, loginAs, openSettings, openSettingsTab, REGULAR } from './support/auth';
import { apiContext, lockDown } from './support/ownedServer';
import { holdPort, releasePort } from './support/ports';
import {
    type PrivateServerPaths,
    privateServerPaths,
    readConfigFile,
    removePrivateRoot,
    type ServerHandle,
    seedPrivateDataRoot,
    sharedDependencies,
    spawnServer,
    stopQuietly,
    stopServer,
    waitForDependencies,
    waitForServer,
    withoutInheritedOverrides,
} from './support/privateServer';
import { blockServiceActions } from './support/serviceStubs';

/**
 * Item 24, step 3: the service install hand-off with two real app processes on
 * one data root -- the shape that produced the port-shift bug #643, which needs
 * no Windows.
 *
 * Instance A is the local app the user is on. Instance B is "the service": the
 * same `dist/index.js`, started with the environment the service units give it
 * (`WS_SCRCPY_SERVICE=1`), on A's data root and config.json, while A still
 * runs. Only the service manager is stubbed, at the browser: `status` in GET
 * /api/service/status, and the install and uninstall POSTs, so systemd and the
 * SCM are never touched. The one step of each POST the server would have taken
 * itself is played through the API instead (installMode persisted before the
 * install, reverted before the uninstall). Everything the poll reads from the
 * processes is real: the port on disk (`diskWebPort`), `servedByService`,
 * whether the origin answers, and the per-process token.
 *
 * Smoke rows 4.7 (agnostic half), the hand-off halves of 4.3 and 1.11 (c),
 * 13.11's install hand-off, 5.5's page landing, the first load of 13.10, and
 * 3.7 (b) in open and locked mode. 13.11's uninstall half is not here: it keeps
 * the host through the Rust operation-server's /api/discover
 * (launcher/src/operation_server.rs:1000), which the fast tier does not run, so
 * it stays on the guest.
 *
 * Ports 8200-8209 are this file's (8200/8201/8202 the Settings hand-off and its
 * reverse leg, 8203 the same-port hand-off, 8204/8205/8206 the welcome modal's,
 * 8207/8208 row 3.7 b open, 8208/8209 row 3.7 b locked), under data roots named
 * `ws-scrcpy-web-e2e-i24-handoff-*`.
 */

const ROOT_PREFIX = 'ws-scrcpy-web-e2e-i24-handoff-';

/** The browser's address for a port: the loopback IP, never `localhost` (row 13.11 is about the host). */
const at = (port: number): string => `http://127.0.0.1:${port}`;

type ServiceState = 'not-installed' | 'stopped' | 'running';

/** What the stubbed service manager says, and what it saw. */
interface ServiceManager {
    state: ServiceState;
    /** Status reads that found nothing listening on the page's origin: the hand-off's dead window. */
    unreachable: number;
    /** Every POST /api/service/install body the page sent. None reached a server. */
    installBodies: unknown[];
    /**
     * The install POST's answer, set by `playInstallStep` just before the
     * click: what ServiceApi.handleInstall answers once the service manager has
     * done its part, with config.json's real mtime and port.
     */
    installAnswer: Record<string, unknown>;
}

/**
 * Stand in for the service manager behind GET /api/service/status. The read
 * goes to whichever process answers the page's origin, and only `status` (the
 * SCM's or systemctl's answer about the SERVICE) is replaced; `diskWebPort`,
 * `configMtime` and `servedByService` stay what that process said. A refused
 * read passes through untouched, and an origin with nothing listening aborts
 * the page's request, as the dead port itself would.
 *
 * `route.fulfill` and `route.abort` throw when the page has already given up on
 * the request (the poll's 5 s abort); that is the page's business, not the
 * stub's, so it is swallowed.
 *
 * Every other service action is refused by `blockServiceActions`, registered
 * first so the routes here, registered after it, win for their own paths.
 */
async function stubServiceManager(context: BrowserContext): Promise<{ manager: ServiceManager; blocked: string[] }> {
    const blocked = await blockServiceActions(context);
    const manager: ServiceManager = {
        state: 'not-installed',
        unreachable: 0,
        installBodies: [],
        installAnswer: {},
    };
    await context.route('**/api/service/status', async (route) => {
        let real: APIResponse;
        try {
            real = await route.fetch({ timeout: 5_000 });
        } catch {
            manager.unreachable += 1;
            await route.abort('connectionrefused').catch(() => {});
            return;
        }
        if (!real.ok()) {
            await route.fulfill({ response: real }).catch(() => {});
            return;
        }
        const body = (await real.json()) as Record<string, unknown>;
        await route.fulfill({ response: real, json: { ...body, status: manager.state } }).catch(() => {});
    });
    await context.route('**/api/service/install', async (route) => {
        manager.installBodies.push(route.request().postDataJSON());
        await route.fulfill({ json: manager.installAnswer });
    });
    return { manager, blocked };
}

/**
 * Note, as a test annotation, which of the page's two stale-token reloads moved
 * it: the last 403 the page received before its next document request.
 * /api/service/status or /api/discover is the hand-off poll; /api/auth/me is the
 * device tracker (staleTokenReload.ts). Diagnostic only, never asserted: the
 * rows are about where the page ends, and either mechanism is the product's.
 */
function recordReloadCause(page: Page): () => void {
    let last403: string | undefined;
    let atNavigation: string | undefined;
    let navigated = false;
    const onResponse = (r: Response): void => {
        if (!navigated && r.status() === 403) last403 = new URL(r.url()).pathname;
    };
    const onRequest = (r: Request): void => {
        if (navigated || !r.isNavigationRequest()) return;
        navigated = true;
        atNavigation = last403;
    };
    page.on('response', onResponse);
    page.on('request', onRequest);
    return () => {
        page.off('response', onResponse);
        page.off('request', onRequest);
        const by =
            atNavigation === '/api/service/status' || atNavigation === '/api/discover'
                ? 'the hand-off poll'
                : atNavigation === '/api/auth/me'
                  ? 'the device tracker (staleTokenReload.ts)'
                  : 'not identified';
        test.info().annotations.push({
            type: 'reload-cause',
            description: `${by} (last 403 before the reload: ${atNavigation ?? 'none'}); diagnostic only`,
        });
    };
}

interface RealStatus {
    platform: string;
    servedByService: boolean;
    diskWebPort: number;
    configMtime: number;
}

/** GET /api/service/status as the process itself answers it, unrouted. */
async function realStatus(baseURL: string): Promise<RealStatus> {
    const api = await apiContext(baseURL);
    try {
        const res = await api.get('/api/service/status');
        expect(res.status(), `GET /api/service/status on ${baseURL}`).toBe(200);
        return (await res.json()) as RealStatus;
    } finally {
        await api.dispose();
    }
}

interface Envelope {
    config: { webPort: number; installMode: string };
    runtime: { webPort: number; portWasAutoShifted: boolean };
}

/** GET /api/config's envelope from one process, in open mode. */
async function envelope(baseURL: string): Promise<Envelope> {
    const api = await apiContext(baseURL);
    try {
        const res = await api.get('/api/config');
        expect(res.status(), `GET /api/config on ${baseURL}`).toBe(200);
        return (await res.json()) as Envelope;
    } finally {
        await api.dispose();
    }
}

async function patchInstallMode(baseURL: string, installMode: string): Promise<void> {
    const api = await apiContext(baseURL);
    try {
        const res = await api.patch('/api/config', { data: { installMode } });
        expect(res.status(), `PATCH installMode=${installMode} on ${baseURL}: ${await res.text()}`).toBe(200);
    } finally {
        await api.dispose();
    }
}

/**
 * The install mode the local server records for the scope it would install
 * (ServiceApi.handleInstall): Linux takes the page's scope, user by default;
 * Windows detects it, and a Program Files install is `system`.
 */
const serviceModeFor = (platform: string): string => (platform === 'linux' ? 'user-service' : 'system-service');

/**
 * A stand-in for the server step the stubbed POST /api/service/install skips:
 * ServiceApi.handleInstall persists installMode BEFORE it invokes the install,
 * so the service boots in service mode (src/server/api/ServiceApi.ts:524-547).
 * Played through the API here because the POST never reaches A. It is a write
 * on A before B exists, so A's save cannot put A's port back over B's.
 */
async function playInstallStep(manager: ServiceManager, localURL: string): Promise<string> {
    const { platform } = await realStatus(localURL);
    const installMode = serviceModeFor(platform);
    await patchInstallMode(localURL, installMode);
    const disk = await realStatus(localURL);
    manager.installAnswer = {
        ok: true,
        status: 'stopped',
        installMode,
        configMtime: disk.configMtime,
        diskWebPort: disk.diskWebPort,
    };
    return platform;
}

/** Windows raises the elevation pre-flight before any install or uninstall; Linux user scope needs none (ServiceTab). */
async function confirmElevation(page: Page, platform: string): Promise<void> {
    if (platform !== 'win32') return;
    const admin = page.locator('dialog.admin-confirm-modal[open]');
    await expect(admin).toBeVisible();
    await admin.getByRole('button', { name: 'continue', exact: true }).click();
}

/** Settings > Service on the page's current origin, its card rendered from the status read. */
async function openServiceTab(page: Page): Promise<Locator> {
    const settings = await openSettings(page);
    const service = await openSettingsTab(settings, 'Service');
    await expect(service.getByText('loading install/uninstall status…')).toHaveCount(0);
    return service;
}

/** The 13.10 service card on the page, worded for `url`, and no welcome modal beside it. */
async function expectServiceFirstLoad(page: Page, url: string): Promise<void> {
    const card = page.locator('.bookmark-reminder[data-kind="service"]');
    await expect(card).toBeVisible();
    await expect(card.locator('a')).toHaveText(url);
    await expect(card).toContainText(
        `ws-scrcpy-web is running as a service and starts with your computer. this page lives at ${url} — bookmark it.`,
    );
    // The card is the END of the first-run chain's service branch, which returns
    // before the welcome modal is considered (src/app/index.ts), so with the card
    // up this count is final, not a sample taken too early.
    await expect(page.locator('dialog.welcome-modal')).toHaveCount(0);
}

test.describe('service install hand-off: two instances on one data root (item 24)', () => {
    /**
     * What the running test has started, torn down in `afterEach`, which
     * Playwright awaits even after a test timeout; a `finally` inside the test
     * body never runs then, and its servers would outlive the run.
     */
    interface Run {
        paths?: PrivateServerPaths;
        /** Every instance's DEPS_PATH: the fast tier's folder (`sharedDependencies`). */
        dependenciesPath?: string;
        handles: ServerHandle[];
        blocker?: net.Server;
        context?: BrowserContext;
    }
    let run: Run = { handles: [] };

    test.beforeEach(() => {
        run = { handles: [] };
    });

    test.afterEach(async () => {
        const label = test.info().title;
        try {
            await run.context?.close();
        } catch (err) {
            console.warn('cleanup failed (context):', label, String(err));
        }
        for (const handle of run.handles) await stopQuietly(handle, label);
        await releasePort(run.blocker);
        if (run.paths) {
            try {
                removePrivateRoot(run.paths);
            } catch (err) {
                // EBUSY on the WAL sidecars is tolerated: the next run re-seeds the root.
                console.warn('cleanup failed (root):', label, String(err));
            }
        }
    });

    async function seed(
        name: string,
        port: number,
        extraConfig: Record<string, unknown> = {},
    ): Promise<PrivateServerPaths> {
        const paths = privateServerPaths(`${ROOT_PREFIX}${name}`, port);
        seedPrivateDataRoot(paths, extraConfig);
        run.paths = paths;
        // No row here installs or reads a dependency, so no root hydrates its own.
        run.dependenciesPath = await sharedDependencies();
        return paths;
    }

    /** The DEPS_PATH `seed` chose; an instance spawned before it would hydrate a folder of its own. */
    function dependenciesPath(): string {
        if (!run.dependenciesPath) throw new Error('seed the root before spawning an instance on it');
        return run.dependenciesPath;
    }

    /** A spawned as the local app, C as the local app relaunched after an uninstall. */
    function spawnLocal(paths: PrivateServerPaths): ServerHandle {
        const handle = spawnServer(paths, {
            env: withoutInheritedOverrides(),
            portOverride: false,
            dependenciesPath: dependenciesPath(),
        });
        run.handles.push(handle);
        return handle;
    }

    /** B, spawned as the service units start it. */
    function spawnService(paths: PrivateServerPaths): ServerHandle {
        const handle = spawnServer(paths, {
            env: withoutInheritedOverrides({ WS_SCRCPY_SERVICE: '1' }),
            portOverride: false,
            dependenciesPath: dependenciesPath(),
        });
        run.handles.push(handle);
        return handle;
    }

    test('4.7 / 4.3 / 13.11 (install) / 13.10 / 5.5 the configured port held: local on +1, the service walks to +2 and persists it, the page follows on 127.0.0.1 and reads installed; uninstalled, it ends on the relaunched local app', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const configured = 8200;
        const local = 8201;
        const service = 8202;
        const paths = await seed('settings', configured);

        // 4.7's precondition: another program holds the configured port, so
        // the local app walks to +1 and persists it (row 1.12's rule).
        run.blocker = await holdPort(configured);
        const a = spawnLocal(paths);
        await waitForServer(a, at(local));
        expect(readConfigFile(paths)['webPort']).toBe(local);
        // A and B run from the fast tier's dependencies, installed before A
        // booted (`seed`): A itself reports them installed before B joins it.
        await waitForDependencies(at(local));

        run.context = await browser.newContext({ baseURL: at(local) });
        const { manager, blocked } = await stubServiceManager(run.context);
        let answerUninstall: (body: Record<string, unknown>) => void = () => {};
        const uninstallAnswer = new Promise<Record<string, unknown>>((resolve) => {
            answerUninstall = resolve;
        });
        await run.context.route('**/api/service/uninstall', async (route) => {
            const json = await uninstallAnswer;
            // The page may already have reloaded onto the relaunched app,
            // which drops this request (see the reverse leg).
            await route.fulfill({ json }).catch(() => {});
        });
        const page = await run.context.newPage();
        await page.goto('/');

        let tab = await openServiceTab(page);
        const install = tab.getByRole('button', { name: 'not installed — install?', exact: true });
        await expect(install).toBeEnabled();

        const platform = await playInstallStep(manager, at(local));
        const installed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/service/install');
        await install.click();
        await confirmElevation(page, platform);
        expect((await installed).status()).toBe(200);
        manager.state = 'stopped';
        expect(manager.installBodies).toEqual([platform === 'linux' ? { scope: 'user' } : {}]);

        // The service comes up while A is still serving the page: A holds +1,
        // so B walks to +2 and, as the service, persists it. The service
        // manager reports it running from the moment its process starts, before
        // it has bound or persisted anything, so a tick can read "running" with
        // the disk still naming +1: the page's own port, which must not
        // navigate (installHandoffPoll.ts:84).
        const landed = page.waitForURL(`${at(service)}/`, { timeout: 90_000 });
        const b = spawnService(paths);
        manager.state = 'running';
        await waitForServer(b, at(service));
        expect(readConfigFile(paths)['webPort']).toBe(service);

        // The poll, still asking A (same origin, +1), learns the moved port
        // from A's own disk read and the running service from the service
        // manager, and goes there on the host the browser is on (13.11).
        await landed;
        expect(a.child.exitCode, 'A was still serving when the page left it').toBeNull();
        await stopServer(a);
        expect(new URL(page.url()).hostname).toBe('127.0.0.1');

        // 4.7: persisted on disk and reported by B, which says it is the service.
        expect(readConfigFile(paths)).toMatchObject({ webPort: service, installMode: serviceModeFor(platform) });
        const bEnv = await envelope(at(service));
        expect(bEnv.config.webPort).toBe(service);
        expect(bEnv.runtime).toMatchObject({ webPort: service, portWasAutoShifted: true });
        expect(await realStatus(at(service))).toMatchObject({ servedByService: true, diskWebPort: service });

        // 13.10 / 4.3: B's first load is the service card on B's address, no welcome modal.
        await expectServiceFirstLoad(page, at(service));

        // 4.7 / 4.3: Settings > Service reads installed.
        tab = await openServiceTab(page);
        const uninstall = tab.getByRole('button', { name: 'running — uninstall?', exact: true });
        await expect(uninstall).toBeVisible();

        // 5.5, the reverse leg. A stand-in for the server step the stubbed
        // POST /api/service/uninstall skips: the mirror of the install's
        // persist (src/server/api/ServiceApi.ts:524-547), handleUninstall
        // reverts installMode BEFORE the service goes (ServiceApi.ts:820-829 on
        // Linux, 930-949 on Windows), so the relaunched local app boots in
        // local mode. A is gone, so B's save writes B's port, which is the
        // disk's.
        const reverted = platform === 'linux' ? 'user' : 'system';
        await patchInstallMode(at(service), reverted);
        const bDisk = await realStatus(at(service));
        await uninstall.click();
        await confirmElevation(page, platform);
        // Located by text, not role: the progress dialog is modal, so the tab
        // behind it is outside the accessibility tree while it is up.
        await expect(tab.locator('button', { hasText: 'uninstalling…' })).toBeDisabled();
        await expect(page.locator('dialog.service-operation-modal[open]')).toContainText('uninstalling service');

        // The teardown's part: the service stops, and the local app is
        // relaunched on the same root. Nothing holds +2 now, so it binds the
        // port config.json names. Only then does the POST answer.
        //
        // What this leg holds is 5.5's: "uninstalling…", then the page ends at
        // the local-mode URL, served by the relaunched app in local mode. It
        // does NOT hold the uninstall discovery loop (ServiceTab.ts:603-644),
        // which serviceTabHandoff.test.ts does: the page is reloaded by
        // whichever of two stale-token readers asks the relaunched app first,
        // that loop or the device tracker (staleTokenReload.ts), and the
        // tracker usually wins. The wait is armed before anything moves, so
        // neither can slip past it; the annotation says which one it was.
        const reloaded = page.waitForEvent('load', { timeout: 90_000 });
        const reportCause = recordReloadCause(page);
        await stopServer(b);
        manager.state = 'not-installed';
        const c = spawnLocal(paths);
        await waitForServer(c, at(service));
        answerUninstall({
            ok: true,
            status: 'shutting-down',
            installMode: reverted,
            configMtime: bDisk.configMtime,
        });

        // The page ends at the local-mode URL, on the relaunched local app. That
        // app took the page's own port, so no navigation named a host here:
        // 13.11's uninstall half (the host kept through the operation-server's
        // /api/discover) is the guest's.
        await reloaded;
        reportCause();
        expect(page.url()).toBe(`${at(service)}/`);
        expect(await realStatus(at(service))).toMatchObject({ servedByService: false, diskWebPort: service });
        expect(readConfigFile(paths)).toMatchObject({ webPort: service, installMode: reverted });
        // Local mode's first load: the bookmark card in its local wording, on
        // the browser's address, and not the service card.
        const bookmark = page.locator('.bookmark-reminder[data-kind="bookmark"]');
        await expect(bookmark).toBeVisible();
        await expect(bookmark).toContainText(`this app lives at ${at(service)}`);
        await expect(page.locator('.bookmark-reminder[data-kind="service"]')).toHaveCount(0);
        tab = await openServiceTab(page);
        await expect(tab.getByRole('button', { name: 'not installed — install?', exact: true })).toBeVisible();
        expect(blocked, 'no other service action was fired').toEqual([]);
    });

    test('4.3 the local app gone before the service is up: the service takes the same port and the page ends on it, reading installed', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const port = 8203;
        const paths = await seed('same-port', port);
        const a = spawnLocal(paths);
        await waitForServer(a, at(port));
        await waitForDependencies(at(port));

        run.context = await browser.newContext({ baseURL: at(port) });
        const { manager, blocked } = await stubServiceManager(run.context);
        const page = await run.context.newPage();
        await page.goto('/');
        const tab = await openServiceTab(page);
        const install = tab.getByRole('button', { name: 'not installed — install?', exact: true });
        await expect(install).toBeEnabled();

        const platform = await playInstallStep(manager, at(port));
        const installed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/service/install');
        await install.click();
        await confirmElevation(page, platform);
        expect((await installed).status()).toBe(200);
        manager.state = 'stopped';

        // The local app exits before the service starts (the Linux user-scope
        // order: ServiceApi exits it so the hand-off helper can start the unit).
        //
        // This leg stands where item 24's sketch had "A dead before B is seen,
        // the sticky disk port", which cannot happen with two real processes.
        // The poll is same-origin, and its sticky state (the last disk port, the
        // service seen running) only matters when a LATER answer on this port
        // says "running" without a port. With A dead, only B can answer here,
        // and B, started after A has gone, takes this free configured port
        // rather than walking past it. The world where that answer comes from
        // someone else is made up by installHandoffPoll.test.ts:155.
        await stopServer(a);
        await expect
            .poll(() => manager.unreachable, { message: 'a status read met the dead port', timeout: 30_000 })
            .toBeGreaterThan(0);

        // The service then takes the port A left: config.json names it and it
        // is free, so there is nothing to walk past, and nothing to persist.
        //
        // What this leg holds is the server side (B takes the free configured
        // port without walking, serves as the service, and reports this port on
        // disk), that the page ends on the service with a fresh token through
        // some reload, the 13.10 card, and Service reading installed. It does
        // NOT hold the poll's tolerance of the dead window or its reconnect on
        // the stale-token 403; installHandoffPoll.test.ts does. The page is
        // reloaded by whichever stale-token reader asks B first, the poll or
        // the device tracker (staleTokenReload.ts), so the poll may never get
        // to act on its own; the annotation says which one it was.
        const reloaded = page.waitForEvent('load', { timeout: 90_000 });
        const reportCause = recordReloadCause(page);
        const b = spawnService(paths);
        await waitForServer(b, at(port));
        manager.state = 'running';

        await reloaded;
        reportCause();
        expect(page.url()).toBe(`${at(port)}/`);
        expect(readConfigFile(paths)['webPort']).toBe(port);
        expect((await envelope(at(port))).runtime).toMatchObject({ webPort: port, portWasAutoShifted: false });
        expect(await realStatus(at(port))).toMatchObject({ servedByService: true, diskWebPort: port });

        await expectServiceFirstLoad(page, at(port));
        const after = await openServiceTab(page);
        await expect(after.getByRole('button', { name: 'running — uninstall?', exact: true })).toBeVisible();
        expect(blocked, 'no other service action was fired').toEqual([]);
    });

    test('1.11 (c) "yes, install service" on a first run shares the Settings poll: the welcome modal follows the service to its shifted port, where no welcome modal opens', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const configured = 8204;
        const local = 8205;
        const service = 8206;
        const paths = await seed('welcome', configured, { firstRunComplete: false });
        run.blocker = await holdPort(configured);
        const a = spawnLocal(paths);
        await waitForServer(a, at(local));
        await waitForDependencies(at(local));

        run.context = await browser.newContext({ baseURL: at(local) });
        const { manager, blocked } = await stubServiceManager(run.context);
        const page = await run.context.newPage();
        await page.goto('/');
        const welcome = page.locator('dialog.welcome-modal[open]');
        await expect(welcome).toBeVisible();
        await expect(welcome.locator('a').first()).toHaveText(at(local));

        const platform = await playInstallStep(manager, at(local));
        const installed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/service/install');
        await welcome.getByRole('button', { name: 'yes, install service', exact: true }).click();
        expect((await installed).status()).toBe(200);
        manager.state = 'stopped';
        // Linux sends the scope the modal shows (just for me, by default); Windows sends none.
        expect(manager.installBodies).toEqual([platform === 'linux' ? { scope: 'user' } : {}]);
        await expect(welcome).toContainText('service installed. waiting for it to start…');

        // Running from the moment the process starts, as in the Settings leg:
        // a tick may read "running" while the disk still names this page's port.
        const landed = page.waitForURL(`${at(service)}/`, { timeout: 90_000 });
        const b = spawnService(paths);
        manager.state = 'running';
        await waitForServer(b, at(service));
        await landed;
        await stopServer(a);

        expect(readConfigFile(paths)).toMatchObject({ webPort: service, firstRunComplete: false });
        expect(await realStatus(at(service))).toMatchObject({ servedByService: true, diskWebPort: service });
        // firstRunComplete is still false on disk, and still no welcome modal:
        // a service instance shows its card instead.
        await expectServiceFirstLoad(page, at(service));
        expect(blocked, 'no other service action was fired').toEqual([]);
    });

    test('3.7 (b) a second instance that finds the configured port held by a sibling binds the next port and does not persist it', async () => {
        test.setTimeout(300_000);
        const configured = 8207;
        const next = 8208;
        const paths = await seed('sibling', configured);
        const a = spawnLocal(paths);
        await waitForServer(a, at(configured));
        await waitForDependencies(at(configured));

        // Not the service: no WS_SCRCPY_SERVICE, so the sibling guard runs,
        // finds this app on the configured port (GET /api/whoami), and keeps
        // the shift to itself.
        const b = spawnLocal(paths);
        await waitForServer(b, at(next));
        const bEnv = await envelope(at(next));
        expect(bEnv.runtime).toMatchObject({ webPort: next, portWasAutoShifted: true });
        expect(bEnv.config.webPort, "B's own config still names the configured port").toBe(configured);
        expect(readConfigFile(paths)['webPort']).toBe(configured);
        // The sibling it found is still serving the port config.json names.
        expect((await envelope(at(configured))).runtime.webPort).toBe(configured);

        // Nor does B's exit write it.
        await stopServer(b);
        expect(readConfigFile(paths)['webPort']).toBe(configured);
    });

    test('3.7 (b) with users configured, the second instance still finds the sibling and does not persist its port', async () => {
        test.setTimeout(300_000);
        const configured = 8208;
        const next = 8209;
        const paths = await seed('sibling-locked', configured);
        const a = spawnLocal(paths);
        await waitForServer(a, at(configured));
        await waitForDependencies(at(configured));

        // Users configured: the lockdown writes the database, not config.json.
        // The sibling probe has to identify A without a session now, which is
        // what GET /api/whoami is for (siblingInstance.ts): the AuthGate answers
        // /api/config 401.
        await lockDown(at(configured), ADMIN, REGULAR);
        expect(readConfigFile(paths)['webPort']).toBe(configured);

        const b = spawnLocal(paths);
        await waitForServer(b, at(next));
        const api = await apiContext(at(next));
        try {
            // Locked: the runtime is only an admin's to read.
            expect((await api.get('/api/config')).status(), 'an unauthenticated /api/config, locked').toBe(401);
            expect((await loginAs(api, ADMIN)).status(), 'admin sign-in on B').toBe(200);
            const res = await api.get('/api/config');
            expect(res.status()).toBe(200);
            const bEnv = (await res.json()) as Envelope;
            expect(bEnv.runtime).toMatchObject({ webPort: next, portWasAutoShifted: true });
            expect(bEnv.config.webPort, "B's own config still names the configured port").toBe(configured);
        } finally {
            await api.dispose();
        }
        expect(readConfigFile(paths)['webPort']).toBe(configured);

        await stopServer(b);
        expect(readConfigFile(paths)['webPort']).toBe(configured);
    });
});
