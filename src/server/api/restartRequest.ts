import { writeFileAtomicSync } from '../util/atomicFile';

/**
 * Write the `.restart` marker and schedule `process.exit(75)` a beat after
 * responding, so the launcher's supervisor restarts the app on the new port.
 *
 * Shared by `ConfigApi` (PATCH /api/config) and `SettingsBatchApi` (POST
 * /api/settings/batch) -- the only two entry points that can change
 * `webPort`. Keep exactly one copy here: the marker path, the 1s delay, and
 * the log lines are load-bearing and must not drift between the two callers.
 */
export function scheduleRestartForPortChange(
    markerPath: string,
    log: { info(m: string): void; warn(m: string): void },
    seams?: { schedule?: (cb: () => void, ms: number) => unknown; exit?: (code: number) => void },
): void {
    try {
        writeFileAtomicSync(markerPath, `restart-requested-${Date.now()}`);
    } catch (err) {
        log.warn(
            `could not write .restart marker (port change won't take effect until manual restart): ${(err as Error).message}`,
        );
    }

    const schedule = seams?.schedule ?? setTimeout;
    const exit = seams?.exit ?? ((code: number) => process.exit(code));

    // Schedule own exit AFTER responding. exit-75
    // is the supervisor's restart signal. Delay
    // long enough for the response body + headers
    // to fully flush over the socket.
    const handle = schedule(() => {
        log.info('port change committed; exiting with 75 to trigger restart');
        exit(75);
    }, 1000);
    // The real setTimeout's return value supports unref (don't let this lone
    // timer keep the event loop alive); an injected test seam's return value
    // may not, so this is checked rather than assumed -- preserves ConfigApi's
    // pre-extraction behaviour exactly when no seam is supplied.
    (handle as { unref?: () => void } | undefined)?.unref?.();
}
