/**
 * Serials that do not name one device (M11 fix round 1, m4).
 *
 * Since M11 a device's row, its stream settings and the device list's
 * duplicate-transport merge are all keyed by `ro.serialno`. A serial many
 * devices share would fold different devices into one row, one settings set
 * and one card, so these are treated as no serial at all: the tracker keys
 * the device by its adb transport as it does before the serial is read, and
 * the duplicate merge leaves the descriptor alone.
 *
 * - empty / blank: not read yet, or the device answered nothing;
 * - `unknown`: the value `ro.serialno` falls back to when the bootloader passes
 *   none (`Build.UNKNOWN`);
 * - `0123456789ABCDEF`: the placeholder many cheap boards and TV boxes ship
 *   with, the same on every unit;
 * - `EMULATOR<version>`: the Android emulator's default serial, built from the
 *   emulator's own version (`EMULATOR37.1.11.0` in emulator 37.1.11's binary,
 *   `EMULATOR37X1X11X0` as the guest reports it), so every AVD started by one
 *   emulator version has the same one.
 *
 * Shared by the server (tracker sighting, duplicate merge) and the client
 * (settings binding), so the two never disagree on what identifies a device.
 */
const PLACEHOLDER_SERIALS: ReadonlySet<string> = new Set(['', 'UNKNOWN', '0123456789ABCDEF']);

const EMULATOR_SERIAL = /^EMULATOR\d+(?:[X.]\d+)+$/;

/** True when `serial` names one device, so it can key that device's row, settings and card. */
export function isUniqueSerial(serial: string | null | undefined): boolean {
    const s = (serial ?? '').trim().toUpperCase();
    return !PLACEHOLDER_SERIALS.has(s) && !EMULATOR_SERIAL.test(s);
}
