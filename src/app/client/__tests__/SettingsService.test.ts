// Tests for the new SettingsService singleton, sync accessors, and write-through cache.
// Uses a fetch stub injected via vi.stubGlobal to avoid real network calls.

import { afterEach, describe, expect, it, vi } from 'vitest';

// We import the class (not the singleton) so each test can instantiate fresh.
// The singleton export is tested separately in the singleton test below.
import { SettingsService } from '../SettingsService';
import type { StoredVideo } from '../SettingsService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

function makeFetchStub(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
    return vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// getGlobalCached
// ---------------------------------------------------------------------------

describe('SettingsService.getGlobalCached()', () => {
    it('returns {} before loadGlobal() has been called', () => {
        const svc = new SettingsService();
        expect(svc.getGlobalCached()).toEqual({});
    });

    it('returns the cached object after loadGlobal() resolves', async () => {
        const svc = new SettingsService();
        const stub = makeFetchStub(() => makeOkResponse({ iconSize: 24, scanSubnets: ['10.0.0.0/24'] }));
        vi.stubGlobal('fetch', stub);
        await svc.loadGlobal();
        expect(svc.getGlobalCached()).toEqual({ iconSize: 24, scanSubnets: ['10.0.0.0/24'] });
    });

    it('returns the same object reference for repeated calls (no clone)', async () => {
        const svc = new SettingsService();
        vi.stubGlobal('fetch', makeFetchStub(() => makeOkResponse({ theme: 'dark' })));
        await svc.loadGlobal();
        expect(svc.getGlobalCached()).toBe(svc.getGlobalCached());
    });
});

// ---------------------------------------------------------------------------
// hydrateDevice — once-guard + concurrent dedup (Adjustment 1 + review fix)
// ---------------------------------------------------------------------------

describe('SettingsService.hydrateDevice() — once-guard', () => {
    it('fetches device settings on first call', async () => {
        const svc = new SettingsService();
        const stub = makeFetchStub(() => makeOkResponse({ audio: { enabled: true } }));
        vi.stubGlobal('fetch', stub);

        await svc.hydrateDevice('udid-1');

        expect(stub).toHaveBeenCalledOnce();
    });

    it('does NOT issue a second GET when called again with the same udid (sequential)', async () => {
        const svc = new SettingsService();
        const stub = makeFetchStub(() => makeOkResponse({ video: { fit: true } }));
        vi.stubGlobal('fetch', stub);

        await svc.hydrateDevice('udid-2');
        await svc.hydrateDevice('udid-2'); // second call — should be a no-op

        // Only 1 fetch for the GET, not 2.
        expect(stub).toHaveBeenCalledOnce();
    });

    it('does NOT issue a second GET for concurrent calls with the same udid', async () => {
        const svc = new SettingsService();
        let getCount = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                getCount++;
                return Promise.resolve(makeOkResponse({}));
            }),
        );

        // Fire both without awaiting in between — true concurrent callers.
        await Promise.all([svc.hydrateDevice('udid-c'), svc.hydrateDevice('udid-c')]);

        expect(getCount).toBe(1); // one GET, not two
    });

    it('hydrates different udids independently', async () => {
        const svc = new SettingsService();
        let callCount = 0;
        const stub = makeFetchStub(() => {
            callCount++;
            return makeOkResponse({});
        });
        vi.stubGlobal('fetch', stub);

        await svc.hydrateDevice('udid-a');
        await svc.hydrateDevice('udid-b');
        await svc.hydrateDevice('udid-a'); // cached — no extra fetch

        expect(callCount).toBe(2); // one GET per udid
    });
});

// ---------------------------------------------------------------------------
// getDeviceVideo / getDeviceAudio — before and after hydration
// ---------------------------------------------------------------------------

describe('SettingsService.getDeviceVideo/Audio()', () => {
    it('returns undefined for unhydrated udid', () => {
        const svc = new SettingsService();
        expect(svc.getDeviceVideo('udid-x')).toBeUndefined();
        expect(svc.getDeviceAudio('udid-x')).toBeUndefined();
    });

    it('returns undefined when hydrated but scope is absent', async () => {
        const svc = new SettingsService();
        vi.stubGlobal('fetch', makeFetchStub(() => makeOkResponse({}))); // no video / no audio
        await svc.hydrateDevice('udid-y');

        expect(svc.getDeviceVideo('udid-y')).toBeUndefined();
        expect(svc.getDeviceAudio('udid-y')).toBeUndefined();
    });

    it('returns stored video after hydration', async () => {
        const svc = new SettingsService();
        const videoData: StoredVideo = { settings: { bitRate: 4000000 }, fit: false };
        vi.stubGlobal('fetch', makeFetchStub(() => makeOkResponse({ video: videoData })));

        await svc.hydrateDevice('udid-v');
        const result = svc.getDeviceVideo('udid-v');
        expect(result).toEqual(videoData);
    });

    it('returns stored audio after hydration', async () => {
        const svc = new SettingsService();
        const audioData = { enabled: true, source: 'output', codec: 'aac' };
        vi.stubGlobal('fetch', makeFetchStub(() => makeOkResponse({ audio: audioData })));

        await svc.hydrateDevice('udid-a2');
        const result = svc.getDeviceAudio('udid-a2');
        expect(result).toEqual(audioData);
    });
});

// ---------------------------------------------------------------------------
// setDeviceVideo / setDeviceAudio — sync cache update + fire-and-forget PATCH
// ---------------------------------------------------------------------------

describe('SettingsService.setDeviceVideo()', () => {
    it('updates the sync cache immediately so getDeviceVideo reflects the write', async () => {
        const svc = new SettingsService();
        // Hydrate with empty device settings first
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(makeOkResponse({}))),
        );

        await svc.hydrateDevice('udid-sv');
        const video: StoredVideo = { settings: { bitRate: 8000000 }, fit: true };
        svc.setDeviceVideo('udid-sv', video);

        // Sync cache update must be visible immediately (before any await)
        expect(svc.getDeviceVideo('udid-sv')).toEqual(video);
    });

    it('calls patchDevice with the new video value', async () => {
        const svc = new SettingsService();
        const patchBodies: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.method === 'PATCH') {
                    patchBodies.push(init.body as string);
                }
                return Promise.resolve(makeOkResponse({}));
            }),
        );

        await svc.hydrateDevice('udid-sv2');
        const video: StoredVideo = { fit: true };
        svc.setDeviceVideo('udid-sv2', video);

        // Flush the microtask queue so the fire-and-forget PATCH resolves
        await new Promise((r) => setTimeout(r, 0));

        expect(patchBodies).toHaveLength(1);
        const body = JSON.parse(patchBodies[0]!) as Record<string, unknown>;
        expect(body).toMatchObject({ video });
    });

    it('swallows a rejected patchDevice — does not throw', async () => {
        const svc = new SettingsService();
        let patchCallCount = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.method === 'PATCH') {
                    patchCallCount++;
                    // Reject the PATCH
                    return Promise.reject(new Error('network error'));
                }
                return Promise.resolve(makeOkResponse({}));
            }),
        );
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await svc.hydrateDevice('udid-sw');
        // Must not throw even though patchDevice will reject
        expect(() => svc.setDeviceVideo('udid-sw', { fit: false })).not.toThrow();

        // Wait for the background promise to settle
        await new Promise((r) => setTimeout(r, 0));

        expect(patchCallCount).toBe(1);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});

describe('SettingsService.setDeviceAudio()', () => {
    it('updates the sync cache immediately so getDeviceAudio reflects the write', async () => {
        const svc = new SettingsService();
        vi.stubGlobal('fetch', makeFetchStub(() => makeOkResponse({})));

        await svc.hydrateDevice('udid-sa');
        const audio = { enabled: true, source: 'mic', codec: 'opus' };
        svc.setDeviceAudio('udid-sa', audio);

        expect(svc.getDeviceAudio('udid-sa')).toEqual(audio);
    });

    it('calls patchDevice with the new audio value', async () => {
        const svc = new SettingsService();
        const patchBodies: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.method === 'PATCH') {
                    patchBodies.push(init.body as string);
                }
                return Promise.resolve(makeOkResponse({}));
            }),
        );

        await svc.hydrateDevice('udid-sa2');
        const audio = { enabled: false, source: 'output', codec: 'aac' };
        svc.setDeviceAudio('udid-sa2', audio);

        await new Promise((r) => setTimeout(r, 0));

        expect(patchBodies).toHaveLength(1);
        const body = JSON.parse(patchBodies[0]!) as Record<string, unknown>;
        expect(body).toMatchObject({ audio });
    });

    it('swallows a rejected patchDevice — does not throw', async () => {
        const svc = new SettingsService();
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init?: RequestInit) => {
                if (init?.method === 'PATCH') {
                    return Promise.reject(new Error('network error'));
                }
                return Promise.resolve(makeOkResponse({}));
            }),
        );
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await svc.hydrateDevice('udid-sw2');
        expect(() => svc.setDeviceAudio('udid-sw2', { enabled: true })).not.toThrow();

        await new Promise((r) => setTimeout(r, 0));
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

describe('settingsService singleton', () => {
    it('is exported and is an instance of SettingsService', async () => {
        const { settingsService } = await import('../SettingsService');
        expect(settingsService).toBeInstanceOf(SettingsService);
    });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
