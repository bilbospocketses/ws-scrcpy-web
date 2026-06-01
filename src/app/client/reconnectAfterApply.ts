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
 * Poll GET /api/updates/status on the same origin until it answers with a
 * currentVersion different from previousVersion (-> 'updated'), or the deadline
 * elapses (-> 'timeout'). Fetch errors are expected during the Velopack swap
 * (the server is down) and are swallowed — keep polling. No DOM here; the
 * caller owns the UI. Linux in-app update reconnect (see the apply handlers).
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
            }
        } catch {
            // server down during the swap — expected; keep polling
        }
        if (now() - start >= deadlineMs) return 'timeout';
        if (intervalMs > 0) await new Promise((res) => setTimeout(res, intervalMs));
    }
}
