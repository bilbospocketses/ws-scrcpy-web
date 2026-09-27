/**
 * The decision half of the e2e rule for a spent api.github.com quota (item 149
 * for 9.4, #753 for 20.9 and 1.9): which dependency states are the network's
 * rather than the app's. Pure on purpose -- no Playwright import -- so
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
 * This is the shape of the excuse, not the excuse itself: the quota must also
 * be proven spent -- see the partition functions below.
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

/**
 * 1.9: splits a `retry-install` reply's `errors` into the ones a proven-spent
 * quota explains and the ones that must still fail the test. `listed` is
 * `/api/dependencies`, which is where `deferInstall` comes from. With no quota
 * answer, or one with calls left, nothing is excused.
 */
export function partitionRetryErrors(
    errors: Record<string, string>,
    listed: { name: string; deferInstall?: boolean | undefined }[],
    quota: GithubQuota | undefined,
): { excused: string[]; unexplained: Record<string, string> } {
    const excused = Object.entries(errors)
        .filter(
            ([name, errorMessage]) =>
                quota?.exhausted === true &&
                isDeferredGithubLookupRefusal({
                    name,
                    errorMessage,
                    status: 'error',
                    deferInstall: listed.find((d) => d.name === name)?.deferInstall,
                }),
        )
        .map(([name]) => name);
    const unexplained = Object.fromEntries(Object.entries(errors).filter(([name]) => !excused.includes(name)));
    return { excused, unexplained };
}

/**
 * 20.9: splits the first-boot dependency list into the entries a proven-spent
 * quota explains and the ones whose status must still be checked. With no
 * quota answer, or one with calls left, everything is checked.
 */
export function partitionDependencyStates<
    T extends {
        name: string;
        deferInstall?: boolean | undefined;
        status?: string | undefined;
        errorMessage?: string | undefined;
    },
>(deps: T[], quota: GithubQuota | undefined): { excused: T[]; checked: T[] } {
    const excused = deps.filter((d) => quota?.exhausted === true && isDeferredGithubLookupRefusal(d));
    return { excused, checked: deps.filter((d) => !excused.includes(d)) };
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
