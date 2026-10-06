import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore } from '../DeviceStore';
import { runMigrations } from '../migrations';
import { UserStore } from '../UserStore';

let db: DatabaseSync;
let store: DeviceStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new DeviceStore(db);
});

describe('DeviceStore observed devices', () => {
    it('upserts and reads observed metadata (partial fields preserved)', () => {
        store.upsertDevice({ serial: 'S1', model: 'Pixel 7', lastSeenAt: 100 });
        store.upsertDevice({ serial: 'S1', address: '10.0.0.5:5555', lastSeenAt: 200 });
        expect(store.getDevice('S1')).toEqual({
            serial: 'S1',
            manufacturer: null,
            model: 'Pixel 7',
            address: '10.0.0.5:5555',
            lastSeenAt: 200,
        });
        expect(store.listDevices().length).toBe(1);
    });

    it('claimAddress gives an address to one device at a time (row 19.5)', () => {
        // S1 once answered at the address, and has since been seen over USB,
        // which bumps its last_seen_at and keeps the old address.
        store.claimAddress('S1', '10.0.0.5:5555', 100);
        store.claimAddress('S2', '10.0.0.5:5555', 200);
        store.upsertDevice({ serial: 'S1', model: 'Pixel 7', lastSeenAt: 300 });

        expect(store.findByAddress('10.0.0.5:5555')?.serial).toBe('S2');
        expect(store.getDevice('S1')).toMatchObject({ address: null, model: 'Pixel 7' });
        expect(store.getDevice('S2')).toMatchObject({ address: '10.0.0.5:5555', lastSeenAt: 200 });
    });
});

describe('DeviceStore per-user labels', () => {
    it('sets/gets/deletes labels scoped per user', () => {
        // device_labels.user_id is an FK to users(id); create user 2 so the label
        // holds under foreign_keys=ON (the runtime opens with that pragma).
        new UserStore(db).create({ username: 'u2', role: 'user', passwordHash: null });
        store.setLabel(1, 'S1', 'Living Room');
        store.setLabel(2, 'S1', 'Office');
        expect(store.getLabel(1, 'S1')).toBe('Living Room');
        store.deleteLabel(1, 'S1');
        expect(store.getLabel(1, 'S1')).toBeUndefined();
        expect(store.getAllLabels(2)).toEqual({ S1: 'Office' });
    });
});
