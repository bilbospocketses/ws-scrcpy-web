import type GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';

/**
 * Collapse the multiple adb transports of one physical device to a single
 * descriptor.
 *
 * An Android 11+ device with wireless debugging on reaches `adb devices`
 * **twice**: once as the `ip:port` transport we opened ourselves with
 * `adb connect`, and once as the `_adb-tls-connect._tcp` transport adb's own
 * mDNS auto-connect opened. Two serial strings, one phone — and `ControlCenter`
 * keys `knownDevices` / `deviceMap` / `descriptors` on that serial string, so
 * the home page rendered two cards for the same device.
 *
 * Observed on a Pixel 10a, 2026-08-26:
 * ```
 * 192.168.86.190:37571                            ro.serialno=5C061JEA327610
 * adb-5C061JEA327610-bo0E0q._adb-tls-connect._tcp ro.serialno=5C061JEA327610
 * ```
 *
 * `ro.serialno` is the only safe key. Model is not: two Google TV Streamers on
 * one network report an identical `ro.product.model`, and merging those would
 * hide a real device. The descriptor already carries `ro.serialno`, so this
 * needs no new probing — only that the list stops trusting the transport string
 * as an identity.
 */

/**
 * True for a `host:port` udid — the form produced by `adb connect`, and the
 * only form we can later `adb disconnect`.
 */
export function isNetworkTransportUdid(udid: string): boolean {
    return /^[^\s:]+:\d+$/.test(udid);
}

/**
 * One descriptor per hardware serial, preferring the `ip:port` transport.
 *
 * That preference is not cosmetic: the `_adb-tls-connect._tcp` form has no
 * host:port to disconnect from, which is why its card rendered without a
 * disconnect button. Keeping the network transport resolves the duplicate and
 * the missing action in one move.
 *
 * Descriptors whose `ro.serialno` is still empty — the initial value, until
 * `getprop` lands — pass through untouched. An unidentified device must stay
 * visible, and two unidentified devices must never be merged into one on the
 * strength of both being unknown.
 *
 * Selects rather than rebuilds: callers hold references to these descriptors.
 */
export function dedupeByHardwareSerial(descriptors: GoogDeviceDescriptor[]): GoogDeviceDescriptor[] {
    const winnerBySerial = new Map<string, GoogDeviceDescriptor>();
    // Preserves first-appearance order: a serial key marks the slot its group
    // occupies, a descriptor is an unidentified pass-through.
    const order: (string | GoogDeviceDescriptor)[] = [];

    for (const descriptor of descriptors) {
        const serial = descriptor['ro.serialno'];
        if (!serial) {
            order.push(descriptor);
            continue;
        }
        const incumbent = winnerBySerial.get(serial);
        if (!incumbent) {
            winnerBySerial.set(serial, descriptor);
            order.push(serial);
            continue;
        }
        if (!isNetworkTransportUdid(incumbent.udid) && isNetworkTransportUdid(descriptor.udid)) {
            winnerBySerial.set(serial, descriptor);
        }
    }

    return order.map((entry) => (typeof entry === 'string' ? winnerBySerial.get(entry)! : entry));
}

/**
 * True when `descriptor` is the transport its serial's group would keep.
 *
 * Gates the incremental `device` event: without it, a losing transport's own
 * update would push a second card to a client that already holds the survivor
 * from the initial device list.
 */
export function survivesDedupe(descriptor: GoogDeviceDescriptor, all: readonly GoogDeviceDescriptor[]): boolean {
    return dedupeByHardwareSerial([...all]).some((kept) => kept.udid === descriptor.udid);
}
