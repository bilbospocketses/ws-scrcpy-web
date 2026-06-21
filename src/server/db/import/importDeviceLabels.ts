import type { DatabaseSync } from 'node:sqlite';
import { DeviceStore } from '../DeviceStore';
import { IMPLICIT_ADMIN_ID } from '../constants';

export function importDeviceLabels(db: DatabaseSync, labels: Record<string, string>): void {
    const ds = new DeviceStore(db);
    for (const [serial, label] of Object.entries(labels)) {
        ds.upsertDevice({ serial });
        ds.setLabel(IMPLICIT_ADMIN_ID, serial, label);
    }
}
