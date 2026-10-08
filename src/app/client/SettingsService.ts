async function ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`settings request failed: HTTP ${res.status}`);
    return res;
}

/**
 * Tries a device-settings request gets while the server answers 503 (M11 fix
 * 1): the device on the transport has not reported its serial yet, and the
 * server will not file the device's settings under the transport meanwhile.
 * Each wait follows `Retry-After`, capped at `DEVICE_RETRY_CAP_MS`.
 */
export const DEVICE_SETTINGS_ATTEMPTS = 4;
const DEVICE_RETRY_DEFAULT_MS = 1000;
const DEVICE_RETRY_CAP_MS = 5000;

function retryAfterMs(res: Response): number {
    const raw = res.headers?.get?.('Retry-After');
    const seconds = raw == null ? Number.NaN : Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return DEVICE_RETRY_DEFAULT_MS;
    return Math.min(seconds * 1000, DEVICE_RETRY_CAP_MS);
}

/**
 * A device-settings request, retried while the server answers 503 and at most
 * `DEVICE_SETTINGS_ATTEMPTS` times. Every retry is logged, and the last 503 is
 * thrown with what it means, so a setting that could not be saved is never
 * dropped in silence.
 */
async function deviceRequest(key: string, init?: RequestInit): Promise<Response> {
    const url = `/api/settings/device?udid=${encodeURIComponent(key)}`;
    for (let attempt = 1; ; attempt++) {
        const res = await fetch(url, init);
        if (res.status !== 503) return ok(res);
        if (attempt >= DEVICE_SETTINGS_ATTEMPTS) {
            throw new Error(
                `device settings for ${key} are unavailable: the device has not reported its serial ` +
                    `(HTTP 503 after ${attempt} attempts)`,
            );
        }
        const wait = retryAfterMs(res);
        console.warn('[SettingsService] device settings not ready (serial not read yet); retrying', {
            key,
            retry: attempt,
            of: DEVICE_SETTINGS_ATTEMPTS - 1,
            waitMs: wait,
        });
        await new Promise((r) => setTimeout(r, wait));
    }
}

// Shape stored under device scope 'video'.
export interface StoredVideo {
    settings?: Record<string, unknown> | undefined; // raw VideoSettings JSON
    fit?: boolean | undefined;
}

// Scope 'audio' is typed as Record<string,unknown> at the service boundary to
// keep this module dependency-light (avoids importing AudioSettingsStore which
// would create a cycle). Callers validate the shape before use.

export class SettingsService {
    private globalCache: Record<string, unknown> | null = null;
    // null  = not hydrated yet → sync accessors fall back to defaults
    // object = hydrated (may be {} for a fresh device)
    private readonly deviceCache = new Map<string, Record<string, unknown>>();
    // Deduplicates concurrent hydrateDevice() calls for the same udid so only
    // one GET is issued even if multiple callers race before the first resolves.
    private readonly pendingHydrations = new Map<string, Promise<void>>();
    // adb transport udid -> the device's real serial (M11). Stream settings are
    // keyed by the serial, so one device keeps one set across USB, Wi-Fi and IP
    // changes; every device accessor below maps its udid through `keyFor`.
    private readonly serialByUdid = new Map<string, string>();

    /**
     * Record that the device on transport `udid` has serial `serial`, so its
     * settings are read and written under the serial. The device list calls
     * this for every descriptor. An empty serial (not read yet) drops the
     * binding, so a transport address DHCP has handed to another device never
     * reads the previous device's settings. An unbound udid is used as it is:
     * the server resolves a transport it has read a serial on (a stream opened
     * from a direct link).
     */
    bindSerial(udid: string, serial: string): void {
        if (serial) this.serialByUdid.set(udid, serial);
        else this.serialByUdid.delete(udid);
    }

    private keyFor(udid: string): string {
        return this.serialByUdid.get(udid) ?? udid;
    }

    // ── existing async surface (keys mapped through keyFor since M11) ──

    async loadGlobal(): Promise<Record<string, unknown>> {
        if (!this.globalCache) {
            const res = await ok(await fetch('/api/settings'));
            this.globalCache = (await res.json()) as Record<string, unknown>;
        }
        return this.globalCache;
    }

    async patchGlobal(patch: Record<string, unknown>): Promise<void> {
        const res = await ok(
            await fetch('/api/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch),
            }),
        );
        this.globalCache = (await res.json()) as Record<string, unknown>;
    }

    async getDevice(udid: string): Promise<Record<string, unknown>> {
        return this.fetchDevice(this.keyFor(udid));
    }

    async patchDevice(udid: string, patch: Record<string, unknown>): Promise<void> {
        return this.sendDevicePatch(this.keyFor(udid), patch);
    }

    private async fetchDevice(key: string): Promise<Record<string, unknown>> {
        const res = await deviceRequest(key);
        return (await res.json()) as Record<string, unknown>;
    }

    private async sendDevicePatch(key: string, patch: Record<string, unknown>): Promise<void> {
        await deviceRequest(key, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
        });
    }

    async reset(): Promise<void> {
        await ok(await fetch('/api/settings/reset', { method: 'POST' }));
    }

    // ── NEW: synchronous global accessor (read-after-loadGlobal) ──

    /** Returns the cached global object, or {} if loadGlobal() has not resolved yet. */
    getGlobalCached(): Record<string, unknown> {
        return this.globalCache ?? {};
    }

    // ── NEW: device hydration + sync scoped accessors ──

    /**
     * Hydrate the per-device cache for the given udid. Idempotent: the first
     * hydrate is authoritative. A later re-GET could return a stale value and
     * clobber a setting the user just wrote (whose fire-and-forget PATCH may not
     * have landed yet). Sequential re-calls are no-ops; concurrent calls for the
     * same udid share one in-flight GET rather than issuing duplicates.
     */
    async hydrateDevice(udid: string): Promise<void> {
        const key = this.keyFor(udid);
        if (this.deviceCache.has(key)) return; // once-guard: first hydrate wins
        const inflight = this.pendingHydrations.get(key);
        if (inflight) return inflight; // concurrent caller — share the same GET
        const p = this.fetchDevice(key)
            .then((v) => {
                this.deviceCache.set(key, v);
            })
            .finally(() => {
                this.pendingHydrations.delete(key);
            });
        this.pendingHydrations.set(key, p);
        return p;
    }

    /**
     * Returns the stored video settings for the udid, or undefined when:
     * (a) the udid has never been hydrated, or (b) it was hydrated but the
     * 'video' scope is absent. Callers treat undefined as "no stored value"
     * and fall back to their existing default path.
     */
    getDeviceVideo(udid: string): StoredVideo | undefined {
        return this.deviceCache.get(this.keyFor(udid))?.['video'] as StoredVideo | undefined;
    }

    /**
     * Returns the stored audio settings for the udid, or undefined on miss.
     * Typed as Record<string,unknown> — callers (AudioSettingsStore) validate
     * the shape via isValidStored before use.
     */
    getDeviceAudio(udid: string): Record<string, unknown> | undefined {
        return this.deviceCache.get(this.keyFor(udid))?.['audio'] as Record<string, unknown> | undefined;
    }

    /**
     * Write-through: update the sync cache immediately, then fire-and-forget the
     * PATCH. Cache update is unconditional so a subsequent sync read reflects the
     * write even if the network is slow/offline. PATCH errors are logged, never
     * thrown (callers are sync/void).
     */
    setDeviceVideo(udid: string, video: StoredVideo): void {
        const key = this.keyFor(udid);
        const cur = this.deviceCache.get(key) ?? {};
        cur['video'] = video;
        this.deviceCache.set(key, cur);
        void this.sendDevicePatch(key, { video }).catch((e) =>
            console.error('[SettingsService] setDeviceVideo PATCH failed', e),
        );
    }

    /**
     * Write-through: update the sync cache immediately, then fire-and-forget the
     * PATCH. Cache update is unconditional so a subsequent sync read reflects the
     * write even if the network is slow/offline. PATCH errors are logged, never
     * thrown (callers are sync/void).
     */
    setDeviceAudio(udid: string, audio: Record<string, unknown>): void {
        const key = this.keyFor(udid);
        const cur = this.deviceCache.get(key) ?? {};
        cur['audio'] = audio;
        this.deviceCache.set(key, cur);
        void this.sendDevicePatch(key, { audio }).catch((e) =>
            console.error('[SettingsService] setDeviceAudio PATCH failed', e),
        );
    }
}

// Singleton — every call site imports THIS so caches are
// shared. A module singleton (rather than DI) is required because BasePlayer's
// static methods have no `this`-instance to thread a service reference through.
export const settingsService = new SettingsService();
