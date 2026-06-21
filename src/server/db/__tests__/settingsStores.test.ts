import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { UserSettingsStore } from '../UserSettingsStore';
import { AppSettingsStore } from '../AppSettingsStore';
import { UserStore } from '../UserStore';

let db: DatabaseSync;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
});

describe('UserSettingsStore', () => {
    it('round-trips JSON values and isolates users', () => {
        const us = new UserStore(db);
        const bob = us.create({ username: 'bob', role: 'user', passwordHash: null });
        const s = new UserSettingsStore(db);
        s.set(1, 'theme', 'dark');
        s.set(bob.id, 'theme', 'light');
        s.set(1, 'scanSubnets', ['10.0.0.0/24']);
        expect(s.get(1, 'theme')).toBe('dark');
        expect(s.get(bob.id, 'theme')).toBe('light');
        expect(s.get(1, 'scanSubnets')).toEqual(['10.0.0.0/24']);
        expect(s.get(1, 'missing')).toBeUndefined();
        expect(s.getAll(1)).toEqual({ theme: 'dark', scanSubnets: ['10.0.0.0/24'] });
    });

    it('delete and clearForUser remove only that user rows', () => {
        const s = new UserSettingsStore(db);
        const us = new UserStore(db);
        const bob = us.create({ username: 'bob', role: 'user', passwordHash: null });
        s.set(1, 'a', 1);
        s.set(1, 'b', 2);
        s.set(bob.id, 'a', 9);
        s.delete(1, 'a');
        expect(s.get(1, 'a')).toBeUndefined();
        s.clearForUser(1);
        expect(s.getAll(1)).toEqual({});
        expect(s.get(bob.id, 'a')).toBe(9);
    });
});

describe('AppSettingsStore', () => {
    it('round-trips and upserts global values', () => {
        const a = new AppSettingsStore(db);
        a.set('autoUpdate', true);
        a.set('channel', 'beta');
        a.set('channel', 'stable'); // upsert
        expect(a.get('autoUpdate')).toBe(true);
        expect(a.get('channel')).toBe('stable');
        expect(a.getAll()).toMatchObject({ authEnabled: false, autoUpdate: true, channel: 'stable' });
    });
});
