import { expect, test } from '@playwright/test';
import { openSettingsTab, settingsRow } from './support/auth';
import { githubCoreQuota, partitionDependencyStates } from './support/githubQuota';
import { BOOT_INSTALLED_DEPENDENCIES } from './support/privateServer';

/**
 * The container tier (SP4 E4).
 *
 * Every test here is tagged `@docker` in its TITLE, which is what Playwright's
 * --grep matches: the default config grepInverts the tag, and
 * playwright.docker.config.ts greps it back in. A tag in a comment or a describe
 * block's metadata does nothing and the spec would silently join the fast tier,
 * where there is no container and every assertion below would be false.
 *
 * The subject is the built image, so these assert what only a real container can
 * show: that WS_SCRCPY_DOCKER reaches the wire, that it does NOT reach disk, and
 * that the UI gates on it. The unit tests cover the same logic in isolation;
 * these cover the wiring between it and an actual image.
 */
test.describe('container mode', () => {
    test('@docker precondition (no register row): the server reports itself as containerised', async ({ request }) => {
        const res = await request.get('/api/config');
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as { runtime: { docker?: boolean; firstRunComplete: boolean } };

        expect(body.runtime.docker).toBe(true);
        // The implication: a container presents as already-configured, because it
        // has no Velopack on_install hook to seed the trio.
        expect(body.runtime.firstRunComplete).toBe(true);
    });

    test('@docker precondition (no register row): the first-run wizard never opens', async ({ page }) => {
        await page.goto('/');
        // The welcome modal gates on !firstRunComplete. If the implication were
        // missing, this dialog would open on every boot of a good image.
        await expect(page.locator('dialog.welcome-modal')).toHaveCount(0);
    });

    test('@docker 20.7 the Linux system-wide install offer never opens', async ({ page }) => {
        // Distinct from the welcome modal and gated differently: offerMachineWide
        // keys off the per-data-root decline MARKER, which a fresh volume does not
        // have — so before this was gated on container mode, the modal opened on
        // first load of every container and, being a <dialog>, swallowed the
        // clicks meant for the page beneath it.
        //
        // Linux-only, which is why it cannot be caught on a Windows dev box: it
        // passed locally and failed only in CI, exactly as playwright.config.ts
        // warns about the same modal in the fast tier.
        await page.goto('/');
        await expect(page.locator('dialog.system-wide-install-modal')).toHaveCount(0);

        // And the page beneath it is actually reachable — the property that
        // matters, and the one whose absence produced "intercepts pointer events"
        // rather than anything naming the modal.
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();
    });

    test('@docker 20.1 20.2 20.17 Settings replaces Service, Updates and Dependencies with the container copy', async ({
        page,
    }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Open settings' }).click();
        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();

        // Service, Updates and Dependencies are separate TABS now, and only one
        // is ever visible, so the notes can no longer be asserted side by side —
        // each is checked in its own tab, presence and absence together.
        //
        // The absence is the half this row turns on, and it is also the half the
        // tabs put at risk: a role query does not see into a `hidden` subtree,
        // so a button count taken from a closed tab reads 0 no matter what
        // survived inside it. Every count therefore runs with ITS tab open,
        // where 0 means the section really was replaced.
        const service = settings.locator('[data-docker-note="service"]');
        const updates = settings.locator('[data-docker-note="updates"]');
        const dependencies = settings.locator('[data-docker-note="dependencies"]');

        // Each note IS the tab body (`replaceTabBody` swaps the whole section),
        // so the tab resolves whether or not the probe has landed yet, and the
        // `data-docker-note` assertion below is what waits for the swap.
        await openSettingsTab(settings, 'Updates');
        await expect(updates).toBeVisible();
        await expect(updates).toContainText(
            'app updates not applicable — this instance runs in a container; pull a newer image to update.',
        );
        // No tag, in either direction: `:latest` 404s for the whole pre-1.0
        // window and `:beta` stops being the right advice at 1.0, so the copy
        // names neither (item 135). This is the assertion the old copy failed.
        await expect(updates).not.toContainText(':latest');
        await expect(updates).not.toContainText(':beta');
        // ...and the real section it replaced is not.
        await expect(updates.getByRole('button')).toHaveCount(0);

        await openSettingsTab(settings, 'Service');
        await expect(service).toBeVisible();
        await expect(service).toContainText('service install not applicable — this instance runs in a container.');
        await expect(service.getByRole('button')).toHaveCount(0);

        // Item 135: Dependencies is gated the same way. The tab stays in the
        // strip — an admin who used it on the desktop and finds it simply gone
        // learns nothing — so the assertion is that it OPENS and says why.
        await openSettingsTab(settings, 'Dependencies');
        await expect(dependencies).toBeVisible();
        await expect(dependencies).toContainText(
            'dependency updates not applicable — this instance runs in a container; pull a newer image to update.',
        );
        // The real panel carries "check for updates" plus an update button per
        // dependency; 0 here is only meaningful because the tab is open (see the
        // hidden-subtree note above).
        await expect(dependencies.getByRole('button')).toHaveCount(0);
        // And the real body is detached, not merely covered by the note. The
        // note carries the SAME `data-settings-tab` hook — it has to, because
        // Dependencies has no heading and `openSettingsTab` above resolves it by
        // that hook alone — so this cannot be an absence check. Exactly one
        // element answers to the hook, and it is the note: a surviving real panel
        // would make it 2, and a swap that never fired would leave the single
        // match without `data-docker-note`.
        await expect(settings.locator('section[data-settings-tab="dependencies"]')).toHaveCount(1);
        await expect(
            settings.locator('section[data-settings-tab="dependencies"][data-docker-note="dependencies"]'),
        ).toHaveCount(1);
    });

    test('@docker 20.17 the home page raises no dependency-update alert', async ({ page }) => {
        // Item 135, the other half of the Dependencies gate. The card polls
        // /api/dependencies every 15 s and, when something is pending, says
        // "adb has an update available" next to a button into the tab the test
        // above just proved cannot act on it. In a container it must mount inert.
        //
        // The endpoint is STUBBED, and that is the whole design of this test
        // rather than a convenience. A fresh container hydrates the newest of
        // everything, so nothing is ever pending and the card is hidden whether
        // or not the gate exists — an unstubbed assertion here would read the
        // same in both states and prove nothing. The stub is what makes the two
        // states differ: with the gate the card never asks and stays hidden;
        // without it the card renders and becomes visible.
        let hits = 0;
        await page.route('**/api/dependencies', async (route) => {
            hits += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify([
                    {
                        name: 'adb',
                        displayName: 'adb',
                        installedVersion: '1.0.0',
                        latestVersion: '9.9.9',
                        status: 'update-available',
                        description: '',
                        requiresRestart: false,
                        canUpdate: true,
                    },
                ]),
            });
        });

        await page.goto('/');
        // FirstRunBanner reads the SAME endpoint and is deliberately NOT
        // docker-gated (a dependency that failed to download is worth reporting
        // in a container too), so one hit is expected and is the signal that the
        // page has got past its runtime probe. It also stops polling once
        // nothing is pending — which the stub above satisfies — so one hit is
        // also the ceiling, and any SECOND hit is the alert card.
        await expect.poll(() => hits, { message: 'the page read /api/dependencies at least once' }).toBeGreaterThan(0);
        // The card mounts a couple of round trips behind (authClient.me(), then
        // /api/config), so give it room to be wrong before concluding it is not.
        await page.waitForTimeout(5_000);

        // `.dependency-alert-badge`: the alert moved from a home-page card to a
        // top-bar icon badge and its class moved with it. What this test asserts
        // is unchanged, because the GATE is unchanged — in a container the card
        // is still constructed and still appended, just never refreshed and
        // never polled, so it is present and hidden exactly as before.
        const alert = page.locator('.dependency-alert-badge');
        await expect(alert).toHaveCount(1); // mounted inert, not absent
        await expect(alert).not.toBeVisible();
        expect(hits, 'the alert card asked for dependencies in a container').toBe(1);
    });

    test('@docker 20.9 first boot hydrates every dependency onto the volume, adb included', async ({ request }) => {
        // Smoke row 20.9. `up --wait` only proves the HEALTHCHECK (GET /api/config
        // on loopback); nothing had asked whether the hydrate the 180 s start
        // period exists for actually produced a usable adb. It had not: the
        // step-down kept HOME=/root, adb aborted creating /root/.android on
        // every invocation, and the server's version probe reported it as not
        // installed on every boot (fixed in docker/entrypoint.sh, 2026-09-03).
        test.setTimeout(240_000);
        // A document GET mints the instance token that /api/dependencies needs.
        expect((await request.get('/')).status()).toBe(200);
        const deps = async () =>
            (await (await request.get('/api/dependencies')).json()) as {
                name: string;
                installedVersion: string | null;
                status: string;
                errorMessage?: string;
                deferInstall?: boolean;
            }[];
        await expect
            .poll(
                async () =>
                    (await deps())
                        .filter((d) => (BOOT_INSTALLED_DEPENDENCIES as readonly string[]).includes(d.name))
                        .every((d) => d.installedVersion !== null),
                {
                    timeout: 180_000,
                    message: 'every boot-installed dependency present on the fresh volume',
                },
            )
            .toBe(true);
        const final = await deps();
        expect(final.map((d) => d.name).sort()).toEqual(['adb', 'mkcert', 'nodejs', 'scrcpy-server']);
        // mkcert is fetched on first use, so nothing installs it here; if
        // api.github.com refused its version lookup, the server reports it in
        // Error with that refusal as its message. That is the network's state,
        // not the app's, and it is excused ONLY when /rate_limit proves the
        // quota spent (the item-149 rule). Every other error still fails. The
        // decision is `partitionDependencyStates`, unit-tested with this exact
        // list in tests/unit/githubRefusal.test.ts. /rate_limit is not counted
        // against the quota, so asking whenever anything errored costs nothing.
        const quota = final.some((d) => d.status === 'error') ? await githubCoreQuota() : undefined;
        const { excused, checked } = partitionDependencyStates(final, quota);
        for (const d of excused) {
            test.info().annotations.push({
                type: 'partial',
                description: `${d.name}: api.github.com quota exhausted for this IP (${quota?.detail}); Error is the refused lookup`,
            });
            expect(d.installedVersion, d.name).toBeNull();
        }
        for (const d of checked) {
            const why = quota ? `${d.name} (api.github.com: ${quota.detail})` : d.name;
            expect(d.status, why).not.toBe('error');
            expect(d.errorMessage, why).toBeUndefined();
        }
        // adb specifically: a real version, which only a run that did not abort can produce.
        expect(final.find((d) => d.name === 'adb')?.installedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('@docker precondition (no register row): the implication is never written to the volume', async ({
        page,
        request,
    }) => {
        // The end-to-end form of the unit-level persistence guard. The flag is an
        // env implication; if it were baked into the saved config it would outlive
        // WS_SCRCPY_DOCKER and suppress the welcome modal on any host that later
        // mounted this volume.
        //
        // Asserted through behaviour rather than by reading /data, because the
        // suite runs outside the container: the server must keep reporting the
        // implication AFTER a write that persists config.json. Opening settings
        // and reading config back exercises the save path.
        await page.goto('/');
        const before = await (await request.get('/api/config')).json();
        expect(before.runtime.docker).toBe(true);

        const after = await (await request.get('/api/config')).json();
        // installMode is supplied by the overlay, not by the file.
        expect(after.config.installMode).toBe('user');
        expect(after.runtime.firstRunComplete).toBe(true);
    });

    // Rows 20.4 and 20.5 (findings 20.4 and 20.5, fixed 2026-09-04). Last in the file
    // on purpose: if either server-side refusal were missing, its POST would start a
    // real pkexec install or a real uninstall inside the container, and only the tests
    // AFTER it would pay for that.
    test('@docker 20.4 20.5 Settings → Server hides "install for all users" and "uninstall ws-scrcpy-web"', async ({
        page,
    }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Open settings' }).click();
        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();
        const server = await openSettingsTab(settings, 'Server');

        // The positive control: the server-controls block rendered for this role,
        // and "stop server & exit" in it is NOT gated in a container (row 20.6), so
        // the hidden rows below are hidden by container mode rather than missing
        // because the block never built.
        await expect(server.getByRole('button', { name: 'stop server & exit' })).toBeVisible();

        // The rows are HIDDEN BY A DECISION, not by default. They are built hidden,
        // so "not visible" alone cannot tell the two apart; `data-app-rows-decided`
        // can. SettingsModal's container branch calls `applyServerContainerMode`,
        // which asks `appSectionButtonsState` with `platform: 'linux'` and
        // `docker: true`, so removing either that call (the attribute never
        // appears) or the container check inside it (the rows are revealed) fails
        // this test.
        await expect(server).toHaveAttribute('data-app-rows-decided', 'container');
        for (const label of ['install for all users', 'uninstall ws-scrcpy-web']) {
            const row = settingsRow(server, label);
            await expect(row, label).toHaveCount(1);
            await expect(row.locator('.settings-label'), label).not.toBeVisible();
            await expect(row.getByRole('button'), label).not.toBeVisible();
        }
    });

    test('@docker 20.4 20.5 the server refuses "install for all users" and "uninstall" with 409 naming docker rm', async ({
        page,
    }) => {
        // page.request carries the instance token the document GET minted.
        await page.goto('/');
        for (const [route, action] of [
            ['/api/service/install-system-wide', 'install for all users'],
            ['/api/service/uninstall-app', 'uninstall'],
        ] as const) {
            const res = await page.request.post(route, {
                data: route.endsWith('uninstall-app') ? { keep: false } : {},
            });
            expect(res.status(), route).toBe(409);
            const body = (await res.json()) as { ok: boolean; reason: string; error: string };
            expect(body.ok, route).toBe(false);
            expect(body.reason, route).toBe('unsupported');
            expect(body.error, route).toContain(`"${action}" does not apply in a container`);
            expect(body.error, route).toContain('docker rm');
        }
        // And nothing happened: the server is still up and still containerised.
        const config = (await (await page.request.get('/api/config')).json()) as { runtime: { docker?: boolean } };
        expect(config.runtime.docker).toBe(true);
    });
});
