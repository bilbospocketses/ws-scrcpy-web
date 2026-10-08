import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore } from '../DeviceStore';
import { runMigrations } from '../migrations';

// M11: one device, one row, one set of stream settings. The device tracker used
// to file what it saw under the adb TRANSPORT id (`<ip>:5555` for Wi-Fi), while
// connect filed the address and MAC under the real `ro.serialno`, so a Wi-Fi
// device had two half rows. Settings were keyed by the transport too, so USB
// and Wi-Fi had separate settings and an IP change lost them.

const SERIAL = 'R5CN30ABCDE';
const TRANSPORT = '10.0.0.5:5555';

let db: DatabaseSync;
let store: DeviceStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    db.prepare("INSERT INTO users (id, username, role, created_at) VALUES (2, 'second', 'user', 0)").run();
    store = new DeviceStore(db);
});

function rowCount(serial: string): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM devices WHERE serial = ?').get(serial) as { n: number }).n;
}

describe('DeviceStore.mergeDeviceInto (the transport row folds into the serial row)', () => {
    it('serial row values win where set, the transport row fills the gaps, and the transport row is deleted', () => {
        store.upsertDevice({ serial: TRANSPORT, manufacturer: 'Google', model: 'Old Model', lastSeenAt: 10 });
        store.upsertDevice({ serial: SERIAL, model: 'Pixel 7', lastSeenAt: 5 });

        store.mergeDeviceInto(TRANSPORT, SERIAL);

        expect(store.getDevice(SERIAL)).toMatchObject({ manufacturer: 'Google', model: 'Pixel 7' });
        expect(rowCount(TRANSPORT)).toBe(0);
    });

    it('takes the newer last_seen_at, whichever row holds it', () => {
        store.upsertDevice({ serial: TRANSPORT, lastSeenAt: 50 });
        store.upsertDevice({ serial: SERIAL, lastSeenAt: 20 });
        store.mergeDeviceInto(TRANSPORT, SERIAL);
        expect(store.getDevice(SERIAL)?.lastSeenAt).toBe(50);

        store.upsertDevice({ serial: TRANSPORT, lastSeenAt: 30 });
        store.mergeDeviceInto(TRANSPORT, SERIAL);
        expect(store.getDevice(SERIAL)?.lastSeenAt).toBe(50);
    });

    it('a missing last_seen_at on either side keeps the one that is set', () => {
        store.upsertDevice({ serial: TRANSPORT, model: 'X' });
        store.upsertDevice({ serial: SERIAL, lastSeenAt: 20 });
        store.mergeDeviceInto(TRANSPORT, SERIAL);
        expect(store.getDevice(SERIAL)?.lastSeenAt).toBe(20);

        store.upsertDevice({ serial: TRANSPORT, lastSeenAt: 40 });
        db.prepare('UPDATE devices SET last_seen_at = NULL WHERE serial = ?').run(SERIAL);
        store.mergeDeviceInto(TRANSPORT, SERIAL);
        expect(store.getDevice(SERIAL)?.lastSeenAt).toBe(40);
    });

    it('never nulls the serial row address or MAC', () => {
        store.claimAddress(SERIAL, '10.0.0.5:5555', 5);
        store.recordMac(SERIAL, 'aa:bb:cc:dd:ee:ff');
        store.upsertDevice({ serial: TRANSPORT, model: 'Pixel 7', lastSeenAt: 10 });

        store.mergeDeviceInto(TRANSPORT, SERIAL);

        expect(store.getDevice(SERIAL)?.address).toBe('10.0.0.5:5555');
        expect(store.getMac(SERIAL)).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('carries an address and MAC the serial row does not have yet', () => {
        store.upsertDevice({ serial: TRANSPORT, address: '10.0.0.9:5555' });
        store.recordMac(TRANSPORT, 'aa:bb:cc:dd:ee:ff');

        store.mergeDeviceInto(TRANSPORT, SERIAL);

        expect(store.getDevice(SERIAL)?.address).toBe('10.0.0.9:5555');
        expect(store.getMac(SERIAL)).toBe('aa:bb:cc:dd:ee:ff');
        expect(rowCount(TRANSPORT)).toBe(0);
    });

    it('does nothing when the two keys are the same (a USB transport is its serial)', () => {
        store.upsertDevice({ serial: SERIAL, model: 'Pixel 7', lastSeenAt: 5 });
        store.mergeDeviceInto(SERIAL, SERIAL);
        expect(store.getDevice(SERIAL)).toMatchObject({ model: 'Pixel 7', lastSeenAt: 5 });
    });

    it('an empty serial writes nothing', () => {
        store.upsertDevice({ serial: TRANSPORT, model: 'Pixel 7', lastSeenAt: 5 });
        store.mergeDeviceInto(TRANSPORT, '');
        expect(rowCount('')).toBe(0);
        expect(rowCount(TRANSPORT)).toBe(1);
    });
});

describe('DeviceStore.adoptTransportSettings (legacy transport-keyed stream settings)', () => {
    it('adopts the transport rows when the serial has none, and removes them from the transport', () => {
        store.setDeviceSetting(1, TRANSPORT, 'video', { fit: true });
        store.setDeviceSetting(1, TRANSPORT, 'audio', { source: 'mic' });

        store.adoptTransportSettings(TRANSPORT, SERIAL);

        expect(store.getDeviceSettings(1, SERIAL)).toEqual({ video: { fit: true }, audio: { source: 'mic' } });
        expect(store.getDeviceSettings(1, TRANSPORT)).toEqual({});
    });

    it('never overwrites a serial row: the serial set wins and the old rows stay where they are', () => {
        store.setDeviceSetting(1, SERIAL, 'video', { fit: false });
        store.setDeviceSetting(1, TRANSPORT, 'video', { fit: true });
        store.setDeviceSetting(1, TRANSPORT, 'audio', { source: 'mic' });

        store.adoptTransportSettings(TRANSPORT, SERIAL);

        expect(store.getDeviceSettings(1, SERIAL)).toEqual({ video: { fit: false } });
        expect(store.getDeviceSettings(1, TRANSPORT)).toEqual({ video: { fit: true }, audio: { source: 'mic' } });
    });

    it('decides per user', () => {
        store.setDeviceSetting(1, SERIAL, 'video', { fit: false });
        store.setDeviceSetting(1, TRANSPORT, 'video', { fit: true });
        store.setDeviceSetting(2, TRANSPORT, 'audio', { source: 'output' });

        store.adoptTransportSettings(TRANSPORT, SERIAL);

        expect(store.getDeviceSettings(1, SERIAL)).toEqual({ video: { fit: false } });
        expect(store.getDeviceSettings(2, SERIAL)).toEqual({ audio: { source: 'output' } });
        expect(store.getDeviceSettings(2, TRANSPORT)).toEqual({});
    });

    it('adopts once: a second legacy transport seen later does not replace the adopted set', () => {
        store.setDeviceSetting(1, TRANSPORT, 'video', { fit: true });
        store.adoptTransportSettings(TRANSPORT, SERIAL);

        store.setDeviceSetting(1, '10.0.0.9:5555', 'video', { fit: false });
        store.adoptTransportSettings('10.0.0.9:5555', SERIAL);

        expect(store.getDeviceSettings(1, SERIAL)).toEqual({ video: { fit: true } });
        expect(store.getDeviceSettings(1, '10.0.0.9:5555')).toEqual({ video: { fit: false } });
    });

    it('does nothing for the same key or an empty serial', () => {
        store.setDeviceSetting(1, TRANSPORT, 'video', { fit: true });
        store.adoptTransportSettings(TRANSPORT, TRANSPORT);
        store.adoptTransportSettings(TRANSPORT, '');
        expect(store.getDeviceSettings(1, TRANSPORT)).toEqual({ video: { fit: true } });
        expect(store.getDeviceSettings(1, '')).toEqual({});
    });
});
