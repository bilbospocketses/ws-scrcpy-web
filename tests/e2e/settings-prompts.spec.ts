import { expect, test } from '@playwright/test';
import { gotoHome } from './support/consent';
import { E2E_PORT } from './support/paths';
import { readUserSettings, resetUserSettings, restoreFirstRun, restoreHarnessPrompts } from './support/theme';

/**
 * Smoke module 13 — the settings prompts (rows 13.1–13.3).
 *
 * These specs UNDO the global setup first, deliberately. `global-setup.ts`
 * pre-dismisses the bookmark reminder for the whole run (it would otherwise
 * open on every load against the virgin data root), and rows 13.1 and 13.2 are
 * about that exact flag — so inheriting the harness's pre-arranged state would
 * make them assert something they did not establish, which is a test that
 * cannot fail.
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

    test('13.1 the bookmark reminder is a card, not a dialog; got it stamps the port, never again asks first and persists', async ({
        page,
    }) => {
        await page.reload();

        // The reminder is a card, not a dialog: the page beneath it stays
        // usable. Prove it in the failing direction the old <dialog> had — a
        // click on the app while the reminder is up must land.
        const card = page.locator('.bookmark-reminder[data-kind="bookmark"]');
        await expect(card).toBeVisible();
        await expect(page.locator('dialog.port-change-modal')).toHaveCount(0);
        await page.getByRole('button', { name: 'Open settings' }).click();
        await expect(page.locator('dialog.settings-modal')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog.settings-modal')).toBeHidden();
        await expect(card).toBeVisible();

        // The address it shows is the one THIS browser is on (item 112).
        await expect(card.locator('a')).toHaveAttribute('href', new URL(page.url()).origin);

        // "got it" persists the current port only, in one click.
        await card.getByRole('button', { name: 'got it', exact: true }).click();
        await expect(card).toHaveCount(0);
        await expect.poll(async () => (await readUserSettings(page))['bookmarkDismissedForPort']).toBe(E2E_PORT);
        expect((await readUserSettings(page))['bookmarkDismissedGlobally']).toBeUndefined();

        // Back to a clean slate for the global half.
        await resetUserSettings(page);
        await page.reload();
        await expect(card).toBeVisible();

        // "never again" goes through a confirmation, so it cannot be committed by
        // a stray click. Prove the gate in its failing direction first: cancel
        // leaves the card up and writes nothing.
        await card.getByRole('button', { name: 'never again', exact: true }).click();
        const confirm = page.locator('dialog.modal').filter({ hasText: "you won't see this bookmark helper again" });
        await expect(confirm).toBeVisible();
        // The row's "white-outline buttons" clause: both are modal-button styled.
        await expect(confirm.getByRole('button', { name: /cancel/i })).toHaveClass(/\bmodal-button\b/);
        await expect(confirm.getByRole('button', { name: /yes|confirm|ok/i })).toHaveClass(/\bmodal-button\b/);
        await confirm.getByRole('button', { name: /cancel/i }).click();
        await expect(confirm).toBeHidden();
        await expect(card).toBeVisible();
        expect((await readUserSettings(page))['bookmarkDismissedGlobally']).toBeUndefined();

        // Now the affirmative path.
        await card.getByRole('button', { name: 'never again', exact: true }).click();
        await expect(confirm).toBeVisible();
        await confirm.getByRole('button', { name: /yes|confirm|ok/i }).click();
        await expect(card).toHaveCount(0);
        await expect.poll(async () => (await readUserSettings(page))['bookmarkDismissedGlobally']).toBe(true);
        // The global commit does not also stamp the per-port flag.
        expect((await readUserSettings(page))['bookmarkDismissedForPort']).toBeUndefined();

        // And it actually suppresses the card on the next load — the point of
        // the flag rather than the flag itself. This cannot be a bare
        // toHaveCount(0) after reload(): reload resolves at the load event, and
        // the card is mounted only at the end of an async chain (settings
        // fetch, dynamic import, service status, config) that starts in
        // window.onload. An immediate count of zero is satisfied before the app
        // could possibly have shown it, on a build whose gate ignores the flag.
        // Anchor to the chain's last network step, then let the page settle.
        const gated = page.waitForResponse(
            (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/config',
        );
        await page.reload();
        await gated;
        await page.waitForLoadState('networkidle');
        await expect(card).toHaveCount(0);
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

    test('13.3 the Server section lists its rows in order with the port staged for the dialog Save, quiet at rest', async ({
        page,
    }) => {
        await restoreHarnessPrompts(page);
        await gotoHome(page);
        await page.getByRole('button', { name: 'Open settings' }).click();

        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();
        // Server is a tab now, and not the one the dialog opens on. The row is
        // about what this section SHOWS, so it has to be the visible one.
        await settings.getByRole('tab', { name: 'Server', exact: true }).click();
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

        // The web-port row is a BARE input now. Editing it stages the value and
        // the dialog's one footer Save sends the batch, so the inline save the
        // beta.62 layout put in this cell is deliberately gone — ServerTab says
        // so outright: "There is no per-field Save button any more".
        //
        // Asserted as a pair, because the absence on its own would also hold if
        // the tab were simply closed (a role query does not see into a `hidden`
        // subtree). The footer Save answers the same query in the same dialog,
        // so the zero above is the row's layout talking, not the tab's state.
        await expect(control.locator('input')).toHaveCount(1);
        await expect(control.getByRole('button')).toHaveCount(0);
        await expect(settings.locator('button.settings-save')).toBeVisible();

        // Status empty AT REST: nothing status-shaped anywhere in the section.
        const statusy = server.locator('.settings-status', { hasText: /saving|saved|no change|error|couldn't/i });
        await expect(statusy).toHaveCount(0);

        // And the status line is WIRED, still proven with zero side effects. The
        // "no change." reply left with the button that produced it, so the proof
        // re-homes onto the range guard, which moved the same way — "onto the
        // stage rather than the save" (ServerTab). An out-of-range port is
        // REFUSED the stage, so this writes the status line while issuing no
        // request and leaving nothing for the footer Save to commit — and it
        // still identifies the one status element the port path writes to,
        // rather than trusting whichever <p> came first.
        const portInput = control.locator('input');
        const rangeMsg = server.locator('.settings-status', { hasText: 'port must be between 1024 and 65535' });
        // TYPED, not `fill()`ed. The guard hangs off `change`, and a programmatic
        // fill leaves the field un-dirtied, so no blur ever commits it and the
        // status line stays empty — measured, not assumed: the first cut of this
        // used fill() and found nothing.
        const typePort = async (value: string) => {
            await portInput.click();
            await portInput.press('Control+a');
            await portInput.pressSequentially(value);
            await portInput.press('Tab');
        };
        await typePort('80');
        await expect(rangeMsg).toHaveCount(1);

        // A valid port clears the message again, which also hands the shared
        // dialog back at its baseline rather than holding an edit for whatever
        // runs next.
        await typePort(String(E2E_PORT));
        await expect(rangeMsg).toHaveCount(0);

        // NOT covered here, and said so: "change port → save → persists +
        // restarts" is deliberately manual. A real PATCH would move the shared
        // 8123 server out from under every spec that follows.
    });
});
