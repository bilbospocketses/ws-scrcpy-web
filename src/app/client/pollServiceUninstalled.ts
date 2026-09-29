import type { ServiceStatusResponse } from '../../common/ServiceEvents';

export interface PollUninstalledOptions {
    /** Injectable for tests. Defaults to the global fetch. */
    fetchFn?: typeof fetch;
    /** Poll interval (ms). Default 1000. */
    intervalMs?: number;
    /** Give up after this long (ms). Default 30000. */
    deadlineMs?: number;
    /** How long this origin must stay unanswered to count as stopped (ms). Default 5000. */
    silentMs?: number;
    /** Injectable clock for tests. Default Date.now. */
    now?: () => number;
}

/**
 * Poll GET /api/service/status after a system-scope uninstall until one of:
 *
 * - it answers `status === 'not-installed'` -> 'uninstalled';
 * - nothing has answered on this origin for `silentMs` -> 'stopped';
 * - the deadline elapses while something still answers -> 'still-present'.
 *
 * 'stopped' is the normal end of a system-scope uninstall served by the service
 * itself (D11, item 157): the teardown stops the unit that serves this page, and
 * since §D5 nothing relaunches, so this origin simply goes quiet. It used to be
 * the only outcome the poll could not recognise, so every successful uninstall
 * timed out into the red "still running" error.
 *
 * This is still the honesty check from beta.60 #9 5.1, where the teardown helper
 * core-dumped and the service kept running while the UI said "removed": a service
 * that is still up keeps ANSWERING, so it never goes silent and still reaches
 * 'still-present'. Any response at all, whatever its status, resets the silence.
 * No DOM here; the caller owns the UI.
 */
export async function pollServiceUninstalled(
    opts: PollUninstalledOptions = {},
): Promise<'uninstalled' | 'stopped' | 'still-present'> {
    const fetchFn = opts.fetchFn ?? fetch;
    const intervalMs = opts.intervalMs ?? 1000;
    const deadlineMs = opts.deadlineMs ?? 30_000;
    const silentMs = opts.silentMs ?? 5000;
    const now = opts.now ?? (() => Date.now());
    const start = now();
    let silentSince: number | null = null;
    for (;;) {
        try {
            const r = await fetchFn('/api/service/status', { cache: 'no-store' });
            silentSince = null;
            if (r.ok) {
                const s = (await r.json()) as ServiceStatusResponse;
                if (s.status === 'not-installed') {
                    return 'uninstalled';
                }
            }
        } catch {
            // Nothing answered on this origin: the teardown has stopped the unit.
            silentSince ??= now();
            if (now() - silentSince >= silentMs) return 'stopped';
        }
        if (now() - start >= deadlineMs) return 'still-present';
        if (intervalMs > 0) await new Promise((res) => setTimeout(res, intervalMs));
    }
}
