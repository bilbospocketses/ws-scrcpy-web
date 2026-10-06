/**
 * The decision half of the e2e rule for a refused api.github.com lookup (item
 * 149, row 9.4 on a host): which dependency states are the network's rather than
 * the app's. Rows 20.9 and 1.9 used it too until 2026-10-01, when a container
 * stopped listing mkcert, its only GitHub-backed dependency fetched on first use;
 * those rows now excuse nothing. Pure on purpose -- no Playwright import -- so
 * `tests/unit/githubRefusal.test.ts` can run every branch on every build. The
 * refused branch otherwise runs only on a rate-limited CI runner, which cannot be
 * arranged on demand.
 *
 * The evidence is the app's OWN record of the lookup (`latestLookup` on GET
 * /api/dependencies), not a `/rate_limit` query made afterwards. That query raced
 * the hourly reset: on 2026-10-06 the server logged `HTTP 403 rate limit
 * exceeded` for its lookup while the re-query read remaining=60, then 1, and 9.4
 * failed falsely twice.
 */

/**
 * The dependencies whose latest-version lookup goes through api.github.com
 * (`src/server/DependencyDefinitions.ts`). nodejs.org and dl.google.com do not
 * rate-limit, so nodejs and adb must ALWAYS resolve; api.github.com allows 60
 * unauthenticated requests an hour per IP, and CI runners share IPs. Item 149:
 * `scrcpy-server.latestVersion` came back null on beta.134's bump PR, twice in
 * one run, and passed on a re-run.
 */
export const GITHUB_BACKED_DEPENDENCIES: readonly string[] = ['scrcpy-server', 'mkcert'];

/** The statuses GitHub answers a spent quota with: 403 for the unauthenticated cap, 429 for a secondary limit. */
export const RATE_LIMIT_STATUSES: readonly number[] = [403, 429];

/** The shape of `DependencyInfo.latestLookup` (src/common/DependencyTypes.ts), restated so this file stays pure. */
export interface LatestLookupRecord {
    seq: number;
    at: string;
    outcome: 'ok' | 'refused' | 'failed';
    httpStatus?: number | undefined;
}

/**
 * 9.4: a null Latest after "check for updates" is the network's only for a
 * GitHub-backed dependency whose lookup was REFUSED with a rate-limit status,
 * and only when that lookup is one the test's own press caused -- its `seq` is
 * past `seqBefore`, the value read before pressing. An older refusal says
 * nothing about the check under test, a 500 is not a rate limit, and a lookup
 * that FAILED (no answer, or an answer the app rejected) is the app's to explain.
 */
export function isExcusableNullLatest(
    dep: { name: string; latestVersion: string | null; latestLookup?: LatestLookupRecord | undefined },
    seqBefore: number,
): boolean {
    const lookup = dep.latestLookup;
    return (
        dep.latestVersion === null &&
        GITHUB_BACKED_DEPENDENCIES.includes(dep.name) &&
        lookup?.outcome === 'refused' &&
        lookup.httpStatus !== undefined &&
        RATE_LIMIT_STATUSES.includes(lookup.httpStatus) &&
        lookup.seq > seqBefore
    );
}
