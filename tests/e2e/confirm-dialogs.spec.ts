import { expect, type Locator, type Page, test } from '@playwright/test';
import { openSettings, settingsSection } from './support/auth';
import { askToEmbed, gotoHome, readServerConfig, revokeAllOrigins, waitForPrompt } from './support/consent';

/**
 * Smoke row 4.5 — confirm-dialog button style (item 35): the cancel/confirm
 * buttons of a confirm dialog use the shared outline style — the text colour
 * as a hairline border on a transparent ground, "white-outline + white-text"
 * in the dark theme — matching the welcome / bookmark / service-first-run
 * modals rather than each dialog styling its own.
 *
 * The row names the service install/uninstall "privileges required" confirm
 * and the "end shell session" confirm. This tier can open the first
 * (`AdminConfirmModal` is a pre-flight: it opens BEFORE any privileged call,
 * so cancelling it touches nothing) and the generic `ConfirmModal` the
 * Embedding revoke uses; the shell-close confirm needs a live shell session,
 * which needs a device, so its class is pinned by its unit test instead
 * (`src/app/client/__tests__/ShellCloseConfirmModal.test.ts`).
 *
 * Two assertions per dialog: the shared class on both buttons, and the
 * computed style it resolves to. Then the "matching" claim itself: the
 * computed values are identical across the dialogs opened here.
 */

const ORIGIN = 'http://localhost:5161';

interface ButtonStyle {
    color: string;
    borderColor: string;
    borderStyle: string;
    background: string;
}

async function styleOf(button: Locator): Promise<ButtonStyle> {
    return button.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
            color: s.color,
            borderColor: s.borderTopColor,
            borderStyle: s.borderTopStyle,
            background: s.backgroundColor,
        };
    });
}

async function expectSharedStyle(
    dialog: Locator,
    cancel: Locator,
    confirm: Locator,
): Promise<[ButtonStyle, ButtonStyle]> {
    await expect(dialog).toBeVisible();
    await expect(cancel).toHaveClass(/\bmodal-button\b/);
    await expect(confirm).toHaveClass(/\bmodal-button\b/);
    const styles: [ButtonStyle, ButtonStyle] = [await styleOf(cancel), await styleOf(confirm)];
    for (const s of styles) {
        // The outline IS the text colour, on nothing: that is the shared look.
        expect(s.borderStyle).toBe('solid');
        expect(s.borderColor).toBe(s.color);
        expect(s.background).toBe('rgba(0, 0, 0, 0)');
    }
    return styles;
}

async function approveOrigin(page: Page, request: Parameters<typeof askToEmbed>[0]): Promise<void> {
    await askToEmbed(request, ORIGIN, 'Control Menu');
    await gotoHome(page);
    await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
    await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);
}

test.describe('confirm dialogs (smoke §4.5)', () => {
    test.afterEach(async ({ page }) => {
        await gotoHome(page);
        await revokeAllOrigins(page);
    });

    test('4.5 the confirm dialogs share one button style: the shared class on both buttons, the outline in the text colour on a transparent ground, identical across dialogs', async ({
        page,
        request,
    }) => {
        // 1. The generic ConfirmModal, via Settings → Embedding → revoke.
        await approveOrigin(page, request);
        const settings = await openSettings(page);
        await settings.getByRole('button', { name: 'revoke' }).click();
        const revoke = page.locator('dialog.confirm-modal');
        const revokeStyles = await expectSharedStyle(
            revoke,
            revoke.getByRole('button', { name: 'cancel', exact: true }),
            revoke.getByRole('button', { name: 'ok', exact: true }),
        );
        await revoke.getByRole('button', { name: 'cancel', exact: true }).click();
        await expect(revoke).toBeHidden();
        expect(readServerConfig().frameAncestors, 'cancel touched nothing').toContain(ORIGIN);

        // 2. The service install's "privileges required" pre-flight, the row's
        //    named case. System scope on Linux, any scope on Windows, raises it
        //    before anything runs; cancelling it is the whole interaction. It is
        //    reachable only where the host OFFERS the install: a packaged
        //    install, or a dev box with a service manager and a launcher. CI's
        //    fast tier is a bare `node dist/index.js` — the Service section
        //    renders there, with the install disabled — so the tier records the
        //    half it could not open rather than pretending it did. The dialog's
        //    class is pinned by its unit test on every run.
        const status = (await (await page.request.get('/api/service/status')).json()) as {
            supported: boolean;
            unsupportedReason?: string;
        };
        const service = settingsSection(settings, 'Service');
        await expect(service.getByText('loading…')).toHaveCount(0);
        const install = service.getByRole('button', { name: /install/i }).first();
        const offersInstall = status.supported && (await install.count()) > 0 && (await install.isEnabled());
        let adminStyles: [ButtonStyle, ButtonStyle] | null = null;
        if (offersInstall) {
            const systemScope = service.getByRole('radio', { name: /system/i });
            if ((await systemScope.count()) > 0) {
                await systemScope.check();
            }
            await install.click();
            const admin = page.locator('dialog.admin-confirm-modal');
            adminStyles = await expectSharedStyle(
                admin,
                admin.getByRole('button', { name: 'cancel', exact: true }),
                admin.getByRole('button', { name: /continue/i }),
            );
            await admin.getByRole('button', { name: 'cancel', exact: true }).click();
            await expect(admin).toBeHidden();
            // Nothing was installed: the section is still offering to.
            await expect(install).toBeEnabled();
        } else {
            const why = status.supported
                ? `install offered disabled: ${(await service.locator('.settings-status').allTextContents()).join(' | ').trim() || 'no note rendered'}`
                : `service mode unsupported on this host (${status.unsupportedReason ?? 'no reason given'})`;
            test.info().annotations.push({
                type: 'partial',
                description: `${why}: the AdminConfirmModal pre-flight was not opened here; its class is pinned by src/app/client/__tests__/AdminConfirmModal.test.ts`,
            });
        }

        // 3. "Matching": the dialogs resolve to the same computed style, cancel
        //    to cancel and confirm to confirm.
        if (adminStyles) {
            expect(adminStyles[0]).toEqual(revokeStyles[0]);
            expect(adminStyles[1]).toEqual(revokeStyles[1]);
        }
    });
});
