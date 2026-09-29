import { isStaleTokenRefusal } from './staleToken';

export interface ReconnectOptions {
    /** The version running before apply; resolve once /status reports a different one. */
    previousVersion: string;
    /** Injectable for tests. Defaults to the global fetch. */
    fetchFn?: typeof fetch;
    /** Poll interval (ms). Default 1000. */
    intervalMs?: number;
    /** Give up after this long (ms). Default 60000. */
    deadlineMs?: number;
    /** Injectable clock for tests. Default Date.now. */
    now?: () => number;
}

/**
 * Poll GET /api/updates/status on the same origin until the updated process
 * answers (-> 'updated'), or the deadline elapses (-> 'timeout'). Fetch errors
 * are expected during the swap (the server is down) and are swallowed. No DOM
 * here; the caller owns the UI and reloads on 'updated'.
 *
 * "The updated process answers" is either of:
 * - a 200 whose currentVersion differs from previousVersion; or
 * - the stale-token 403. The relaunched server mints a new instance token and
 *   refuses this page's old one, so that refusal proves a different process now
 *   holds the origin, and the caller's reload fetches its token (D15, like D4).
 *   Before this the poll read it as "not yet" for 60 s and gave up.
 *
 * Pages served by a build BEFORE this fix still carry the old poll, which only
 * accepts the 200. For them the server answers a token-less GET of this route
 * with `{ currentVersion }` alone (UpdatesApi), so they reconnect too.
 */
export async function reconnectAfterApply(opts: ReconnectOptions): Promise<'updated' | 'timeout'> {
    const fetchFn = opts.fetchFn ?? fetch;
    const intervalMs = opts.intervalMs ?? 1000;
    const deadlineMs = opts.deadlineMs ?? 60_000;
    const now = opts.now ?? (() => Date.now());
    const start = now();
    for (;;) {
        try {
            const r = await fetchFn('/api/updates/status', { cache: 'no-store' });
            if (r.ok) {
                const s = (await r.json()) as { currentVersion?: string };
                if (s.currentVersion && s.currentVersion !== opts.previousVersion) {
                    return 'updated';
                }
            } else if (isStaleTokenRefusal(r.status, await r.json().catch(() => null))) {
                return 'updated';
            }
        } catch {
            // server down during the swap — expected; keep polling
        }
        if (now() - start >= deadlineMs) return 'timeout';
        if (intervalMs > 0) await new Promise((res) => setTimeout(res, intervalMs));
    }
}
