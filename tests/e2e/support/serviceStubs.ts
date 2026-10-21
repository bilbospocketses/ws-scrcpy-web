import type { BrowserContext, Page } from '@playwright/test';

/**
 * The service rows on the fast tier (smoke 4.3, 12.2, 15.3) drive controls
 * that install, remove, stop or restart something. The fast tier's server is a
 * bare `node dist/index.js` shared by every spec, with no supervisor to start
 * it again, and on Linux CI nothing may touch a service manager, so none of
 * those requests may ever reach it.
 */

/** Every endpoint that installs, removes, stops or restarts something, by path. */
export const SERVICE_ACTION_PATHS = [
    '/api/service/install', // ServiceApi.ts
    '/api/service/uninstall', // ServiceApi.ts
    '/api/service/install-system-wide', // ServiceApi.ts
    '/api/service/uninstall-app', // ServiceApi.ts
    '/api/server/shutdown', // ServerShutdownApi.ts
    // Both exit 75 for the supervisor to restart; the fast tier has none, so
    // either one ends the shared server for good.
    '/api/server/restart', // ServerRestartApi.ts
    '/api/dependencies/restart', // DependencyApi.ts
] as const;

/**
 * Refuse every service action in the browser (`blockedbyclient`) and record
 * it as `METHOD /path`, so a regression that fired one shows up in the list
 * instead of installing, uninstalling, stopping or restarting the shared
 * server. A row
 * that EXPECTS one of them routes it itself, after this: Playwright runs the
 * later route first, so the list holds only the requests nobody expected.
 *
 * Install before the first navigation, on the page or on its whole context.
 */
export async function blockServiceActions(target: Pick<Page | BrowserContext, 'route'>): Promise<string[]> {
    const blocked: string[] = [];
    const paths = new Set<string>(SERVICE_ACTION_PATHS);
    await target.route(
        (url) => paths.has(url.pathname),
        async (route) => {
            blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
            await route.abort('blockedbyclient');
        },
    );
    return blocked;
}
