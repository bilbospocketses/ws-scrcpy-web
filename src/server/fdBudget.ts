/**
 * The file-descriptor budget: how many the server may hold open, and the one
 * knob that can spend most of them.
 *
 * Why this exists. On Linux the server inherits its parent's soft
 * RLIMIT_NOFILE, and nothing set one: a systemd service got systemd's
 * DefaultLimitNOFILE (1024 soft on every mainstream distro), a desktop launch
 * got the shell's `ulimit -n` (1024 there too). That budget is shared by the
 * HTTP listener, every browser WebSocket, adb's sockets, the SQLite store, the
 * log, and — the elephant — the subnet scan, which opens `scanConcurrency`
 * TCP connects at once and accepted any number at all. The review of PR #506
 * argued publicly that a 1024-socket sweep would collide with the process
 * limit outright; that was true, and it was true for our own scanner with a
 * large enough `SCAN_CONCURRENCY`. This module makes the budget explicit and
 * ties the two numbers together so neither moves without the other.
 *
 * The arithmetic, worst case, per process:
 *
 *   base                 32   listener, stdio, log, SQLite (db + wal + shm),
 *                             adb client sockets, Node's own handles
 *   per browser tab       6   1–2 HTTP keep-alive + up to 4 WebSockets
 *                             (device tracker, scan, shell, multiplexer)
 *   per streamed device   8   video / audio / control over adb forward,
 *                             the stream WebSocket, probes, file listing
 *   scan                MAX_SCAN_CONCURRENCY
 *
 * Sixteen tabs and sixteen devices at once — well past anything the smoke
 * has ever run — is 32 + 96 + 128 = 256, plus the scan. With the scan capped
 * at 512 that is 768; SERVICE_NOFILE_LIMIT is 4096, five times the worst
 * case, and below the hard limit every systemd since v240 grants (524288)
 * as well as the 4096 hard cap older units shipped with, so it is always
 * grantable without privilege. The cap on the scan is the load-bearing half:
 * it is what keeps a config.json or an env var from spending the budget.
 *
 * Who reads this:
 *   - src/server/service/SystemdClient.ts writes `LimitNOFILE=` into both
 *     unit scopes (service runs).
 *   - launcher/src/spawn.rs raises the launcher's own soft limit to the same
 *     number before it spawns Node, which inherits it (desktop runs on Linux).
 *     The Rust constant is pinned to this one by fdBudget.test.ts.
 *   - src/server/Config.ts clamps `scanConcurrency` to MAX_SCAN_CONCURRENCY.
 *
 * Windows has no equivalent and needs none: there is no per-process fd
 * rlimit — sockets are kernel handles, and the CRT's `_setmaxstdio` ceiling
 * covers only C `FILE*` streams, which libuv does not use. Docker: the engine's
 * default `nofile` ulimit is 1048576, so the container is never the binding
 * constraint either.
 */

/** Default in-flight TCP connects in the scan's probe pool. */
export const DEFAULT_SCAN_CONCURRENCY = 64;

/** Hard ceiling on `scanConcurrency`, whatever config.json or SCAN_CONCURRENCY says. */
export const MAX_SCAN_CONCURRENCY = 512;

/**
 * Soft RLIMIT_NOFILE the service unit and the Linux launcher grant the server.
 * launcher/src/spawn.rs carries the same number as `NOFILE_LIMIT`.
 */
export const SERVICE_NOFILE_LIMIT = 4096;

/**
 * Resolve a requested scan concurrency to one the budget allows. Anything that
 * is not a positive finite number falls back to the default; anything above the
 * cap is brought down to it. Returns the value and whether it was changed, so
 * the caller can say so in the log — a silently halved setting is a support
 * ticket.
 */
export function clampScanConcurrency(requested: number | undefined): { value: number; clamped: boolean } {
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
        return { value: DEFAULT_SCAN_CONCURRENCY, clamped: false };
    }
    const value = Math.floor(requested);
    if (value > MAX_SCAN_CONCURRENCY) {
        return { value: MAX_SCAN_CONCURRENCY, clamped: true };
    }
    return { value, clamped: false };
}
