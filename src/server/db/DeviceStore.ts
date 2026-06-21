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
}
