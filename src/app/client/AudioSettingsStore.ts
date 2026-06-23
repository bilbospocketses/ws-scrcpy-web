import type { AudioSource } from '../../common/AudioDefaults';
import { settingsService } from './SettingsService';

/**
 * Per-device audio preferences backed by the SettingsService singleton's sync
 * device cache. Mirrors the former localStorage pattern but delegates all
 * storage to the server via settingsService (write-through PATCH, sync reads
 * off the hydrated cache).
 *
 * Fields match the three interactive controls in ConfigureScrcpy's audio
 * group: the "enable audio" checkbox, the "audio source" dropdown, and the
 * "audio codec" dropdown.
 */
export interface StoredAudioSettings {
    enabled: boolean;
    source: AudioSource;
    codec: string;
}

const VALID_SOURCES: ReadonlySet<string> = new Set<AudioSource>(['playback', 'output', 'mic']);
const VALID_CODECS: ReadonlySet<string> = new Set(['opus', 'aac', 'flac', 'raw']);

function isValidStored(value: unknown): value is StoredAudioSettings {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v['enabled'] === 'boolean' &&
        typeof v['source'] === 'string' &&
        VALID_SOURCES.has(v['source'] as string) &&
        typeof v['codec'] === 'string' &&
        VALID_CODECS.has(v['codec'] as string)
    );
}

export const AudioSettingsStore = {
    /**
     * Sync read off the service's hydrated device cache. Returns null when:
     * (a) the udid has never been hydrated, (b) the 'audio' scope is absent,
     * or (c) the cached value fails the StoredAudioSettings shape check.
     * Callers must ensure settingsService.hydrateDevice(udid) has resolved
     * before calling load to get a meaningful result.
     */
    load(udid: string): StoredAudioSettings | null {
        const raw = settingsService.getDeviceAudio(udid);
        return isValidStored(raw) ? raw : null;
    },

    /**
     * Write-through save: updates the singleton's sync cache immediately and
     * fires a background PATCH to the server (no await — callers are sync/void).
     */
    save(udid: string, settings: StoredAudioSettings): void {
        settingsService.setDeviceAudio(udid, settings as unknown as Record<string, unknown>);
    },
};
