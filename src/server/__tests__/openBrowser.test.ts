// biome-ignore lint/style/useNodejsImportProtocol: match the non-prefixed app-code import style
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: match the non-prefixed app-code import style
import { tmpdir } from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: match the non-prefixed app-code import style
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consumeSuppressBrowserMarker, shouldAutoOpenBrowser } from '../openBrowser';

/**
 * D1: a cold start PAST first-run must still open a browser tab. The native
 * launcher's supervisor sets WS_SCRCPY_OPEN_BROWSER=1 on its FIRST Node spawn
 * (launcherFreshLaunch); supervisor restarts and dev (no launcher) do not.
 * Service mode and a relaunch's WS_SCRCPY_NO_BROWSER suppression always win.
 */
describe('shouldAutoOpenBrowser', () => {
    const base = {
        firstRunComplete: true as boolean | undefined,
        isServiceMode: false,
        suppressBrowser: false,
        launcherFreshLaunch: false,
    };

    it('opens on a fresh launcher launch even past first-run (the D1 fix)', () => {
        expect(shouldAutoOpenBrowser({ ...base, launcherFreshLaunch: true })).toBe(true);
    });

    it('opens on first run when there is no launcher signal (dev / fallback)', () => {
        expect(shouldAutoOpenBrowser({ ...base, firstRunComplete: false })).toBe(true);
    });

    it('does NOT open on a supervisor restart past first-run (no launcher signal)', () => {
        // The first spawn set the flag; restarts (webPort change, crash) do not.
        expect(shouldAutoOpenBrowser({ ...base })).toBe(false);
    });

    it('does NOT open in service mode, even on a fresh launch', () => {
        expect(shouldAutoOpenBrowser({ ...base, isServiceMode: true, launcherFreshLaunch: true })).toBe(false);
    });

    it('does NOT open when a relaunch asked for suppression (overrides both signals)', () => {
        expect(
            shouldAutoOpenBrowser({
                ...base,
                suppressBrowser: true,
                launcherFreshLaunch: true,
                firstRunComplete: false,
            }),
        ).toBe(false);
    });

    it('treats undefined firstRunComplete as "not first run" (no spurious open)', () => {
        expect(shouldAutoOpenBrowser({ ...base, firstRunComplete: undefined })).toBe(false);
    });
});

/**
 * D4: a post-update relaunch (esp. Windows local mode, where Velopack owns the
 * relaunch and carries no WS_SCRCPY_NO_BROWSER) must not pop a 2nd tab on top of
 * the user's reconnecting one. applyUpdate leaves a consume-once marker; the
 * relaunched server consumes it (always deletes; honored only when fresh).
 */
describe('consumeSuppressBrowserMarker', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'wssw-suppress-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns false when the marker is absent', () => {
        expect(consumeSuppressBrowserMarker(join(dir, 'suppress-browser-open'))).toBe(false);
    });

    it('returns true and deletes the marker when fresh', () => {
        const p = join(dir, 'suppress-browser-open');
        writeFileSync(p, '');
        expect(consumeSuppressBrowserMarker(p)).toBe(true);
        expect(existsSync(p), 'marker consumed (deleted)').toBe(false);
    });

    it('returns false but still deletes the marker when stale', () => {
        const p = join(dir, 'suppress-browser-open');
        writeFileSync(p, '');
        // Evaluate "now" an hour ahead so the just-written mtime reads as stale.
        const future = Date.now() + 60 * 60_000;
        expect(consumeSuppressBrowserMarker(p, { now: future })).toBe(false);
        expect(existsSync(p), 'stale marker still cleaned up').toBe(false);
    });
});
