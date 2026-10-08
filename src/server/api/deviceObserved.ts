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

/** What the device tracker read off one adb transport. */
export interface TrackerSighting {
    /** The adb transport id: a USB serial, or `host:port` for TCP. */
    udid: string;
    /** `ro.serialno`; empty until the device answers it. */
    serial: string;
    manufacturer: string | null;
    model: string | null;
    at: number;
}

/**
 * Record a device tracker sighting under the device's real serial (M11).
 *
 * The tracker used to upsert under the transport id, so a Wi-Fi device had a
 * `<ip>:5555` row with the model beside the serial row connect wrote with the
 * address and MAC. Now a transport row is folded into the serial row and
 * deleted (`mergeDeviceInto`), what was just read lands on the serial row, and
 * stream settings filed under the transport before M11 are adopted
 * (`adoptTransportSettings`). An unknown serial writes nothing: a row under
 * the transport is exactly what this replaces.
 *
 * The address of a TCP transport is claimed separately, after a DNS lookup
 * (`Device.claimTransportAddress`).
 */
export function recordTrackerSighting(db: Db, s: TrackerSighting): void {
    if (!s.serial) return;
    db.devices.mergeDeviceInto(s.udid, s.serial);
    db.devices.upsertDevice({ serial: s.serial, manufacturer: s.manufacturer, model: s.model, lastSeenAt: s.at });
    db.devices.adoptTransportSettings(s.udid, s.serial);
}
