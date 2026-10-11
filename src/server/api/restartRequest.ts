import { liveStreams } from '../liveStreams';
import { writeFileAtomicSync } from '../util/atomicFile';

/** Test seams for `scheduleRestart`: the timer and the exit. */
export interface RestartSeams {
    schedule?: (cb: () => void, ms: number) => unknown;
    exit?: (code: number) => void;
}

/**
 * Write the `.restart` marker and schedule `process.exit(75)` a beat after
 * responding, so the launcher's supervisor (or the container's start.sh loop)
 * starts the app again.
 *
 * Shared by every caller that restarts the server on purpose: a port change
 * (`ConfigApi`, `SettingsBatchApi`, `TlsApi`) and Settings' "restart server"
 * (`ServerRestartApi`). Keep exactly one copy here: the marker path, the 1s
 * delay, and the log lines are load-bearing and must not drift between callers.
 * `reason` names the cause in the log ("port change", "restart requested").
 */
export function scheduleRestart(
    markerPath: string,
    log: { info(m: string): void; warn(m: string): void },
    reason: string,
    seams?: RestartSeams,
): void {
    try {
        writeFileAtomicSync(markerPath, `restart-requested-${Date.now()}`);
    } catch (err) {
        log.warn(
            `could not write .restart marker (${reason} won't take effect until manual restart): ${(err as Error).message}`,
        );
    }

    const schedule = seams?.schedule ?? setTimeout;
    const exit = seams?.exit ?? ((code: number) => process.exit(code));

    // Schedule own exit AFTER responding. exit-75
    // is the supervisor's restart signal. Delay
    // long enough for the response body + headers
    // to fully flush over the socket.
    const handle = schedule(() => {
        log.info(`${reason} committed; exiting with 75 to trigger restart`);
        // The exit ends every open stream; close them as a deliberate stop
        // (1001) so a viewer is not told the stream failed. See liveStreams.ts.
        liveStreams.closeAllForShutdown();
        exit(75);
    }, 1000);
    // The real setTimeout's return value supports unref (don't let this lone
    // timer keep the event loop alive); an injected test seam's return value
    // may not, so this is checked rather than assumed -- preserves ConfigApi's
    // pre-extraction behavior exactly when no seam is supplied.
    (handle as { unref?: () => void } | undefined)?.unref?.();
}

/** `scheduleRestart` for a committed port change, the cause it was first written for. */
export function scheduleRestartForPortChange(
    markerPath: string,
    log: { info(m: string): void; warn(m: string): void },
    seams?: RestartSeams,
): void {
    scheduleRestart(markerPath, log, 'port change', seams);
}
