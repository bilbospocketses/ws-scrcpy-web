import { request } from '@playwright/test';

/**
 * The dependencies whose latest-version lookup goes through api.github.com
 * (`src/server/DependencyDefinitions.ts`). nodejs.org and dl.google.com do not
 * rate-limit, so nodejs and adb must ALWAYS resolve; api.github.com allows 60
 * unauthenticated requests an hour per IP, and CI runners share IPs. Item 149:
 * `scrcpy-server.latestVersion` came back null on beta.134's bump PR, twice in
 * one run, and passed on a re-run.
 */
export const GITHUB_BACKED_DEPENDENCIES: readonly string[] = ['scrcpy-server', 'mkcert'];

/**
 * This runner's remaining api.github.com core quota, read from `/rate_limit`,
 * which GitHub does not count against the quota. The test runs on the same
 * machine as the server (a container's egress leaves through the same host), so
 * this is the quota the server's lookup saw. `exhausted` is true only on
 * positive evidence: `remaining` is 0. An unreachable endpoint proves nothing
 * about the quota, so it is reported in the detail and never excuses anything.
 */
export async function githubCoreQuota(): Promise<{ exhausted: boolean; detail: string }> {
    const ctx = await request.newContext();
    try {
        const res = await ctx.get('https://api.github.com/rate_limit', {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web-e2e' },
            timeout: 15_000,
        });
        if (!res.ok()) return { exhausted: false, detail: `rate_limit answered HTTP ${res.status()}` };
        const core = ((await res.json()) as { resources?: { core?: { remaining?: number; reset?: number } } }).resources
            ?.core;
        const remaining = core?.remaining;
        const reset = core?.reset ? new Date(core.reset * 1000).toISOString() : 'unknown';
        return { exhausted: remaining === 0, detail: `core remaining=${remaining ?? 'unknown'}, resets ${reset}` };
    } catch (err) {
        return { exhausted: false, detail: `rate_limit unreachable: ${(err as Error).message}` };
    } finally {
        await ctx.dispose();
    }
}

/**
 * A refused lookup exactly as the server words it (`HttpStatusError` in
 * `src/server/util/fetchWithRetry.ts`), e.g. `HTTP 403 rate limit exceeded from
 * https://api.github.com/repos/bilbospocketses/mkcert/releases/latest`.
 */
const REFUSED_GITHUB_LOOKUP = /^HTTP (?:403|429)\b.* from https:\/\/api\.github\.com\//;

/**
 * True when `dep` is in `error` for ONE reason: api.github.com refused its
 * version lookup. Only a GitHub-backed dependency fetched on first use
 * (`deferInstall`, i.e. mkcert) qualifies: nothing installs it at boot or on a
 * retry, so a refused lookup legitimately leaves it in the Error state the
 * server reports for "not installed, latest unknown" (DependencyManager
 * `checkLatest`). scrcpy-server never qualifies, because a refused lookup makes
 * it install its bundled fallback, so an error there is a real failure.
 *
 * This is the shape of the excuse, not the excuse itself: a caller must also
 * have `githubCoreQuota()` report the quota spent before accepting it.
 */
export function isDeferredGithubLookupRefusal(dep: {
    name: string;
    deferInstall?: boolean | undefined;
    status?: string | undefined;
    errorMessage?: string | undefined;
}): boolean {
    return (
        dep.deferInstall === true &&
        GITHUB_BACKED_DEPENDENCIES.includes(dep.name) &&
        dep.status === 'error' &&
        REFUSED_GITHUB_LOOKUP.test(dep.errorMessage ?? '')
    );
}
