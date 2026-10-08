import type { Db } from '../db/Db';

/**
 * A name typed at connect whose device serial was not yet known (row 19.5
 * follow-up).
 *
 * Right after `adb connect` a device can still be unauthorized, or slow, so
 * `getprop ro.serialno` fails or answers empty. The card reads names by that
 * serial, and an address-keyed copy would go stale on a rename, so the name is
 * held here against the transport adb opened, and filed under the serial the
 * first time it is known: when the device tracker reads the device's properties
 * (`Device.fetchDeviceInfo`), or on the next connect whose lookup succeeds. If
 * the tracker read them before the name could be held, it is filed at once.
 *
 * Held in memory, never on disk. An entry lives until it is applied, the
 * transport disconnects, or `PENDING_LABEL_TTL_MS` passes, so it cannot later
 * name a different device that DHCP hands the same address. A restart drops it,
 * which costs only the name, as before the follow-up.
 */
export const PENDING_LABEL_TTL_MS = 10 * 60 * 1000;

interface PendingLabel {
    label: string;
    /** The MAC resolved at connect time, off a container. */
    mac: string | null;
    /** The address a scan hit carries for this device (`scanAddressFor`). */
    scanAddress: string;
    expiresAt: number;
}

/** adb transport serial -> user id -> the name that user typed. */
const pending = new Map<string, Map<number, PendingLabel>>();

/**
 * adb transport serial -> the device serial last read on it. The tracker polls
 * on its own clock and can read a device's properties while the connect route
 * is still awaiting getprop, the MAC and DNS; the route asks here before it
 * holds a name, so the name is filed whichever happens first.
 */
const serials = new Map<string, string>();

/**
 * The serial adb lists a TCP transport under: the connect address, with adb's
 * default port when none was given (`adb connect 10.0.0.5` lists
 * `10.0.0.5:5555`). A device tracker udid is already in this form.
 */
export function transportKey(address: string): string {
    return /:\d+$/.test(address) ? address : `${address}:5555`;
}

export function rememberPendingLabel(
    address: string,
    userId: number,
    entry: { label: string; mac: string | null; scanAddress: string },
    now: number = Date.now(),
): void {
    for (const [key, byUser] of pending) {
        for (const [user, e] of byUser) if (e.expiresAt <= now) byUser.delete(user);
        if (byUser.size === 0) pending.delete(key);
    }
    const key = transportKey(address);
    const byUser = pending.get(key) ?? new Map<number, PendingLabel>();
    byUser.set(userId, { ...entry, expiresAt: now + PENDING_LABEL_TTL_MS });
    pending.set(key, byUser);
}

/**
 * File any name waiting on `address` under `serial`, now that it is known, and
 * record the address (and MAC) a rescan will reach the device by. An expired
 * entry is dropped without touching the store.
 */
export function applyPendingLabels(db: Db, address: string, serial: string, now: number = Date.now()): void {
    const key = transportKey(address);
    serials.set(key, serial);
    const byUser = pending.get(key);
    if (!byUser) return;
    pending.delete(key);
    for (const [userId, e] of byUser) {
        if (e.expiresAt <= now) continue;
        db.devices.setLabel(userId, serial, e.label);
        db.devices.claimAddress(serial, e.scanAddress, now);
        if (e.mac) db.devices.recordMac(serial, e.mac);
    }
}

/**
 * The device serial already read on the transport at `address`, if it is still
 * up. Also how `SettingsApi` keys a transport's stream settings by serial (M11).
 */
export function serialReadOn(address: string): string | undefined {
    return serials.get(transportKey(address));
}

/** The transport at `address` went away: whatever answers there next is not the device that was named. */
export function forgetPendingLabels(address: string): void {
    pending.delete(transportKey(address));
    serials.delete(transportKey(address));
}

export function _resetPendingLabelsForTest(): void {
    pending.clear();
    serials.clear();
}
