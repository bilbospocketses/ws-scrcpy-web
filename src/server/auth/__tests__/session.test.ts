import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrations';
import { hashToken, SessionStore } from '../session';

let db: DatabaseSync;
let store: SessionStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new SessionStore(db);
});

describe('SessionStore', () => {
    it('mints a token, stores only its hash, and validates it', () => {
        const token = store.create(1, 1000, 60_000);
        const stored = db.prepare('SELECT token_hash, user_id FROM sessions').get() as {
            token_hash: string;
            user_id: number;
        };
        expect(stored.token_hash).toBe(hashToken(token));
        expect(stored.token_hash).not.toBe(token); // raw token never stored
        expect(store.findValid(token, 2000)?.userId).toBe(1);
    });

    it('rejects + deletes an expired session', () => {
        const token = store.create(1, 0, 1000);
        expect(store.findValid(token, 1001)).toBeUndefined();
        expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    });

    it('slides the expiry on use', () => {
        const token = store.create(1, 0, 1000);
        store.findValid(token, 500); // slides to 500 + ttl
        const row = db.prepare('SELECT expires_at FROM sessions').get() as { expires_at: number };
        expect(row.expires_at).toBeGreaterThan(1000);
    });

    it('deletes by token and by user', () => {
        const t1 = store.create(1, 0, 10_000);
        store.create(1, 0, 10_000);
        store.delete(t1);
        expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1);
        store.deleteForUser(1);
        expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    });
});
