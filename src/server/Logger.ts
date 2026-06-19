import * as fs from 'fs';
import * as path from 'path';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Compute the log file path. Per Local-Dependencies-Only architecture
 * (CLAUDE.md), runtime mutable state including logs lives in dataRoot,
 * not in the install image — a Velopack swap of `current/` should not
 * wipe accumulated logs.
 *
 * Resolution order:
 *   1. <dataRoot>/logs/ws-scrcpy-web.log  — the production target.
 *      dataRoot is derived from DEPS_PATH (which the launcher always
 *      sets to <dataRoot>/dependencies/), so dataRoot =
 *      path.dirname(DEPS_PATH). v0.1.24-beta.7 moved the file under a
 *      `logs/` subdirectory to colocate with launcher.log + server.log
 *      (already moved in v0.1.24-beta.3) — single source of truth for
 *      "where do logs live."
 *   2. <__dirname>/../ws-scrcpy-web.log  — dev fallback when DEPS_PATH
 *      isn't set (npm start without launcher, vitest, etc.). Kept at
 *      project root for dev convenience; not worth a sibling logs/ dir
 *      in a working tree.
 *
 * Pre-v0.1.23-beta.25 the log lived at the dev-fallback path
 * unconditionally — for production that resolved to
 * <installRoot>/current/ws-scrcpy-web.log, inside the swappable image,
 * so the log was lost on every in-app update. Fixed in beta.25.
 */
function resolveLogFilePath(): string {
    const depsPath = process.env['DEPS_PATH'];
    if (depsPath) {
        return path.join(path.dirname(depsPath), 'logs', 'ws-scrcpy-web.log');
    }
    // After webpack build, __dirname = dist/. One level up = project root.
    return path.resolve(__dirname, '..', 'ws-scrcpy-web.log');
}

const LOG_FILE = resolveLogFilePath();

/**
 * Rotate `logFile` to `logFile.1` when it reaches `maxBytes`. Called on EVERY
 * write (no once-per-process guard) so a long-running process stays bounded.
 * Single backup; a prior `.1` is overwritten by renameSync. All failures are
 * swallowed — logging must never crash the server.
 */
export function rotateIfNeeded(logFile: string, maxBytes: number): void {
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {
        // directory uncreatable — the appendFileSync below will no-op too
    }
    try {
        const stats = fs.statSync(logFile);
        if (stats.size >= maxBytes) {
            fs.renameSync(logFile, `${logFile}.1`);
        }
    } catch {
        // file doesn't exist yet — nothing to rotate
    }
}

function timestamp(): string {
    return new Date().toISOString();
}

function writeToFile(line: string): void {
    rotateIfNeeded(LOG_FILE, MAX_LOG_SIZE);
    try {
        fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch {
        // If we can't write to the log file, don't crash the server
    }
}

/**
 * Whether Logger should echo to the console. True only when the target stream
 * is a terminal (dev). Under the launcher, stdout/stderr are redirected to a
 * file (server.log), so isTTY is falsy and we skip the console echo — that
 * echo would only duplicate ws-scrcpy-web.log into server.log. Keyed on the
 * OS truth (isTTY), never an env var, so it can never drift from the actual
 * capture state.
 */
export function shouldLogToConsole(isTty: boolean): boolean {
    return isTty;
}

export class Logger {
    private readonly tag: string;

    private constructor(tag: string) {
        this.tag = `[${tag}]`;
    }

    static for(tag: string): Logger {
        return new Logger(tag);
    }

    info(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ${message}`;
        // Console echo is gated on isTTY (dev terminal only); under the
        // launcher stdout is redirected so isTTY is falsy and server.log
        // stays a thin crash-catcher rather than a mirror of this file.
        if (shouldLogToConsole(Boolean(process.stdout.isTTY))) {
            console.log(`${ts} ${this.tag}`, ...args);
        }
        writeToFile(line);
    }

    warn(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} WARN ${message}`;
        if (shouldLogToConsole(Boolean(process.stderr.isTTY))) {
            console.warn(`${ts} ${this.tag} WARN`, ...args);
        }
        writeToFile(line);
    }

    error(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ERROR ${message}`;
        if (shouldLogToConsole(Boolean(process.stderr.isTTY))) {
            console.error(`${ts} ${this.tag} ERROR`, ...args);
        }
        writeToFile(line);
    }
}
