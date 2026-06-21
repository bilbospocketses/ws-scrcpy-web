import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations';

function tables(db: DatabaseSync): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
}

describe('migration 001', () => {
    it('creates every v1 table', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        for (const t of [
            'users',
            'sessions',
            'user_settings',
            'devices',
            'device_labels',
            'device_settings',
            'app_settings',
        ]) {
            expect(tables(db)).toContain(t);
        }
    });

    it('seeds the implicit admin (id 1, role admin, no password) and authEnabled=false', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        const admin = db
            .prepare('SELECT id, username, role, password_hash, disabled FROM users WHERE id = 1')
            .get() as {
            id: number;
            username: string;
            role: string;
            password_hash: string | null;
            disabled: number;
        };
        expect(admin).toMatchObject({ id: 1, role: 'admin', password_hash: null, disabled: 0 });
        const flag = db.prepare("SELECT value FROM app_settings WHERE key = 'authEnabled'").get() as { value: string };
        expect(flag.value).toBe('false');
    });

    it('enforces the role CHECK constraint', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        expect(() => db.exec("INSERT INTO users (username, role, created_at) VALUES ('x', 'superuser', 0)")).toThrow();
    });
});
