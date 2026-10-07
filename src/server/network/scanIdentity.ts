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
 * The `devices` table records serial -> address, and that is the join these
 * helpers use. It also carries the remembered `model` that the scan UI's route
 * never had (finding 7.6). Its address is written on every successful
 * `POST /api/devices/connect`, in the form a scan hit would carry
 * (`scanAddressFor`). Before row 19.5 the only writer was the mDNS REST scan,
 * which no client calls, so the join never fired for a TCP hit.
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
 * Label precedence: explicit > the device's real serial (an mDNS hit's own
 * serial, then the serial observed at this address) > MAC alias > a name filed
 * under the probe address itself. The real serial is the one source of truth:
 * a rename on the device card rewrites only that key, so a MAC copy written at
 * connect time can be stale and must not win over it (row 19.5). The probe
 * address key comes last because only the pre-19.5 connect route wrote it.
 */
export function resolveHitIdentity(input: HitIdentityInput): { label: string; model: string | null } {
    const observed = input.deviceByAddress?.(input.address);
    const hitIsAddress = isProbeAddressSerial(input.hitSerial, input.address);

    let label = input.explicitLabel;
    if (label === undefined && !hitIsAddress) label = input.labelFor(input.hitSerial);
    if (label === undefined && observed) label = input.labelFor(observed.serial);
    if (label === undefined && input.mac) label = input.labelFor(input.mac);
    if (label === undefined && hitIsAddress) label = input.labelFor(input.hitSerial);

    return { label: label ?? '', model: observed?.model ?? null };
}

/**
 * Whether a "serial" is really an address: the TCP-hit form `<host>:<port>`
 * (`NetworkScanner` sets `serial: address`), or the connect address itself.
 * A label must never be filed under one — the device card reads `ro.serialno`.
 */
export function isProbeAddressSerial(serial: string, address: string): boolean {
    return serial === address || splitHostPort(serial) !== null;
}

/**
 * The address a scan hit would carry for a device connected at `address`, so
 * the address recorded on connect is the one `deviceByAddress` is later asked
 * for. A scan probes IPv4 literals, so a hostname is resolved, and a bare host
 * takes adb's default port. A lookup that fails or throws keeps the hostname
 * form: the worst case is a rescan that does not find it, as before.
 */
export async function scanAddressFor(
    address: string,
    lookupHost: (hostname: string) => Promise<string | null>,
): Promise<string> {
    const split = splitHostPort(address);
    const host = split ? split.host : address;
    const port = split ? split.port : '5555';
    if (isIpLiteral(host) || host.startsWith('[')) return `${host}:${port}`;
    try {
        const ip = await lookupHost(host);
        if (ip) return `${ip}:${port}`;
    } catch {
        // DNS is best-effort here — the hostname form is still recorded.
    }
    return `${host}:${port}`;
}

/**
 * The host of a connect address or transport serial, for a MAC lookup:
 * `[v6]:port` and `[v6]` give `v6`, `host:port` gives `host`, and a bare host,
 * including an unbracketed IPv6 literal, is returned as it is. `split(':')[0]`
 * answered `[` for an IPv6 transport, so its MAC was never found.
 */
export function hostOf(address: string): string {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
    if (bracketed) return bracketed[1]!;
    const idx = address.indexOf(':');
    if (idx === -1 || idx !== address.lastIndexOf(':')) return address;
    return address.slice(0, idx);
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
