import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the SettingsService singleton so AudioSettingsStore reads/writes go
// through an in-test Map instead of fetch(). The stub mirrors the subset of
// SettingsService used by AudioSettingsStore: getDeviceAudio, setDeviceAudio,
// and hydrateDevice (which populates the cache from the "server").
const _cache = new Map<string, Record<string, unknown>>();
vi.mock('../SettingsService', () => {
    return {
        settingsService: {
            getDeviceAudio(udid: string): Record<string, unknown> | undefined {
                return _cache.get(udid)?.['audio'] as Record<string, unknown> | undefined;
            },
            setDeviceAudio(udid: string, audio: Record<string, unknown>): void {
                const cur = _cache.get(udid) ?? {};
                cur['audio'] = audio;
                _cache.set(udid, cur);
            },
            hydrateDevice(_udid: string): Promise<void> {
                // In tests that exercise read-after-hydrate: pre-seed _cache before
                // calling hydrateDevice; this implementation is a no-op (the real
                // service fetches from the server, but the stub treats the cache as
                // already populated by the test).
                return Promise.resolve();
            },
        },
    };
});

import { AudioSettingsStore, type StoredAudioSettings } from '../AudioSettingsStore';

beforeEach(() => {
    _cache.clear();
});

afterEach(() => {
    _cache.clear();
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
    it('removes saved settings for a udid (cache-only)', () => {
        AudioSettingsStore.save('dev1', { enabled: true, source: 'playback', codec: 'opus' });
        AudioSettingsStore.clear('dev1');
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });

    it('is a no-op when nothing was saved', () => {
        expect(() => AudioSettingsStore.clear('dev1')).not.toThrow();
    });
});
