import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, BrowserContext, Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openSettings, openSettingsTab, settingsRow, settingsTabLine } from './support/auth';
import {
    apiContext,
    dismissPrivatePrompts,
    disposePrivateServer,
    freshPage,
    type PrivateServer,
    restartOnPort,
    startPrivateServer,
} from './support/ownedServer';
import { plantPendingBatch, walRows } from './support/pendingSettings';
import { readConfigBytes, readConfigFile, withTimeout } from './support/privateServer';
import { readServerLog } from './support/serverLog';
import {
    footerSave,
    INSTALLED_VERSION,
    recordApiWrites,
    reviewDialog,
    reviewLines,
    serverUpdatesState,
    stubInstalledUpdates,
    typeAndLeave,
    type UpdatesState,
    unsavedDialog,
} from './support/settingsUi';

/**
 * Item 164, batch C: the Settings dialog's staged save (smoke 13.4-13.9), the
 * dependency alert (13.7), the top-bar update pill (6.9) and the port hand-off
 * (13.11).
 *
 * Every row that SAVES runs on a spec-owned server. A Save writes the updater
 * settings into the server's database and a web-port change ends the process
 * with exit 75 — on the shared server the first would leak into later files and
 * the second would end the run. Rows 13.7 and 6.9 only stub the reads they are
 * about and write nothing, so they use the shared server.
 *
 * Ports 8171-8175 are this file's (8171 the staged-save rows, 8172/8173 row
 * 13.8, 8174/8175 row 13.11).
 */

const onOff = (v: boolean): string => (v ? 'on' : 'off');

/** The version the spec-owned server reads, from the same package.json it does. */
function repoVersion(): string {
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    return (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
}

/** Settings → Updates on a page whose status read says "installed", controls rendered. */
async function openUpdatesTab(page: Page): Promise<{ settings: Locator; updates: Locator }> {
    const settings = await openSettings(page);
    const updates = await openSettingsTab(settings, 'Updates');
    // The controls are rendered by the status read, after the tab is shown.
    await expect(updates.getByRole('button', { name: 'check for updates now' })).toBeVisible();
    await expect(updates.getByText(`up to date: v${INSTALLED_VERSION}`)).toBeVisible();
    return { settings, updates };
}

function updatesControls(updates: Locator) {
    return {
        auto: settingsRow(updates, 'automatically download updates').locator('input[type="checkbox"]'),
        interval: settingsRow(updates, 'check interval (minutes)').locator('input'),
        owner: settingsRow(updates, 'github owner').locator('input'),
        radio: (channel: string) => updates.getByRole('radio', { name: channel, exact: true }),
        /**
         * A refusal, on the line under the field it is about (0.5.5): the
         * interval's or the owner's. The action row's label keeps to the
         * update state.
         */
        refusal: (text: string) =>
            updates.locator('[data-updates-interval-note], [data-updates-owner-note]', { hasText: text }),
    };
}

/** The one POST /api/settings/batch the next Save sends, and its answer. */
function nextBatchResponse(page: Page) {
    return page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/settings/batch',
    );
}

test.describe('settings dialog: the staged save (smoke 13.4-13.6, 13.9)', () => {
    let server: PrivateServer | undefined;
    let api: APIRequestContext | undefined;
    let context: BrowserContext | undefined;

    test.beforeAll(async () => {
        test.setTimeout(150_000);
        server = await startPrivateServer('staged-save', 8171);
        await dismissPrivatePrompts(server.paths.baseURL);
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

    async function installedPage(browser: import('@playwright/test').Browser): Promise<Page> {
        if (!server) throw new Error('private server not started');
        const fresh = await freshPage(browser, server.paths.baseURL);
        context = fresh.context;
        await stubInstalledUpdates(fresh.page);
        await fresh.page.goto('/');
        return fresh.page;
    }

    test('13.4 nothing is written while editing; save opens Review changes; Cancel writes nothing; Save applies the batch once', async ({
        browser,
    }) => {
        if (!server || !api) throw new Error('private server not started');
        const page = await installedPage(browser);
        const before = await serverUpdatesState(api);
        const walBefore = walRows(server.paths.dbPath).length;
        const writes = recordApiWrites(page);

        const { settings, updates } = await openUpdatesTab(page);
        const c = updatesControls(updates);
        await expect(c.auto).toBeChecked({ checked: before.autoUpdate });
        await expect(footerSave(settings)).toBeDisabled();
        // The running version, on Save's line at the left (0.5.1). It comes
        // from /api/config, not the stubbed updates status, so it is the
        // server's own package.json version, not INSTALLED_VERSION.
        await expect(settings.locator('.modal-footer .settings-version')).toHaveText(`v${repoVersion()}`);

        const newOwner = before.githubOwner === 'e2e-164c-owner-a' ? 'e2e-164c-owner-b' : 'e2e-164c-owner-a';
        await c.auto.click();
        await typeAndLeave(c.owner, newOwner);
        await expect(footerSave(settings)).toBeEnabled();

        // Nothing written while editing: no write request of any kind, and the
        // server still reports what it did before.
        expect(writes).toEqual([]);
        expect(await serverUpdatesState(api)).toEqual(before);

        // save → Review changes, one `<setting>: <old> → <new>` line per change,
        // booleans as on / off.
        await footerSave(settings).click();
        const review = reviewDialog(page);
        await expect(review).toBeVisible();
        const expectedLines = [
            `Automatic updates: ${onOff(before.autoUpdate)} → ${onOff(!before.autoUpdate)}`,
            `GitHub owner: ${before.githubOwner} → ${newOwner}`,
        ];
        await expect(reviewLines(review)).toHaveText(expectedLines);

        // Cancel writes nothing, and the edits are still staged behind it.
        await review.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(review).toBeHidden();
        await expect(settings).toBeVisible();
        await expect(c.auto).toBeChecked({ checked: !before.autoUpdate });
        await expect(c.owner).toHaveValue(newOwner);
        await expect(footerSave(settings)).toBeEnabled();
        expect(writes).toEqual([]);
        expect(await serverUpdatesState(api)).toEqual(before);
        expect(walRows(server.paths.dbPath)).toHaveLength(walBefore);

        // Save applies every change in ONE batch.
        const batch = nextBatchResponse(page);
        await footerSave(settings).click();
        await expect(review).toBeVisible();
        await expect(reviewLines(review)).toHaveText(expectedLines);
        await review.getByRole('button', { name: 'Save', exact: true }).click();
        const res = await batch;
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { ok: boolean; applied: string[] };
        expect(body.ok).toBe(true);
        expect([...body.applied].sort()).toEqual(['autoUpdate', 'githubOwner']);
        await expect(page.locator('dialog.settings-modal[open]')).toBeHidden();

        // What the request carried: the RAW values (a boolean, not "off" — the
        // formatted value on the wire is how every autoUpdate save once 400'd).
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ method: 'POST', path: '/api/settings/batch' });
        const sent = (writes[0]!.body as { changes: { id: string; to: unknown }[] }).changes;
        expect(sent.map((ch) => ({ id: ch.id, to: ch.to }))).toEqual([
            { id: 'autoUpdate', to: !before.autoUpdate },
            { id: 'githubOwner', to: newOwner },
        ]);

        // What the server stored, and the one journal row for the batch.
        expect(await serverUpdatesState(api)).toEqual({
            ...before,
            autoUpdate: !before.autoUpdate,
            githubOwner: newOwner,
        });
        const wal = walRows(server.paths.dbPath);
        expect(wal).toHaveLength(walBefore + 1);
        expect(wal.at(-1)?.status).toBe('completed');
        expect(wal.at(-1)?.changes.map((ch) => ch.id)).toEqual(['autoUpdate', 'githubOwner']);
    });

    test('13.5 closing a dirty dialog by ×, Esc or the backdrop asks first; cancel keeps the change, discard drops it, save runs the review', async ({
        browser,
    }) => {
        if (!server || !api) throw new Error('private server not started');
        const page = await installedPage(browser);
        const before = await serverUpdatesState(api);
        const writes = recordApiWrites(page);

        const { settings, updates } = await openUpdatesTab(page);
        const c = updatesControls(updates);
        await c.auto.click();
        await expect(footerSave(settings)).toBeEnabled();

        const prompt = unsavedDialog(page);
        const expectPrompt = async () => {
            await expect(prompt).toBeVisible();
            await expect(prompt).toContainText('you have changes that have not been saved yet.');
            for (const name of ['cancel', 'discard', 'save']) {
                await expect(prompt.getByRole('button', { name, exact: true })).toBeVisible();
            }
        };
        const expectStillStaged = async () => {
            await expect(prompt).toBeHidden();
            await expect(settings).toBeVisible();
            await expect(c.auto).toBeChecked({ checked: !before.autoUpdate });
            await expect(footerSave(settings)).toBeEnabled();
        };

        // ×, then cancel: back to Settings with the change still staged.
        await settings.getByRole('button', { name: '×', exact: true }).click();
        await expectPrompt();
        await prompt.getByRole('button', { name: 'cancel', exact: true }).click();
        await expectStillStaged();

        // Esc asks too.
        await c.auto.focus();
        await page.keyboard.press('Escape');
        await expectPrompt();
        await prompt.getByRole('button', { name: 'cancel', exact: true }).click();
        await expectStillStaged();

        // The backdrop asks too; this time discard, which drops the change.
        await page.mouse.click(2, 2);
        await expectPrompt();
        await prompt.getByRole('button', { name: 'discard', exact: true }).click();
        await expect(prompt).toBeHidden();
        await expect(settings).toBeHidden();
        expect(writes).toEqual([]);
        expect(await serverUpdatesState(api)).toEqual(before);

        // Reopened, the dialog shows the server's value: nothing survived the discard.
        const again = await openUpdatesTab(page);
        const c2 = updatesControls(again.updates);
        await expect(c2.auto).toBeChecked({ checked: before.autoUpdate });
        await expect(footerSave(again.settings)).toBeDisabled();

        // save from the prompt runs 13.4's review, and its Save writes.
        await c2.auto.click();
        await again.settings.getByRole('button', { name: '×', exact: true }).click();
        await expectPrompt();
        const batch = nextBatchResponse(page);
        await prompt.getByRole('button', { name: 'save', exact: true }).click();
        const review = reviewDialog(page);
        await expect(review).toBeVisible();
        await expect(reviewLines(review)).toHaveText([
            `Automatic updates: ${onOff(before.autoUpdate)} → ${onOff(!before.autoUpdate)}`,
        ]);
        expect(writes).toEqual([]);
        await review.getByRole('button', { name: 'Save', exact: true }).click();
        expect((await batch).status()).toBe(200);
        await expect(again.settings).toBeHidden();
        expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['POST /api/settings/batch']);
        expect((await serverUpdatesState(api)).autoUpdate).toBe(!before.autoUpdate);
    });

    test('13.6 channel, automatic updates, interval and GitHub owner are all staged and applied only on save', async ({
        browser,
    }) => {
        if (!server || !api) throw new Error('private server not started');
        const page = await installedPage(browser);
        const before = await serverUpdatesState(api);
        const writes = recordApiWrites(page);

        const { settings, updates } = await openUpdatesTab(page);
        const c = updatesControls(updates);
        const target: UpdatesState = {
            channel: before.channel === 'beta' ? 'stable' : 'beta',
            autoUpdate: !before.autoUpdate,
            updateCheckIntervalMinutes: before.updateCheckIntervalMinutes === 90 ? 120 : 90,
            githubOwner: before.githubOwner === 'e2e-164c-owner-c' ? 'e2e-164c-owner-d' : 'e2e-164c-owner-c',
        };

        // Each control, one at a time, with the server re-read after each: none
        // of them writes on the spot.
        await c.radio(target.channel).check();
        expect(writes).toEqual([]);
        await c.auto.click();
        expect(writes).toEqual([]);
        await typeAndLeave(c.interval, String(target.updateCheckIntervalMinutes));
        expect(writes).toEqual([]);
        await typeAndLeave(c.owner, target.githubOwner);
        await expect(footerSave(settings)).toBeEnabled();
        expect(writes).toEqual([]);
        expect(await serverUpdatesState(api)).toEqual(before);

        // All four in the review, in the row's format.
        const batch = nextBatchResponse(page);
        await footerSave(settings).click();
        const review = reviewDialog(page);
        await expect(review).toBeVisible();
        await expect(reviewLines(review)).toHaveText([
            `Update channel: ${before.channel} → ${target.channel}`,
            `Automatic updates: ${onOff(before.autoUpdate)} → ${onOff(target.autoUpdate)}`,
            `Check interval (minutes): ${before.updateCheckIntervalMinutes} → ${target.updateCheckIntervalMinutes}`,
            `GitHub owner: ${before.githubOwner} → ${target.githubOwner}`,
        ]);
        expect(await serverUpdatesState(api)).toEqual(before);

        await review.getByRole('button', { name: 'Save', exact: true }).click();
        const res = await batch;
        expect(res.status()).toBe(200);
        expect([...((await res.json()) as { applied: string[] }).applied].sort()).toEqual(
            ['autoUpdate', 'channel', 'githubOwner', 'updateCheckIntervalMinutes'].sort(),
        );
        // One batch, carrying raw values of the right types.
        expect(writes).toHaveLength(1);
        const sent = (writes[0]!.body as { changes: { id: string; to: unknown }[] }).changes;
        expect(Object.fromEntries(sent.map((ch) => [ch.id, ch.to]))).toEqual({
            channel: target.channel,
            autoUpdate: target.autoUpdate,
            updateCheckIntervalMinutes: target.updateCheckIntervalMinutes,
            githubOwner: target.githubOwner,
        });
        expect(await serverUpdatesState(api)).toEqual(target);
    });

    test('13.9 a bad interval or a blank owner is refused on the spot and never reaches the review', async ({
        browser,
    }) => {
        if (!server || !api) throw new Error('private server not started');
        const page = await installedPage(browser);
        const before = await serverUpdatesState(api);
        const writes = recordApiWrites(page);

        const { settings, updates } = await openUpdatesTab(page);
        const c = updatesControls(updates);
        // A valid change staged alongside, so Save is live and the review has
        // something to show: what it must NOT show is the refused values.
        await c.auto.click();

        const intervalMsg = 'interval must be between 5 and 1440 minutes';
        for (const bad of ['4', '90.5', '1441']) {
            await typeAndLeave(c.interval, bad);
            await expect(c.refusal(intervalMsg)).toBeVisible();
            // Left on screen for the user to correct, not snapped back.
            await expect(c.interval).toHaveValue(bad);
        }
        // Each under its own field, in that field's item, and not on the status
        // label, which keeps the update state.
        const itemWith = (input: string) =>
            updates
                .locator('.settings-item')
                .filter({ has: page.locator(input) })
                .locator('.settings-status');
        await expect(itemWith('input[type="number"]')).toHaveText(intervalMsg);
        await expect(updates.getByText(`up to date: v${INSTALLED_VERSION}`)).toBeVisible();
        await typeAndLeave(c.owner, '');
        await expect(c.refusal('github owner cannot be empty')).toBeVisible();
        await expect(itemWith('input[type="text"]')).toHaveText('github owner cannot be empty');

        await footerSave(settings).click();
        const review = reviewDialog(page);
        await expect(review).toBeVisible();
        await expect(reviewLines(review)).toHaveText([
            `Automatic updates: ${onOff(before.autoUpdate)} → ${onOff(!before.autoUpdate)}`,
        ]);
        await review.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(review).toBeHidden();

        // The control: a valid interval clears the refusal and DOES reach the
        // review, so the absence above is the guard, not a dead field.
        const goodInterval = before.updateCheckIntervalMinutes === 30 ? 45 : 30;
        await typeAndLeave(c.interval, String(goodInterval));
        await expect(c.refusal(intervalMsg)).toHaveCount(0);
        await footerSave(settings).click();
        await expect(review).toBeVisible();
        await expect(reviewLines(review)).toHaveText([
            `Automatic updates: ${onOff(before.autoUpdate)} → ${onOff(!before.autoUpdate)}`,
            `Check interval (minutes): ${before.updateCheckIntervalMinutes} → ${goodInterval}`,
        ]);
        await review.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(review).toBeHidden();

        // Walk away without saving: nothing was ever written.
        await settings.getByRole('button', { name: '×', exact: true }).click();
        await unsavedDialog(page).getByRole('button', { name: 'discard', exact: true }).click();
        await expect(settings).toBeHidden();
        expect(writes).toEqual([]);
        expect(await serverUpdatesState(api)).toEqual(before);
    });

    test('13.9 a build that is not installed shows the dev-mode note and no update controls', async ({ browser }) => {
        if (!server || !api) throw new Error('private server not started');
        // Unstubbed: the fast tier's `node dist/index.js` is exactly such a build.
        const status = (await (await api.get('/api/updates/status')).json()) as { isInstalled: boolean };
        expect(status.isInstalled, 'the fast-tier server is not an installed build').toBe(false);

        const fresh = await freshPage(browser, server.paths.baseURL);
        context = fresh.context;
        await fresh.page.goto('/');
        const settings = await openSettings(fresh.page);
        const updates = await openSettingsTab(settings, 'Updates');
        await expect(updates.locator('.settings-stub-note')).toContainText('dev mode — packaging features disabled');
        const c = updatesControls(updates);
        await expect(c.auto).toHaveCount(0);
        await expect(c.interval).toHaveCount(0);
        await expect(c.owner).toHaveCount(0);
        await expect(updates.getByRole('radio')).toHaveCount(0);
    });
});

test.describe('settings dialog: the dependency alert (smoke 13.7)', () => {
    test('13.7 the top-bar dependency alert shows only when something needs updating and opens Settings on Dependencies', async ({
        page,
    }) => {
        // Stubbed from the REAL list: every dependency the server reports, with
        // the status forced. A fresh install hydrates the newest of everything,
        // so "an update is waiting" cannot be produced for real here.
        let pending = false;
        let hits = 0;
        let adbName = '';
        await page.route('**/api/dependencies', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            hits += 1;
            const res = await route.fetch();
            const real = (await res.json()) as Record<string, unknown>[];
            adbName = String(real.find((d) => d['name'] === 'adb')?.['displayName'] ?? '');
            const deps = real.map((d) =>
                d['name'] === 'adb' && pending
                    ? { ...d, status: 'update-available', latestVersion: '99.0.0', canUpdate: true }
                    : { ...d, status: 'up-to-date', latestVersion: d['installedVersion'] ?? d['latestVersion'] },
            );
            await route.fulfill({ response: res, json: deps });
        });
        await page.clock.install();
        await page.goto('/');

        const badge = page.locator('.dependency-alert-badge');
        // The card is appended only AFTER its first read resolved, so a mounted
        // badge is one that has already decided.
        await expect(badge).toHaveCount(1);
        expect(hits).toBeGreaterThan(0);
        expect(adbName, 'the server lists adb').not.toBe('');
        await expect(badge).toBeHidden();

        // An update appears: the next poll (15 s) shows the icon button, named
        // for the dependency by its display name.
        pending = true;
        await page.clock.fastForward(15_000);
        const open = page.getByRole('button', { name: `${adbName} has an update available`, exact: true });
        await expect(open).toBeVisible();

        // It opens Settings ON the Dependencies tab, not on the first tab.
        await open.click();
        const settings = page.locator('dialog.settings-modal[open]');
        await expect(settings).toBeVisible();
        await expect(settings.getByRole('tab', { name: 'Dependencies', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(settings.getByRole('tab', { name: 'Users', exact: true })).toHaveAttribute(
            'aria-selected',
            'false',
        );
        await expect(settings.locator('section[data-settings-tab="dependencies"]')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(settings).toBeHidden();

        // Nothing to update again: the button hides on the next poll.
        pending = false;
        await page.clock.fastForward(15_000);
        await expect(badge).toBeHidden();
        await expect(open).toHaveCount(0);
    });
});

test.describe('settings dialog: the top-bar update pill (smoke 6.9)', () => {
    test('6.9 the pill moves checking → downloading N% → apply update vX → restarting, and a failed check offers a retry', async ({
        page,
    }) => {
        // Stubbed through each state, as the register line says: the fast tier
        // is not an installed build, so the real status is always "dev mode,
        // hidden". The apply and check POSTs are stubbed too, so the shared
        // server is never asked to do either.
        let state: Record<string, unknown> = { status: 'checking' };
        await page.route('**/api/updates/status', async (route) => {
            const res = await route.fetch();
            const real = (await res.json()) as Record<string, unknown>;
            await route.fulfill({
                response: res,
                json: { ...real, isInstalled: true, currentVersion: '0.1.0', ...state },
            });
        });
        const posts: string[] = [];
        await page.route('**/api/updates/apply', async (route) => {
            posts.push(`${route.request().method()} /api/updates/apply`);
            await route.fulfill({ status: 200, json: { ok: true } });
        });
        await page.route('**/api/updates/check', async (route) => {
            posts.push(`${route.request().method()} /api/updates/check`);
            const res = await route.fetch({ method: 'GET', url: route.request().url().replace('/check', '/status') });
            const real = (await res.json()) as Record<string, unknown>;
            await route.fulfill({ status: 200, json: { ...real, isInstalled: true, status: 'idle' } });
        });
        await page.clock.install();
        await page.goto('/');

        const pill = page.locator('.update-button-container');
        await expect(pill).toBeVisible();
        await expect(pill).toHaveText('checking…');

        // checking polls every 30 s; downloading every 2 s.
        state = { status: 'downloading', availableVersion: '9.9.9', progress: 42.4 };
        await page.clock.fastForward(30_000);
        await expect(pill).toHaveText('downloading update… 42%');
        state = { status: 'downloading', availableVersion: '9.9.9', progress: 87 };
        await page.clock.fastForward(2_000);
        await expect(pill).toHaveText('downloading update… 87%');

        state = { status: 'ready', availableVersion: '9.9.9' };
        await page.clock.fastForward(2_000);
        const apply = pill.getByRole('button', { name: 'apply update v9.9.9', exact: true });
        await expect(apply).toBeVisible();
        await apply.click();
        await expect(pill).toHaveText('restarting…');
        expect(posts).toEqual(['POST /api/updates/apply']);

        // A failed check: "update check failed" with a retry, on a fresh load.
        state = { status: 'error', errorMessage: 'no releases found for owner e2e-nobody' };
        await page.goto('/');
        await expect(pill).toBeVisible();
        await expect(pill.locator('.update-button-label')).toHaveText('update check failed');
        await expect(pill).toHaveAttribute('title', 'update check failed: no releases found for owner e2e-nobody');
        const retry = pill.getByRole('button', { name: 'retry', exact: true });
        await expect(retry).toBeVisible();

        // Retry runs a check, and a check that comes back clean hides the pill.
        await retry.click();
        await expect.poll(() => posts).toEqual(['POST /api/updates/apply', 'POST /api/updates/check']);
        await expect(pill).toBeHidden();
    });
});

test.describe('settings dialog: the batch on the server (smoke 13.8)', () => {
    test('13.8 the batch is journalled, the web port applies last, an unfinished batch is abandoned at boot, and bad ids and values are refused', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const name = 'batch-1308';
        let server: PrivateServer | undefined;
        let context: BrowserContext | undefined;
        try {
            server = await startPrivateServer(name, 8172);
            await dismissPrivatePrompts(server.paths.baseURL);
            let api = await apiContext(server.paths.baseURL);
            const before = await serverUpdatesState(api);
            await api.dispose();

            // --- The real Save, web port plus one other setting (13.4's dialog) ---
            const fresh = await freshPage(browser, server.paths.baseURL);
            context = fresh.context;
            const page = fresh.page;
            await stubInstalledUpdates(page);
            await page.goto('/');
            const { settings, updates } = await openUpdatesTab(page);
            const owner = `e2e-164c-batch-${before.githubOwner === 'e2e-164c-batch-1' ? 2 : 1}`;
            await typeAndLeave(updatesControls(updates).owner, owner);
            const serverTab = await openSettingsTab(settings, 'Server');
            const portInput = settingsRow(serverTab, 'http port').locator('input');
            await expect(portInput).toHaveValue('8172');
            await typeAndLeave(portInput, '8173');

            const batch = nextBatchResponse(page);
            const redirect = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).port === '8173', {
                timeout: 20_000,
            });
            await footerSave(settings).click();
            const review = reviewDialog(page);
            await expect(review).toBeVisible();
            await expect(reviewLines(review)).toHaveText([
                `GitHub owner: ${before.githubOwner} → ${owner}`,
                'HTTP port: 8172 → 8173',
            ]);
            await expect(review.locator('.settings-summary__restart')).toContainText(
                'Changing the HTTP port will restart the server.',
            );
            await review.getByRole('button', { name: 'Save', exact: true }).click();
            const res = await batch;
            // This is the request the beta.156 Save-404 never got an answer to.
            expect(res.status()).toBe(200);
            expect(await res.json()).toEqual({
                ok: true,
                applied: ['githubOwner', 'webPort'],
                restartRequired: true,
                redirectPort: 8173,
            });
            // On the status line of the tab Save was clicked from (0.5.5), and
            // the footer has no line of its own any more.
            await expect(settingsTabLine(serverTab)).toHaveText('restarting → redirecting…');
            await expect(settings.locator('.modal-footer [data-settings-alert], .settings-save-status')).toHaveCount(0);
            // Exit 75 is the supervisor's restart signal; the browser follows.
            const exit1 = await withTimeout(server.handle.exited, 15_000, () => server!.handle.output());
            expect(exit1.code).toBe(75);
            expect(new URL((await redirect).url()).hostname).toBe('localhost');
            expect(readConfigFile(server.paths)['webPort']).toBe(8173);
            const walAfterUi = walRows(server.paths.dbPath);
            const uiRow = walAfterUi.at(-1)!;
            expect(uiRow.status).toBe('completed');
            expect(uiRow.changes.map((ch) => [ch.id, ch.to])).toEqual([
                ['githubOwner', owner],
                ['webPort', 8173],
            ]);
            await context.close();
            context = undefined;

            // --- The web port is applied LAST even when it is sent first ---
            server = await restartOnPort(name, 8173);
            api = await apiContext(server.paths.baseURL);
            expect((await serverUpdatesState(api)).githubOwner).toBe(owner);
            const otherChannel = before.channel === 'beta' ? 'stable' : 'beta';
            const portFirst = await api.post('/api/settings/batch', {
                data: {
                    changes: [
                        { id: 'webPort', label: 'HTTP port', from: 8173, to: 8172 },
                        { id: 'channel', label: 'Update channel', from: before.channel, to: otherChannel },
                    ],
                },
            });
            expect(portFirst.status()).toBe(200);
            expect(await portFirst.json()).toEqual({
                ok: true,
                applied: ['channel', 'webPort'],
                restartRequired: true,
                redirectPort: 8172,
            });
            await api.dispose();
            expect((await withTimeout(server.handle.exited, 15_000, () => server!.handle.output())).code).toBe(75);

            // --- A batch left pending (what a kill mid-apply leaves) is NOT re-applied ---
            const planted = plantPendingBatch(server.paths.dbPath, [
                { id: 'githubOwner', label: 'GitHub owner', to: 'e2e-164c-must-not-apply' },
            ]);
            server = await restartOnPort(name, 8172);
            api = await apiContext(server.paths.baseURL);
            const paths = server.paths;
            await expect
                .poll(() => readServerLog(paths), { message: 'the boot reports the unfinished batch' })
                .toContain(
                    `batch ${planted} was still pending at boot (1 change(s)); marking abandoned and NOT applying it`,
                );
            // Only the unfinished one: the two completed batches were never reported.
            expect(readServerLog(paths)).not.toContain(`batch ${uiRow.id} was still pending`);
            expect(walRows(paths.dbPath).find((r) => r.id === planted)?.status).toBe('abandoned');
            const afterBoot = await serverUpdatesState(api);
            expect(afterBoot.githubOwner).toBe(owner);
            expect(afterBoot.channel).toBe(otherChannel);

            // --- An unknown setting id is refused, before any journal row ---
            const walCount = walRows(paths.dbPath).length;
            const unknown = await api.post('/api/settings/batch', {
                data: { changes: [{ id: 'e2eNotASetting', label: 'x', from: 1, to: 2 }] },
            });
            expect(unknown.status()).toBe(400);
            expect(await unknown.json()).toEqual({ error: 'not a stageable setting: e2eNotASetting' });
            expect(walRows(paths.dbPath)).toHaveLength(walCount);
            // Control: a stageable id in the same shape is accepted and journalled.
            const valid = await api.post('/api/settings/batch', {
                data: {
                    changes: [
                        {
                            id: 'autoUpdate',
                            label: 'Automatic updates',
                            from: before.autoUpdate,
                            to: !before.autoUpdate,
                        },
                    ],
                },
            });
            expect(valid.status()).toBe(200);
            expect(walRows(paths.dbPath)).toHaveLength(walCount + 1);
            expect(walRows(paths.dbPath).at(-1)?.status).toBe('completed');

            // --- Bad PATCH /api/config values: 400 naming the field, nothing written ---
            const stateBefore = await serverUpdatesState(api);
            const bytesBefore = readConfigBytes(paths);
            for (const [field, value] of [
                ['webPort', 80],
                ['channel', 'nightly'],
                ['updateCheckIntervalMinutes', 0],
            ] as const) {
                const bad = await api.patch('/api/config', { data: { [field]: value } });
                expect(bad.status(), `PATCH ${field}=${value}`).toBe(400);
                const answer = (await bad.json()) as { error: string; field: string };
                expect(answer.field).toBe(field);
                expect(answer.error).toContain(field);
                expect(readConfigBytes(paths), `config.json after PATCH ${field}=${value}`).toBe(bytesBefore);
                expect(await serverUpdatesState(api)).toEqual(stateBefore);
            }
            // Still up on the same port (a webPort write would have exited it).
            expect(server.handle.child.exitCode).toBeNull();
            // Control: a good value through the same route is written.
            const good = await api.patch('/api/config', { data: { channel: before.channel } });
            expect(good.status()).toBe(200);
            expect((await serverUpdatesState(api)).channel).toBe(before.channel);
            await api.dispose();
        } finally {
            await context?.close();
            await disposePrivateServer(server);
        }
    });
});

test.describe('settings dialog: the port hand-off keeps the host (smoke 13.11)', () => {
    test('13.11 from 127.0.0.1 a web-port save lands on 127.0.0.1, the reminder cards name 127.0.0.1, and PATCH /api/config returns redirectPort', async ({
        browser,
    }) => {
        test.setTimeout(300_000);
        const name = 'handoff-1311';
        let server: PrivateServer | undefined;
        let context: BrowserContext | undefined;
        try {
            server = await startPrivateServer(name, 8174);
            // Acknowledge THIS port only, the "got it" state: the card stays off
            // here and comes back once the port has moved — which is the card
            // whose address this row is about.
            const seed = await apiContext(server.paths.baseURL);
            expect(
                (
                    await seed.patch('/api/settings', {
                        data: { bookmarkDismissedForPort: 8174, serviceFirstRunSeen: true },
                    })
                ).status(),
            ).toBe(200);
            await seed.dispose();

            const loopbackIp = 'http://127.0.0.1:8174';
            context = await browser.newContext({ baseURL: loopbackIp });
            const page = await context.newPage();
            await stubInstalledUpdates(page);
            await page.goto('/');
            expect(new URL(page.url()).hostname).toBe('127.0.0.1');

            const settings = await openSettings(page);
            const serverTab = await openSettingsTab(settings, 'Server');
            const portInput = settingsRow(serverTab, 'http port').locator('input');
            await expect(portInput).toHaveValue('8174');
            await typeAndLeave(portInput, '8175');
            const batch = nextBatchResponse(page);
            const redirect = page.waitForRequest((r) => r.isNavigationRequest() && new URL(r.url()).port === '8175', {
                timeout: 20_000,
            });
            await footerSave(settings).click();
            const review = reviewDialog(page);
            await expect(reviewLines(review)).toHaveText(['HTTP port: 8174 → 8175']);
            await review.getByRole('button', { name: 'Save', exact: true }).click();
            const res = await batch;
            expect(res.status()).toBe(200);
            expect(((await res.json()) as { redirectPort?: number }).redirectPort).toBe(8175);

            // The hand-off keeps the browser's host and changes only the port. A
            // literal localhost here is the regression the row exists for.
            const target = new URL((await redirect).url());
            expect(target.hostname).toBe('127.0.0.1');
            expect(target.port).toBe('8175');
            expect(target.protocol).toBe('http:');
            expect((await withTimeout(server.handle.exited, 15_000, () => server!.handle.output())).code).toBe(75);

            // The supervisor's part, then the page on the new port.
            server = await restartOnPort(name, 8175);
            await page.goto('http://127.0.0.1:8175/');
            const bookmark = page.locator('.bookmark-reminder[data-kind="bookmark"]');
            await expect(bookmark).toBeVisible();
            await expect(bookmark.locator('a')).toHaveText('http://127.0.0.1:8175');
            await expect(bookmark).toContainText('this app lives at http://127.0.0.1:8175');

            // The service card's wording names the browser's address too (the
            // install mode stubbed: a real service install is the guest tier).
            const prefs = await page.request.patch('http://127.0.0.1:8175/api/settings', {
                data: { serviceFirstRunSeen: false },
            });
            expect(prefs.status()).toBe(200);
            await page.route('**/api/config', async (route) => {
                if (route.request().method() !== 'GET') return route.continue();
                const real = await route.fetch();
                const env = (await real.json()) as { config: Record<string, unknown> };
                await route.fulfill({
                    response: real,
                    json: { ...env, config: { ...env.config, installMode: 'user-service' } },
                });
            });
            await page.reload();
            const serviceCard = page.locator('.bookmark-reminder[data-kind="service"]');
            await expect(serviceCard).toBeVisible();
            await expect(serviceCard.locator('a')).toHaveText('http://127.0.0.1:8175');
            await expect(serviceCard).toContainText('this page lives at http://127.0.0.1:8175');

            // PATCH /api/config names only the new PORT (redirectPort), never a URL.
            const patch = await page.request.patch('http://127.0.0.1:8175/api/config', { data: { webPort: 8174 } });
            expect(patch.status()).toBe(200);
            const patchBody = (await patch.json()) as { restartRequired: boolean; redirectPort?: number };
            expect(patchBody.restartRequired).toBe(true);
            expect(patchBody.redirectPort).toBe(8174);
            expect(JSON.stringify(patchBody)).not.toContain('localhost');
            expect((await withTimeout(server.handle.exited, 15_000, () => server!.handle.output())).code).toBe(75);
            expect(readConfigFile(server.paths)['webPort']).toBe(8174);
        } finally {
            await context?.close();
            await disposePrivateServer(server);
        }
    });
});
