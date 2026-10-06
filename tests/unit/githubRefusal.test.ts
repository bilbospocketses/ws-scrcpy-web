import { describe, expect, it } from 'vitest';
import { isExcusableNullLatest, type LatestLookupRecord } from '../e2e/support/githubRefusal';

// The refused branch of the e2e rule (item 149, row 9.4 on a host) runs only
// when a CI runner's api.github.com quota is spent, which cannot be arranged on
// demand. So the DECISION it makes lives in a pure function, and this file runs
// every branch of it on every build.
//
// The evidence is the app's own `latestLookup`, numbered, so the test excuses
// only the refusal of the lookup its own press caused (2026-10-06: a separate
// /rate_limit query raced the hourly reset and failed 9.4 falsely twice).

const AT = '2026-10-06T14:02:11.000Z';
const refused = (httpStatus: number, seq = 4): LatestLookupRecord => ({ seq, at: AT, outcome: 'refused', httpStatus });

describe('isExcusableNullLatest (9.4: the Latest column after a check)', () => {
    it.each([403, 429])('excuses a GitHub-backed null latest refused with HTTP %i by a newer lookup', (status) => {
        expect(
            isExcusableNullLatest({ name: 'scrcpy-server', latestVersion: null, latestLookup: refused(status) }, 3),
        ).toBe(true);
        expect(isExcusableNullLatest({ name: 'mkcert', latestVersion: null, latestLookup: refused(status) }, 3)).toBe(
            true,
        );
    });

    it('excuses a dependency never looked up before the press (seqBefore 0)', () => {
        expect(isExcusableNullLatest({ name: 'mkcert', latestVersion: null, latestLookup: refused(403, 1) }, 0)).toBe(
            true,
        );
    });

    it.each([
        [
            'a refusal no newer than the press (seq == before)',
            { name: 'mkcert', latestVersion: null, latestLookup: refused(403, 3) },
            3,
        ],
        [
            'a refusal OLDER than the press (seq < before)',
            { name: 'mkcert', latestVersion: null, latestLookup: refused(403, 2) },
            3,
        ],
        [
            'a lookup that FAILED rather than was refused',
            { name: 'mkcert', latestVersion: null, latestLookup: { seq: 4, at: AT, outcome: 'failed' as const } },
            3,
        ],
        [
            'a refusal that is not a rate limit (HTTP 500)',
            { name: 'mkcert', latestVersion: null, latestLookup: refused(500) },
            3,
        ],
        [
            'a refusal with no status',
            { name: 'mkcert', latestVersion: null, latestLookup: { seq: 4, at: AT, outcome: 'refused' as const } },
            3,
        ],
        ['no lookup recorded at all', { name: 'mkcert', latestVersion: null }, 0],
        ['nodejs, whose lookup is not GitHub', { name: 'nodejs', latestVersion: null, latestLookup: refused(403) }, 3],
        ['adb, whose lookup is not GitHub', { name: 'adb', latestVersion: null, latestLookup: refused(429) }, 3],
        ['a latest that DID resolve', { name: 'mkcert', latestVersion: 'v0.1.0', latestLookup: refused(403) }, 3],
    ])('does not excuse %s', (_label, dep, seqBefore) => {
        expect(isExcusableNullLatest(dep, seqBefore)).toBe(false);
    });
});
