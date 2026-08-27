import type { NetInterface } from '../../../types/NetInterface';

/**
 * Choose which of a device's network interfaces to advertise as the stream
 * host.
 *
 * The old rule was `interfaces.find(i => i.name === device['wifi.interface'])
 * || interfaces[0]`, with `interfaces` sorted alphabetically by name. Two
 * things go wrong with that on a modern phone:
 *
 *   - `getprop wifi.interface` is a legacy property and returns **empty** on
 *     current Android (verified on a Pixel 10a, Android 17), so the lookup
 *     misses and the fallback runs; and
 *   - the fallback is alphabetical, and `rmnet16` sorts before `wlan0`.
 *
 * So a phone with mobile data on advertised its **cellular** address —
 * `100.90.22.137`, a carrier CGNAT address that nothing on the LAN can route
 * to. (That range is shared with Tailscale, which is what made it look like a
 * VPN address at first.) Single-homed devices such as the Google TV Streamer
 * hid the bug completely, since `eth0` was the only candidate.
 *
 * Alphabetical order carries no meaning here, so this ranks candidates instead.
 */

/** Interface-name families, best first. Matched case-insensitively as prefixes. */
const NAME_RANK: readonly { prefixes: readonly string[]; score: number }[] = [
    // Wi-Fi: what a phone on the same network as the server should use.
    { prefixes: ['wlan', 'wifi', 'ap'], score: 100 },
    // Wired: the Google TV Streamer and most set-top boxes.
    { prefixes: ['eth', 'enp', 'ens', 'eno'], score: 90 },
    // USB tethering / reverse tethering — routable, but rarely what is wanted
    // when a real network interface exists.
    { prefixes: ['rndis', 'usb', 'ncm'], score: 40 },
    // Tunnels and VPNs. Reachable in principle, but the far side is somebody
    // else's network and the address is not the device's LAN identity.
    { prefixes: ['tun', 'tap', 'wg', 'ppp'], score: 20 },
    // Cellular. `rmnet` is the Qualcomm/Exynos modem interface; `ccmni` is
    // MediaTek's; `pdp_ip` is the older name. Never routable from the LAN.
    { prefixes: ['rmnet', 'ccmni', 'pdp_ip', 'clat'], score: 10 },
];

const DEFAULT_NAME_SCORE = 50;

function nameScore(name: string): number {
    const lower = name.toLowerCase();
    for (const { prefixes, score } of NAME_RANK) {
        if (prefixes.some((p) => lower.startsWith(p))) return score;
    }
    return DEFAULT_NAME_SCORE;
}

/**
 * RFC1918 private space — the address families a device on our LAN actually
 * has. Deliberately does NOT include 100.64.0.0/10 (CGNAT): that is what
 * carriers hand out to phones on mobile data, and it is the exact address this
 * function exists to stop picking.
 */
export function isPrivateLanAddress(ipv4: string): boolean {
    const octets = ipv4.split('.').map((o) => Number.parseInt(o, 10));
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        return false;
    }
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
}

function score(iface: NetInterface): number {
    // A private-LAN address is a strong signal on its own: it survives an
    // interface name nobody has enumerated here, and it is precisely what
    // separates wlan0's 192.168.x from rmnet's 100.x.
    return nameScore(iface.name) + (isPrivateLanAddress(iface.ipv4) ? 25 : 0);
}

/**
 * Pick the interface to build the stream URL from, or `undefined` when the
 * device reported none.
 *
 * `wifiInterfaceName` is the device's `wifi.interface` property. When it is set
 * AND matches a reported interface it still wins outright — the device naming
 * its own Wi-Fi interface is better evidence than any heuristic. It is simply
 * no longer the only thing standing between us and an alphabetical guess.
 */
export function pickDeviceInterface(
    interfaces: readonly NetInterface[],
    wifiInterfaceName?: string | undefined,
): NetInterface | undefined {
    if (interfaces.length === 0) return undefined;

    if (wifiInterfaceName) {
        const named = interfaces.find((i) => i.name === wifiInterfaceName);
        if (named) return named;
    }

    let best = interfaces[0]!;
    let bestScore = score(best);
    for (const candidate of interfaces.slice(1)) {
        const candidateScore = score(candidate);
        // Strictly greater, so an equal-scoring tie keeps the device's own
        // ordering rather than reshuffling on every poll.
        if (candidateScore > bestScore) {
            best = candidate;
            bestScore = candidateScore;
        }
    }
    return best;
}
