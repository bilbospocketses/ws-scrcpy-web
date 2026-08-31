import { expect, test } from '@playwright/test';
import { askToEmbed, gotoHome, readServerConfig, revokeAllOrigins, waitForPrompt } from './support/consent';
import { SEED_CONFIG } from './support/paths';

const ORIGIN = 'http://localhost:5159';

/**
 * The consent protocol end to end.
 *
 * The split it enforces is the design, not an implementation detail:
 *   asking      — unauthenticated, loopback-only, touches no config
 *   granting    — admin AND loopback, human click only
 *   cancelling  — loopback-only, and retract-only: it can never undo a decision
 */
test.describe('embed consent', () => {
    test.afterEach(async ({ page }) => {
        await gotoHome(page);
        await revokeAllOrigins(page);
    });

    test('asking for permission writes nothing to config', async ({ request }) => {
        const before = readServerConfig();

        await askToEmbed(request, ORIGIN, 'Control Menu');

        // Asking raises a prompt and does nothing else. If this ever fails, an
        // unauthenticated caller has gained the ability to change stored config.
        expect(readServerConfig()).toEqual(before);
    });

    test('approving stores the origin and leaves unrelated keys untouched', async ({ page, request }) => {
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);

        const prompt = await waitForPrompt(page);
        await expect(prompt).toContainText(ORIGIN);
        await expect(prompt).toContainText('Control Menu');
        await prompt.getByRole('button', { name: 'approve', exact: true }).click();

        await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);

        // The assertion with real teeth. `webPort` shares this file, so a write that
        // rebuilt the config instead of amending it would move the running server to
        // a different port — a failure that looks like "the app died" from outside.
        const after = readServerConfig();
        expect(after.webPort).toBe(SEED_CONFIG.webPort);
        expect(after.installMode).toBe(SEED_CONFIG.installMode);
        expect(after.firstRunComplete).toBe(SEED_CONFIG.firstRunComplete);
    });

    test('denying grants nothing', async ({ page, request }) => {
        const id = await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);

        await (await waitForPrompt(page)).getByRole('button', { name: 'deny', exact: true }).click();

        await expect
            .poll(async () => (await request.get(`/embed-request/${id}`)).json())
            .toMatchObject({
                status: 'denied',
            });
        expect(readServerConfig().frameAncestors).not.toContain(ORIGIN);
    });

    test('withdrawing replaces the prompt instead of leaving it decidable', async ({ page, request }) => {
        const id = await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        const prompt = await waitForPrompt(page);

        const res = await request.post(`/embed-request/${id}/cancel`);
        expect(await res.json()).toMatchObject({ cancelled: true, status: 'cancelled' });

        // Leaving an abandoned prompt on screen would be worse than closing it:
        // approving it would grant permission to an app that stopped waiting.
        await expect(prompt).toContainText('withdrew this request');
        await expect(prompt.getByRole('button', { name: 'approve', exact: true })).toHaveCount(0);
        await expect(prompt.getByRole('button', { name: 'deny', exact: true })).toHaveCount(0);
    });

    test('a cancel after approval is refused, and the approval stands', async ({ page, request }) => {
        const id = await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
        await expect.poll(() => readServerConfig().frameAncestors).toContain(ORIGIN);

        const res = await request.post(`/embed-request/${id}/cancel`);

        // Retract-only. The asking app may withdraw a request nobody has answered;
        // it may never reach back and undo a human's decision.
        expect(await res.json()).toMatchObject({ cancelled: false, status: 'approved' });
        expect(readServerConfig().frameAncestors).toContain(ORIGIN);
    });

    test('a web page cannot raise a prompt, even from this machine', async ({ request }) => {
        const res = await request.post('/embed-request', {
            headers: { Origin: 'http://evil.example' },
            data: { origin: 'http://evil.example', appName: 'Evil' },
        });

        // A browser always sends Origin and it will never match ours, which is what
        // stops a random page from raising a consent prompt on this desktop. A
        // native local app sends none, and is allowed — see askToEmbed.
        expect(res.status()).toBe(403);
        expect(await res.json()).toMatchObject({ reason: 'cross-origin request rejected' });
    });

    test('an unknown request id reports unknown rather than failing', async ({ request }) => {
        const res = await request.get('/embed-request/not-a-real-id');

        expect(res.status()).toBe(200);
        expect(await res.json()).toMatchObject({ status: 'unknown' });
    });
});
