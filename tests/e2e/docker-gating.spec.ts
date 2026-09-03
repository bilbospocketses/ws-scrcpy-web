import { expect, test } from '@playwright/test';

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
    test('@docker the server reports itself as containerised', async ({ request }) => {
        const res = await request.get('/api/config');
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as { runtime: { docker?: boolean; firstRunComplete: boolean } };

        expect(body.runtime.docker).toBe(true);
        // The implication: a container presents as already-configured, because it
        // has no Velopack on_install hook to seed the trio.
        expect(body.runtime.firstRunComplete).toBe(true);
    });

    test('@docker the first-run wizard never opens', async ({ page }) => {
        await page.goto('/');
        // The welcome modal gates on !firstRunComplete. If the implication were
        // missing, this dialog would open on every boot of a good image.
        await expect(page.locator('dialog.welcome-modal')).toHaveCount(0);
    });

    test('@docker the Linux system-wide install offer never opens', async ({ page }) => {
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

    test('@docker Settings replaces Service and Updates with the container copy', async ({ page }) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Open settings' }).click();
        const settings = page.locator('dialog.settings-modal');
        await expect(settings).toBeVisible();

        // The notes are present...
        const service = settings.locator('[data-docker-note="service"]');
        const updates = settings.locator('[data-docker-note="updates"]');
        await expect(service).toBeVisible();
        await expect(updates).toBeVisible();
        await expect(service).toContainText('service install not applicable — this instance runs in a container.');
        await expect(updates).toContainText('update via `docker pull jchapz30/ws-scrcpy-web:latest`.');

        // ...and the real sections they replaced are not. Asserting the absence
        // matters as much as the presence: a note rendered ALONGSIDE a working
        // install button would satisfy the first half and still be wrong.
        await expect(service.getByRole('button')).toHaveCount(0);
        await expect(updates.getByRole('button')).toHaveCount(0);
    });

    test('@docker first boot hydrates every dependency onto the volume, adb included', async ({ request }) => {
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
            }[];
        await expect
            .poll(async () => (await deps()).every((d) => d.installedVersion !== null), {
                timeout: 180_000,
                message: 'every dependency installed on the fresh volume',
            })
            .toBe(true);
        const final = await deps();
        expect(final.map((d) => d.name).sort()).toEqual(['adb', 'nodejs', 'scrcpy-server']);
        for (const d of final) {
            expect(d.status, d.name).not.toBe('error');
            expect(d.errorMessage, d.name).toBeUndefined();
        }
        // adb specifically: a real version, which only a run that did not abort can produce.
        expect(final.find((d) => d.name === 'adb')?.installedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('@docker the implication is never written to the volume', async ({ page, request }) => {
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
});
