import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { openSettings, openSettingsTab } from './auth';

/**
 * The Local HTTPS panel (Settings → Server), and the browser-side stubs that
 * let a row drive it against the SHARED server without ever changing that
 * server's TLS state.
 */

/** Settings → Server → the Local HTTPS section, once its state fetch has rendered. */
export async function openLocalHttpsPanel(page: Page): Promise<Locator> {
    const settings = await openSettings(page);
    const server = await openSettingsTab(settings, 'Server');
    const panel = server
        .locator('section.settings-section')
        .filter({ has: page.locator('h3.settings-section-heading', { hasText: 'Local HTTPS' }) });
    await expect(panel).toBeVisible();
    // The panel is swapped in only after GET /api/tls/state has answered.
    await expect(panel.locator('[data-tls-generate]')).toBeVisible();
    return panel;
}

/**
 * Answer GET /api/tls/state with `initial`, and with whatever `set()` names
 * after that (takes effect on the panel's next build, i.e. a reload); the
 * server never sees the request.
 */
export async function stubTlsState(
    page: Page,
    initial: Record<string, unknown>,
): Promise<{ set(state: Record<string, unknown>): void }> {
    let current = initial;
    await page.route(
        (url) => url.pathname === '/api/tls/state',
        (route: Route) =>
            route.request().method() === 'GET'
                ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) })
                : route.fallback(),
    );
    return {
        set(state) {
            current = state;
        },
    };
}

export interface TlsWriteLog {
    writes: { method: string; pathname: string; body: unknown }[];
}

/**
 * Catch every non-GET to /api/tls/* before it leaves the browser, so a panel
 * driven against the SHARED server can never generate, revoke, change exposure
 * or restart it through the https port. `respond` decides the stubbed answer.
 */
export async function guardTlsWrites(
    page: Page,
    respond: (pathname: string, body: unknown) => { status: number; json: unknown } = () => ({
        status: 418,
        json: { error: 'blocked by the e2e write guard' },
    }),
): Promise<TlsWriteLog> {
    const log: TlsWriteLog = { writes: [] };
    await page.route(
        (url) => url.pathname.startsWith('/api/tls/'),
        (route: Route) => {
            const req = route.request();
            if (req.method() === 'GET' || req.method() === 'HEAD') return route.fallback();
            const pathname = new URL(req.url()).pathname;
            let body: unknown = null;
            try {
                body = req.postDataJSON();
            } catch {
                body = req.postData();
            }
            log.writes.push({ method: req.method(), pathname, body });
            const answer = respond(pathname, body);
            return route.fulfill({
                status: answer.status,
                contentType: 'application/json',
                body: JSON.stringify(answer.json),
            });
        },
    );
    return log;
}
