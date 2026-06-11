/**
 * Force process.stdout/stderr into blocking (synchronous-to-the-TTY) mode so
 * every subsequent log line is flushed before the process exits.
 *
 * On Windows, TTY writes are asynchronous (per the Node docs — "TTYs are
 * asynchronous on Windows"), so the last lines of a fast shutdown — e.g. the
 * "Stopping adb daemon ..." teardown — get dropped from the console even though
 * the file log (Logger.writeToFile uses appendFileSync) has every line.
 *
 * Both quit paths call this before running teardown so the console matches the
 * file log:
 *   - the signal-quit path (index.ts `exit()` on SIGINT/SIGTERM), and
 *   - the button/tray-quit path (ServerShutdownApi's cleanup → gracefulShutdown,
 *     which previously skipped the flush — its "Stopping ..." lines reached the
 *     file but dropped from the console; SE-3).
 *
 * `stream._handle.setBlocking` is an internal Node API, wrapped in try/catch so
 * a missing `_handle` on a future Node version degrades to prior behavior
 * (async console writes) rather than crashing.
 */
export function forceBlockingStdio(): void {
    try {
        const stdoutHandle = (process.stdout as { _handle?: { setBlocking?: (b: boolean) => void } })._handle;
        const stderrHandle = (process.stderr as { _handle?: { setBlocking?: (b: boolean) => void } })._handle;
        stdoutHandle?.setBlocking?.(true);
        stderrHandle?.setBlocking?.(true);
    } catch {
        /* best-effort — internal API */
    }
}
