import { request } from '@playwright/test';
import { type GithubQuota, quotaFromRateLimit } from './githubRefusal';

export { GITHUB_BACKED_DEPENDENCIES, type GithubQuota, isExcusableNullLatest } from './githubRefusal';

/**
 * This runner's remaining api.github.com core quota, read from `/rate_limit`,
 * which GitHub does not count against the quota. The test runs on the same
 * machine as the server (a container's egress leaves through the same host), so
 * this is the quota the server's lookup saw. The reading of the answer lives in
 * `githubRefusal.ts` (`quotaFromRateLimit`), where it is unit-tested; this is
 * only the call. An unreachable endpoint proves nothing about the quota.
 */
export async function githubCoreQuota(): Promise<GithubQuota> {
    const ctx = await request.newContext();
    try {
        const res = await ctx.get('https://api.github.com/rate_limit', {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web-e2e' },
            timeout: 15_000,
        });
        return quotaFromRateLimit(res.status(), res.ok() ? await res.json() : undefined);
    } catch (err) {
        return { exhausted: false, detail: `rate_limit unreachable: ${(err as Error).message}` };
    } finally {
        await ctx.dispose();
    }
}
