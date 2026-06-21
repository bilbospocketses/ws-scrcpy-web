import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../migrations';
import { DeviceStore } from '../DeviceStore';

let db: DatabaseSync;
let store: DeviceStore;
beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new DeviceStore(db);
});

describe('DeviceStore per-device settings', () => {
    it('round-trips scoped per-device JSON and lists by udid', () => {
        store.setDeviceSetting(1, 'UDID1', 'video:0:0', { codec: 'h264', bitrate: 8000 });
        store.setDeviceSetting(1, 'UDID1', 'audio', { source: 'output' });
        expect(store.getDeviceSetting(1, 'UDID1', 'video:0:0')).toEqual({ codec: 'h264', bitrate: 8000 });
        expect(store.getDeviceSettings(1, 'UDID1')).toEqual({
            'video:0:0': { codec: 'h264', bitrate: 8000 },
            audio: { source: 'output' },
        });
        expect(store.getDeviceSetting(2, 'UDID1', 'audio')).toBeUndefined(); // per-user isolation
    });

    it('clearForUser removes that user labels + device settings only', () => {
        store.setLabel(1, 'S1', 'TV');
        store.setDeviceSetting(1, 'UDID1', 'audio', { source: 'mic' });
        store.clearForUser(1);
        expect(store.getAllLabels(1)).toEqual({});
        expect(store.getDeviceSettings(1, 'UDID1')).toEqual({});
    });
});
