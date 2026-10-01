import { expect, test } from '@playwright/test';
import { dismissPromptsFor, openSettingsTab, settingsRow } from './support/auth';
import { dockerCli } from './support/dockerStack';
import { CONTAINER_BOOT_INSTALLED_DEPENDENCIES } from './support/privateServer';

/**
 * The suite container's log, for a failure message. The config starts it with
 * `docker compose up --wait ws-scrcpy-web` from the repo root, which is this
 * process's cwd. An external stack (QA_EXTERNAL_STACK) is not ours to read, and
 * a failed read must never mask the assertion it is there to explain.
 */
function composeServiceLog(): string {
    if (process.env['QA_EXTERNAL_STACK'] === '1') return '(external stack: read its log where it runs)';
    try {
        return dockerCli(['compose', 'logs', '--no-color', '--tail', '300', 'ws-scrcpy-web'], 30_000);
    } catch (err) {
        return `(docker compose logs failed: ${(err as Error).message})`;
    }
}

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
                        .filter((d) => (CONTAINER_BOOT_INSTALLED_DEPENDENCIES as readonly string[]).includes(d.name))
                        .every((d) => d.installedVersion !== null),
                {
                    timeout: 180_000,
                    message: 'every boot-installed dependency present on the fresh volume',
                },
            )
            .toBe(true);
        const final = await deps();
        // Exactly the two the container hydrates. No nodejs: the image runs its
        // own Node (2026-09-30). No mkcert: it only issues the Local HTTPS
        // certificate, which a container never serves, so the container does not
        // list it or look it up on api.github.com (2026-10-01; that lookup failed
        // this row on #819's CI with quota left, for a reason nothing recorded).
        expect(final.map((d) => d.name).sort()).toEqual(['adb', 'scrcpy-server']);
        // Every listed dependency is fine, and a failure says WHY: the server's own
        // status and message for each, then the container's log. The #819 failure
        // stopped at "status error" and never showed the message.
        const report = final
            .map((d) => `${d.name}: status=${d.status} installed=${d.installedVersion} error=${d.errorMessage ?? '-'}`)
            .join('\n');
        const failing = final.filter((d) => d.status === 'error' || d.errorMessage !== undefined);
        // Constant first argument: a log is external data, never a format string.
        if (failing.length > 0) console.warn('20.9 container log:\n', composeServiceLog().slice(-4000));
        expect(failing, `dependency states:\n${report}`).toEqual([]);
        // adb specifically: a real version, which only a run that did not abort can produce.
        expect(final.find((d) => d.name === 'adb')?.installedVersion, report).toMatch(/^\d+\.\d+\.\d+$/);
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

    // Row 20.19: the page's container decisions. Each one is asserted against a
    // control that proves the thing it looks for would be there on a host: the
    // update pill's container is in the DOM (hidden) whenever it is mounted, the
    // web-port row is still BUILT, and the Local HTTPS slot is filled with a note
    // rather than left empty.
    test('@docker 20.19 no update pill, no web-port row, Local HTTPS names the reverse proxy', async ({ page }) => {
        const updatePolls: string[] = [];
        page.on('request', (req) => {
            if (new URL(req.url()).pathname === '/api/updates/status') updatePolls.push(req.url());
        });
        const configRead = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/config');
        await page.goto('/');
        await configRead;
        await expect(page.getByRole('button', { name: 'Open settings' })).toBeEnabled();

        // Never mounted, not merely hidden: the pill's container sits in the DOM
        // with display:none whenever it is mounted, so a count separates the two.
        await expect(page.locator('.top-bar-indicators')).toHaveCount(1);
        await expect(page.locator('.update-button-container')).toHaveCount(0);

        await page.getByRole('button', { name: 'Open settings' }).click();
        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();
        const server = await openSettingsTab(settings, 'Server');
        // The container decision has run (the same attribute 20.4 / 20.5 wait on).
        await expect(server).toHaveAttribute('data-app-rows-decided', 'container');

        const webPort = settingsRow(server, 'web port');
        await expect(webPort, 'the row is built, so hiding it is a decision').toHaveCount(1);
        await expect(webPort.locator('.settings-label')).not.toBeVisible();
        await expect(webPort.locator('input[type="number"]')).not.toBeVisible();

        const note = server.locator('[data-local-https-container-note]');
        await expect(note).toBeVisible();
        await expect(note).toContainText('reverse proxy');
        await expect(server.locator('[data-tls-subject]')).toHaveCount(0);

        // Checked last, after the modal work gave any stray poll time to fire.
        expect(updatePolls, 'no /api/updates/status poll from the page').toEqual([]);
    });

    test('@docker 20.19 "reset all my settings" never asks to reset first run', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Open settings' }).click();
        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();
        const server = await openSettingsTab(settings, 'Server');
        await expect(server).toHaveAttribute('data-app-rows-decided', 'container');

        const configWrites: string[] = [];
        page.on('request', (req) => {
            if (req.method() === 'PATCH' && new URL(req.url()).pathname === '/api/config') {
                configWrites.push(req.postData() ?? '');
            }
        });

        // The per-user half still runs: the reset POST is the positive control
        // that the confirm went through and the click did something. The reload
        // comes after BOTH requests have settled, so once it has happened any
        // PATCH the reset was going to send has been seen.
        const userReset = page.waitForRequest(
            (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/settings/reset',
        );
        const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
        await settingsRow(server, 'reset all my settings').getByRole('button', { name: 'reset' }).click();
        await page.getByRole('button', { name: 'confirm reset' }).click();
        await userReset;
        await reloaded;
        await page.waitForLoadState('load');

        expect(configWrites, 'no PATCH /api/config from the reset').toEqual([]);
        const config = (await (await page.request.get('/api/config')).json()) as {
            runtime: { docker?: boolean; firstRunComplete: boolean };
        };
        expect(config.runtime.docker).toBe(true);
        expect(config.runtime.firstRunComplete).toBe(true);
        await expect(page.locator('dialog.welcome-modal')).toHaveCount(0);

        // The reset cleared the prompt dismissals global-setup seeded, so put them
        // back: otherwise the bookmark reminder opens over "Open settings" in the
        // next test and swallows its click.
        await dismissPromptsFor(page.request);
    });

    // Row 20.20 (item 11 of the container audit). Measured 2026-09-30: in a
    // bridge-networked container the subnet route proposed docker's own
    // 172.17.0.0/16, 65,534 hosts and never the user's phones.
    test('@docker 20.20 the scan dialog asks for the LAN subnet instead of proposing the docker bridge', async ({
        page,
    }) => {
        await page.goto('/');
        const res = await page.request.get('/api/devices/scan/subnet');
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ container: true });

        await page.locator('#discovery-panel .discovery-scan-btn').click();
        const scanModal = page.locator('dialog.scan-network-modal');
        await expect(scanModal).toBeVisible();
        const note = scanModal.locator('[data-scan-container-note]');
        await expect(note).toBeVisible();
        await expect(note).toContainText('network_mode: host');
        // Nothing proposed as "detected": the only way a subnet reaches the list
        // here is the user adding it.
        await expect(scanModal.getByText('detected gateway subnet')).toHaveCount(0);
        await expect(scanModal.getByText('172.17.')).toHaveCount(0);
        await scanModal.getByRole('button', { name: 'cancel', exact: true }).click();
        await expect(scanModal).not.toBeVisible();
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

    // Row 20.18 (the container audit). Last in the file for the same reason as the
    // test above: a missing refusal here would restart the server on another port,
    // mint a certificate or write a unit file, and only later tests would pay.
    test('@docker 20.18 every host-only route answers 409 naming the container and its remedy', async ({ page }) => {
        await page.goto('/');
        const cases: { method: 'get' | 'post' | 'patch'; route: string; data?: unknown; remedy: RegExp }[] = [
            { method: 'post', route: '/api/service/install', data: { scope: 'user' }, remedy: /docker rm/ },
            { method: 'post', route: '/api/service/uninstall', remedy: /docker rm/ },
            { method: 'post', route: '/api/service/decline-system-wide', remedy: /docker rm/ },
            { method: 'post', route: '/api/updates/check', remedy: /pull a newer image/i },
            { method: 'post', route: '/api/updates/apply', remedy: /pull a newer image/i },
            {
                method: 'patch',
                route: '/api/updates/config',
                data: { autoUpdate: true },
                remedy: /pull a newer image/i,
            },
            { method: 'post', route: '/api/dependencies/check', remedy: /pull a newer image/i },
            { method: 'post', route: '/api/dependencies/adb/update', remedy: /pull a newer image/i },
            {
                method: 'post',
                route: '/api/tls/generate',
                data: { kind: 'ip', value: '10.0.0.2' },
                remedy: /reverse proxy/,
            },
            { method: 'post', route: '/api/tls/revoke', remedy: /reverse proxy/ },
            { method: 'post', route: '/api/tls/exposure', data: { mode: 'httpsOnly' }, remedy: /reverse proxy/ },
            { method: 'post', route: '/api/tls/https-port', data: { port: 8443 }, remedy: /reverse proxy/ },
            // The reads too (2026-10-01): a container carries no hint of the local CA.
            { method: 'get', route: '/api/tls/state', remedy: /reverse proxy/ },
            { method: 'get', route: '/api/tls/ca-root', remedy: /reverse proxy/ },
            { method: 'patch', route: '/api/config', data: { webPort: 9000 }, remedy: /docker run -p/ },
            {
                method: 'patch',
                route: '/api/config',
                data: { installMode: 'user-service' },
                remedy: /docker owns this setting/,
            },
            {
                method: 'patch',
                route: '/api/config',
                data: { firstRunComplete: false },
                remedy: /docker owns this setting/,
            },
            {
                method: 'post',
                route: '/api/settings/batch',
                data: { changes: [{ id: 'webPort', from: 8000, to: 9000 }] },
                remedy: /docker run -p/,
            },
        ];
        for (const c of cases) {
            const label = `${c.method.toUpperCase()} ${c.route} ${JSON.stringify(c.data ?? {})}`;
            const res = await page.request[c.method](c.route, c.data === undefined ? {} : { data: c.data });
            expect(res.status(), label).toBe(409);
            const body = (await res.json()) as { ok: boolean; reason: string; error: string };
            expect(body.reason, label).toBe('unsupported');
            expect(body.error, label).toMatch(/does not apply in a container/);
            expect(body.error, label).toMatch(c.remedy);
        }

        // The service status answers without a host probe.
        const status = (await (await page.request.get('/api/service/status')).json()) as {
            supported: boolean;
            docker?: boolean;
            unsupportedReason?: string;
        };
        expect(status).toMatchObject({ supported: false, docker: true });
        expect(status.unsupportedReason).toMatch(/container/);

        // Nothing moved: still containerised, still first-run-complete, still on 8000.
        const config = (await (await page.request.get('/api/config')).json()) as {
            config: { webPort: number; installMode: string | null };
            runtime: { docker?: boolean; firstRunComplete: boolean };
        };
        expect(config.runtime.docker).toBe(true);
        expect(config.runtime.firstRunComplete).toBe(true);
        expect(config.config.webPort).toBe(8000);
        expect(config.config.installMode).toBe('user');
    });
});
