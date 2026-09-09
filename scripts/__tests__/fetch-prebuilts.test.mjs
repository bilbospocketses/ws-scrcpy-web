import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_RELEASE_URL_BASE,
    fetchWithRetry,
    isRetryableStatus,
    readInstalledNodePtyVersion,
    resolveReleaseUrlBase,
    retryDelayMs,
} from '../fetch-prebuilts.mjs';

describe('resolveReleaseUrlBase', () => {
    it('uses the canonical GitHub URL when no override env is set', () => {
        const r = resolveReleaseUrlBase({});
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.overridden).toBe(false);
        expect(r.ignoredOverride).toBe(false);
    });

    it('ignores WSSCRCPY_RELEASE_URL_BASE without the explicit opt-in', () => {
        const r = resolveReleaseUrlBase({
            WSSCRCPY_RELEASE_URL_BASE: 'https://evil.example/releases/download',
        });
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.overridden).toBe(false);
        expect(r.ignoredOverride).toBe(true);
    });

    it('honors the override only when WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE=1', () => {
        const r = resolveReleaseUrlBase({
            WSSCRCPY_RELEASE_URL_BASE: 'https://mirror.internal/dl',
            WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE: '1',
        });
        expect(r.base).toBe('https://mirror.internal/dl');
        expect(r.overridden).toBe(true);
        expect(r.ignoredOverride).toBe(false);
    });

    it('treats any opt-in value other than "1" as not opted in', () => {
        const r = resolveReleaseUrlBase({
            WSSCRCPY_RELEASE_URL_BASE: 'https://mirror.internal/dl',
            WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE: 'true',
        });
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.ignoredOverride).toBe(true);
    });

    it('does not treat the opt-in alone (no base set) as an override', () => {
        const r = resolveReleaseUrlBase({ WSSCRCPY_ALLOW_RELEASE_URL_OVERRIDE: '1' });
        expect(r.base).toBe(DEFAULT_RELEASE_URL_BASE);
        expect(r.overridden).toBe(false);
        expect(r.ignoredOverride).toBe(false);
    });
});

describe('readInstalledNodePtyVersion', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-fetch-prebuilts-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    it('reads the version from <repoRoot>/node_modules/node-pty/package.json', () => {
        const pkgDir = path.join(tmpDir, 'node_modules', 'node-pty');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
            path.join(pkgDir, 'package.json'),
            JSON.stringify({ name: 'node-pty', version: '1.1.0' }),
        );
        expect(readInstalledNodePtyVersion(tmpDir)).toBe('1.1.0');
    });

    it('throws a clear error when node-pty is not installed', () => {
        expect(() => readInstalledNodePtyVersion(tmpDir)).toThrow(/node-pty/);
    });

    it('throws when the installed package.json has no version field', () => {
        const pkgDir = path.join(tmpDir, 'node_modules', 'node-pty');
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(
            path.join(pkgDir, 'package.json'),
            JSON.stringify({ name: 'node-pty' }),
        );
        expect(() => readInstalledNodePtyVersion(tmpDir)).toThrow(/version/);
    });
});

// Item 121. The three downloads in this script were one-shot: any non-OK status
// hit process.exit(1). The script runs inside the REQUIRED build-and-test check
// (vitest.globalSetup calls it), so GitHub answering 500 for its own release
// asset — which it did on 2026-09-09 — reddened `main` over a blip that had
// already cleared by the time anyone looked.
describe('isRetryableStatus', () => {
    it('retries rate limiting and server-side failures', () => {
        for (const status of [429, 500, 502, 503, 504, 599]) {
            expect(isRetryableStatus(status), `status ${status}`).toBe(true);
        }
    });

    // The whole point of the narrow list: a 404 is a real answer, and retrying
    // it turns a fast clear failure into a slow identical one.
    it('never retries a 404 or the other client-side answers', () => {
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
    it('doubles from the 2s base: 2s after attempt 1, 4s after attempt 2', () => {
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
    /** Fake `fetch` returning the queued items in order; a thrown value rejects. */
    function queuedFetch(queue) {
        const calls = [];
        const impl = async (url) => {
            calls.push(url);
            const next = queue.shift();
            if (next instanceof Error) {
                throw next;
            }
            return next;
        };
        return { impl, calls };
    }

    const res = (status) => ({ ok: status >= 200 && status < 300, status });

    /** Records the requested delays instead of waiting them out. */
    function recordingSleep() {
        const waits = [];
        return { sleep: async (ms) => void waits.push(ms), waits };
    }

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

    it('gives up after the attempt budget and returns the last non-OK response', async () => {
        const { impl, calls } = queuedFetch([res(503), res(503), res(503)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/e', { fetchImpl: impl, sleep });
        // The caller still reports the real status; it does not throw.
        expect(out.status).toBe(503);
        expect(calls).toHaveLength(3);
        expect(waits).toEqual([2000, 4000]);
    });

    it('retries a network error (DNS/reset/AbortSignal timeout) and recovers', async () => {
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
        await expect(
            fetchWithRetry('https://example.test/g', { fetchImpl: impl, sleep }),
        ).rejects.toThrow(/ENOTFOUND/);
        expect(calls).toHaveLength(3);
    });

    it('reports each retry to onRetry with the attempt and the reason', async () => {
        const { impl } = queuedFetch([res(500), new Error('socket hang up'), res(200)]);
        const { sleep } = recordingSleep();
        const seen = [];
        await fetchWithRetry('https://example.test/h', {
            fetchImpl: impl,
            sleep,
            onRetry: (info) => seen.push(info),
        });
        expect(seen).toEqual([
            { url: 'https://example.test/h', attempt: 1, attempts: 3, reason: 'HTTP 500' },
            { url: 'https://example.test/h', attempt: 2, attempts: 3, reason: 'socket hang up' },
        ]);
    });

    it('honors a caller-supplied attempt budget', async () => {
        const { impl, calls } = queuedFetch([res(503), res(503)]);
        const { sleep, waits } = recordingSleep();
        const out = await fetchWithRetry('https://example.test/i', {
            fetchImpl: impl,
            sleep,
            attempts: 2,
        });
        expect(out.status).toBe(503);
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([2000]);
    });
});
