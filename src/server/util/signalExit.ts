// src/server/util/signalExit.ts
//
// Decide what a SIGINT or SIGTERM does once the graceful stop has started.
//
// WHY THIS EXISTS (smoke row 12.10, qa-harness 2026-10-06). One Ctrl+C on Linux
// reaches the server twice: the terminal sends SIGINT to the whole process
// group, and the launcher, which also got it, sends its child SIGTERM
// (launcher/src/supervisor.rs `wait_with_signal`). The handler used to
// force-exit on any second signal, so that pair could cut gracefulShutdown
// short before its last step, the SQLite backup (`backupAndCloseStore`).
//
// A repeat inside REPEAT_SIGNAL_GRACE_MS of the FIRST signal is the same stop
// arriving twice, so it is logged and ignored. A signal after that is someone
// asking again because the stop looks stuck, and it still forces the exit. The
// window runs from the first signal, so a burst of repeats cannot extend it.

/** The two signals of one Ctrl+C arrive within milliseconds; a person pressing again takes longer. */
export const REPEAT_SIGNAL_GRACE_MS = 2000;

export interface SignalExitDeps {
    log: (message: string) => void;
    /** Start the graceful stop. Called once, for the first signal. */
    startShutdown: (signal: string) => void;
    /** Leave at once, skipping whatever the graceful stop has not finished. */
    forceExit: () => void;
    now?: () => number;
    graceMs?: number;
}

/** Returns the handler to call with each signal's name. */
export function createSignalExitHandler(deps: SignalExitDeps): (signal: string) => void {
    const now = deps.now ?? Date.now;
    const graceMs = deps.graceMs ?? REPEAT_SIGNAL_GRACE_MS;
    let firstAt: number | undefined;

    return (signal: string) => {
        deps.log(`Received signal ${signal}`);
        if (firstAt === undefined) {
            firstAt = now();
            deps.startShutdown(signal);
            return;
        }
        const sinceFirst = now() - firstAt;
        if (sinceFirst < graceMs) {
            deps.log(`Ignoring ${signal} ${sinceFirst}ms after the first signal: graceful shutdown is already running`);
            return;
        }
        deps.log('Force exit');
        deps.forceExit();
    };
}
