// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioSettingsStore, type StoredAudioSettings } from '../AudioSettingsStore';

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    localStorage.clear();
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

    it('returns null on corrupted storage value (defensive)', () => {
        localStorage.setItem('ws-scrcpy-web:audio:dev1', 'not json');
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });

    it('returns null when stored value is missing required fields', () => {
        localStorage.setItem('ws-scrcpy-web:audio:dev1', JSON.stringify({ source: 'playback' }));
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });

    it('returns null when stored enum values are invalid', () => {
        localStorage.setItem(
            'ws-scrcpy-web:audio:dev1',
            JSON.stringify({ enabled: true, source: 'voice-call', codec: 'opus' }),
        );
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
    it('removes saved settings for a udid', () => {
        AudioSettingsStore.save('dev1', { enabled: true, source: 'playback', codec: 'opus' });
        AudioSettingsStore.clear('dev1');
        expect(AudioSettingsStore.load('dev1')).toBeNull();
    });

    it('is a no-op when nothing was saved', () => {
        expect(() => AudioSettingsStore.clear('dev1')).not.toThrow();
    });
});
