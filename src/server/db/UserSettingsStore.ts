import type { DatabaseSync } from 'node:sqlite';

export class UserSettingsStore {
    constructor(private readonly db: DatabaseSync) {}

    get(userId: number, key: string): unknown {
        const r = this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as
            | { value: string }
            | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }

    getAll(userId: number): Record<string, unknown> {
        const rows = this.db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(userId) as Array<{
            key: string;
            value: string;
        }>;
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.key] = JSON.parse(r.value);
        return out;
    }

    set(userId: number, key: string, value: unknown): void {
        this.db
            .prepare(
                'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ' +
                    'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
            )
            .run(userId, key, JSON.stringify(value));
    }

    delete(userId: number, key: string): void {
        this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
    }

    clearForUser(userId: number): void {
        this.db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
    }
}
