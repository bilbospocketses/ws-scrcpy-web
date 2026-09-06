import { spawn } from 'child_process';
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
 * UNDER THE NATIVE LAUNCHER (`launcherManaged` — the supervisor hands every
 * Node spawn a DEPS_PATH, so its presence is the launcher's signature) the
 * supervisor is the only authority: it sets WS_SCRCPY_OPEN_BROWSER=1 on its
 * FIRST Node spawn of a user launch (`launcherFreshLaunch`, D1) and on nothing
 * else. A supervisor RESTART (webPort change, crash) is not a fresh launch and
 * opens no tab — whatever `firstRunComplete` says. Until 2026-09-06 the
 * first-run clause below also applied under the launcher, so a port change made
 * while the WelcomeModal's "don't show again" box had never been ticked (the
 * state every fresh install is in) popped a SECOND tab next to the one the page
 * redirects. Measured by qa-harness Arc 1a: 2 tabs after 8000→8010 with
 * firstRunComplete=false, exactly 1 with it true (smoke row 1.8).
 *
 * WITHOUT A LAUNCHER (dev, a hand-run dist) nobody can signal anything, so the
 * very first run (`firstRunComplete === false`) opens the welcome modal for the
 * user — the original v0.1.9 open, kept only for that case.
 *
 * NEVER opens in service mode (session-0 service instances are reached via the
 * install-handoff redirect) or when a relaunch asked for suppression
 * (`suppressBrowser` ← WS_SCRCPY_NO_BROWSER=1 — the user already has a
 * reconnecting tab). Suppression overrides every open signal, so a relaunch
 * that happens to also carry the fresh-launch flag still won't double-pop.
 */
export function shouldAutoOpenBrowser(opts: {
    firstRunComplete: boolean | undefined;
    isServiceMode: boolean;
    suppressBrowser: boolean;
    launcherFreshLaunch: boolean;
    launcherManaged: boolean;
}): boolean {
    if (opts.isServiceMode || opts.suppressBrowser) {
        return false;
    }
    if (opts.launcherManaged) {
        return opts.launcherFreshLaunch;
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
