import type { Db } from '../db/Db';

/** Observed (shared, not per-user) facts about a device, upserted server-side. */
export interface ObservedDevice {
    serial: string;
    manufacturer?: string | null;
    model?: string | null;
    address?: string | null;
    lastSeenAt?: number | null;
}

/**
 * Upsert observed device metadata into the shared `devices` table. One shared
 * helper so both the scan path and the goog-device props path stay DRY; the
 * COALESCE upsert in DeviceStore preserves prior non-null fields when a later
 * sighting omits them.
 */
export function upsertObservedDevices(db: Db, devices: ObservedDevice[]): void {
    for (const d of devices) db.devices.upsertDevice(d);
}
