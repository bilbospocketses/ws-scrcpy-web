import type { DatabaseSync } from 'node:sqlite';

export class AppSettingsStore {
    constructor(private readonly db: DatabaseSync) {}

    get(key: string): unknown {
        const r = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }

    getAll(): Record<string, unknown> {
        const rows = this.db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.key] = JSON.parse(r.value);
        return out;
    }

    set(key: string, value: unknown): void {
        this.db
            .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, JSON.stringify(value));
    }
}
