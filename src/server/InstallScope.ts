/**
 * Detect whether the running app is installed per-user or per-machine.
 *
 * Velopack on Windows installs to one of two locations depending on the
 * --setupIcon-bearing installer's elevation choice:
 *   - Per-user:    %LOCALAPPDATA%\<AppId>\current\
 *   - Per-machine: %ProgramFiles%\<AppId>\current\  (or similar)
 *
 * For SP3 P3, the only consumer is ServiceApi: per-user install -> register
 * the service under the current user; per-machine install -> register under
 * LocalSystem so it survives logout / non-interactive sessions.
 *
 * Heuristic:
 *   - If process.platform !== 'win32', return 'system'. Linux phase will
 *     reinterpret this independently (systemd `--user` vs root).
 *   - Else: compare the installed binary directory (`dirname(execPath)`)
 *     against `%LOCALAPPDATA%`. If it's underneath, we're per-user; else
 *     per-machine.
 *
 * Function is exposed as pure-ish (takes injectables for testability) so
 * unit tests can mock execPath + LOCALAPPDATA without touching the real env.
 */

import * as path from 'node:path';

export type InstallScope = 'user' | 'system';

export interface DetectInstallScopeOptions {
    /** Override `process.platform` (default: real platform). */
    platform?: NodeJS.Platform;
    /** Override `process.execPath` (default: real execPath). */
    execPath?: string;
    /** Override LOCALAPPDATA (default: process.env.LOCALAPPDATA). */
    localAppData?: string | undefined;
}

export function detectInstallScope(opts: DetectInstallScopeOptions = {}): InstallScope {
    const platform = opts.platform ?? process.platform;
    if (platform !== 'win32') return 'system';

    const localAppData = opts.localAppData ?? process.env['LOCALAPPDATA'];
    if (!localAppData) return 'system';

    const execPath = opts.execPath ?? process.execPath;
    // Use win32 path semantics explicitly: when tests inject platform: 'win32'
    // on a POSIX CI host, the default `path.dirname` would treat backslashes
    // as literal chars and return '.'. On real Windows this is a no-op.
    const installDir = path.win32.dirname(execPath);

    // Case-insensitive prefix compare (Windows paths are case-insensitive).
    // We don't bother with realpath / symlink resolution — Velopack installs
    // are flat copies, no symlinks involved.
    return installDir.toLowerCase().startsWith(localAppData.toLowerCase()) ? 'user' : 'system';
}
