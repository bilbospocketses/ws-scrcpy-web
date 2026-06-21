import type { DatabaseSync } from 'node:sqlite';
import { migration001 } from './migrations/001_initial';

export interface Migration {
    version: number;
    up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [migration001];

export function runMigrations(db: DatabaseSync): void {
    const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > MIGRATIONS.length) {
        throw new Error(
            `wsscrcpy.db schema v${current} is newer than supported v${MIGRATIONS.length}; ` +
                `refusing to run (downgrade unsupported).`,
        );
    }
    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        db.exec('BEGIN');
        try {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`); // m.version is a trusted integer literal
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }
}
