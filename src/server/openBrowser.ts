// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { spawn } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { rmSync, statSync } from 'fs';
import { Logger } from './Logger';

const log = Logger.for('OpenBrowser');

/**
 * Best-effort cross-platform "open this URL in the user's default browser."
 *
 * Used by the v0.1.9 first-run UX: when the LOCAL user instance starts
 * for the very first time (firstRunComplete=false, installMode is not
 * service-mode), we invoke this so the user lands on the welcome modal
 * without having to remember to type the URL into a browser themselves.
 *
 * Detached + ignored stdio so the Node server doesn't wait on the
 * browser process. Any failure is logged at info level — opening a
 * browser is a UX nicety, not a hard requirement.
 *
 * Implementation per-platform:
 *   - Windows: `start "" "<url>"` via cmd.exe /c. The empty quoted
 *     title is required because cmd's `start` interprets the first
 *     quoted token as a window title; without it, the URL would be
 *     misparsed.
 *   - Linux:   `xdg-open <url>`. Standard freedesktop.org launcher.
 *   - macOS:   `open <url>`. (Reserved; we don't ship macOS today.)
 */
export function openBrowser(url: string): void {
    try {
        if (process.platform === 'win32') {
            // We pass arguments via array form (no shell interpolation),
            // so a malicious URL can't inject extra cmd.exe commands.
            const child = spawn('cmd.exe', ['/c', 'start', '""', url], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            log.info(`opened ${url} via cmd start`);
            return;
        }
        if (process.platform === 'linux') {
            const child = spawn('xdg-open', [url], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            log.info(`opened ${url} via xdg-open`);
            return;
        }
        if (process.platform === 'darwin') {
            const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
            child.unref();
            log.info(`opened ${url} via open`);
            return;
        }
        log.info(`no browser-open handler for platform=${process.platform}; skipping`);
    } catch (err) {
        log.info(`browser open failed (best-effort): ${(err as Error).message}`);
    }
}

/**
 * Decide whether the server should auto-open a browser tab at startup. Pure, so
 * it is unit-testable.
 *
 * Opens when EITHER the native launcher signalled a fresh user launch
 * (`launcherFreshLaunch` ← WS_SCRCPY_OPEN_BROWSER=1, set by the supervisor on
 * its FIRST Node spawn — so a cold start PAST first-run still gets a tab; D1)
 * OR this is the very first run (`firstRunComplete === false` — the original
 * v0.1.9 welcome-modal open, and the dev/no-launcher fallback).
 *
 * NEVER opens in service mode (session-0 service instances are reached via the
 * install-handoff redirect) or when a relaunch asked for suppression
 * (`suppressBrowser` ← WS_SCRCPY_NO_BROWSER=1 — the user already has a
 * reconnecting tab). Suppression overrides BOTH open signals, so a relaunch
 * that happens to also carry the fresh-launch flag still won't double-pop.
 *
 * Supervisor restarts (webPort change, crash) are NOT first spawns, so they
 * carry neither signal and (past first-run) do not re-open a tab.
 */
export function shouldAutoOpenBrowser(opts: {
    firstRunComplete: boolean | undefined;
    isServiceMode: boolean;
    suppressBrowser: boolean;
    launcherFreshLaunch: boolean;
}): boolean {
    if (opts.isServiceMode || opts.suppressBrowser) {
        return false;
    }
    const isFirstRun = opts.firstRunComplete === false;
    return opts.launcherFreshLaunch || isFirstRun;
}

/**
 * Consume the post-update "suppress browser open" marker (see
 * Config.suppressBrowserOpenMarkerPath). UpdateService.applyUpdate writes it
 * before the app goes down to apply an update; the relaunched server already
 * carries the user's tab (reconnect / redirect / reload), so it must not pop a
 * NEW one — this is the Windows-local-mode equivalent of Linux's
 * WS_SCRCPY_NO_BROWSER (Velopack owns that relaunch, so we can't set an env on
 * it). Consume-once: the marker is ALWAYS deleted when present, and only honored
 * when FRESH (a stale marker from a failed/abandoned update that never
 * relaunched must not suppress a much-later manual launch). Returns true iff a
 * fresh marker was present. Pure aside from fs; unit-tested with a real temp file.
 */
export function consumeSuppressBrowserMarker(
    markerPath: string,
    opts: { maxAgeMs?: number; now?: number } = {},
): boolean {
    const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
    let mtimeMs: number;
    try {
        mtimeMs = statSync(markerPath).mtimeMs;
    } catch {
        return false; // absent — nothing to consume
    }
    try {
        rmSync(markerPath, { force: true });
    } catch {
        /* best-effort cleanup */
    }
    const now = opts.now ?? Date.now();
    return now - mtimeMs <= maxAgeMs;
}
