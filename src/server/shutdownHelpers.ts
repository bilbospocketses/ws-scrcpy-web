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
