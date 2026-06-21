import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, MIGRATIONS } from '../migrations';

function userVersion(db: DatabaseSync): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('runMigrations', () => {
    it('applies all migrations once and is idempotent on re-run', () => {
        const db = new DatabaseSync(':memory:');
        runMigrations(db);
        expect(userVersion(db)).toBe(MIGRATIONS.length);
        // Re-run: no throw, version unchanged, tables still present (no double-create).
        runMigrations(db);
        expect(userVersion(db)).toBe(MIGRATIONS.length);
    });

    it('refuses a database newer than the binary supports', () => {
        const db = new DatabaseSync(':memory:');
        db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
        expect(() => runMigrations(db)).toThrow(/newer than supported/);
    });
});
