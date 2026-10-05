import { readFileSync } from 'node:fs';
import { type APIRequestContext, request as apiRequest, expect, type Frame, type Page, test } from '@playwright/test';
import { e2eBaseUrl, expectLoginHtml, loginAs, me, mintToken } from './support/auth';
import { askToEmbed, gotoHome, resetSharedEmbedState, waitForPrompt } from './support/consent';
import { countFetches, fetchCount } from './support/fetchCounter';
import { PRIVATE_ADMIN, PRIVATE_USER, startLockedPrivateServer } from './support/lockedServer';
import { lanAddress, serveHtml } from './support/rawHttp';

/**
 * Smoke rows 10.15 (the consent flow's trust edges), 10.16 (theme messages from
 * an approved embedder only) and the fast-tier half of 10.20 (embed.html's
 * missing-`device` error).
 *
 * 10.10 (`embed-consent.spec.ts`) covers approve / deny. This file covers what
 * stands around them: who may ask, who may decide, what happens when nobody
 * does, and who may drive the theme of a frame once one is allowed.
 *
 * Every test leaves the shared server as it found it — no pending request, no
 * approved origin, the stored theme unchanged — through `resetSharedEmbedState`
 * and the theme restore in 10.16. Locked mode runs on a spec-owned server on
 * 8181, because nothing in the API can take the shared server back out of it.
 */

/**
 * The approved embedder and an unapproved sibling: two tiny pages served from
 * this test process on loopback (8188, 8189 — batch D's private range).
 *
 * Real listeners, not `page.route`: Chrome's Local Network Access check treats
 * a document Playwright fulfils as coming from outside the machine, and then
 * refuses its iframe of the app on localhost (`ERR_BLOCKED_BY_LOCAL_NETWORK_
 * ACCESS_CHECKS`) — a browser policy, nothing to do with the app's.
 *
 * Both are `localhost` on purpose: SameSite ignores the port, so the app framed
 * by them is same-site and keeps its Strict token cookie — see README
 * "Embedding". A cross-site embedder over plain http cannot authenticate inside
 * the frame at all, which would make "ignored" pass for the wrong reason.
 */
const EMBEDDER = 'http://localhost:8188';
const STRANGER = 'http://localhost:8189';

/** Copied from src/app/public/themeEmbed.ts (DEFAULT_MESSAGE_TYPE and its suffixes). */
const THEME = 'ws-scrcpy-web:theme';
const THEME_READY = 'ws-scrcpy-web:theme-ready';
const THEME_CHANGED = 'ws-scrcpy-web:theme-changed';
const THEME_REQUEST = 'ws-scrcpy-web:theme-request';

/** Copied from src/server/api/EmbedRequestApi.ts. */
const ASK_REFUSED_REMOTE = 'embed requests are accepted from this machine only';
const CANCEL_REFUSED_REMOTE = 'embed requests are cancelled from this machine only';
const DECIDE_REFUSED_REMOTE = 'embed permission is decided on this machine only';

/** Copied from src/app/public/embed-entry.ts; the error colour is `#f06c75`. */
const MISSING_DEVICE = 'missing required "device" param';
const ERROR_RGB = 'rgb(240, 108, 117)';

function appOrigin(): string {
    return new URL(e2eBaseUrl()).origin;
}

async function embedStatus(ctx: APIRequestContext, id: string): Promise<string> {
    const res = await ctx.get(`/embed-request/${encodeURIComponent(id)}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { status: string }).status;
}

test.describe('10.15 embed consent: the trust edges', () => {
    test.afterEach(async ({ request }) => {
        await resetSharedEmbedState(request);
    });

    test('10.15 in locked mode the consent endpoints answer JSON, a non-admin decision is 403, and the admin decision lands', async () => {
        test.setTimeout(180_000);
        // Its own adb daemon (8184), so neither its device poll nor its shutdown
        // ever reaches the machine's daemon on 5037, which the shared server uses.
        const server = await startLockedPrivateServer('ws-scrcpy-web-e2e-164d-embed-locked', 8181, {
            isolatedAdbPort: 8184,
        });
        const contexts: APIRequestContext[] = [];
        const newCtx = async () => {
            const ctx = await apiRequest.newContext({ baseURL: server.paths.baseURL });
            contexts.push(ctx);
            return ctx;
        };
        try {
            // No session and no token: the asking app's position.
            const anon = await newCtx();

            // The server IS locked: a document is the login page, the admin API 401s.
            const doc = await anon.get('/');
            expect(doc.status()).toBe(200);
            expectLoginHtml(await doc.text());
            const gated = await anon.get('/api/embed-request');
            expect(gated.status()).toBe(401);
            expect(await gated.json()).toEqual({ error: 'unauthorized' });

            // ...and the ask is still answered as JSON, not with that login page.
            const ask = await anon.post('/embed-request', { data: { origin: EMBEDDER, appName: 'E2E Locked' } });
            expect(ask.status()).toBe(200);
            expect(ask.headers()['content-type']).toContain('application/json');
            const askText = await ask.text();
            expect(askText).not.toContain('<title>Sign in</title>');
            const asked = JSON.parse(askText) as { id: string; status: string };
            expect(asked).toEqual({ id: expect.any(String), status: 'pending' });
            const statusRes = await anon.get(`/embed-request/${encodeURIComponent(asked.id)}`);
            expect(statusRes.headers()['content-type']).toContain('application/json');
            expect(await statusRes.json()).toEqual({ id: asked.id, status: 'pending' });

            // A signed-in non-admin can neither read the pending request nor decide it.
            const user = await newCtx();
            await mintToken(user);
            expect((await loginAs(user, PRIVATE_USER)).status()).toBe(200);
            expect((await me(user)).user).toEqual({ username: PRIVATE_USER.username, role: 'user' });
            const userRead = await user.get('/api/embed-request');
            expect(userRead.status()).toBe(403);
            expect(await userRead.json()).toEqual({ error: 'forbidden' });
            for (const approved of [true, false]) {
                const decision = await user.post('/api/embed-request/decision', { data: { id: asked.id, approved } });
                expect(decision.status(), `non-admin decision approved=${approved}`).toBe(403);
                expect(await decision.json()).toEqual({ error: 'forbidden' });
            }
            // Refused means refused: still pending, nothing written.
            expect(await embedStatus(anon, asked.id)).toBe('pending');
            const configAfterUser = JSON.parse(readFileSync(server.paths.configPath, 'utf8')) as {
                frameAncestors?: string[];
            };
            expect(configAfterUser.frameAncestors ?? []).not.toContain(EMBEDDER);

            // The control: the admin on the same server reads and decides the same request.
            const admin = await newCtx();
            await mintToken(admin);
            expect((await loginAs(admin, PRIVATE_ADMIN)).status()).toBe(200);
            const adminRead = await admin.get('/api/embed-request');
            expect(adminRead.status()).toBe(200);
            expect(await adminRead.json()).toMatchObject({
                request: { id: asked.id, origin: EMBEDDER, appName: 'E2E Locked' },
            });
            const approve = await admin.post('/api/embed-request/decision', { data: { id: asked.id, approved: true } });
            expect(approve.status()).toBe(200);
            expect(await approve.json()).toEqual({ status: 'approved', origin: EMBEDDER });
            expect(await embedStatus(anon, asked.id)).toBe('approved');
            await expect
                .poll(
                    () =>
                        (JSON.parse(readFileSync(server.paths.configPath, 'utf8')) as { frameAncestors?: string[] })
                            .frameAncestors,
                )
                .toContain(EMBEDDER);
        } finally {
            for (const ctx of contexts) await ctx.dispose();
            await server.stop();
        }
    });

    test('10.15 a request from another machine is refused, while the same request from this machine is accepted', async ({
        request,
    }) => {
        const ip = lanAddress();
        expect(
            ip,
            'this host needs a non-loopback IPv4 address to stand in for another machine (none found in os.networkInterfaces())',
        ).toBeTruthy();
        const lan = await apiRequest.newContext({ baseURL: `http://${ip}:${new URL(e2eBaseUrl()).port}` });
        try {
            // The remote ask.
            const remoteAsk = await lan.post('/embed-request', { data: { origin: EMBEDDER, appName: 'E2E Remote' } });
            expect(remoteAsk.status()).toBe(403);
            expect(await remoteAsk.json()).toEqual({ error: ASK_REFUSED_REMOTE });

            // The control: the identical body from loopback raises a pending request.
            const id = await askToEmbed(request, EMBEDDER, 'E2E Local');

            // The other two remote moves on that request: deciding it (with a
            // token the LAN client minted for itself — the gap the loopback
            // check exists for) and withdrawing it.
            await mintToken(lan);
            const remoteRead = await lan.get('/api/embed-request');
            expect(remoteRead.status()).toBe(403);
            expect(await remoteRead.json()).toEqual({ error: DECIDE_REFUSED_REMOTE });
            const remoteDecide = await lan.post('/api/embed-request/decision', { data: { id, approved: true } });
            expect(remoteDecide.status()).toBe(403);
            expect(await remoteDecide.json()).toEqual({ error: DECIDE_REFUSED_REMOTE });
            const remoteCancel = await lan.post(`/embed-request/${encodeURIComponent(id)}/cancel`);
            expect(remoteCancel.status()).toBe(403);
            expect(await remoteCancel.json()).toEqual({ error: CANCEL_REFUSED_REMOTE });

            // None of the three took: the request is still pending.
            expect(await embedStatus(request, id)).toBe('pending');

            // And from loopback the withdrawal works.
            const localCancel = await request.post(`/embed-request/${encodeURIComponent(id)}/cancel`);
            expect(await localCancel.json()).toEqual({ id, cancelled: true, status: 'cancelled' });
        } finally {
            await lan.dispose();
        }
    });

    test('10.15 an expired request leaves the close-button notice and sends no decision', async ({
        page,
        browser,
        request,
    }) => {
        await countFetches(page, ['/api/embed-request/decision']);
        const id = await askToEmbed(request, EMBEDDER, 'E2E Expiry');

        // The prompt counts down on the page's clock, so the page's clock is the
        // one moved. The server's five minutes are untouched, which is what lets
        // the request still read 'pending' below: a decision, had one been sent,
        // would have been accepted.
        await page.clock.install();
        await gotoHome(page);
        const prompt = await waitForPrompt(page);
        await expect(prompt).toContainText('This request expires in');
        await expect(prompt.getByRole('button', { name: 'approve', exact: true })).toBeVisible();

        await page.clock.fastForward('05:01');

        await expect(prompt).toContainText(
            'The five-minute window to approve this request has timed out. E2E Expiry was not granted permission to embed this app.',
        );
        await expect(prompt.getByRole('button', { name: 'approve', exact: true })).toHaveCount(0);
        await expect(prompt.getByRole('button', { name: 'deny', exact: true })).toHaveCount(0);
        await prompt.getByRole('button', { name: 'close', exact: true }).click();
        await expect(prompt).toBeHidden();

        expect(await fetchCount(page, '/api/embed-request/decision')).toBe(0);
        expect(await embedStatus(request, id)).toBe('pending');
        expect(await (await request.post(`/embed-request/${encodeURIComponent(id)}/cancel`)).json()).toMatchObject({
            cancelled: true,
        });

        // The control: a prompt answered with a button DOES send its decision, and
        // the same counter sees it. In a fresh browser context, because the
        // clock belongs to the context: this one now runs five minutes ahead of
        // the server, and every prompt it raised would open already expired.
        await page.close();
        const freshContext = await browser.newContext({ baseURL: e2eBaseUrl() });
        try {
            const fresh = await freshContext.newPage();
            await countFetches(fresh, ['/api/embed-request/decision']);
            const second = await askToEmbed(request, EMBEDDER, 'E2E Expiry Control');
            await gotoHome(fresh);
            const secondPrompt = await waitForPrompt(fresh);
            await expect(secondPrompt).toContainText('E2E Expiry Control');
            await expect(secondPrompt).toContainText('This request expires in');
            await secondPrompt.getByRole('button', { name: 'deny', exact: true }).click();
            await expect.poll(() => fetchCount(fresh, '/api/embed-request/decision')).toBe(1);
            await expect.poll(() => embedStatus(request, second)).toBe('denied');
        } finally {
            await freshContext.close();
        }
    });
});

/**
 * The host page for 10.16: frames the app, frames an unapproved sibling, and
 * records every message it receives. Its listener is installed in <head>,
 * before either frame exists, so the app's one-shot load handshake cannot be
 * missed (README "Race condition note").
 */
function hostPage(app: string): string {
    return `<!doctype html><html><head><title>e2e embedder</title><script>
window.__messages = [];
window.addEventListener('message', function (e) { window.__messages.push({ origin: e.origin, data: e.data }); });
</script></head><body>
<iframe id="app" src="${app}/" style="width: 1100px; height: 700px; border: 0"></iframe>
<iframe id="stranger" src="${STRANGER}/" style="width: 200px; height: 60px; border: 0"></iframe>
</body></html>`;
}

interface HostMessage {
    origin: string;
    data: { type?: string; theme?: string };
}

async function hostMessages(page: Page, type: string): Promise<HostMessage[]> {
    const all = await page.evaluate(() => (window as unknown as { __messages: HostMessage[] }).__messages);
    return all.filter((m) => m.data?.type === type);
}

async function frameTheme(frame: Frame): Promise<string | null> {
    return frame.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

async function storedTheme(ctx: APIRequestContext): Promise<unknown> {
    const res = await ctx.get('/api/settings');
    expect(res.status()).toBe(200);
    return ((await res.json()) as Record<string, unknown>)['theme'];
}

test.describe('10.16 theme messages from an approved embedder only', () => {
    test.afterEach(async ({ request }) => {
        await resetSharedEmbedState(request);
    });

    test('10.16 a theme from an unapproved origin is ignored; one from the approved embedder applies, is not persisted, and the handshake messages arrive', async ({
        page,
        request,
    }) => {
        const app = appOrigin();

        // Approve the embedder through the same decision route the prompt's
        // button calls (10.10 drives that button; here it is only the setup).
        await mintToken(request);
        const id = await askToEmbed(request, EMBEDDER, 'E2E Theme Host');
        const decided = await request.post('/api/embed-request/decision', { data: { id, approved: true } });
        expect(await decided.json()).toEqual({ status: 'approved', origin: EMBEDDER });

        const originalStored = await storedTheme(request);
        const embedderSite = await serveHtml(Number(new URL(EMBEDDER).port), hostPage(app));
        const strangerSite = await serveHtml(
            Number(new URL(STRANGER).port),
            '<!doctype html><title>stranger</title><p>unapproved sibling</p>',
        );
        try {
            await page.goto(`${EMBEDDER}/`);

            const appFrame = await (await page.locator('#app').elementHandle())?.contentFrame();
            const strangerFrame = await (await page.locator('#stranger').elementHandle())?.contentFrame();
            if (!appFrame || !strangerFrame) throw new Error('the host page did not create both frames');

            // Settled: the header toggle mounts only after the stored theme is applied.
            await appFrame.locator('button.theme-toggle:not(.modal-close)').waitFor();
            // Two readies: one at module load, one re-announced once /api/config
            // has widened the allowlist to the approved embedder.
            await expect.poll(async () => (await hostMessages(page, THEME_READY)).length).toBe(2);
            const original = await frameTheme(appFrame);
            expect(original === 'dark' || original === 'light').toBe(true);
            expect(original).toBe(originalStored);
            const opposite = original === 'dark' ? 'light' : 'dark';
            for (const ready of await hostMessages(page, THEME_READY)) {
                expect(ready).toEqual({ origin: app, data: { type: THEME_READY, theme: original } });
            }

            // Witness every message the app's window receives, so "ignored" can be
            // told apart from "never delivered".
            await appFrame.evaluate(() => {
                const w = window as unknown as { __received: { origin: string; data: unknown }[] };
                w.__received = [];
                window.addEventListener('message', (e) => w.__received.push({ origin: e.origin, data: e.data }));
            });

            // The unapproved origin pushes a theme into the app frame.
            await strangerFrame.evaluate(
                ({ type, theme }) => {
                    window.parent.frames[0]?.postMessage({ type, theme }, '*');
                },
                { type: THEME, theme: opposite },
            );
            // Barrier: the approved parent asks for a fresh handshake AFTER it. The
            // reply is the app's theme once the stranger's message has been handled.
            await page.evaluate(
                ({ type, target }) => {
                    (document.getElementById('app') as HTMLIFrameElement).contentWindow?.postMessage({ type }, target);
                },
                { type: THEME_REQUEST, target: app },
            );
            await expect.poll(async () => (await hostMessages(page, THEME_READY)).length).toBe(3);
            expect((await hostMessages(page, THEME_READY))[2]).toEqual({
                origin: app,
                data: { type: THEME_READY, theme: original },
            });
            expect(await frameTheme(appFrame)).toBe(original);
            const received = await appFrame.evaluate(
                () => (window as unknown as { __received: { origin: string; data: unknown }[] }).__received,
            );
            expect(received).toContainEqual({ origin: STRANGER, data: { type: THEME, theme: opposite } });

            // The control: the approved parent's identical message applies.
            await page.evaluate(
                ({ type, theme, target }) => {
                    (document.getElementById('app') as HTMLIFrameElement).contentWindow?.postMessage(
                        { type, theme },
                        target,
                    );
                },
                { type: THEME, theme: opposite, target: app },
            );
            await expect.poll(() => frameTheme(appFrame)).toBe(opposite);

            // Not persisted: the user's own theme is still the stored one, and a
            // reload of the frame comes back to it (and handshakes again).
            expect(await storedTheme(request)).toBe(original);
            await appFrame.goto(`${app}/`);
            await appFrame.locator('button.theme-toggle:not(.modal-close)').waitFor();
            expect(await frameTheme(appFrame)).toBe(original);
            await expect.poll(async () => (await hostMessages(page, THEME_READY)).length).toBe(5);
            expect(await storedTheme(request)).toBe(original);

            // theme-changed: posted to the parent when a theme applies through the
            // app's own toggle (README "Embedding: theme bridge"). Each step is
            // waited out in the store before the next, so the two writes cannot
            // land out of order and leave the opposite theme saved.
            expect(await hostMessages(page, THEME_CHANGED)).toEqual([]);
            const toggle = appFrame.locator('button.theme-toggle:not(.modal-close)');
            await toggle.click();
            await expect
                .poll(() => hostMessages(page, THEME_CHANGED))
                .toEqual([{ origin: app, data: { type: THEME_CHANGED, theme: opposite } }]);
            expect(await frameTheme(appFrame)).toBe(opposite);
            await expect.poll(() => storedTheme(request)).toBe(opposite);
            await toggle.click();
            await expect.poll(async () => (await hostMessages(page, THEME_CHANGED)).length).toBe(2);
            expect((await hostMessages(page, THEME_CHANGED))[1]).toEqual({
                origin: app,
                data: { type: THEME_CHANGED, theme: original },
            });
            await expect.poll(() => storedTheme(request)).toBe(original);
        } finally {
            await embedderSite.close();
            await strangerSite.close();
            // Belt for a failure between the two toggle clicks.
            if ((await storedTheme(request)) !== originalStored) {
                const res = await request.patch('/api/settings', { data: { theme: originalStored } });
                expect(res.status(), 'restore the stored theme').toBe(200);
            }
        }
    });
});

test.describe('10.20 embed.html', () => {
    /**
     * Record every call to `WsScrcpy.startStream`, then call through. The UMD
     * bundle assigns `globalThis.WsScrcpy`, so a setter on window sees it land
     * before embed.js reads it.
     */
    async function spyOnStartStream(page: Page): Promise<void> {
        await page.addInitScript(() => {
            type Lib = { startStream: (container: HTMLElement, deviceId: string, options?: unknown) => unknown };
            const w = window as unknown as { __startStreamCalls: { deviceId: string }[] };
            w.__startStreamCalls = [];
            let lib: Lib | undefined;
            Object.defineProperty(window, 'WsScrcpy', {
                configurable: true,
                get: () => lib,
                set: (value: Lib) => {
                    // A copy, not an assignment onto `value`: the bundle hands over
                    // its module namespace, whose exports are read-only getters,
                    // so assigning to one is silently ignored.
                    const original = value.startStream.bind(value);
                    lib = {
                        ...value,
                        startStream: (container, deviceId, options) => {
                            w.__startStreamCalls.push({ deviceId });
                            return original(container, deviceId, options);
                        },
                    };
                },
            });
        });
    }

    async function startStreamCalls(page: Page): Promise<{ deviceId: string }[]> {
        return page.evaluate(
            () => (window as unknown as { __startStreamCalls: { deviceId: string }[] }).__startStreamCalls,
        );
    }

    test('10.20 embed.html with no device param shows the red missing-device error and starts no stream', async ({
        page,
    }) => {
        await spyOnStartStream(page);
        const status = page.locator('#status');

        for (const path of ['/embed.html', '/embed.html?device=', '/embed.html?codec=h264&maxFps=15']) {
            await page.goto(path);
            await expect(status, path).toHaveText(MISSING_DEVICE);
            await expect(status, path).toBeVisible();
            await expect(status, path).toHaveCSS('color', ERROR_RGB);
            expect(await startStreamCalls(page), path).toEqual([]);
        }

        // The control: with a device the same page hands it to startStream and
        // never shows the missing-device error. (Whether that device then
        // streams is the device tier's half of the row.)
        await page.goto('/embed.html?device=e2e-no-such-device&codec=h264');
        await expect.poll(() => startStreamCalls(page)).toEqual([{ deviceId: 'e2e-no-such-device' }]);
        await expect(status).not.toHaveText(MISSING_DEVICE);
    });
});
