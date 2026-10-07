import * as path from 'path';
import * as process from 'process';

// Kept in a module of its own, importing nothing but node built-ins, so the
// vitest setup (vitest.setup.ts) can call the real resolver to guard the suite
// against the machine's real data root. Importing it from Config.ts there would
// load Config's whole graph (Db, Logger, fs) ahead of every test file, and a
// module a setup file has loaded is cached before the test file's vi.mock calls
// can replace it. Config.ts re-exports it, so every caller imports it from there.

/**
 * Pure resolver for the writable-state root. On Windows this is
 * `<PROGRAMDATA>\WsScrcpyWeb` — a machine-wide, all-users-writable location
 * distinct from the install root (where Velopack manages binaries).
 *
 * On non-Windows the resolution order is:
 *   1. `DATA_ROOT` env var — set by the Rust launcher as a bridge so the
 *      Node child always knows its data root without platform detection.
 *   2. `XDG_DATA_HOME/WsScrcpyWeb` — respects the XDG Base Directory spec.
 *   3. `~/.local/share/WsScrcpyWeb` — XDG default fallback.
 *   4. `null` — only when HOME is also missing (extreme edge case).
 *
 * Defaulting `PROGRAMDATA` to `C:\ProgramData` matches Microsoft's
 * documented value for the system ProgramData folder when the env var is
 * unexpectedly missing — an extremely rare edge but worth covering rather
 * than crashing.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
    // An explicit DATA_ROOT wins everywhere, Windows included. It used to be
    // read only on non-Windows, so on Windows the variable was inert: setting
    // it moved config.json and the store nowhere, and a caller who set only
    // DATA_ROOT got a data root and a dependencies tree in different places.
    if (env['DATA_ROOT'] && env['DATA_ROOT'].length > 0) {
        return env['DATA_ROOT'];
    }
    if (platform === 'win32') {
        const programData =
            env['PROGRAMDATA'] && env['PROGRAMDATA'].length > 0 ? env['PROGRAMDATA'] : 'C:\\ProgramData';
        return path.win32.join(programData, 'WsScrcpyWeb');
    }
    // Non-Windows fallbacks: XDG_DATA_HOME > ~/.local/share
    if (env['XDG_DATA_HOME'] && env['XDG_DATA_HOME'].length > 0) {
        return path.join(env['XDG_DATA_HOME'], 'WsScrcpyWeb');
    }
    if (env['HOME'] && env['HOME'].length > 0) {
        return path.join(env['HOME'], '.local', 'share', 'WsScrcpyWeb');
    }
    return null;
}
