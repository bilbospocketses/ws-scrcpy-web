/**
 * The decision half of the e2e rule for a spent api.github.com quota (item 149,
 * row 9.4 on a host): which dependency states are the network's rather than the
 * app's. Rows 20.9 and 1.9 used it too until 2026-10-01, when a container stopped
 * listing mkcert, its only GitHub-backed dependency fetched on first use; those
 * rows now excuse nothing. Pure on purpose -- no Playwright import -- so
 * `tests/unit/githubRefusal.test.ts` can run every branch on every build. The
 * quota-exhausted branch otherwise runs only on a rate-limited CI runner,
 * which cannot be arranged on demand. The one network call, `githubCoreQuota`,
 * stays in `githubQuota.ts`.
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

export interface GithubQuota {
    exhausted: boolean;
    detail: string;
}

/**
 * Reads a `/rate_limit` answer. `exhausted` is true only on positive evidence:
 * the call succeeded and `resources.core.remaining` is 0. A failed call or a
 * body without the core resource proves nothing about the quota, so it is
 * reported in the detail and never excuses anything.
 */
export function quotaFromRateLimit(status: number, body: unknown): GithubQuota {
    if (status < 200 || status > 299) return { exhausted: false, detail: `rate_limit answered HTTP ${status}` };
    const core = (body as { resources?: { core?: { remaining?: number; reset?: number } } } | null)?.resources?.core;
    const remaining = core?.remaining;
    const reset = core?.reset ? new Date(core.reset * 1000).toISOString() : 'unknown';
    return { exhausted: remaining === 0, detail: `core remaining=${remaining ?? 'unknown'}, resets ${reset}` };
}

/**
 * 9.4: a null Latest after "check for updates" is the network's only for a
 * GitHub-backed dependency, and only when the quota is proven spent.
 */
export function isExcusableNullLatest(
    dep: { name: string; latestVersion: string | null },
    quota: GithubQuota | undefined,
): boolean {
    return dep.latestVersion === null && GITHUB_BACKED_DEPENDENCIES.includes(dep.name) && quota?.exhausted === true;
}
