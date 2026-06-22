import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the spy and the shared cache so they are available inside vi.mock()'s
// factory (which is also hoisted). This is the standard vitest pattern for
// accessing a vi.fn() from within a vi.mock() factory.
const { _cache, mockClearDeviceAudio, mockSetDeviceAudio } = vi.hoisted(() => {
    const cache = new Map<string, Record<string, unknown>>();
    return {
        _cache: cache,
        mockSetDeviceAudio: vi.fn((udid: string, audio: Record<string, unknown>) => {
            const cur = cache.get(udid) ?? {};
            cur['audio'] = audio;
            cache.set(udid, cur);
        }),
        mockClearDeviceAudio: vi.fn((udid: string) => {
            const cur = cache.get(udid);
            if (cur && 'audio' in cur) delete cur['audio'];
        }),
    };
});

// Stub the SettingsService singleton so AudioSettingsStore reads/writes go
// through an in-test Map instead of fetch(). The stub mirrors the subset of
// SettingsService used by AudioSettingsStore: getDeviceAudio, setDeviceAudio,
// clearDeviceAudio, and hydrateDevice.
//
// setDeviceAudio and clearDeviceAudio are vi.fn() spies (hoisted above) so
// the clear() tests can assert clearDeviceAudio was called and setDeviceAudio
// was NOT called — the assertion that catches a "clear fires a write-through
// PATCH" regression.
vi.mock('../SettingsService', () => ({
    settingsService: {
        getDeviceAudio(udid: string): Record<string, unknown> | undefined {
            return _cache.get(udid)?.['audio'] as Record<string, unknown> | undefined;
        },
        setDeviceAudio: mockSetDeviceAudio,
        clearDeviceAudio: mockClearDeviceAudio,
        hydrateDevice(_udid: string): Promise<void> {
            // In tests that exercise read-after-hydrate: pre-seed _cache before
            // calling hydrateDevice; this is a no-op (the real service fetches
            // from the server, but the stub treats the cache as already populated).
            return Promise.resolve();
        },
    },
}));

import { AudioSettingsStore, type StoredAudioSettings } from '../AudioSettingsStore';

beforeEach(() => {
    _cache.clear();
    mockSetDeviceAudio.mockClear();
    mockClearDeviceAudio.mockClear();
});

afterEach(() => {
    _cache.clear();
    mockSetDeviceAudio.mockClear();
    mockClearDeviceAudio.mockClear();
});

describe('AudioSettingsStore.load', () => {
    it('returns null when nothing has been saved for the udid', () => {
        expect(AudioSettingsStore.load('192.168.1.50:5555')).toBeNull();
    });

    it('returns saved settings round-trip', () => {
        const settings: StoredAudioSettings = { enabled: true, source: 'playback', codec: 'opus' };
        AudioSettingsStore.save('dev1', settings);
        expect(AudioSettingsStore.load('dev1')).toEqual(settings);
    });

    it('isolates settings per udid', () => {
        AudioSettingsStore.save('phone', { enabled: true, source: 'playback', codec: 'opus' });
        AudioSettingsStore.save('tv', { enabled: false, source: 'output', codec: 'aac' });
        expect(AudioSettingsStore.load('phone')?.source).toBe('playback');
        expect(AudioSettingsStore.load('tv')?.enabled).toBe(false);
    });

    it('returns null when stored value is missing required fields', () => {
        // Seed the cache directly with a bad object (no JSON parse needed — cache holds parsed objects)
        const cur = _cache.get('dev1') ?? {};
        cur['audio'] = { source: 'playback' };
        _cache.set('dev1', cur);
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });

    it('returns null when stored enum values are invalid', () => {
        const cur = _cache.get('dev1') ?? {};
        cur['audio'] = { enabled: true, source: 'voice-call', codec: 'opus' };
        _cache.set('dev1', cur);
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });

    it('returns null when the cached audio value is not an object', () => {
        const cur = _cache.get('dev1') ?? {};
        cur['audio'] = 'not-an-object';
        _cache.set('dev1', cur);
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });
});

describe('AudioSettingsStore.save', () => {
    it('overwrites previous settings for the same udid', () => {
        AudioSettingsStore.save('dev1', { enabled: true, source: 'playback', codec: 'opus' });
        AudioSettingsStore.save('dev1', { enabled: false, source: 'output', codec: 'aac' });
        expect(AudioSettingsStore.load('dev1')).toEqual({ enabled: false, source: 'output', codec: 'aac' });
    });
});

describe('AudioSettingsStore.clear', () => {
    it('removes saved settings for a udid and does NOT trigger a network write', () => {
        AudioSettingsStore.save('dev1', { enabled: true, source: 'playback', codec: 'opus' });
        mockSetDeviceAudio.mockClear(); // reset after the save() above
        AudioSettingsStore.clear('dev1');
        // Post-clear load must return null (cache-only removal worked)
        expect(AudioSettingsStore.load('dev1')).toBeNull();
        // clear() must route through clearDeviceAudio (cache-only), NOT setDeviceAudio
        // (which fires a write-through PATCH). This is the regression guard.
        expect(mockClearDeviceAudio).toHaveBeenCalledOnce();
        expect(mockClearDeviceAudio).toHaveBeenCalledWith('dev1');
        expect(mockSetDeviceAudio).not.toHaveBeenCalled();
    });

    it('is a no-op when nothing was saved', () => {
        expect(() => AudioSettingsStore.clear('dev1')).not.toThrow();
        expect(mockClearDeviceAudio).toHaveBeenCalledOnce();
        expect(mockSetDeviceAudio).not.toHaveBeenCalled();
    });
});
