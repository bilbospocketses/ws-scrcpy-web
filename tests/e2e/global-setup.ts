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
    /**
     * Honour PLAYWRIGHT_BASE_URL, exactly as both configs' `use.baseURL` does.
     *
     * Hardcoding E2E_BASE_URL worked only while every run started its own server
     * on 8123. The heavy tier does not: qa-harness owns the stack, sets
     * QA_EXTERNAL_STACK=1 so the config starts nothing, and points
     * PLAYWRIGHT_BASE_URL at its own address — where this would then fail with
     * ECONNREFUSED against 8123 before a single spec ran, blaming a port nobody
     * asked it to use.
     */
    const baseURL = process.env['PLAYWRIGHT_BASE_URL'] || E2E_BASE_URL;
    const ctx = await request.newContext({ baseURL });
    try {
        // A document GET is what mints the per-instance token cookie that gates /api.
        await ctx.get('/');
        const res = await ctx.patch('/api/settings', {
            data: { bookmarkDismissedGlobally: true, serviceFirstRunSeen: true },
        });
        if (!res.ok()) {
            // A 401 here has one known cause: the e2e database is in locked mode.
            // playwright.config.ts wipes it before webServer starts, so this only
            // fires when that wipe was bypassed (QA_EXTERNAL_STACK, or a hand-run
            // server) — name the cause rather than let it look like a harness bug.
            const hint =
                res.status() === 401
                    ? ' — the e2e database is in locked mode; playwright.config.ts should have wiped ' +
                      'wsscrcpy.db under the e2e data root (delete it and its -wal/-shm sidecars and rerun)'
                    : '';
            throw new Error(`could not pre-dismiss the bookmark reminder: ${res.status()} ${await res.text()}${hint}`);
        }
    } finally {
        await ctx.dispose();
    }
}
