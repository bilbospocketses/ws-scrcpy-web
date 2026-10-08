import type { DatabaseSync } from 'node:sqlite';

export interface DeviceRecord {
    serial: string;
    manufacturer: string | null;
    model: string | null;
    address: string | null;
    lastSeenAt: number | null;
}

export class DeviceStore {
    constructor(private readonly db: DatabaseSync) {}

    upsertDevice(rec: {
        serial: string;
        manufacturer?: string | null;
        model?: string | null;
        address?: string | null;
        lastSeenAt?: number | null;
    }): void {
        // COALESCE(excluded, existing): a field omitted (undefined→null bind) does not clobber a known value.
        this.db
            .prepare(
                `INSERT INTO devices (serial, manufacturer, model, address, last_seen_at) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(serial) DO UPDATE SET
                   manufacturer = COALESCE(excluded.manufacturer, devices.manufacturer),
                   model        = COALESCE(excluded.model,        devices.model),
                   address      = COALESCE(excluded.address,      devices.address),
                   last_seen_at = COALESCE(excluded.last_seen_at, devices.last_seen_at)`,
            )
            .run(rec.serial, rec.manufacturer ?? null, rec.model ?? null, rec.address ?? null, rec.lastSeenAt ?? null);
    }

    /**
     * Record that `serial` answered at `address` just now, for `findByAddress`.
     * An address belongs to one device at a time, so any other row still
     * holding it is cleared. Ordering by last_seen_at alone does not settle
     * that: a device seen since over USB bumps its own last_seen_at while
     * keeping an old network address, and would win the address back from the
     * device DHCP handed it to.
     */
    claimAddress(serial: string, address: string, at: number): void {
        this.db.prepare('UPDATE devices SET address = NULL WHERE address = ? AND serial <> ?').run(address, serial);
        this.upsertDevice({ serial, address, lastSeenAt: at });
    }

    /**
     * Record `mac` as the MAC `serial` was last seen with, so the label copy a
     * connect files under that MAC can follow a rename or clear made by serial
     * on the card (row 19.5 follow-up). A MAC belongs to one device at a time,
     * as an address does in `claimAddress`.
     */
    recordMac(serial: string, mac: string): void {
        this.db.prepare('UPDATE devices SET mac = NULL WHERE mac = ? AND serial <> ?').run(mac, serial);
        this.db
            .prepare(
                'INSERT INTO devices (serial, mac) VALUES (?, ?) ON CONFLICT(serial) DO UPDATE SET mac = excluded.mac',
            )
            .run(serial, mac);
    }

    /**
     * Fold the row filed under `from`, an adb transport id, into the row for the
     * device's real serial `into`, and delete it (M11). Before M11 the device
     * tracker filed what it saw under the transport (`<ip>:5555` for Wi-Fi)
     * while connect filed the address and MAC under the serial, so one device
     * had two half rows and a rescan, which joins by address, found no model.
     *
     * The serial row's values win where set, the transport row only fills
     * gaps, so an address or MAC is never nulled; the newer `last_seen_at`
     * wins. Nothing happens for an empty serial or when the keys are the same
     * (a USB transport id is the serial).
     */
    mergeDeviceInto(from: string, into: string): void {
        if (!from || !into || from === into) return;
        const old = this.db
            .prepare('SELECT manufacturer, model, address, mac, last_seen_at FROM devices WHERE serial = ?')
            .get(from) as
            | {
                  manufacturer: string | null;
                  model: string | null;
                  address: string | null;
                  mac: string | null;
                  last_seen_at: number | null;
              }
            | undefined;
        if (!old) return;
        // A savepoint, not BEGIN, so this also nests inside a caller's transaction.
        this.db.exec('SAVEPOINT merge_device');
        try {
            this.db
                .prepare(
                    `INSERT INTO devices (serial, manufacturer, model, address, mac, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(serial) DO UPDATE SET
                       manufacturer = COALESCE(devices.manufacturer, excluded.manufacturer),
                       model        = COALESCE(devices.model,        excluded.model),
                       address      = COALESCE(devices.address,      excluded.address),
                       mac          = COALESCE(devices.mac,          excluded.mac),
                       last_seen_at = CASE
                         WHEN devices.last_seen_at IS NULL THEN excluded.last_seen_at
                         WHEN excluded.last_seen_at IS NULL THEN devices.last_seen_at
                         ELSE MAX(devices.last_seen_at, excluded.last_seen_at) END`,
                )
                .run(into, old.manufacturer, old.model, old.address, old.mac, old.last_seen_at);
            this.db.prepare('DELETE FROM devices WHERE serial = ?').run(from);
            this.db.exec('RELEASE merge_device');
        } catch (e) {
            this.db.exec('ROLLBACK TO merge_device');
            this.db.exec('RELEASE merge_device');
            throw e;
        }
    }

    getMac(serial: string): string | undefined {
        const r = this.db.prepare('SELECT mac FROM devices WHERE serial = ?').get(serial) as
            | { mac: string | null }
            | undefined;
        return r?.mac ?? undefined;
    }

    getDevice(serial: string): DeviceRecord | undefined {
        const r = this.db
            .prepare('SELECT serial, manufacturer, model, address, last_seen_at FROM devices WHERE serial = ?')
            .get(serial) as
            | {
                  serial: string;
                  manufacturer: string | null;
                  model: string | null;
                  address: string | null;
                  last_seen_at: number | null;
              }
            | undefined;
        return r
            ? {
                  serial: r.serial,
                  manufacturer: r.manufacturer,
                  model: r.model,
                  address: r.address,
                  lastSeenAt: r.last_seen_at,
              }
            : undefined;
    }

    /**
     * The device last observed at a probe address. This is the join that lets a
     * scan hit — whose identity is the address it was probed at — reach the
     * device identity everything else keys on (ro.serialno), so a label saved
     * from the device row survives a disconnect and rescan (finding 19.4).
     *
     * Most recent sighting wins: an address can be reassigned by DHCP, and the
     * device that answered there last is the one a fresh hit means.
     */
    findByAddress(address: string): DeviceRecord | undefined {
        const r = this.db
            .prepare(
                `SELECT serial, manufacturer, model, address, last_seen_at FROM devices
                 WHERE address = ? ORDER BY last_seen_at DESC LIMIT 1`,
            )
            .get(address) as
            | {
                  serial: string;
                  manufacturer: string | null;
                  model: string | null;
                  address: string | null;
                  last_seen_at: number | null;
              }
            | undefined;
        return r
            ? {
                  serial: r.serial,
                  manufacturer: r.manufacturer,
                  model: r.model,
                  address: r.address,
                  lastSeenAt: r.last_seen_at,
              }
            : undefined;
    }

    listDevices(): DeviceRecord[] {
        return (
            this.db
                .prepare('SELECT serial, manufacturer, model, address, last_seen_at FROM devices ORDER BY serial')
                .all() as Array<{
                serial: string;
                manufacturer: string | null;
                model: string | null;
                address: string | null;
                last_seen_at: number | null;
            }>
        ).map((r) => ({
            serial: r.serial,
            manufacturer: r.manufacturer,
            model: r.model,
            address: r.address,
            lastSeenAt: r.last_seen_at,
        }));
    }

    getLabel(userId: number, serial: string): string | undefined {
        const r = this.db
            .prepare('SELECT label FROM device_labels WHERE user_id = ? AND serial = ?')
            .get(userId, serial) as { label: string } | undefined;
        return r?.label;
    }

    setLabel(userId: number, serial: string, label: string): void {
        this.db
            .prepare(
                'INSERT INTO device_labels (user_id, serial, label) VALUES (?, ?, ?) ON CONFLICT(user_id, serial) DO UPDATE SET label = excluded.label',
            )
            .run(userId, serial, label);
    }

    deleteLabel(userId: number, serial: string): void {
        this.db.prepare('DELETE FROM device_labels WHERE user_id = ? AND serial = ?').run(userId, serial);
    }

    getAllLabels(userId: number): Record<string, string> {
        const rows = this.db.prepare('SELECT serial, label FROM device_labels WHERE user_id = ?').all(userId) as Array<{
            serial: string;
            label: string;
        }>;
        const out: Record<string, string> = {};
        for (const r of rows) out[r.serial] = r.label;
        return out;
    }

    // --- Per-device settings (Phase 3): device_settings keyed (user, udid, scope) ---
    // Since M11 the `udid` column holds the device's real serial (`ro.serialno`),
    // so one device keeps one set across USB, Wi-Fi and IP changes. Rows written
    // before M11 under an adb transport id are adopted by `adoptTransportSettings`.

    /**
     * Adopt stream settings filed under the adb transport `transport` (before
     * M11) for the device whose serial is `serial`, now that it is seen there.
     * Per user: a user with no settings under the serial yet takes the
     * transport's whole set, which moves to the serial. A user who already has
     * settings under the serial keeps them, and the transport rows stay where
     * they are, so no setting is ever lost silently. Nothing happens for an
     * empty serial or when the keys are the same.
     */
    adoptTransportSettings(transport: string, serial: string): void {
        if (!transport || !serial || transport === serial) return;
        this.db
            .prepare(
                `UPDATE device_settings SET udid = ?
                 WHERE udid = ? AND user_id NOT IN (SELECT user_id FROM device_settings WHERE udid = ?)`,
            )
            .run(serial, transport, serial);
    }

    getDeviceSetting(userId: number, udid: string, scope: string): unknown {
        const r = this.db
            .prepare('SELECT value FROM device_settings WHERE user_id = ? AND udid = ? AND scope = ?')
            .get(userId, udid, scope) as { value: string } | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }

    setDeviceSetting(userId: number, udid: string, scope: string, value: unknown): void {
        this.db
            .prepare(
                'INSERT INTO device_settings (user_id, udid, scope, value) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, udid, scope) DO UPDATE SET value = excluded.value',
            )
            .run(userId, udid, scope, JSON.stringify(value));
    }

    getDeviceSettings(userId: number, udid: string): Record<string, unknown> {
        const rows = this.db
            .prepare('SELECT scope, value FROM device_settings WHERE user_id = ? AND udid = ?')
            .all(userId, udid) as Array<{ scope: string; value: string }>;
        const out: Record<string, unknown> = {};
        for (const r of rows) out[r.scope] = JSON.parse(r.value);
        return out;
    }

    /** Clear all of a user's device labels + per-device settings (the per-user reset). */
    clearForUser(userId: number): void {
        this.db.prepare('DELETE FROM device_labels WHERE user_id = ?').run(userId);
        this.db.prepare('DELETE FROM device_settings WHERE user_id = ?').run(userId);
    }
}
