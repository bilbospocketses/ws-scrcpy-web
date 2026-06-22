import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations';
import { UserStore } from '../UserStore';

let db: DatabaseSync;
let store: UserStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new UserStore(db);
});

describe('UserStore auth methods', () => {
    it('sets password/role/disabled/username/lastLogin', () => {
        store.setPasswordHash(1, 'scrypt$...');
        store.setUsername(1, 'owner');
        store.setRole(1, 'admin');
        store.setDisabled(1, true);
        store.setLastLogin(1, 999);
        const u = store.getById(1)!;
        expect(u).toMatchObject({ username: 'owner', passwordHash: 'scrypt$...', disabled: true, lastLoginAt: 999 });
    });
    it('counts enabled admins and enabled-admins-with-password', () => {
        expect(store.countEnabledAdmins()).toBe(1); // seeded admin, no pw
        expect(store.countEnabledAdminsWithPassword()).toBe(0);
        store.setPasswordHash(1, 'scrypt$...');
        expect(store.countEnabledAdminsWithPassword()).toBe(1);
        store.setDisabled(1, true);
        expect(store.countEnabledAdmins()).toBe(0);
    });
    it('persists and clears lockout state', () => {
        store.setLockout(1, { failedAttempts: 5, lockoutWindowStart: 10, lockedUntil: 9000 });
        expect(store.getById(1)).toMatchObject({ failedAttempts: 5, lockedUntil: 9000 });
        store.clearLockout(1);
        expect(store.getById(1)).toMatchObject({ failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null });
    });
    it('deletes a user', () => {
        const u = store.create({ username: 'bob', role: 'user', passwordHash: null });
        store.delete(u.id);
        expect(store.getById(u.id)).toBeUndefined();
    });
});
