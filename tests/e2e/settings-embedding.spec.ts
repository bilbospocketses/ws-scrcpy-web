import { expect, type Locator, test } from '@playwright/test';
import { askToEmbed, gotoHome, readServerConfig, revokeAllOrigins, waitForPrompt } from './support/consent';
import { SEED_CONFIG } from './support/paths';
import { footerSave, reviewDialog, reviewLines, unsavedDialog } from './support/settingsUi';

const ORIGIN = 'http://localhost:5159';

/** The Embedding tab's add row (0.5.3): address, port, scheme, add, and the line under it. */
function addRow(settings: Locator) {
    return {
        address: settings.getByRole('textbox', { name: 'embedder address' }),
        port: settings.getByRole('textbox', { name: 'embedder port' }),
        scheme: settings.getByRole('combobox', { name: 'embedder scheme' }),
        add: settings.locator('[data-embed-add-button]'),
        message: settings.locator('[data-embed-add-message]'),
        pending: (origin: string) => settings.locator(`[data-embed-pending="${origin}"]`),
        allPending: settings.locator('[data-embed-pending]'),
    };
}

/**
 * Open Settings on its Embedding tab.
 *
 * The dialog opens on Users, and every other tab body carries `hidden`. Every
 * assertion below is about what the operator can see and click, so the tab has
 * to be the open one — including the "no origin is allow-listed" copy, which
 * `toContainText` would otherwise read straight out of a closed tab.
 */
async function openEmbeddingSettings(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.locator('dialog.settings-modal[open]');
    await expect(settings).toBeVisible();
    await settings.getByRole('tab', { name: 'Embedding', exact: true }).click();
    return settings;
}

/**
 * Settings -> Embedding: the only place an operator can withdraw a permission they
 * previously granted, without hand-editing config.json.
 */
test.describe('settings / embedding', () => {
    test.afterEach(async ({ page }) => {
        await gotoHome(page);
        await revokeAllOrigins(page);
    });

    test('says so plainly when no origin is allow-listed', async ({ page }) => {
        await gotoHome(page);
        const settings = await openEmbeddingSettings(page);

        await expect(settings).toContainText('No other origins may embed this app.');
    });

    test('lists an approved origin with a way to revoke it', async ({ page, request }) => {
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
        await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);

        const settings = await openEmbeddingSettings(page);

        await expect(settings).toContainText(ORIGIN);
        await expect(settings.getByRole('button', { name: 'revoke' })).toBeVisible();
    });

    test('asks for confirmation before revoking, and the origin survives a cancel', async ({ page, request }) => {
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
        await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);

        const settings = await openEmbeddingSettings(page);
        await settings.getByRole('button', { name: 'revoke' }).click();

        // Revoking breaks whatever that origin is currently displaying, so it is a
        // confirmed action rather than a single click.
        const confirm = page.locator('dialog.confirm-modal[open]');
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText(ORIGIN);

        await confirm.getByRole('button', { name: 'cancel', exact: true }).click();
        expect(readServerConfig().frameAncestors).toContain(ORIGIN);
    });

    test('revoking removes the origin from the list and from config', async ({ page, request }) => {
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
        await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);

        const settings = await openEmbeddingSettings(page);
        await settings.getByRole('button', { name: 'revoke' }).click();
        await page.locator('dialog.confirm-modal[open]').getByRole('button', { name: 'ok', exact: true }).click();

        await expect(settings).toContainText('No other origins may embed this app.');
        await expect.poll(() => readServerConfig().frameAncestors).not.toContain(ORIGIN);

        // Same integrity guarantee as approving: revoking amends the file, it does
        // not rewrite it and lose the keys the server booted from.
        const after = readServerConfig();
        expect(after.webPort).toBe(SEED_CONFIG.webPort);
        expect(after.installMode).toBe(SEED_CONFIG.installMode);
        expect(after.firstRunComplete).toBe(SEED_CONFIG.firstRunComplete);
    });

    test('10.22 a pre-approved embedder is staged as pending and written only by save', async ({ page, request }) => {
        await gotoHome(page);
        const settings = await openEmbeddingSettings(page);
        const row = addRow(settings);
        await expect(row.scheme).toHaveValue('http');
        await expect(row.port).toHaveAttribute('placeholder', '80');

        await row.address.fill('localhost');
        await row.port.fill('5159');
        await row.add.click();

        // Listed, marked pending, removable -- and nothing written yet.
        await expect(row.pending(ORIGIN)).toContainText('pending — saved when you click save');
        await expect(row.pending(ORIGIN).getByRole('button', { name: `remove ${ORIGIN} before saving` })).toBeVisible();
        await expect(row.address).toHaveValue('');
        await expect(footerSave(settings)).toBeEnabled();
        expect(readServerConfig().frameAncestors ?? []).not.toContain(ORIGIN);

        // Save → Review changes names it; Save there writes it.
        await footerSave(settings).click();
        const review = reviewDialog(page);
        await expect(reviewLines(review)).toHaveText([`Allowed embedders: none added → add ${ORIGIN}`]);
        await review.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('dialog.settings-modal[open]')).toBeHidden();

        await expect.poll(() => readServerConfig().frameAncestors).toEqual([ORIGIN]);
        // Applied to the running server, like a consent approval: no restart.
        const res = await request.get('/');
        expect(res.headers()['content-security-policy']).toBe(`frame-ancestors 'self' ${ORIGIN}`);
        // And it amended config.json rather than rewriting it.
        const after = readServerConfig();
        expect(after.webPort).toBe(SEED_CONFIG.webPort);
        expect(after.installMode).toBe(SEED_CONFIG.installMode);

        // Reopened, it is an ordinary approved origin, with revoke.
        const again = await openEmbeddingSettings(page);
        await expect(again).toContainText(ORIGIN);
        await expect(again.getByRole('button', { name: 'revoke' })).toBeVisible();
        await expect(addRow(again).allPending).toHaveCount(0);
    });

    test('10.22 closing without saving discards a pending embedder, and one can be removed before saving', async ({
        page,
    }) => {
        await gotoHome(page);
        const settings = await openEmbeddingSettings(page);
        const row = addRow(settings);

        // Removed before saving: gone, and the dialog is clean again.
        await row.address.fill('localhost');
        await row.port.fill('5159');
        await row.add.click();
        await row
            .pending(ORIGIN)
            .getByRole('button', { name: `remove ${ORIGIN} before saving` })
            .click();
        await expect(row.allPending).toHaveCount(0);
        await expect(footerSave(settings)).toBeDisabled();
        await expect(settings).toContainText('No other origins may embed this app.');

        // Staged again, then the dialog closed with discard: nothing written.
        await row.address.fill('localhost');
        await row.port.fill('5159');
        await row.add.click();
        await settings.getByRole('button', { name: '×', exact: true }).click();
        const prompt = unsavedDialog(page);
        await expect(prompt).toBeVisible();
        await prompt.getByRole('button', { name: 'discard', exact: true }).click();
        await expect(page.locator('dialog.settings-modal[open]')).toBeHidden();
        expect(readServerConfig().frameAncestors ?? []).not.toContain(ORIGIN);

        const again = await openEmbeddingSettings(page);
        await expect(again).toContainText('No other origins may embed this app.');
        await expect(addRow(again).allPending).toHaveCount(0);
    });

    test('10.23 the add row refuses a bad address or port inline, adds two for http & https, and never stages a duplicate', async ({
        page,
        request,
    }) => {
        // One origin already approved, through the consent prompt.
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
        await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);

        const settings = await openEmbeddingSettings(page);
        const row = addRow(settings);

        // A bad address: the reason inline, add disabled.
        await row.address.fill('not_a_host');
        await expect(row.message).toHaveText('"not_a_host" is not a valid ip address or hostname.');
        await expect(row.add).toBeDisabled();
        await row.address.fill('localhost:5159');
        await expect(row.message).toHaveText('enter the port in the port box, not after the address.');
        await expect(row.add).toBeDisabled();
        await row.address.fill('http://localhost');
        await expect(row.message).toHaveText(
            'enter only the address: choose the scheme from the list, and leave out any path.',
        );
        await expect(row.add).toBeDisabled();

        // A bad port: likewise, above the range and below it.
        await row.address.fill('localhost');
        await row.port.fill('70000');
        await expect(row.message).toHaveText('port must be a whole number from 1 to 65535.');
        await expect(row.add).toBeDisabled();
        await row.port.fill('0');
        await expect(row.message).toHaveText('port must be a whole number from 1 to 65535.');
        await expect(row.add).toBeDisabled();
        await row.port.fill('5159');
        await expect(row.message).toBeHidden();
        await expect(row.add).toBeEnabled();

        // Already approved: refused, nothing staged.
        await row.add.click();
        await expect(row.message).toHaveText(`${ORIGIN} is already allowed.`);
        await expect(row.allPending).toHaveCount(0);
        await expect(footerSave(settings)).toBeDisabled();

        // http & https on a new port: two pending origins; a default port is
        // stored as no port, the way a browser sends it.
        await row.address.fill('::1');
        await row.port.fill('');
        await row.scheme.selectOption({ label: 'http & https' });
        await row.add.click();
        await expect(row.pending('http://[::1]')).toBeVisible();
        await expect(row.pending('https://[::1]')).toBeVisible();

        // The same again: already waiting, still two.
        await row.address.fill('[::1]');
        await row.add.click();
        await expect(row.message).toHaveText(
            'http://[::1] is already waiting to be saved; https://[::1] is already waiting to be saved.',
        );
        await expect(row.allPending).toHaveCount(2);

        // A typed default port is stored as no port.
        await row.scheme.selectOption({ label: 'http' });
        await row.address.fill('tools.example');
        await row.port.fill('80');
        await row.add.click();
        await expect(row.pending('http://tools.example')).toBeVisible();
        await row.scheme.selectOption({ label: 'https' });
        await row.address.fill('192.168.1.50');
        await row.port.fill('443');
        await row.add.click();
        await expect(row.pending('https://192.168.1.50')).toBeVisible();
        await expect(row.allPending).toHaveCount(4);

        // Leave nothing behind on the shared server.
        await settings.getByRole('button', { name: '×', exact: true }).click();
        await unsavedDialog(page).getByRole('button', { name: 'discard', exact: true }).click();
        expect(readServerConfig().frameAncestors).toEqual([ORIGIN]);
    });
});
