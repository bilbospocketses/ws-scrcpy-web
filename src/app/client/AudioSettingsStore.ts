import type { AudioSource } from '../../common/AudioDefaults';

/**
 * localStorage-persisted audio preferences keyed by device udid. Mirrors the
 * pattern used by `BasePlayer.saveVideoSettings` but keeps audio isolated from
 * video (distinct concerns, separate concerns, simpler serialization).
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

const PREFIX = 'ws-scrcpy-web:audio';
const VALID_SOURCES: ReadonlySet<string> = new Set<AudioSource>(['playback', 'output', 'mic']);
const VALID_CODECS: ReadonlySet<string> = new Set(['opus', 'aac', 'flac', 'raw']);

function keyFor(udid: string): string {
    return `${PREFIX}:${udid}`;
}

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
    load(udid: string): StoredAudioSettings | null {
        try {
            const raw = localStorage.getItem(keyFor(udid));
            if (!raw) return null;
            const parsed: unknown = JSON.parse(raw);
            return isValidStored(parsed) ? parsed : null;
        } catch {
            return null;
        }
    },

    save(udid: string, settings: StoredAudioSettings): void {
        try {
            localStorage.setItem(keyFor(udid), JSON.stringify(settings));
        } catch {
            // Storage full or disabled — silently ignore, consistent with
            // how BasePlayer handles localStorage failures.
        }
    },

    clear(udid: string): void {
        try {
            localStorage.removeItem(keyFor(udid));
        } catch {
            // ignore
        }
    },
};
