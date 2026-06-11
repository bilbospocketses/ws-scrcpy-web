import { describe, expect, it } from 'vitest';
import { shouldAutoOpenBrowser } from '../openBrowser';

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
        expect(
            shouldAutoOpenBrowser({ ...base, isServiceMode: true, launcherFreshLaunch: true }),
        ).toBe(false);
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
