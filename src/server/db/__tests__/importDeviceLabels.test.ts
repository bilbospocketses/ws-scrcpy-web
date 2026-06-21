import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { DeviceStore } from '../DeviceStore';
import { importDeviceLabels } from '../import/importDeviceLabels';
import { IMPLICIT_ADMIN_ID } from '../constants';

let db: DatabaseSync;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
});

describe('importDeviceLabels', () => {
    it('imports labels for the implicit admin and seeds devices', () => {
        importDeviceLabels(db, { S1: 'Living Room', S2: 'Office' });
        const ds = new DeviceStore(db);
        expect(ds.getAllLabels(IMPLICIT_ADMIN_ID)).toEqual({ S1: 'Living Room', S2: 'Office' });
        expect(ds.getDevice('S1')?.serial).toBe('S1');
        expect(ds.listDevices().length).toBe(2);
    });
});
