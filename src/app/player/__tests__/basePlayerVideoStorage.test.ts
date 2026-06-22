// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 4c — BasePlayer video read/write via SettingsService singleton.
 *
 * Verifies:
 *  - Cold (unhydrated) path: getVideoSettingFromStorage returns preferred,
 *    getFitToScreenFromStorage returns false.
 *  - Seeded cache: getVideoSettingFromStorage coerces the stored plain-JSON object
 *    into a VideoSettings instance with all fields applied; getFitToScreenFromStorage
 *    returns the stored fit value.
 *  - Write path: putVideoSettingsToStorage stores a plain-JSON form (no class
 *    instance), and the subsequent read reflects the write.
 *  - Adjustment #3: the stored `settings` value is a plain object (JSON.parse-able),
 *    not a VideoSettings class instance, so round-trip reads are identical whether
 *    the cache was populated by a write or by a server GET.
 */

// Stub the SettingsService module BEFORE importing BasePlayer so the module-level
// singleton is replaced with a controlled fake backed by a plain Map.
const fakeDeviceCache = new Map<string, Record<string, unknown>>();
let capturedSetDeviceVideo: Array<{ udid: string; video: Record<string, unknown> }> = [];

vi.mock('../../client/SettingsService', () => {
    const fakeService = {
        getDeviceVideo(udid: string) {
            return fakeDeviceCache.get(udid)?.['video'] as Record<string, unknown> | undefined;
        },
        setDeviceVideo(udid: string, video: Record<string, unknown>) {
            const cur = fakeDeviceCache.get(udid) ?? {};
            cur['video'] = video;
            fakeDeviceCache.set(udid, cur);
            capturedSetDeviceVideo.push({ udid, video });
        },
        hydrateDevice: vi.fn().mockResolvedValue(undefined),
    };
    return { settingsService: fakeService };
});

describe('BasePlayer video storage — Task 4c (SettingsService-backed)', () => {
    const UDID = 'test-device-udid';

    beforeEach(() => {
        fakeDeviceCache.clear();
        capturedSetDeviceVideo = [];
        // Invalidate vitest's module cache so each test gets a fresh BasePlayer
        // import (module reuse is OK here — we only check static method results).
        vi.resetModules();
    });

    async function importModules() {
        // Must be dynamic so the vi.mock stub is active before module eval.
        const { BasePlayer } = await import('../BasePlayer');
        const { default: VideoSettings } = await import('../../VideoSettings');
        const { default: Size } = await import('../../Size');
        return { BasePlayer, VideoSettings, Size };
    }

    it('cold miss: getVideoSettingFromStorage returns preferred', async () => {
        const { BasePlayer, VideoSettings, Size } = await importModules();
        const preferred = new VideoSettings({ bitrate: 1_000_000, maxFps: 30, iFrameInterval: 5, bounds: new Size(640, 480) });
        const result = BasePlayer.getVideoSettingFromStorage(preferred, 'WebCodecsPlayer', UDID);
        expect(result).toBe(preferred);
    });

    it('cold miss: getFitToScreenFromStorage returns false', async () => {
        const { BasePlayer } = await importModules();
        const result = BasePlayer.getFitToScreenFromStorage('WebCodecsPlayer', UDID);
        expect(result).toBe(false);
    });

    it('seeded cache: getVideoSettingFromStorage coerces stored plain-JSON into VideoSettings', async () => {
        const { BasePlayer, VideoSettings, Size } = await importModules();
        // Seed as a plain JSON object (as the migration + server GET would return).
        fakeDeviceCache.set(UDID, {
            video: {
                settings: {
                    bitrate: 2_000_000,
                    maxFps: 60,
                    iFrameInterval: 10,
                    lockedVideoOrientation: 0,
                    sendFrameMeta: false,
                    bounds: { width: 1280, height: 720 },
                },
                fit: true,
            },
        });
        const preferred = new VideoSettings({ bitrate: 1_000_000, maxFps: 30, iFrameInterval: 5, bounds: new Size(640, 480) });
        const result = BasePlayer.getVideoSettingFromStorage(preferred, 'WebCodecsPlayer', UDID);
        expect(result).toBeInstanceOf(VideoSettings);
        expect(result.bitrate).toBe(2_000_000);
        expect(result.maxFps).toBe(60);
        expect(result.iFrameInterval).toBe(10);
        expect(result.bounds).toEqual(new Size(1280, 720));
        expect(result.sendFrameMeta).toBe(false);
    });

    it('seeded cache: getFitToScreenFromStorage returns stored fit', async () => {
        const { BasePlayer } = await importModules();
        fakeDeviceCache.set(UDID, { video: { fit: true } });
        expect(BasePlayer.getFitToScreenFromStorage('WebCodecsPlayer', UDID)).toBe(true);

        fakeDeviceCache.set(UDID, { video: { fit: false } });
        expect(BasePlayer.getFitToScreenFromStorage('WebCodecsPlayer', UDID)).toBe(false);
    });

    it('write-through: putVideoSettingsToStorage stores plain-JSON + fit and cache reflects it', async () => {
        const { BasePlayer, VideoSettings, Size } = await importModules();
        const vs = new VideoSettings({ bitrate: 3_000_000, maxFps: 30, iFrameInterval: 5, bounds: new Size(800, 600) });

        // Access the protected static via cast.
        (BasePlayer as unknown as { putVideoSettingsToStorage: Function }).putVideoSettingsToStorage(
            'WebCodecsPlayer',
            UDID,
            vs,
            true,
        );

        // Exactly one setDeviceVideo call.
        expect(capturedSetDeviceVideo).toHaveLength(1);
        const { udid, video } = capturedSetDeviceVideo[0]!;
        expect(udid).toBe(UDID);

        // Adjustment #3: stored settings must be a plain object, not a class instance.
        const settings = (video as Record<string, unknown>)['settings'];
        expect(settings).toBeDefined();
        expect(typeof settings).toBe('object');
        expect((settings as Record<string, unknown>)['bitrate']).toBe(3_000_000);
        // Plain-object check: JSON.parse(JSON.stringify(...)) — constructor name should not be VideoSettings.
        expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
        expect((video as Record<string, unknown>)['fit']).toBe(true);

        // Read back: getVideoSettingFromStorage should now return the written value.
        const preferred = new VideoSettings({ bitrate: 1_000_000, maxFps: 15, iFrameInterval: 5 });
        const result = BasePlayer.getVideoSettingFromStorage(preferred, 'WebCodecsPlayer', UDID);
        expect(result).toBeInstanceOf(VideoSettings);
        expect(result.bitrate).toBe(3_000_000);
        expect(BasePlayer.getFitToScreenFromStorage('WebCodecsPlayer', UDID)).toBe(true);
    });
});
