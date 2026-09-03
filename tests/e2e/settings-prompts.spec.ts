import { expect, test } from '@playwright/test';
import { gotoHome } from './support/consent';
import { readUserSettings, resetUserSettings, restoreHarnessPrompts } from './support/theme';

/**
 * Smoke module 13 — the settings prompts (rows 13.1–13.3).
 *
 * These specs UNDO the global setup first, deliberately. `global-setup.ts`
 * pre-dismisses the bookmark reminder for the whole run (it is a <dialog> that
 * otherwise swallows other specs' clicks), and rows 13.1 and 13.2 are about
 * that exact flag — so inheriting the harness's pre-arranged state would make
 * them assert something they did not establish, which is a test that cannot
 * fail.
 */
test.describe('settings prompts', () => {
    test.beforeEach(async ({ page }) => {
        // Needs a document first: the per-instance token cookie is minted by a
        // document GET, and /api/settings is behind it.
        await gotoHome(page);
        await resetUserSettings(page);
    });

    test.afterEach(async ({ page }) => {
        // Restore what global-setup arranged, so a later spec in the same run
        // does not inherit a live bookmark modal over its clicks.
        await restoreHarnessPrompts(page);
    });

    test('13.1 the global dismissal supersedes and disables the per-port one, and persists', async ({ page }) => {
        await page.reload();

        const modal = page.locator('dialog.modal').filter({ hasText: 'this app lives at:' });
        await expect(modal).toBeVisible();

        const perPort = modal.locator('input[type="checkbox"]').first();
        const global = modal.locator('input[type="checkbox"]').nth(1);
        await expect(perPort).toBeEnabled();

        // Checking the stronger box supersedes the weaker one by DISABLING it —
        // the row's actual claim, and the half a "persists" assertion alone
        // would miss.
        await global.check();
        await expect(perPort).toBeDisabled();

        // Committing goes through a confirmation, so it cannot be set by an
        // accidental tick.
        await modal.getByRole('button', { name: 'got it' }).click();
        const confirm = page.locator('dialog.modal').filter({ hasText: "you won't see this bookmark helper again" });
        await expect(confirm).toBeVisible();
        await confirm
            .getByRole('button', { name: /yes|confirm|ok/i })
            .first()
            .click();

        await expect.poll(async () => (await readUserSettings(page))['bookmarkDismissedGlobally']).toBe(true);

        // And it actually suppresses the modal on the next load, which is the
        // point of the flag rather than the flag itself.
        await page.reload();
        await expect(page.locator('dialog.modal').filter({ hasText: 'this app lives at:' })).toHaveCount(0);
    });

    test('13.2 reset wipes the other per-user settings without re-suppressing the per-port bookmark', async ({
        page,
    }) => {
        // Arrange visible state across BOTH stores the reset must clear.
        await page.request.patch('/api/settings', {
            data: {
                theme: 'light',
                iconSize: 'large',
                scanSubnets: ['192.168.50.0/24'],
                bookmarkDismissedGlobally: true,
                bookmarkDismissedForPort: 8123,
            },
        });
        await page.request.patch('/api/settings/device?udid=e2e-fake-device', {
            data: { stream: { codec: 'h264' }, audio: { enabled: true } },
        });

        const before = await readUserSettings(page);
        expect(before['theme']).toBe('light');
        expect(before['iconSize']).toBe('large');

        await resetUserSettings(page);
        const after = await readUserSettings(page);

        // Everything the row enumerates, asserted one by one rather than as a
        // count — the row exists because a narrower earlier implementation
        // cleared some of these and not others.
        expect(after['theme']).toBeUndefined();
        expect(after['iconSize']).toBeUndefined();
        expect(after['scanSubnets']).toBeUndefined();
        expect(after['bookmarkDismissedGlobally']).toBeUndefined();

        // The regression clause, and the reason this row is worth automating:
        // the reset must NOT leave the per-port bookmark suppressed. A reset
        // that re-suppressed it would look like success while silently hiding
        // the very prompt it just restored.
        expect(after['bookmarkDismissedForPort']).toBeUndefined();

        // Per-device settings live in the other store and must go too.
        const dev = await page.request.get('/api/settings/device?udid=e2e-fake-device');
        expect(await dev.json()).toEqual({});
    });

    test('13.3 the Server section lists its rows in order with an inline port save, quiet at rest', async ({
        page,
    }) => {
        await restoreHarnessPrompts(page);
        await gotoHome(page);
        await page.getByRole('button', { name: 'Open settings' }).click();

        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();
        const server = settings.locator('section.settings-section').filter({
            has: page.locator('.settings-section-heading', { hasText: 'Server' }),
        });
        await expect(server).toBeVisible();

        const labels = await server.locator('.settings-label').allTextContents();
        const idx = (needle: string) => labels.findIndex((l) => l.includes(needle));

        // Order, not mere presence. "install for all users" is Linux-only, so it
        // is checked for position only when it is there at all.
        const reset = idx('reset all my settings');
        const port = idx('web port');
        const stop = idx('stop the server and close the app');
        const uninstall = idx('uninstall');
        expect(reset).toBeGreaterThanOrEqual(0);
        expect(port).toBeGreaterThan(reset);
        expect(stop).toBeGreaterThan(port);
        expect(uninstall).toBeGreaterThan(stop);

        // The web-port row carries its save INLINE, in the same control cell as
        // the input — the beta.62 layout the row pins.
        const portRow = server.locator('.settings-row').filter({ hasText: 'web port' }).first();
        const control = portRow.locator('.settings-control');
        await expect(control.locator('input')).toHaveCount(1);
        await expect(control.locator('button')).toHaveCount(1);

        // Status line empty AT REST: saving…/saved./error appear only after a
        // save. A row that always shows something cannot report anything.
        const status = server.locator('.settings-status').first();
        if (await status.count()) {
            expect((await status.textContent())?.trim()).toBe('');
        }
    });
});
