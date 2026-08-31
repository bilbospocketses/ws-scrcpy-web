import { expect, test } from '@playwright/test';
import { askToEmbed, gotoHome, readServerConfig, revokeAllOrigins, waitForPrompt } from './support/consent';
import { SEED_CONFIG } from './support/paths';

const ORIGIN = 'http://localhost:5159';

/** Open Settings and return its Embedding section. */
async function openEmbeddingSettings(page: import('@playwright/test').Page) {
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.locator('dialog.settings-modal');
    await expect(settings).toBeVisible();
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
        const confirm = page.locator('dialog.confirm-modal');
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
        await page.locator('dialog.confirm-modal').getByRole('button', { name: 'ok', exact: true }).click();

        await expect(settings).toContainText('No other origins may embed this app.');
        await expect.poll(() => readServerConfig().frameAncestors).not.toContain(ORIGIN);

        // Same integrity guarantee as approving: revoking amends the file, it does
        // not rewrite it and lose the keys the server booted from.
        const after = readServerConfig();
        expect(after.webPort).toBe(SEED_CONFIG.webPort);
        expect(after.installMode).toBe(SEED_CONFIG.installMode);
        expect(after.firstRunComplete).toBe(SEED_CONFIG.firstRunComplete);
    });
});
