import { describe, expect, it } from 'vitest';
import {
    type GithubQuota,
    isDeferredGithubLookupRefusal,
    isExcusableNullLatest,
    partitionDependencyStates,
    partitionRetryErrors,
    quotaFromRateLimit,
} from '../e2e/support/githubRefusal';

// The quota-exhausted branch of the e2e rule (item 149 for 9.4, #753 for 20.9
// and 1.9) runs only when a CI runner's api.github.com quota is spent, which
// cannot be arranged on demand. So the DECISION it makes lives in pure
// functions, and this file runs every branch of it on every build -- fed the
// exact payloads #752's failed CI runs produced on 2026-09-27.

/** Verbatim: #752, run 36304861079, dependencies-panel.spec.ts:436's `body.errors`. */
const CI_MKCERT_REFUSAL =
    'HTTP 403 rate limit exceeded from https://api.github.com/repos/bilbospocketses/mkcert/releases/latest';
const SPENT: GithubQuota = { exhausted: true, detail: 'core remaining=0, resets 2026-09-27T09:12:17.000Z' };
const LEFT: GithubQuota = { exhausted: false, detail: 'core remaining=59, resets 2026-09-27T09:12:17.000Z' };

/** The four dependencies as /api/dependencies lists them in a fresh container. */
const LISTED = [
    { name: 'nodejs', deferInstall: undefined },
    { name: 'adb', deferInstall: undefined },
    { name: 'scrcpy-server', deferInstall: undefined },
    { name: 'mkcert', deferInstall: true },
];

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

describe('isDeferredGithubLookupRefusal', () => {
    const mk = { name: 'mkcert', deferInstall: true, status: 'error' };

    it('accepts the exact refusal CI produced', () => {
        expect(isDeferredGithubLookupRefusal({ ...mk, errorMessage: CI_MKCERT_REFUSAL })).toBe(true);
    });

    it('accepts a 429 refusal the same way', () => {
        const msg = CI_MKCERT_REFUSAL.replace('403 rate limit exceeded', '429 Too Many Requests');
        expect(isDeferredGithubLookupRefusal({ ...mk, errorMessage: msg })).toBe(true);
    });

    it.each([
        [
            'scrcpy-server (it falls back, so its error is real)',
            {
                name: 'scrcpy-server',
                status: 'error',
                errorMessage: CI_MKCERT_REFUSAL.replace('bilbospocketses/mkcert', 'Genymobile/scrcpy'),
            },
        ],
        ['mkcert not marked deferInstall', { ...mk, deferInstall: false, errorMessage: CI_MKCERT_REFUSAL }],
        ['mkcert with deferInstall missing', { name: 'mkcert', status: 'error', errorMessage: CI_MKCERT_REFUSAL }],
        ['a deferred dependency that is not GitHub-backed', { ...mk, name: 'adb', errorMessage: CI_MKCERT_REFUSAL }],
        ['the offline failure', { ...mk, errorMessage: 'fetch failed' }],
        ['a 404', { ...mk, errorMessage: CI_MKCERT_REFUSAL.replace('403 rate limit exceeded', '404 Not Found') }],
        ['a 500', { ...mk, errorMessage: CI_MKCERT_REFUSAL.replace('403 rate limit exceeded', '500 Server Error') }],
        [
            'a 403 from a non-API host',
            { ...mk, errorMessage: 'HTTP 403 Forbidden from https://github.com/bilbospocketses/mkcert/releases/x' },
        ],
        ['a status that is not error', { ...mk, status: 'unknown', errorMessage: CI_MKCERT_REFUSAL }],
        ['no message at all', { ...mk }],
    ])('refuses %s', (_label, dep) => {
        expect(isDeferredGithubLookupRefusal(dep)).toBe(false);
    });
});

describe('partitionRetryErrors (1.9: the retry reply)', () => {
    it('excuses the CI refusal when the quota is proven spent', () => {
        expect(partitionRetryErrors({ mkcert: CI_MKCERT_REFUSAL }, LISTED, SPENT)).toEqual({
            excused: ['mkcert'],
            unexplained: {},
        });
    });

    it('excuses NOTHING when the quota has calls left', () => {
        expect(partitionRetryErrors({ mkcert: CI_MKCERT_REFUSAL }, LISTED, LEFT)).toEqual({
            excused: [],
            unexplained: { mkcert: CI_MKCERT_REFUSAL },
        });
    });

    it('excuses NOTHING when the quota was never asked', () => {
        expect(partitionRetryErrors({ mkcert: CI_MKCERT_REFUSAL }, LISTED, undefined)).toEqual({
            excused: [],
            unexplained: { mkcert: CI_MKCERT_REFUSAL },
        });
    });

    it('keeps every other error while excusing the refusal', () => {
        const errors = { mkcert: CI_MKCERT_REFUSAL, adb: 'fetch failed' };
        expect(partitionRetryErrors(errors, LISTED, SPENT)).toEqual({
            excused: ['mkcert'],
            unexplained: { adb: 'fetch failed' },
        });
    });

    it('never excuses scrcpy-server, whose refused lookup installs its fallback instead', () => {
        const msg = CI_MKCERT_REFUSAL.replace('bilbospocketses/mkcert', 'Genymobile/scrcpy');
        expect(partitionRetryErrors({ 'scrcpy-server': msg }, LISTED, SPENT)).toEqual({
            excused: [],
            unexplained: { 'scrcpy-server': msg },
        });
    });

    it('excuses nothing and reports nothing when the retry reported no errors', () => {
        expect(partitionRetryErrors({}, LISTED, SPENT)).toEqual({ excused: [], unexplained: {} });
    });
});

describe('partitionDependencyStates (20.9: the first-boot dependency list)', () => {
    // The shape #752's second attempt failed on: mkcert in error, the boot four fine.
    const FINAL = [
        { name: 'nodejs', installedVersion: '24.19.0', status: 'up-to-date' },
        { name: 'adb', installedVersion: '36.0.0', status: 'up-to-date' },
        { name: 'scrcpy-server', installedVersion: '3.3.4', status: 'unknown' },
        {
            name: 'mkcert',
            installedVersion: null,
            status: 'error',
            errorMessage: CI_MKCERT_REFUSAL,
            deferInstall: true,
        },
    ];

    it('excuses mkcert and checks the rest when the quota is proven spent', () => {
        const { excused, checked } = partitionDependencyStates(FINAL, SPENT);
        expect(excused.map((d) => d.name)).toEqual(['mkcert']);
        expect(checked.map((d) => d.name)).toEqual(['nodejs', 'adb', 'scrcpy-server']);
    });

    it('checks EVERYTHING when the quota has calls left', () => {
        const { excused, checked } = partitionDependencyStates(FINAL, LEFT);
        expect(excused).toEqual([]);
        expect(checked).toHaveLength(4);
    });

    it('checks EVERYTHING when the quota was never asked', () => {
        const { excused, checked } = partitionDependencyStates(FINAL, undefined);
        expect(excused).toEqual([]);
        expect(checked).toHaveLength(4);
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
