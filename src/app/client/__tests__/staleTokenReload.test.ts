// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clearStaleTokenReloadMark,
    probeStaleToken,
    reloadForStaleToken,
    STALE_TOKEN_NOTICE_TEXT,
    STALE_TOKEN_PROBE_TIMEOUT_MS,
    STALE_TOKEN_PROBE_URL,
    STALE_TOKEN_RELOAD_GUARD_MS,
    showStaleTokenNotice,
} from '../staleTokenReload';

/** Item 174: what a tab left open across a restart asks before each websocket retry. */

const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('probeStaleToken', () => {
    it('asks a token-gated, read-only route, with a timeout', async () => {
        const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
            json({ authEnabled: false }, 200),
        );
        await probeStaleToken(fetchFn as unknown as typeof fetch);
        expect(STALE_TOKEN_PROBE_URL).toBe('/api/auth/me');
        const [url, init] = fetchFn.mock.calls[0]!;
        expect(url).toBe(STALE_TOKEN_PROBE_URL);
        expect(init?.cache).toBe('no-store');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(STALE_TOKEN_PROBE_TIMEOUT_MS).toBe(5000);
    });

    it('the stale-token 403 is stale, a 200 is ok', async () => {
        const stale = vi.fn(async () => json({ error: 'forbidden', reason: 'missing or invalid token' }, 403));
        expect(await probeStaleToken(stale as unknown as typeof fetch)).toBe('stale');
        const ok = vi.fn(async () => json({ authEnabled: false }, 200));
        expect(await probeStaleToken(ok as unknown as typeof fetch)).toBe('ok');
    });

    it('still reports a stale token on a WebView without AbortSignal.timeout', async () => {
        const original = AbortSignal.timeout;
        // Simulate an older runtime that has no AbortSignal.timeout.
        (AbortSignal as unknown as { timeout: unknown }).timeout = undefined;
        try {
            const stale = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
                expect(init?.signal).toBeInstanceOf(AbortSignal);
                return json({ error: 'forbidden', reason: 'missing or invalid token' }, 403);
            });
            expect(await probeStaleToken(stale as unknown as typeof fetch)).toBe('stale');
        } finally {
            AbortSignal.timeout = original;
        }
    });

    it('another 403, a 5xx, a non-JSON body or no server at all is unknown', async () => {
        const answers: Array<() => Promise<Response>> = [
            async () => json({ error: 'forbidden' }, 403),
            async () => json({ error: 'cross-origin request rejected' }, 403),
            async () => json({ error: 'boom' }, 500),
            async () => new Response('<html>', { status: 403 }),
            async () => {
                throw new TypeError('Failed to fetch');
            },
        ];
        for (const answer of answers) {
            expect(await probeStaleToken(vi.fn(answer) as unknown as typeof fetch)).toBe('unknown');
        }
    });

    it('a probe that never answers gives up at its timeout, so the retry loop goes on', async () => {
        // A fetch that only ends when its signal aborts: a server that accepted
        // the connection and then hung.
        const hung = vi.fn(
            (_url: RequestInfo | URL, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
                }),
        );
        const started = Date.now();
        expect(await probeStaleToken(hung as unknown as typeof fetch, 50)).toBe('unknown');
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe('reloadForStaleToken', () => {
    function deps(start = 1_000_000) {
        const store = new Map<string, string>();
        let now = start;
        const reload = vi.fn();
        return {
            reload,
            advance: (ms: number) => {
                now += ms;
            },
            d: {
                storage: {
                    getItem: (k: string) => store.get(k) ?? null,
                    setItem: (k: string, v: string) => {
                        store.set(k, v);
                    },
                    removeItem: (k: string) => {
                        store.delete(k);
                    },
                },
                now: () => now,
                reload,
            },
        };
    }

    it('reloads the first time', () => {
        const t = deps();
        expect(reloadForStaleToken(t.d)).toBe(true);
        expect(t.reload).toHaveBeenCalledTimes(1);
    });

    it('does not reload again inside the guard window, so a reload that did not help cannot loop', () => {
        const t = deps();
        reloadForStaleToken(t.d);
        t.advance(STALE_TOKEN_RELOAD_GUARD_MS - 1);
        expect(reloadForStaleToken(t.d)).toBe(false);
        expect(t.reload).toHaveBeenCalledTimes(1);
    });

    it('reloads again inside the window once the page has connected since (a second restart)', () => {
        const t = deps();
        reloadForStaleToken(t.d);
        t.advance(30_000);
        clearStaleTokenReloadMark(t.d.storage);
        expect(reloadForStaleToken(t.d)).toBe(true);
        expect(t.reload).toHaveBeenCalledTimes(2);
    });

    it('reloads again once the window has passed', () => {
        const t = deps();
        reloadForStaleToken(t.d);
        t.advance(STALE_TOKEN_RELOAD_GUARD_MS);
        expect(reloadForStaleToken(t.d)).toBe(true);
        expect(t.reload).toHaveBeenCalledTimes(2);
    });

    it('reloads without storage rather than never', () => {
        const reload = vi.fn();
        expect(reloadForStaleToken({ storage: null, now: () => 0, reload })).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
    });
});

describe('showStaleTokenNotice', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        document.body.style.paddingBottom = '';
    });

    it('shows one lowercase notice with a reload button, however many trackers give up', () => {
        const reload = vi.fn();
        const a = showStaleTokenNotice(reload);
        const b = showStaleTokenNotice(reload);
        expect(b).toBe(a);
        expect(document.querySelectorAll('[data-stale-token-notice]')).toHaveLength(1);
        expect(a.getAttribute('role')).toBe('alert');
        expect(a.textContent).toContain(STALE_TOKEN_NOTICE_TEXT);
        expect(STALE_TOKEN_NOTICE_TEXT).toBe(STALE_TOKEN_NOTICE_TEXT.toLowerCase());
        const button = a.querySelector('button')!;
        expect(button.textContent).toBe('reload');
        button.click();
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
