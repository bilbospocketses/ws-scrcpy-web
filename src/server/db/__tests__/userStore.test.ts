import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations';
import { type User, UserStore } from '../UserStore';

let db: DatabaseSync;
let store: UserStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new UserStore(db);
});

describe('UserStore', () => {
    it('reads the seeded implicit admin by id and username (case-insensitive)', () => {
        const a = store.getById(1) as User;
        expect(a).toMatchObject({ id: 1, username: 'admin', role: 'admin', passwordHash: null, disabled: false });
        expect(store.getByUsername('ADMIN')?.id).toBe(1);
    });

    it('creates a user and lists all', () => {
        const u = store.create({ username: 'bob', role: 'user', passwordHash: 'scrypt$...' });
        expect(u).toMatchObject({ username: 'bob', role: 'user', disabled: false });
        expect(
            store
                .list()
                .map((x) => x.username)
                .sort(),
        ).toEqual(['admin', 'bob']);
    });

    it('rejects a duplicate username (case-insensitive)', () => {
        store.create({ username: 'bob', role: 'user', passwordHash: null });
        expect(() => store.create({ username: 'BOB', role: 'user', passwordHash: null })).toThrow();
    });
});
