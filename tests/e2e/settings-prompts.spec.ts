import { expect, test } from '@playwright/test';
import { gotoHome } from './support/consent';
import { E2E_PORT } from './support/paths';
import { readUserSettings, resetUserSettings, restoreFirstRun, restoreHarnessPrompts } from './support/theme';

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
        // Restore what global-setup and the seed config arranged, so a later spec
        // in the same run — or a CI retry of this one — does not inherit a live
        // bookmark or welcome modal over its clicks.
        await restoreHarnessPrompts(page);
        await restoreFirstRun(page);
    });

    test('13.1 the global dismissal supersedes and disables the per-port one, and persists', async ({ page }) => {
        await page.reload();

        const modal = page.locator('dialog.port-change-modal');
        await expect(modal).toBeVisible();

        const perPort = modal.locator('input[type="checkbox"]').first();
        const global = modal.locator('input[type="checkbox"]').nth(1);
        await expect(perPort).toBeEnabled();

        // Tick the per-port box first, then the global one. "Supersedes" has two
        // halves: the weaker box is DISABLED, and the commit that follows must
        // write the global flag and NOT the per-port one it superseded.
        await perPort.check();
        await global.check();
        await expect(perPort).toBeDisabled();

        // Committing goes through a confirmation, so it cannot be set by an
        // accidental tick. Prove the gate in its failing direction first: cancel
        // leaves the modal open, the box still checked, and nothing written.
        await modal.getByRole('button', { name: 'got it' }).click();
        const confirm = page.locator('dialog.modal').filter({ hasText: "you won't see this bookmark helper again" });
        await expect(confirm).toBeVisible();
        // The row's "white-outline buttons" clause: both are modal-button styled.
        await expect(confirm.getByRole('button', { name: /cancel/i })).toHaveClass(/\bmodal-button\b/);
        await expect(confirm.getByRole('button', { name: /yes|confirm|ok/i })).toHaveClass(/\bmodal-button\b/);
        await confirm.getByRole('button', { name: /cancel/i }).click();
        await expect(confirm).toBeHidden();
        await expect(modal).toBeVisible();
        await expect(perPort).toBeDisabled();
        expect((await readUserSettings(page))['bookmarkDismissedGlobally']).toBeUndefined();

        // Now the affirmative path.
        await modal.getByRole('button', { name: 'got it' }).click();
        await expect(confirm).toBeVisible();
        await confirm.getByRole('button', { name: /yes|confirm|ok/i }).click();
        await expect.poll(async () => (await readUserSettings(page))['bookmarkDismissedGlobally']).toBe(true);
        // The superseded per-port flag was not written by the global commit.
        expect((await readUserSettings(page))['bookmarkDismissedForPort']).toBeUndefined();

        // And it actually suppresses the modal on the next load — the point of
        // the flag rather than the flag itself. This cannot be a bare
        // toHaveCount(0) after reload(): reload resolves at the load event, and
        // the modal is mounted only at the end of an async chain (settings
        // fetch, four dynamic imports, service status, config) that starts in
        // window.onload. An immediate count of zero is satisfied before the app
        // could possibly have shown it, on a build whose gate ignores the flag.
        // Anchor to the chain's last network step, then let the page settle.
        const gated = page.waitForResponse(
            (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/config',
        );
        await page.reload();
        await gated;
        await page.waitForLoadState('networkidle');
        await expect(modal).toHaveCount(0);
    });

    test('13.2 reset wipes the other per-user settings without re-suppressing the per-port bookmark', async ({
        page,
    }) => {
        // Arrange visible state across BOTH stores the reset must clear, and
        // prove it landed: a PATCH whose response is discarded proves nothing,
        // and iconSize is a pixel number in the app, not a word.
        const arranged = {
            theme: 'light',
            iconSize: 96,
            scanSubnets: ['192.168.50.0/24'],
            bookmarkDismissedGlobally: true,
            bookmarkDismissedForPort: E2E_PORT,
        };
        expect((await page.request.patch('/api/settings', { data: arranged })).ok()).toBe(true);
        const deviceArranged = { stream: { codec: 'h264' }, audio: { enabled: true } };
        expect(
            (await page.request.patch('/api/settings/device?udid=e2e-fake-device', { data: deviceArranged })).ok(),
        ).toBe(true);

        const before = await readUserSettings(page);
        expect(before['theme']).toBe('light');
        expect(before['iconSize']).toBe(96);
        expect(before['scanSubnets']).toEqual(['192.168.50.0/24']);
        expect(before['bookmarkDismissedGlobally']).toBe(true);
        expect(before['bookmarkDismissedForPort']).toBe(E2E_PORT);
        expect(await (await page.request.get('/api/settings/device?udid=e2e-fake-device')).json()).toEqual(
            deviceArranged,
        );

        await resetUserSettings(page);
        const after = await readUserSettings(page);

        // Everything the row enumerates, asserted one by one rather than as a
        // count — the row exists because a narrower earlier implementation
        // cleared some of these and not others.
        expect(after['theme']).toBeUndefined();
        expect(after['iconSize']).toBeUndefined();
        expect(after['scanSubnets']).toBeUndefined();
        expect(after['bookmarkDismissedGlobally']).toBeUndefined();
        expect(after['bookmarkDismissedForPort']).toBeUndefined();
        // Per-device settings live in the other store and must go too.
        expect(await (await page.request.get('/api/settings/device?udid=e2e-fake-device')).json()).toEqual({});

        // The regression clause, and the reason this row is worth automating.
        // Bug #35 did NOT live in the server's reset — which is a blanket delete
        // and cannot re-suppress anything — but in the client's post-reset
        // reload: the reset also clears firstRunComplete, the welcome modal
        // re-shows, and an eager per-port stamp in that modal's constructor
        // used to re-write bookmarkDismissedForPort over the reset's null. So
        // the spec drives that path: flip firstRunComplete, reload, watch the
        // welcome modal mount, and assert that NO PATCH to /api/settings the
        // page issued carried the per-port flag — and that the store still
        // lacks it. Asserting the store alone right after the DELETE is a
        // tautology.
        expect((await page.request.patch('/api/config', { data: { firstRunComplete: false } })).ok()).toBe(true);
        const settingsPatches: Record<string, unknown>[] = [];
        page.on('request', (req) => {
            if (req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/settings') {
                settingsPatches.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
            }
        });
        await page.reload();
        await expect(page.locator('dialog.welcome-modal')).toBeVisible();
        // Give any eager stamp its chance to fire before judging.
        await page.waitForLoadState('networkidle');
        const stillAbsent = (await readUserSettings(page))['bookmarkDismissedForPort'];

        // Restore BEFORE asserting, so a failing assertion cannot skip it: the
        // welcome <dialog> would otherwise sit over 13.3's clicks.
        await restoreFirstRun(page);
        await restoreHarnessPrompts(page);

        expect(settingsPatches.filter((b) => 'bookmarkDismissedForPort' in b)).toEqual([]);
        expect(stillAbsent).toBeUndefined();

        // NOT covered here, and said so: device LABELS are also wiped by the
        // reset, but they are the subject of module 19 and are asserted there,
        // in the device tier, where a label can actually be set through the UI.
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

        // Settle first: the port input is filled by the same fetch that could
        // write a status hint, so waiting for its value proves that fetch is
        // done before "empty at rest" is read.
        const portRow = server.locator('.settings-row').filter({ hasText: 'web port' }).first();
        const control = portRow.locator('.settings-control');
        await expect(control.locator('input')).toHaveValue(String(E2E_PORT));

        // Order, not mere presence — including "install for all users", which is
        // built on every platform (merely hidden where inapplicable), so its DOM
        // position is always available to check.
        const labels = await server.locator('.settings-label').allTextContents();
        const idx = (needle: string) => labels.findIndex((l) => l.includes(needle));
        const reset = idx('reset all my settings');
        const port = idx('web port');
        const install = idx('install for all users');
        const stop = idx('stop the server and close the app');
        const uninstall = idx('uninstall');
        expect(reset).toBeGreaterThanOrEqual(0);
        expect(port).toBeGreaterThan(reset);
        expect(install).toBeGreaterThan(port);
        expect(stop).toBeGreaterThan(install);
        expect(uninstall).toBeGreaterThan(stop);

        // The web-port row carries its save INLINE, in the same control cell as
        // the input — the beta.62 layout the row pins.
        await expect(control.locator('input')).toHaveCount(1);
        await expect(control.getByRole('button', { name: 'save' })).toHaveCount(1);

        // Status empty AT REST: nothing status-shaped anywhere in the section.
        const statusy = server.locator('.settings-status', { hasText: /saving|saved|no change|error|couldn't/i });
        await expect(statusy).toHaveCount(0);

        // And the status line is WIRED, proven with zero side effects: saving an
        // unchanged port returns before any request is made and reports "no
        // change." — which also identifies the one status element that the
        // save path writes to, rather than trusting whichever <p> came first.
        await control.getByRole('button', { name: 'save' }).click();
        await expect(server.locator('.settings-status', { hasText: 'no change.' })).toHaveCount(1);

        // NOT covered here, and said so: "change port → save → persists +
        // restarts" is deliberately manual. A real PATCH would move the shared
        // 8123 server out from under every spec that follows.
    });
});
