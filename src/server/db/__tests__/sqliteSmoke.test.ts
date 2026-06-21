import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

describe('node:sqlite smoke (verification spike)', () => {
    it('opens in-memory, execs DDL, prepares/run/get/all, reads pragmas', () => {
        const db = new DatabaseSync(':memory:');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

        const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
        const info = insert.run('alice');
        expect(Number(info.changes)).toBe(1);
        expect(Number(info.lastInsertRowid)).toBe(1);

        const one = db.prepare('SELECT * FROM t WHERE id = ?').get(1) as { id: number; name: string };
        expect(one).toEqual({ id: 1, name: 'alice' });

        insert.run('bob');
        const all = db.prepare('SELECT name FROM t ORDER BY id').all() as Array<{ name: string }>;
        expect(all.map((r) => r.name)).toEqual(['alice', 'bob']);

        const ver = db.prepare('PRAGMA user_version').get() as { user_version: number };
        expect(ver.user_version).toBe(0);
        db.exec('PRAGMA user_version = 3');
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);

        db.close();
    });
});
