import { describe, expect, it } from 'vitest';
import { type GithubQuota, isExcusableNullLatest, quotaFromRateLimit } from '../e2e/support/githubRefusal';

// The quota-exhausted branch of the e2e rule (item 149, row 9.4 on a host)
// runs only when a CI runner's api.github.com quota is spent, which
// cannot be arranged on demand. So the DECISION it makes lives in pure
// functions, and this file runs every branch of it on every build -- fed the
// exact payloads #752's failed CI runs produced on 2026-09-27.

const SPENT: GithubQuota = { exhausted: true, detail: 'core remaining=0, resets 2026-09-27T09:12:17.000Z' };
const LEFT: GithubQuota = { exhausted: false, detail: 'core remaining=59, resets 2026-09-27T09:12:17.000Z' };

describe('quotaFromRateLimit', () => {
    // Shape verbatim from GET https://api.github.com/rate_limit, 2026-09-27.
    const body = (remaining: number) => ({
        resources: { core: { limit: 60, remaining, reset: 1790505737, used: 60 - remaining } },
        rate: { limit: 60, remaining, reset: 1790505737, used: 60 - remaining },
    });

    it('reports exhausted only on positive evidence: core.remaining is 0', () => {
        expect(quotaFromRateLimit(200, body(0))).toEqual({
            exhausted: true,
            detail: 'core remaining=0, resets 2026-09-27T10:42:17.000Z',
        });
    });

    it('reports quota left as NOT exhausted', () => {
        expect(quotaFromRateLimit(200, body(59)).exhausted).toBe(false);
    });

    it('never reads a failed /rate_limit call as exhausted', () => {
        expect(quotaFromRateLimit(403, body(0))).toEqual({ exhausted: false, detail: 'rate_limit answered HTTP 403' });
    });

    it('never reads a body with no core resource as exhausted', () => {
        expect(quotaFromRateLimit(200, { message: 'unexpected' })).toEqual({
            exhausted: false,
            detail: 'core remaining=unknown, resets unknown',
        });
    });
});

describe('isExcusableNullLatest (9.4: the Latest column after a check)', () => {
    it('excuses a GitHub-backed null latest when the quota is proven spent', () => {
        expect(isExcusableNullLatest({ name: 'scrcpy-server', latestVersion: null }, SPENT)).toBe(true);
        expect(isExcusableNullLatest({ name: 'mkcert', latestVersion: null }, SPENT)).toBe(true);
    });

    it.each([
        ['quota left', { name: 'mkcert', latestVersion: null }, LEFT],
        ['quota never asked', { name: 'mkcert', latestVersion: null }, undefined],
        ['nodejs, whose lookup is not GitHub', { name: 'nodejs', latestVersion: null }, SPENT],
        ['adb, whose lookup is not GitHub', { name: 'adb', latestVersion: null }, SPENT],
        ['a latest that DID resolve', { name: 'mkcert', latestVersion: 'v0.1.0' }, SPENT],
    ])('does not excuse %s', (_label, dep, quota) => {
        expect(isExcusableNullLatest(dep, quota)).toBe(false);
    });
});
