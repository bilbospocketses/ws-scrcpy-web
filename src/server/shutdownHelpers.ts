import { liveStreams } from './liveStreams';
import { type ReapOwnAdbDeps, reapOwnAdbOnWindows } from './util/reapOwnAdb';

/**
 * Reap the app's OWN adb daemon on Windows after `adb kill-server`, by
 * executable path: only processes running `adbPath` (`Config.adbPath`) are
 * killed, each with its tree. Returns how many were killed.
 *
 * `adb kill-server` alone leaves the app's daemon behind when it was spawned
 * detached (escaping the Node job object) or had stuck transports / in-flight
 * forwards; this belt-and-braces kill catches those.
 *
 * It used to be `taskkill /F /IM adb.exe /T`, which also killed every OTHER
 * adb on the machine -- Android Studio's, a developer's own platform-tools
 * daemon -- dropping their devices whenever this app exited. Other tools' adb
 * must survive the app's exit, so the match is the binary's path, not its
 * image name. See `util/reapOwnAdb.ts`.
 *
 * Never throws; a no-op on non-Windows platforms.
 */
export async function reapStrayAdbOnWindows(adbPath: string, deps?: ReapOwnAdbDeps): Promise<number> {
    return reapOwnAdbOnWindows(adbPath, deps);
}

/** What the graceful teardown acts on. index.ts passes the real ones; tests pass fakes. */
export interface GracefulShutdownSteps {
    log: { info(message: string): void; warn(message: string): void };
    adbPath: string;
    /** `adb kill-server` through the scanner's client. */
    killAdbServer: () => Promise<void>;
    /** The services index.ts started, released in order. */
    services: readonly { getName(): string; release(): void }[];
    /** Snapshot and close the SQLite store (`backupAndCloseStore`). */
    backupStore: () => void;
    /** Defaults to `reapStrayAdbOnWindows`. */
    reapStrayAdb?: (adbPath: string) => Promise<number>;
    /** Defaults to `process.platform`. */
    platform?: NodeJS.Platform;
}

/**
 * The teardown `gracefulShutdown` in index.ts runs: close the open streams,
 * stop the adb daemon we own and release the running services, then the store.
 * Lives here rather than in index.ts so its ORDER can be tested; index.ts keeps
 * the run-once guard.
 */
export async function runGracefulShutdown(steps: GracefulShutdownSteps): Promise<void> {
    const { log, adbPath } = steps;
    const platform = steps.platform ?? process.platform;
    // FIRST, before kill-server: killing adb kills each session's scrcpy-server,
    // and a session still open then fails with 4005 (or 1006, once the WS
    // server's release terminates the socket), so a viewer saw "stream failed"
    // over a stop they asked for. Closed and released here with 1001, the exit
    // kill-server causes finds the session already gone. See liveStreams.ts.
    const streams = liveStreams.closeAllForShutdown();
    if (streams > 0) {
        log.info(`Closed ${streams} open stream(s) (1001 server shutting down)`);
    }
    log.info('Stopping adb daemon (kill-server) ...');
    try {
        await steps.killAdbServer();
    } catch (err) {
        log.warn(`adb kill-server during exit failed: ${(err as Error).message}`);
    }
    // The own-adb reaper is Windows-only (reapStrayAdbOnWindows no-ops
    // elsewhere); only log it where it actually runs, so Linux/macOS logs
    // don't carry a Windows-only line that does nothing. It stops only
    // processes running config.adbPath -- another tool's adb (Android
    // Studio's) must survive this app's exit.
    if (platform === 'win32') {
        log.info(`Stopping any leftover own adb (${adbPath}) ...`);
    }
    const reaped = await (steps.reapStrayAdb ?? reapStrayAdbOnWindows)(adbPath);
    if (reaped > 0) {
        log.info(`Reaped ${reaped} own adb process(es) left after kill-server`);
    }
    steps.services.forEach((service) => {
        log.info(`Stopping ${service.getName()} ...`);
        service.release();
    });
    // Snapshot the SQLite store (the last-good `.bak` the corrupt-recovery
    // path restores from), then close it so SQLite checkpoints the WAL into
    // wsscrcpy.db (finding 10.21). LAST on purpose: kill-server and the
    // service releases above do not use the store, and the HTTP and WS
    // servers are already closed, so no request reaches it afterwards.
    // Best-effort; never blocks exit.
    steps.backupStore();
}
