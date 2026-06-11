import type { ServiceStatusResponse } from '../../common/ServiceEvents';

export interface PollUninstalledOptions {
    /** Injectable for tests. Defaults to the global fetch. */
    fetchFn?: typeof fetch;
    /** Poll interval (ms). Default 1000. */
    intervalMs?: number;
    /** Give up after this long (ms). Default 30000. */
    deadlineMs?: number;
    /** Injectable clock for tests. Default Date.now. */
    now?: () => number;
}

/**
 * Poll GET /api/service/status until it reports the service is gone
 * (`status === 'not-installed'` → 'uninstalled'), or the deadline elapses
 * (→ 'still-present'). Fetch errors are EXPECTED while a system-scope teardown
 * stops the serving unit (the page's server dies, then a local instance
 * relaunches) and are swallowed — keep polling. No DOM here; the caller owns the UI.
 *
 * This is the honesty check: the UI must CONFIRM the teardown happened before
 * claiming "service removed". beta.60 #9 5.1 — the system teardown helper used to
 * core-dump (missing DATA_ROOT) while ServiceApi optimistically returned
 * `shutting-down`, so the UI reported success while the service kept running.
 */
export async function pollServiceUninstalled(
    opts: PollUninstalledOptions = {},
): Promise<'uninstalled' | 'still-present'> {
    const fetchFn = opts.fetchFn ?? fetch;
    const intervalMs = opts.intervalMs ?? 1000;
    const deadlineMs = opts.deadlineMs ?? 30_000;
    const now = opts.now ?? (() => Date.now());
    const start = now();
    for (;;) {
        try {
            const r = await fetchFn('/api/service/status', { cache: 'no-store' });
            if (r.ok) {
                const s = (await r.json()) as ServiceStatusResponse;
                if (s.status === 'not-installed') {
                    return 'uninstalled';
                }
            }
        } catch {
            // server down while the teardown stops the unit (+ a local instance
            // relaunches) — expected; keep polling.
        }
        if (now() - start >= deadlineMs) return 'still-present';
        if (intervalMs > 0) await new Promise((res) => setTimeout(res, intervalMs));
    }
}
