import { expect, test } from '@playwright/test';
import { askToEmbed, gotoHome, revokeAllOrigins, waitForPrompt } from './support/consent';

const ORIGIN = 'http://localhost:5159';

/**
 * The framing headers as a browser actually receives them.
 *
 * `frameGuard.test.ts` already covers the header-building function itself, so this
 * file deliberately covers what a unit test cannot: whether those headers survive
 * the real response path. That distinction is not academic — a past regression had
 * `securityHeaders()` applied only by the static handler, so the login page and its
 * 401 shipped with no framing headers at all.
 */
test.describe('framing headers', () => {
    test.afterEach(async ({ page }) => {
        await gotoHome(page);
        await revokeAllOrigins(page);
    });

    test('sends X-Frame-Options and omits the CSP when nothing is allow-listed', async ({ request }) => {
        const res = await request.get('/');

        expect(res.status()).toBe(200);
        expect(res.headers()['x-frame-options']).toBe('SAMEORIGIN');
        // An empty allow-list has nothing to permit, so the CSP header is omitted
        // entirely and X-Frame-Options alone governs. Its absence here is the
        // designed behaviour, not a header that failed to be emitted.
        expect(res.headers()['content-security-policy']).toBeUndefined();
    });

    test('adds an approved origin to frame-ancestors and keeps X-Frame-Options', async ({ page, request }) => {
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();

        await expect
            .poll(async () => (await request.get('/')).headers()['content-security-policy'])
            .toBe(`frame-ancestors 'self' ${ORIGIN}`);

        // Both headers ship together on purpose: a browser that understands
        // frame-ancestors must ignore X-Frame-Options when both are present (CSP
        // Level 2), so the allow-list wins where it is understood while older
        // browsers keep the stricter same-origin behaviour.
        expect((await request.get('/')).headers()['x-frame-options']).toBe('SAMEORIGIN');
    });

    test('drops the CSP again once the origin is revoked', async ({ page, request }) => {
        await askToEmbed(request, ORIGIN, 'Control Menu');
        await gotoHome(page);
        await (await waitForPrompt(page)).getByRole('button', { name: 'approve', exact: true }).click();
        await expect.poll(async () => (await request.get('/')).headers()['content-security-policy']).toBeTruthy();

        await revokeAllOrigins(page);

        // Revocation applies to the running server, with no restart.
        await expect.poll(async () => (await request.get('/')).headers()['content-security-policy']).toBeUndefined();
    });
});
