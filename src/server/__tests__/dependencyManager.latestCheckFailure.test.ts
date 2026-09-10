import { afterEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';
import { VERSION_CHECK_POLICY } from '../util/fetchWithRetry';

/**
 * The 2026-09-09 regression, pinned.
 *
 * Items 124/125 made every `checkLatest` throw on a non-OK response instead of
 * silently returning null. Correct for the case the item was about — nothing
 * installed, no way to learn what to install, autoInstallMissing skips it — and
 * wrong for the case that is far more common in a container: the dependency is
 * ALREADY INSTALLED (the Docker image seeds scrcpy-server) and only the
 * advisory "is there a newer one" lookup failed, because api.github.com
 * rate-limits per IP and CI runners share IPs.
 *
 * That turned a healthy container into three red tests — smoke 20.9 and 20.12
 * assert no dependency reports `error`.
 *
 * The second half of the same regression was latency: `checkAll` ran the three
 * latest-checks SERIALLY and boot is `checkAll().then(() =>
 * autoInstallMissing())`, so the version phase gates the seed promote and every
 * install. Three unreachable endpoints cost the sum of their retry budgets.
 */
describe('a failed latest-check does not condemn an installed dependency', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
    });

    /** 403 is what GitHub returns over the unauthenticated hourly cap, and it is not retryable. */
    function stubForbidden() {
        fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(
                new Response('{"message":"API rate limit exceeded"}', { status: 403, statusText: 'Forbidden' }),
            );
    }

    it('keeps an INSTALLED dependency healthy when the version lookup fails', async () => {
        stubForbidden();
        const mgr = new DependencyManager('/tmp/test-deps-latest-fail');
        const dep = mgr.getByName('scrcpy-server')!;
        dep.installedVersion = '3.1'; // the seeded copy, present and usable

        await mgr.checkLatest('scrcpy-server');

        expect(dep.status, 'a rate-limited update check is not a fault in the dependency').not.toBe(
            DependencyStatus.Error,
        );
        expect(dep.errorMessage, 'nothing to report to the user').toBeUndefined();
        expect(dep.installedVersion, 'still installed').toBe('3.1');
        expect(dep.latestVersion, 'we genuinely do not know the latest').toBeNull();
    });

    // The item-124 case, which must stay loud: with nothing installed and no
    // latest version, autoInstallMissing skips the dependency entirely, so a
    // silent state here is how a first run ends up with no scrcpy-server and
    // nothing saying why.
    it('reports an error when the dependency is NOT installed', async () => {
        stubForbidden();
        const mgr = new DependencyManager('/tmp/test-deps-latest-fail');
        const dep = mgr.getByName('scrcpy-server')!;
        dep.installedVersion = null;

        await mgr.checkLatest('scrcpy-server');

        expect(dep.status).toBe(DependencyStatus.Error);
        expect(dep.errorMessage).toMatch(/HTTP 403/);
    });

    it('never leaves a dependency stuck in Checking', async () => {
        stubForbidden();
        const mgr = new DependencyManager('/tmp/test-deps-latest-fail');
        const dep = mgr.getByName('adb')!;
        dep.installedVersion = null;

        await mgr.checkLatest('adb');

        // 1.9 read `checking` where it expected `error`: the status must settle
        // by the time the call resolves, whichever branch it takes.
        expect(dep.status).not.toBe(DependencyStatus.Checking);
    });
});

describe('checkAll runs the latest-version checks concurrently', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
    });

    /**
     * Counts peak in-flight requests rather than measuring elapsed time — a
     * serial implementation can never exceed 1, a concurrent one reaches the
     * number of dependencies, and neither answer depends on how fast the box is.
     */
    it('issues the version requests together, not one after another', async () => {
        let inFlight = 0;
        let peak = 0;
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation((async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 10));
            inFlight -= 1;
            return new Response('{}', { status: 500 });
        }) as unknown as typeof fetch);

        const mgr = new DependencyManager('/tmp/test-deps-concurrent');
        await mgr.checkAll();

        expect(peak, 'serial execution would peak at 1').toBeGreaterThan(1);
    });
});

/**
 * The budget itself. A version check is advisory, and it sits in front of the
 * seed promote and every install, so it must stay small. The download policy
 * (3 attempts, 30s each, 2s+4s backoff) in this position cost ~96s per
 * dependency.
 */
describe('VERSION_CHECK_POLICY', () => {
    it('is materially cheaper than the download policy', () => {
        expect(VERSION_CHECK_POLICY.attempts).toBeLessThanOrEqual(2);
        expect(VERSION_CHECK_POLICY.timeoutMs).toBeLessThanOrEqual(10_000);
        expect(VERSION_CHECK_POLICY.baseDelayMs).toBeLessThanOrEqual(1_000);
    });

    it('worst case stays well inside the 180s hydrate poll even before concurrency', () => {
        const worstCasePerDep =
            VERSION_CHECK_POLICY.attempts * VERSION_CHECK_POLICY.timeoutMs +
            (VERSION_CHECK_POLICY.attempts - 1) * VERSION_CHECK_POLICY.baseDelayMs;
        // Three dependencies, serially, must still leave room for the installs.
        expect(worstCasePerDep * 3).toBeLessThan(120_000);
    });
});
