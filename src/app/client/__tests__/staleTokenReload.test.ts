import { describe, expect, it, vi } from 'vitest';
import {
    probeStaleToken,
    reloadForStaleToken,
    STALE_TOKEN_PROBE_URL,
    STALE_TOKEN_RELOAD_GUARD_MS,
} from '../staleTokenReload';

/** Item 174: what a tab left open across a restart asks before each websocket retry. */

const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('probeStaleToken', () => {
    it('asks a token-gated, read-only route', async () => {
        const fetchFn = vi.fn(async () => json({ authEnabled: false }, 200));
        await probeStaleToken(fetchFn as unknown as typeof fetch);
        expect(fetchFn).toHaveBeenCalledWith(STALE_TOKEN_PROBE_URL, { cache: 'no-store' });
        expect(STALE_TOKEN_PROBE_URL).toBe('/api/auth/me');
    });

    it('the stale-token 403 is stale', async () => {
        const fetchFn = vi.fn(async () => json({ error: 'forbidden', reason: 'missing or invalid token' }, 403));
        expect(await probeStaleToken(fetchFn as unknown as typeof fetch)).toBe(true);
    });

    it('a working token, another 403, a 5xx, a non-JSON body or no server at all is not', async () => {
        const answers: Array<() => Promise<Response>> = [
            async () => json({ authEnabled: false }, 200),
            async () => json({ error: 'forbidden' }, 403),
            async () => json({ error: 'cross-origin request rejected' }, 403),
            async () => json({ error: 'boom' }, 500),
            async () => new Response('<html>', { status: 403 }),
            async () => {
                throw new TypeError('Failed to fetch');
            },
        ];
        for (const answer of answers) {
            expect(await probeStaleToken(vi.fn(answer) as unknown as typeof fetch)).toBe(false);
        }
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
                    setItem: (k: string, v: string) => store.set(k, v),
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

    it('reloads again once the window has passed (the next restart)', () => {
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
