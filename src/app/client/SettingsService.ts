import type { SettingsSink } from './migrateLocalStorage';

async function ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`settings request failed: HTTP ${res.status}`);
    return res;
}

export class SettingsService implements SettingsSink {
    private globalCache: Record<string, unknown> | null = null;

    async loadGlobal(): Promise<Record<string, unknown>> {
        if (!this.globalCache) {
            const res = await ok(await fetch('/api/settings'));
            this.globalCache = (await res.json()) as Record<string, unknown>;
        }
        return this.globalCache;
    }

    async patchGlobal(patch: Record<string, unknown>): Promise<void> {
        await ok(
            await fetch('/api/settings', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(patch),
            }),
        );
        this.globalCache = { ...(this.globalCache ?? {}), ...patch };
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
}
