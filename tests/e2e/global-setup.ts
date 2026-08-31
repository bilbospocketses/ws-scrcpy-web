import { request } from '@playwright/test';
import { E2E_BASE_URL } from './support/paths';

/**
 * Switch off the bookmark reminder before any spec runs.
 *
 * `PortChangeModal` ("this app lives at: ...") opens on every page load for a port
 * the user has not acknowledged, and the suite deliberately runs against a virgin
 * data root — so that is every load. It is a plain <dialog> stacked above the
 * consent prompt, and it silently swallows the clicks aimed at the prompt beneath
 * it. Specs then fail with "subtree intercepts pointer events", which points
 * nowhere near the actual cause.
 *
 * Dismissing it inside each spec raced the async config+settings fetch that opens
 * it, so it is switched off exactly once, here, through the same endpoint the
 * modal's own "don't show again" checkbox writes to.
 *
 * Note the ordering this relies on: Playwright starts `webServer` BEFORE globalSetup,
 * which is why the seed config is written at config-load time instead (see
 * playwright.config.ts) while this — which needs a live server — belongs here.
 */
export default async function globalSetup(): Promise<void> {
    const ctx = await request.newContext({ baseURL: E2E_BASE_URL });
    try {
        // A document GET is what mints the per-instance token cookie that gates /api.
        await ctx.get('/');
        const res = await ctx.patch('/api/settings', {
            data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
        });
        if (!res.ok()) {
            throw new Error(`could not pre-dismiss the bookmark reminder: ${res.status()} ${await res.text()}`);
        }
    } finally {
        await ctx.dispose();
    }
}
