import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_KEYS, migrateLocalStorage, type SettingsSink } from '../migrateLocalStorage';

// Map-backed fake Storage — no jsdom required.
class MemStorage implements Storage {
    private readonly store = new Map<string, string>();

    get length(): number {
        return this.store.size;
    }

    key(index: number): string | null {
        return [...this.store.keys()][index] ?? null;
    }

    getItem(k: string): string | null {
        return this.store.get(k) ?? null;
    }

    setItem(k: string, v: string): void {
        this.store.set(k, v);
    }

    removeItem(k: string): void {
        this.store.delete(k);
    }

    clear(): void {
        this.store.clear();
    }
}

function makeSink(): SettingsSink & { globalPatches: Array<Record<string, unknown>>; devicePatches: Array<{ udid: string; patch: Record<string, unknown> }> } {
    const globalPatches: Array<Record<string, unknown>> = [];
    const devicePatches: Array<{ udid: string; patch: Record<string, unknown> }> = [];
    return {
        globalPatches,
        devicePatches,
        async patchGlobal(patch) {
            globalPatches.push(patch);
        },
        async patchDevice(udid, patch) {
            devicePatches.push({ udid, patch });
        },
    };
}

describe('migrateLocalStorage — happy path', () => {
    let ls: MemStorage;
    let sink: ReturnType<typeof makeSink>;

    beforeEach(() => {
        ls = new MemStorage();
        sink = makeSink();
    });

    it('migrates theme, iconSize, and scanSubnets as global prefs', async () => {
        ls.setItem(LEGACY_KEYS.theme, 'dark');
        ls.setItem(LEGACY_KEYS.iconSize, '28');
        ls.setItem(LEGACY_KEYS.scanSubnets, JSON.stringify(['10.0.0.0/24', '172.16.0.0/24']));

        await migrateLocalStorage(ls, sink);

        expect(sink.globalPatches).toHaveLength(1);
        expect(sink.globalPatches[0]).toEqual({
            theme: 'dark',
            iconSize: 28,
            scanSubnets: ['10.0.0.0/24', '172.16.0.0/24'],
        });
    });

    it('sets the migrated flag and clears legacy keys after success', async () => {
        ls.setItem(LEGACY_KEYS.theme, 'light');
        ls.setItem(LEGACY_KEYS.iconSize, '24');

        await migrateLocalStorage(ls, sink);

        expect(ls.getItem(LEGACY_KEYS.migratedFlag)).toBe('1');
        expect(ls.getItem(LEGACY_KEYS.theme)).toBeNull();
        expect(ls.getItem(LEGACY_KEYS.iconSize)).toBeNull();
    });

    it('migrates audio per-device settings', async () => {
        ls.setItem('ws-scrcpy-web:audio:ABCD1234', JSON.stringify({ enabled: true, source: 'output', codec: 'opus' }));

        await migrateLocalStorage(ls, sink);

        const audioCall = sink.devicePatches.find((p) => p.udid === 'ABCD1234');
        expect(audioCall).toBeDefined();
        expect(audioCall!.patch['audio']).toEqual({ enabled: true, source: 'output', codec: 'opus' });
    });

    it('migrates video settings with a network udid (colon inside) and a :fit sibling', async () => {
        ls.setItem('WebCodecsPlayer:192.168.1.5:5555:1920x1080', JSON.stringify({ bitrate: 8000000 }));
        ls.setItem('WebCodecsPlayer:192.168.1.5:5555:1920x1080:fit', JSON.stringify(true));

        await migrateLocalStorage(ls, sink);

        const videoCall = sink.devicePatches.find((p) => p.udid === '192.168.1.5:5555');
        expect(videoCall).toBeDefined();
        expect(videoCall!.patch['video']).toEqual({ settings: { bitrate: 8000000 }, fit: true });
    });

    it('migrates a USB-serial short video key (no displayId) to the correct udid', async () => {
        ls.setItem('WebCodecsPlayer:ABCD1234:1080x2400', JSON.stringify({ bitrate: 4000000 }));

        await migrateLocalStorage(ls, sink);

        const videoCall = sink.devicePatches.find((p) => p.udid === 'ABCD1234');
        expect(videoCall).toBeDefined();
        expect(videoCall!.patch['video']).toEqual({ settings: { bitrate: 4000000 } });
    });

    it('collapses multiple viewport entries for the same udid into one video scope', async () => {
        ls.setItem('WebCodecsPlayer:ABCD1234:1080x2400', JSON.stringify({ bitrate: 4000000 }));
        ls.setItem('WebCodecsPlayer:ABCD1234:720x1600', JSON.stringify({ bitrate: 2000000 }));

        await migrateLocalStorage(ls, sink);

        const videoCalls = sink.devicePatches.filter((p) => p.udid === 'ABCD1234' && p.patch['video'] !== undefined);
        expect(videoCalls).toHaveLength(1);
    });

    it('combines audio and video for the same udid into a single patchDevice call', async () => {
        ls.setItem('ws-scrcpy-web:audio:ABCD1234', JSON.stringify({ enabled: true, source: 'output', codec: 'opus' }));
        ls.setItem('WebCodecsPlayer:ABCD1234:1080x2400', JSON.stringify({ bitrate: 4000000 }));

        await migrateLocalStorage(ls, sink);

        const calls = sink.devicePatches.filter((p) => p.udid === 'ABCD1234');
        expect(calls).toHaveLength(1);
        expect(calls[0]!.patch['audio']).toBeDefined();
        expect(calls[0]!.patch['video']).toBeDefined();
    });

    it('clears audio and video keys after migration', async () => {
        ls.setItem('ws-scrcpy-web:audio:ABCD1234', JSON.stringify({ enabled: true, source: 'output', codec: 'opus' }));
        ls.setItem('WebCodecsPlayer:ABCD1234:1080x2400', JSON.stringify({ bitrate: 4000000 }));

        await migrateLocalStorage(ls, sink);

        expect(ls.getItem('ws-scrcpy-web:audio:ABCD1234')).toBeNull();
        expect(ls.getItem('WebCodecsPlayer:ABCD1234:1080x2400')).toBeNull();
    });

    it('does not send a global patch when no global prefs are present', async () => {
        ls.setItem('ws-scrcpy-web:audio:ABCD1234', JSON.stringify({ enabled: true, source: 'output', codec: 'opus' }));

        await migrateLocalStorage(ls, sink);

        expect(sink.globalPatches).toHaveLength(0);
    });

    it('parses iconSize as a number (not a string)', async () => {
        ls.setItem(LEGACY_KEYS.iconSize, '28');

        await migrateLocalStorage(ls, sink);

        expect(sink.globalPatches[0]?.['iconSize']).toBe(28);
        expect(typeof sink.globalPatches[0]?.['iconSize']).toBe('number');
    });
});

describe('migrateLocalStorage — no-op when already migrated', () => {
    it('returns immediately when the migrated flag is set', async () => {
        const ls = new MemStorage();
        ls.setItem(LEGACY_KEYS.migratedFlag, '1');
        ls.setItem(LEGACY_KEYS.theme, 'dark');
        const sink = makeSink();

        await migrateLocalStorage(ls, sink);

        expect(sink.globalPatches).toHaveLength(0);
        expect(sink.devicePatches).toHaveLength(0);
        // legacy key is NOT cleared (we bailed early)
        expect(ls.getItem(LEGACY_KEYS.theme)).toBe('dark');
    });
});

describe('migrateLocalStorage — resilience', () => {
    it('skips malformed scanSubnets JSON without throwing', async () => {
        const ls = new MemStorage();
        ls.setItem(LEGACY_KEYS.scanSubnets, 'not-valid-json');
        const sink = makeSink();

        await expect(migrateLocalStorage(ls, sink)).resolves.not.toThrow();
        expect(sink.globalPatches).toHaveLength(0);
    });

    it('skips malformed audio JSON without throwing', async () => {
        const ls = new MemStorage();
        ls.setItem('ws-scrcpy-web:audio:ABCD1234', 'corrupted');
        const sink = makeSink();

        await expect(migrateLocalStorage(ls, sink)).resolves.not.toThrow();
        expect(sink.devicePatches).toHaveLength(0);
    });

    it('skips a video key with an unrecognizable shape (no WxH suffix)', async () => {
        const ls = new MemStorage();
        ls.setItem('WebCodecsPlayer:somekey', JSON.stringify({ bitrate: 1000 }));
        const sink = makeSink();

        await expect(migrateLocalStorage(ls, sink)).resolves.not.toThrow();
        expect(sink.devicePatches).toHaveLength(0);
    });

    it('does not clear legacy keys or set the migrated flag when patchGlobal throws', async () => {
        const ls = new MemStorage();
        ls.setItem(LEGACY_KEYS.theme, 'dark');
        const failSink: SettingsSink = {
            async patchGlobal() {
                throw new Error('network failure');
            },
            async patchDevice() {
                // no-op
            },
        };

        await expect(migrateLocalStorage(ls, failSink)).rejects.toThrow('network failure');

        expect(ls.getItem(LEGACY_KEYS.theme)).toBe('dark');
        expect(ls.getItem(LEGACY_KEYS.migratedFlag)).toBeNull();
    });
});
