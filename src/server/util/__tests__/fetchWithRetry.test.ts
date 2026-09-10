import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ATTEMPTS,
    fetchOkWithRetry,
    fetchWithRetry,
    isRetryableStatus,
    type RetryNotice,
    retryDelayMs,
} from '../fetchWithRetry';

/** Fake `fetch` returning the queued items in order; a queued Error rejects. */
function queuedFetch(queue: (Response | Error)[]) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const res = (status: number, statusText = ''): Response =>
    ({ ok: status >= 200 && status < 300, status, statusText }) as Response;

/** Records the requested delays instead of waiting them out. */
function recordingSleep() {
    const waits: number[] = [];
    return { sleep: async (ms: number) => void waits.push(ms), waits };
}

describe('isRetryableStatus', () => {
    it('retries rate limiting and server-side failures', () => {
        for (const status of [429, 500, 502, 503, 504, 599]) {
            expect(isRetryableStatus(status), `status ${status}`).toBe(true);
        }
    });

    // A 404 is a real answer. Retrying it turns a fast, clear failure into a
    // slow, identical one. 403 is excluded on purpose: GitHub's rate-limit 403
    // is indistinguishable here from a genuine auth failure, and 429 is the
    // status that actually means "try again".
    it('never retries the client-side answers, 403 included', () => {
        for (const status of [400, 401, 403, 404, 410, 418, 422]) {
            expect(isRetryableStatus(status), `status ${status}`).toBe(false);
        }
    });

    it('does not retry success or redirect statuses', () => {
        for (const status of [200, 204, 301, 302, 304]) {
            expect(isRetryableStatus(status), `status ${status}`).toBe(false);
        }
    });
});

describe('retryDelayMs', () => {
    it('doubles from the 2s base', () => {
        expect(retryDelayMs(1)).toBe(2000);
        expect(retryDelayMs(2)).toBe(4000);
        expect(retryDelayMs(3)).toBe(8000);
    });

    it('honors an injected base', () => {
        expect(retryDelayMs(1, 10)).toBe(10);
        expect(retryDelayMs(2, 10)).toBe(20);
    });
});

describe('fetchWithRetry', () => {
    it('defaults to three attempts', () => {
        expect(DEFAULT_ATTEMPTS).toBe(3);
    });

    it('returns the first response and stops when it is OK', async () => {
        const { impl, calls } = queuedFetch([res(200)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/a', { fetchImpl: impl, sleep });
        expect(out.status).toBe(200);
        expect(calls).toHaveLength(1);
        expect(waits).toEqual([]);
    });

    it('retries a 503 and returns the success that follows', async () => {
        const { impl, calls } = queuedFetch([res(503), res(200)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/b', { fetchImpl: impl, sleep });
        expect(out.status).toBe(200);
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([2000]);
    });

    it('backs off 2s then 4s across the full three attempts', async () => {
        const { impl, calls } = queuedFetch([res(500), res(502), res(200)]);
        const { sleep, waits } = recordingSleep();
        await fetchWithRetry('https://example.test/c', { fetchImpl: impl, sleep });
        expect(calls).toHaveLength(3);
        expect(waits).toEqual([2000, 4000]);
    });

    it('does NOT retry a 404 — one call, and the 404 comes back untouched', async () => {
        const { impl, calls } = queuedFetch([res(404), res(200)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/d', { fetchImpl: impl, sleep });
        expect(out.status).toBe(404);
        expect(calls).toHaveLength(1);
        expect(waits).toEqual([]);
    });

    it('gives up after the budget and returns the last non-OK response', async () => {
        const { impl, calls } = queuedFetch([res(503), res(503), res(503)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/e', { fetchImpl: impl, sleep });
        expect(out.status).toBe(503);
        expect(calls).toHaveLength(3);
        expect(waits).toEqual([2000, 4000]);
    });

    it('retries a network error and recovers', async () => {
        const { impl, calls } = queuedFetch([new Error('ECONNRESET'), res(200)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/f', { fetchImpl: impl, sleep });
        expect(out.status).toBe(200);
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([2000]);
    });

    it('rethrows the network error once the attempts are spent', async () => {
        const { impl, calls } = queuedFetch([
            new Error('ECONNRESET'),
            new Error('ECONNRESET'),
            new Error('getaddrinfo ENOTFOUND'),
        ]);
        const { sleep } = recordingSleep();
        await expect(fetchWithRetry('https://example.test/g', { fetchImpl: impl, sleep })).rejects.toThrow(/ENOTFOUND/);
        expect(calls).toHaveLength(3);
    });

    it('reports each retry with the attempt and the reason', async () => {
        const { impl } = queuedFetch([res(500), new Error('socket hang up'), res(200)]);
        const { sleep } = recordingSleep();
        const seen: RetryNotice[] = [];
        await fetchWithRetry('https://example.test/h', {
            fetchImpl: impl,
            sleep,
            onRetry: (n) => seen.push(n),
        });
        expect(seen).toEqual([
            { url: 'https://example.test/h', attempt: 1, attempts: 3, reason: 'HTTP 500' },
            { url: 'https://example.test/h', attempt: 2, attempts: 3, reason: 'socket hang up' },
        ]);
    });

    it('passes the caller init through and attaches a timeout signal', async () => {
        const { impl, calls } = queuedFetch([res(200)]);
        const { sleep } = recordingSleep();
        await fetchWithRetry('https://example.test/i', {
            fetchImpl: impl,
            sleep,
            init: { headers: { 'User-Agent': 'ws-scrcpy-web' } },
        });
        expect((calls[0]!.init!.headers as Record<string, string>)['User-Agent']).toBe('ws-scrcpy-web');
        expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    });

    // A per-attempt deadline aborts body streaming too, so the ~110 MB Node
    // archive download must be able to opt out of it.
    it('attaches NO signal when timeoutMs is null (large streamed bodies)', async () => {
        const { impl, calls } = queuedFetch([res(200)]);
        const { sleep } = recordingSleep();
        await fetchWithRetry('https://example.test/j', { fetchImpl: impl, sleep, timeoutMs: null });
        expect(calls[0]!.init?.signal).toBeUndefined();
    });

    it('honors a caller-supplied attempt budget', async () => {
        const { impl, calls } = queuedFetch([res(503), res(503)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/k', { fetchImpl: impl, sleep, attempts: 2 });
        expect(out.status).toBe(503);
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([2000]);
    });
});

/**
 * The distinction that closes item 124: a failed version check must THROW.
 * `DependencyManager.checkLatest` catches a throw and records
 * DependencyStatus.Error with the message; a `null` return is indistinguishable
 * from "no known latest version" and gets the dependency silently skipped by
 * autoInstallMissing for the rest of the boot.
 */
describe('fetchOkWithRetry', () => {
    it('returns the response when it is OK', async () => {
        const { impl } = queuedFetch([res(200)]);
        const { sleep } = recordingSleep();
        await expect(fetchOkWithRetry('https://example.test/l', { fetchImpl: impl, sleep })).resolves.toMatchObject({
            status: 200,
        });
    });

    it('throws with the status and the URL on a 403 — the api.github.com rate-limit case', async () => {
        const { impl, calls } = queuedFetch([res(403, 'rate limit exceeded')]);
        const { sleep } = recordingSleep();
        await expect(
            fetchOkWithRetry('https://api.github.com/repos/Genymobile/scrcpy/releases/latest', {
                fetchImpl: impl,
                sleep,
            }),
        ).rejects.toThrow(/HTTP 403 rate limit exceeded from https:\/\/api\.github\.com/);
        // 403 is not retryable, so it fails fast rather than burning the budget.
        expect(calls).toHaveLength(1);
    });

    it('throws after exhausting retries on a 5xx', async () => {
        const { impl, calls } = queuedFetch([res(500), res(500), res(500)]);
        const { sleep } = recordingSleep();
        await expect(fetchOkWithRetry('https://example.test/m', { fetchImpl: impl, sleep })).rejects.toThrow(
            /HTTP 500/,
        );
        expect(calls).toHaveLength(3);
    });

    it('does not throw when a retry recovers', async () => {
        const { impl } = queuedFetch([res(503), res(200)]);
        const { sleep } = recordingSleep();
        await expect(fetchOkWithRetry('https://example.test/n', { fetchImpl: impl, sleep })).resolves.toMatchObject({
            status: 200,
        });
    });
});
