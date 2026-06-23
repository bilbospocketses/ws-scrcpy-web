import type { SettingsSink } from './migrateLocalStorage';

async function ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`settings request failed: HTTP ${res.status}`);
    return res;
}

// Shape stored under device scope 'video' (mirrors what the migration writes).
export interface StoredVideo {
    settings?: Record<string, unknown> | undefined; // raw VideoSettings JSON
    fit?: boolean | undefined;
}

// Scope 'audio' is typed as Record<string,unknown> at the service boundary to
// keep this module dependency-light (avoids importing AudioSettingsStore which
// would create a cycle). Callers validate the shape before use.

export class SettingsService implements SettingsSink {
    private globalCache: Record<string, unknown> | null = null;
    // null  = not hydrated yet → sync accessors fall back to defaults
    // object = hydrated (may be {} for a fresh device)
    private readonly deviceCache = new Map<string, Record<string, unknown>>();
    // Deduplicates concurrent hydrateDevice() calls for the same udid so only
    // one GET is issued even if multiple callers race before the first resolves.
    private readonly pendingHydrations = new Map<string, Promise<void>>();

    // ── existing async surface (UNCHANGED) ──

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
        const res = await ok(await fetch(`/api/settings/device?udid=${encodeURIComponent(udid)}`));
        return (await res.json()) as Record<string, unknown>;
    }

    async patchDevice(udid: string, patch: Record<string, unknown>): Promise<void> {
        await ok(
            await fetch(`/api/settings/device?udid=${encodeURIComponent(udid)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch),
            }),
        );
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
        if (this.deviceCache.has(udid)) return; // once-guard: first hydrate wins
        const inflight = this.pendingHydrations.get(udid);
        if (inflight) return inflight; // concurrent caller — share the same GET
        const p = this.getDevice(udid)
            .then((v) => {
                this.deviceCache.set(udid, v);
            })
            .finally(() => {
                this.pendingHydrations.delete(udid);
            });
        this.pendingHydrations.set(udid, p);
        return p;
    }

    /**
     * Returns the stored video settings for the udid, or undefined when:
     * (a) the udid has never been hydrated, or (b) it was hydrated but the
     * 'video' scope is absent. Callers treat undefined as "no stored value"
     * and fall back to their existing default path.
     */
    getDeviceVideo(udid: string): StoredVideo | undefined {
        return this.deviceCache.get(udid)?.['video'] as StoredVideo | undefined;
    }

    /**
     * Returns the stored audio settings for the udid, or undefined on miss.
     * Typed as Record<string,unknown> — callers (AudioSettingsStore) validate
     * the shape via isValidStored before use.
     */
    getDeviceAudio(udid: string): Record<string, unknown> | undefined {
        return this.deviceCache.get(udid)?.['audio'] as Record<string, unknown> | undefined;
    }

    /**
     * Write-through: update the sync cache immediately, then fire-and-forget the
     * PATCH. Cache update is unconditional so a subsequent sync read reflects the
     * write even if the network is slow/offline. PATCH errors are logged, never
     * thrown (callers are sync/void).
     */
    setDeviceVideo(udid: string, video: StoredVideo): void {
        const cur = this.deviceCache.get(udid) ?? {};
        cur['video'] = video;
        this.deviceCache.set(udid, cur);
        void this.patchDevice(udid, { video }).catch((e) =>
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
        const cur = this.deviceCache.get(udid) ?? {};
        cur['audio'] = audio;
        this.deviceCache.set(udid, cur);
        void this.patchDevice(udid, { audio }).catch((e) =>
            console.error('[SettingsService] setDeviceAudio PATCH failed', e),
        );
    }
}

// Singleton — the boot migration AND every call site import THIS so caches are
// shared. A module singleton (rather than DI) is required because BasePlayer's
// static methods have no `this`-instance to thread a service reference through.
export const settingsService = new SettingsService();
