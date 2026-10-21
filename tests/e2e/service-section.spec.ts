import { expect, type Locator, type Page, type Route, test } from '@playwright/test';
import { openSettings, openSettingsTab, settingsTabLine } from './support/auth';
import { gotoHome } from './support/consent';
import { blockServiceActions } from './support/serviceStubs';

/**
 * The Service section's browser halves: smoke 4.3 (1)-(3) and 12.2.
 *
 * Both rows are Windows guest rows whose app logic needs no Windows: what the
 * Settings dialog shows for an installed service, the install progress modal,
 * whether a service instance opens the WelcomeModal, and how "stop server &
 * exit" follows the service status. Each is reached on the shared fast-tier
 * server by answering a read in the browser, merged over the server's own
 * answer: the service status (`stubServiceStatus`) for every row but 4.3 (3),
 * which answers /api/config and /api/settings instead, since the welcome is
 * decided on the install mode. What stays on the guest is the part
 * that needs a real service: the SCM install, the status a real one reports,
 * the launcher log, the hand-off to the service's port (that one is
 * `service-handoff.spec.ts`).
 *
 * Nothing that installs, removes or stops anything reaches the server
 * (`blockServiceActions`); the rows that drive an install or uninstall answer
 * that one request themselves.
 */

/** ServiceOperationModal.ts: the install's sentence, and the uninstall's, which must not carry the install's second half. */
const INSTALL_TITLE = 'installing service';
const INSTALL_SENTENCE =
    'please wait while the service is installed. the first install on a machine can take a couple of minutes.';
const UNINSTALL_TITLE = 'uninstalling service';
const UNINSTALL_SENTENCE = 'please wait while the service is uninstalled...';
const FIRST_INSTALL_NOTE = 'the first install on a machine can take a couple of minutes.';
/** ServerTab.ts `stopServerButtonState`. */
const STOP_NOTE = 'managed by the system service — stop it via your service manager, or uninstall the service.';
/** serviceFailureMessage.ts, reason 'uac-declined'. */
const DECLINED_LINE = 'Administrative privileges were declined. Try again and approve the prompt.';

/**
 * The host fields every status stub pins, whatever the host really is: a
 * desktop (no container) where service mode is supported, with the Linux
 * first-run offers already settled so the system-wide install modal and its
 * update banner never stack in front of a row (both have rows of their own;
 * on Windows these fields are absent).
 */
const SETTLED_HOST = {
    supported: true,
    docker: false,
    machineWideInstalled: true,
    systemInstallDeclined: true,
    optUpdateAvailable: false,
} as const;

type Platform = 'win32' | 'linux';

/** An installed service, as the LOCAL instance serving this page reads it (`servedByService: false`). */
function installedService(platform: Platform, status: 'running' | 'stopped' = 'running'): Record<string, unknown> {
    return platform === 'linux'
        ? { platform, status, installMode: 'user-service', scope: 'user', servedByService: false }
        : { platform, status, installMode: 'system-service', servedByService: false };
}

/** No service installed. */
function noService(platform: Platform): Record<string, unknown> {
    return platform === 'linux'
        ? { platform, status: 'not-installed', installMode: 'user', scope: null, servedByService: false }
        : { platform, status: 'not-installed', installMode: 'user', servedByService: false };
}

/**
 * Answer GET /api/service/status with the server's own body, `SETTLED_HOST`
 * and then `fields()` laid over it. `fields` is read per request, so a row can
 * change what the NEXT read reports. Returns a count of the reads answered.
 */
async function stubServiceStatus(page: Page, fields: () => Record<string, unknown>): Promise<() => number> {
    let reads = 0;
    await page.route('**/api/service/status', async (route: Route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const real = await route.fetch();
        const body = (await real.json()) as Record<string, unknown>;
        reads += 1;
        await route.fulfill({ response: real, json: { ...body, ...SETTLED_HOST, ...fields() } });
    });
    return () => reads;
}

/**
 * Answer one service action (`/api/service/install` or `/uninstall`) only when
 * the row says so, so the progress modal it raises can be read while the
 * request is in flight. The answer is a declined elevation, which closes the
 * modal and changes nothing. `release` is safe to call twice.
 */
async function holdServiceAction(
    page: Page,
    path: '/api/service/install' | '/api/service/uninstall',
): Promise<{ bodies: unknown[]; release(): void }> {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const bodies: unknown[] = [];
    await page.route(`**${path}`, async (route) => {
        bodies.push(route.request().postDataJSON());
        await held;
        await route.fulfill({ status: 403, json: { ok: false, error: 'declined', reason: 'uac-declined' } });
    });
    return { bodies, release: () => release() };
}

/** The Service tab's one action button, by its exact state-aware caption (ServiceTab.ts `renderServiceState`). */
function serviceButton(service: Locator, caption: string): Locator {
    return service.getByRole('button', { name: caption, exact: true });
}

/** Through the Windows pre-flight (AdminConfirmModal): the row is about what follows it. */
async function continuePastAdminConfirm(page: Page): Promise<void> {
    const admin = page.locator('dialog.admin-confirm-modal[open]');
    await expect(admin).toBeVisible();
    await expect(admin.locator('.modal-title')).toHaveText('Administrative Privileges Required');
    await admin.getByRole('button', { name: 'continue', exact: true }).click();
}

test.describe('the Service section with a service installed (smoke §4.3)', () => {
    test('4.3 (1) Settings → Service reads the service installed: its state and the uninstall offer, never the install', async ({
        page,
    }) => {
        const blocked = await blockServiceActions(page);
        let status: 'running' | 'stopped' = 'running';
        await stubServiceStatus(page, () => installedService('win32', status));
        await gotoHome(page);

        // Both installed states; each opening of the dialog reads the status anew.
        for (const state of ['running', 'stopped'] as const) {
            status = state;
            const settings = await openSettings(page);
            const service = await openSettingsTab(settings, 'Service');
            await expect(serviceButton(service, `${state} — uninstall?`), `state ${state}`).toBeVisible();
            await expect(serviceButton(service, 'not installed — install?'), `state ${state}`).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(settings).toBeHidden();
        }
        expect(blocked, 'reading the section fired no service action').toEqual([]);
    });

    test('4.3 (2) continue on the install opens the progress modal, its title and its sentence; the uninstall modal does not carry the install sentence', async ({
        page,
    }) => {
        const blocked = await blockServiceActions(page);
        let fields = noService('win32');
        await stubServiceStatus(page, () => fields);
        await gotoHome(page);
        const progress = page.locator('dialog.service-operation-modal[open]');

        // The install: held in flight, so the modal is read while it is up.
        const install = await holdServiceAction(page, '/api/service/install');
        try {
            const settings = await openSettings(page);
            const service = await openSettingsTab(settings, 'Service');
            await serviceButton(service, 'not installed — install?').click();
            await continuePastAdminConfirm(page);

            await expect(progress).toBeVisible();
            await expect(progress.locator('.modal-title')).toHaveText(INSTALL_TITLE);
            await expect(progress.locator('.modal-body p')).toHaveText(INSTALL_SENTENCE);
            // Windows picks the scope itself: the body carries none.
            await expect.poll(() => install.bodies).toEqual([{}]);

            install.release();
            await expect(progress).toBeHidden();
            // Declined: nothing changed, the button is back and says why.
            await expect(settingsTabLine(service)).toHaveText(DECLINED_LINE);
            await expect(serviceButton(service, 'not installed — install?')).toBeEnabled();
            await page.keyboard.press('Escape');
            await expect(settings).toBeHidden();
        } finally {
            install.release();
        }

        // The uninstall's progress modal, for the second half of the row's
        // sentence: it must not say an install is under way.
        fields = installedService('win32');
        const uninstall = await holdServiceAction(page, '/api/service/uninstall');
        try {
            const settings = await openSettings(page);
            const service = await openSettingsTab(settings, 'Service');
            await serviceButton(service, 'running — uninstall?').click();
            await continuePastAdminConfirm(page);

            await expect(progress).toBeVisible();
            await expect(progress.locator('.modal-title')).toHaveText(UNINSTALL_TITLE);
            await expect(progress.locator('.modal-body p')).toHaveText(UNINSTALL_SENTENCE);
            await expect(progress).not.toContainText(FIRST_INSTALL_NOTE);
            await expect.poll(() => uninstall.bodies.length).toBe(1);

            uninstall.release();
            await expect(progress).toBeHidden();
            await expect(serviceButton(service, 'running — uninstall?')).toBeEnabled();
        } finally {
            uninstall.release();
        }
        expect(blocked, 'only the two answered requests were sent').toEqual([]);
    });

    test('4.3 (3) a service instance opens no WelcomeModal, even with first run incomplete; the same page in local mode does', async ({
        page,
    }) => {
        // The client decides on /api/config's `installMode` (index.ts
        // `maybeShowWelcomeModal`): a service instance takes the reminder
        // card's service branch and returns before the welcome. So the config
        // read is answered with the install mode under test and first run NOT
        // complete, the one state in which the welcome could open. The prompt
        // flags global-setup dismissed are answered as never dismissed, so the
        // service branch ends in a card that can be seen: the witness that the
        // decision has been made, not merely not made yet.
        let installMode = 'user';
        await page.route('**/api/config', async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            const real = await route.fetch();
            const env = (await real.json()) as { config: Record<string, unknown> };
            await route.fulfill({
                response: real,
                json: { ...env, config: { ...env.config, installMode, firstRunComplete: false } },
            });
        });
        await page.route('**/api/settings', async (route) => {
            if (route.request().method() !== 'GET') return route.fallback();
            const real = await route.fetch();
            const prefs = (await real.json()) as Record<string, unknown>;
            await route.fulfill({
                response: real,
                json: { ...prefs, serviceFirstRunSeen: false, bookmarkDismissedGlobally: false },
            });
        });
        const blocked = await blockServiceActions(page);
        const welcome = page.locator('dialog.welcome-modal[open]');
        const serviceCard = page.locator('.bookmark-reminder[data-kind="service"]');

        // The control: local mode with first run incomplete opens the welcome.
        await gotoHome(page);
        await expect(welcome).toBeVisible();
        await expect(serviceCard).toHaveCount(0);

        // Both service scopes (Windows installs the system one).
        for (const mode of ['system-service', 'user-service']) {
            installMode = mode;
            await page.reload();
            await expect(serviceCard, `installMode ${mode}`).toBeVisible();
            await expect(welcome, `installMode ${mode}`).toHaveCount(0);
        }
        expect(blocked).toEqual([]);
    });
});

test.describe('stop server & exit in service mode (smoke §12.2)', () => {
    test('12.2 with a service installed the button is there once, disabled, with its neutral note; a click posts nothing; the status read after an uninstall re-enables it with no reload', async ({
        page,
    }) => {
        // Linux user scope: its uninstall needs no pre-flight, and the answer
        // used below is the server's own for a Linux uninstall that finds no
        // unit left (ServiceApi.ts, `{ ok: true, status: 'not-installed' }`),
        // the one uninstall answer after which the Service tab reads the status
        // again at once. A 'shutting-down' answer starts the hand-off instead,
        // which navigates or reloads, and re-reads in place only once its
        // /api/discover poll gives up (`settleAction`, about a minute later).
        const blocked = await blockServiceActions(page);
        let fields = installedService('linux');
        const reads = await stubServiceStatus(page, () => fields);
        const uninstalls: unknown[] = [];
        await page.route('**/api/service/uninstall', async (route) => {
            uninstalls.push(route.request().method());
            fields = noService('linux');
            await route.fulfill({ json: { ok: true, status: 'not-installed', installMode: 'user' } });
        });
        await gotoHome(page);

        const settings = await openSettings(page);
        const server = await openSettingsTab(settings, 'Server');
        const stop = server.getByRole('button', { name: 'stop server & exit', exact: true });
        const stopItem = server.locator('.settings-item').filter({
            has: page.locator('.settings-label', { hasText: /^stop the server and close the app$/ }),
        });
        const note = stopItem.locator('p.settings-status');

        // Present ONCE across the whole dialog (CSS, so the hidden tabs count),
        // and disabled, never removed.
        await expect(settings.locator('button', { hasText: /^stop server & exit$/ })).toHaveCount(1);
        await expect(stop).toBeDisabled();
        // The note is neutral: the plain status style, not the error one.
        await expect(note).toBeVisible();
        await expect(note).toHaveText(STOP_NOTE);
        await expect(note).not.toHaveClass(/settings-status-error/);

        // A real mouse click on the disabled button: no confirm, no POST.
        await stop.click({ force: true });
        await expect(page.locator('dialog.confirm-modal[open]')).toHaveCount(0);

        // Uninstall the service from the Service tab, on this same document.
        await page.evaluate(() => {
            (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument = true;
        });
        const readsBefore = reads();
        const service = await openSettingsTab(settings, 'Service');
        await serviceButton(service, 'running — uninstall?').click();
        await expect(serviceButton(service, 'not installed — install?')).toBeVisible();
        expect(uninstalls).toEqual(['POST']);
        expect(reads(), 'the Service tab read the status again').toBeGreaterThan(readsBefore);

        // The Server tab heard that read: re-enabled, the note gone, no reload.
        await openSettingsTab(settings, 'Server');
        await expect(stop).toBeEnabled();
        await expect(note).toBeHidden();
        expect(
            await page.evaluate(() => (window as unknown as { __e2eSameDocument?: boolean }).__e2eSameDocument),
            'the page did not reload',
        ).toBe(true);

        // The control: the same click on the enabled button does reach the
        // confirm. Canceled, so nothing is stopped.
        await stop.click();
        const confirm = page.locator('dialog.confirm-modal[open]');
        await expect(confirm).toBeVisible();
        await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
        await expect(confirm).toBeHidden();

        expect(blocked, 'no shutdown POST, and nothing else unexpected').toEqual([]);
    });
});
