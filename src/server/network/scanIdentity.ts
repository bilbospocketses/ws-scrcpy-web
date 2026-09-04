/**
 * Bridging scan-hit identity to device identity.
 *
 * A TCP scan hit's identity is the address it was probed at — `NetworkScanner`
 * sets `serial: address`. A device's identity everywhere else in the app is its
 * `ro.serialno`: that is what the device row keys labels on, and what the
 * `devices` table is keyed by. Nothing joined the two except a MAC alias, and
 * that alias was written only when a label happened to be supplied at connect
 * time. So the round trip a user is most likely to take — name a device from
 * the list, disconnect it, scan for it again — came back unnamed, because the
 * label was filed under a key the scan never asks for (finding 19.4).
 *
 * The `devices` table already records serial -> address for every device it has
 * observed. That is the join these helpers use, and it also carries the
 * remembered `model` that the scan UI's route never had (finding 7.6).
 */

/** The observed-device row for a probe address, if the app has ever seen it. */
export type DeviceByAddress = (address: string) => { serial: string; model: string | null } | undefined;

/**
 * The set of addresses a scan should treat as already connected.
 *
 * `adb devices` reports whatever string the user connected with, so a device
 * reached as `qa-android:5555` is listed under that name while the scan finds
 * it at `<ip>:5555`. Comparing those two as strings never matched, and the same
 * device showed up as connected and as a fresh, unconnected hit at once
 * (finding 7.7). Both forms go in the set.
 *
 * A serial that is not `host:port` (a USB device) is kept as-is and never
 * looked up. A lookup that fails or throws costs nothing: the original form is
 * always present, so the worst case is the behaviour we had before.
 */
export async function expandConnectedAddresses(
    serials: readonly string[],
    lookupHost: (hostname: string) => Promise<string | null>,
): Promise<Set<string>> {
    const out = new Set<string>();
    for (const serial of serials) {
        out.add(serial);
        const split = splitHostPort(serial);
        if (!split || isIpLiteral(split.host)) continue;
        try {
            const ip = await lookupHost(split.host);
            if (ip) out.add(`${ip}:${split.port}`);
        } catch {
            // DNS is best-effort here — the hostname form is already in the set.
        }
    }
    return out;
}

export interface HitIdentityInput {
    address: string;
    hitSerial: string;
    mac: string | null;
    /** Supplied by the caller; wins over any lookup. */
    explicitLabel?: string | undefined;
    labelFor: (key: string) => string | undefined;
    deviceByAddress?: DeviceByAddress | undefined;
}

/**
 * Resolve what a spectator should see for one scan hit: the label saved for it,
 * and the model remembered from a previous sighting.
 *
 * Label precedence: explicit > MAC alias > the hit's own serial > the real
 * serial of the device observed at this address. The last step is the new one —
 * it is what makes a label survive disconnect-and-rescan.
 */
export function resolveHitIdentity(input: HitIdentityInput): { label: string; model: string | null } {
    const observed = input.deviceByAddress?.(input.address);

    let label = input.explicitLabel;
    if (label === undefined && input.mac) label = input.labelFor(input.mac);
    if (label === undefined) label = input.labelFor(input.hitSerial);
    if (label === undefined && observed) label = input.labelFor(observed.serial);

    return { label: label ?? '', model: observed?.model ?? null };
}

function splitHostPort(value: string): { host: string; port: string } | null {
    const idx = value.lastIndexOf(':');
    if (idx <= 0 || idx === value.length - 1) return null;
    const host = value.slice(0, idx);
    const port = value.slice(idx + 1);
    if (!/^\d+$/.test(port)) return null;
    return { host, port };
}

function isIpLiteral(host: string): boolean {
    // IPv4 only: the scan probes an IPv4 subnet, and an IPv6 literal in an adb
    // serial arrives bracketed, which splitHostPort already declines to split.
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
