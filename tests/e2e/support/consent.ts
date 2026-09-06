import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { E2E_CONFIG_PATH } from './paths';

export interface ServerConfig {
    installMode?: string;
    webPort?: number;
    firstRunComplete?: boolean;
    frameAncestors?: string[];
    [key: string]: unknown;
}

/**
 * Navigate to the app.
 *
 * Until item 113 this also had to clear the bookmark reminder out of the way:
 * `PortChangeModal` ("this app lives at: ...") was a <dialog> stacked above the
 * consent prompt that silently swallowed the clicks aimed at it — the specs then
 * failed with "subtree intercepts pointer events", which points nowhere near the
 * cause. The reminder is a non-modal card now (`BookmarkReminder`) and
 * global-setup pre-dismisses it for the run; a developer who sees it anyway loses
 * nothing, because it captures no clicks.
 */
export async function gotoHome(page: Page): Promise<void> {
    await page.goto('/');
}

/** Read the config file the running e2e server is actually bound to. */
export function readServerConfig(): ServerConfig {
    return JSON.parse(readFileSync(E2E_CONFIG_PATH, 'utf8')) as ServerConfig;
}

/**
 * Raise a consent prompt the way another local app does: an unauthenticated,
 * loopback POST carrying no Origin header. Playwright's request context does not
 * set Origin, which is precisely how a native app behaves and why this is allowed
 * where a browser page would be rejected.
 */
export async function askToEmbed(request: APIRequestContext, origin: string, appName: string): Promise<string> {
    const res = await request.post('/embed-request', { data: { origin, appName } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('pending');
    return body.id;
}

/** The consent prompt raised by {@link askToEmbed}, once the page's poller has picked it up. */
export function consentPrompt(page: Page) {
    return page.locator('dialog.confirm-modal').filter({ hasText: 'allow embedding?' });
}

/**
 * Wait for the prompt to surface.
 *
 * The generous timeout is not padding: the prompt is discovered by a poll rather
 * than pushed, so worst case is a full poll interval after the request lands.
 */
export async function waitForPrompt(page: Page) {
    const prompt = consentPrompt(page);
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    return prompt;
}

/**
 * Withdraw every approved origin through the app's own API.
 *
 * Deliberately NOT a file write. `frameAncestors` is applied to the live server as
 * it changes (`Config.removeFrameAncestor` calls through to `setFrameAncestors`), so
 * editing config.json behind the server's back would leave the file and the
 * in-memory allowlist disagreeing — and the next header assertion would then fail
 * for a reason that has nothing to do with the behaviour under test.
 *
 * Runs inside the page so the per-instance token cookie is attached to both calls.
 */
export async function revokeAllOrigins(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const listed = await fetch('/api/embed-origins');
        if (!listed.ok) return;
        const { origins } = (await listed.json()) as { origins: string[] };
        for (const origin of origins) {
            await fetch('/api/embed-origins/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ origin }),
            });
        }
    });
}
