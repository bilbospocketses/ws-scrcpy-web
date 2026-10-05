import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PrivateServerPaths } from './privateServer';

/**
 * A private server's own log file, `<dataRoot>/logs/ws-scrcpy-web.log`.
 *
 * The file is the log: the console echo is TTY-only, so a spawned child's
 * captured stdout never carries it.
 */

export const LOG_REL = path.join('logs', 'ws-scrcpy-web.log');

/** The line `exitIfNothingCanServe()` writes just before `process.exit(1)` (HttpServer.ts, #718). */
export const NOTHING_SERVES = 'no listener is serving: every configured listener failed to bind';

export function serverLogPath(paths: PrivateServerPaths): string {
    return path.join(paths.dataRoot, LOG_REL);
}

/** The whole log, or '' before the server has written its first line. */
export function readServerLog(paths: PrivateServerPaths): string {
    const p = serverLogPath(paths);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Length of the log right now, so a later boot's lines can be read on their own. */
export function logOffset(paths: PrivateServerPaths): number {
    const p = serverLogPath(paths);
    return existsSync(p) ? statSync(p).size : 0;
}

/** Everything the log gained after `offset` (a byte length from `logOffset`). */
export function logSince(paths: PrivateServerPaths, offset: number): string {
    const p = serverLogPath(paths);
    if (!existsSync(p)) return '';
    return readFileSync(p).subarray(offset).toString('utf8');
}

/** Non-overlapping occurrences of `needle`: "logged exactly once" is a count, not a `toContain`. */
export function countOccurrences(haystack: string, needle: string): number {
    let n = 0;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
    return n;
}
