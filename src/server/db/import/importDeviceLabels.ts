import type { DatabaseSync } from 'node:sqlite';
import { IMPLICIT_ADMIN_ID } from '../constants';
import { DeviceStore } from '../DeviceStore';

export function importDeviceLabels(db: DatabaseSync, labels: Record<string, string>): void {
    const ds = new DeviceStore(db);
    for (const [serial, label] of Object.entries(labels)) {
        ds.upsertDevice({ serial });
        ds.setLabel(IMPLICIT_ADMIN_ID, serial, label);
    }
}
