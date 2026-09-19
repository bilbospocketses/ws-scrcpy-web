import type { NetworkInterfaceInfo } from 'os';

/**
 * Every non-internal IPv4 address that could plausibly be the LAN address a
 * phone or another machine uses to reach this one, for the local-HTTPS panel's
 * "generate for this IP" prefill (spec §6). Written as a pure function over
 * `os.networkInterfaces()`-shaped input so it is testable without touching the
 * network -- production wiring is `candidateLanIps(os.networkInterfaces())`.
 *
 * A dev box commonly carries NINE IPv4 addresses at once -- VirtualBox,
 * two link-locals, WSL, Docker, two VPN adapters, the real LAN address, and
 * loopback -- and exactly one of them is reachable from a phone on the LAN.
 * This function does not try to pick that one: it returns every RFC1918
 * candidate, minus two ranges that are never it, and leaves the choice to the
 * panel and the user.
 *
 * Excluded:
 *   - internal / non-IPv4 entries (loopback, IPv6) -- not a routable LAN v4
 *     address at all.
 *   - 169.254.0.0/16 (link-local / APIPA) -- a NIC with no DHCP lease, never
 *     reachable from another machine.
 *   - 100.64.0.0/10 (CGNAT) -- Tailscale and carrier-grade NAT both live here;
 *     it routes, but not to a LAN a phone shares with this machine.
 *
 * Included: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 -- the RFC1918 ranges,
 * with no further narrowing. A VPN adapter handing out a 10.x address looks
 * identical to a real LAN NIC from here; the panel showing every candidate
 * (rather than one silently-wrong guess) is the point.
 */
export function candidateLanIps(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
    const out: string[] = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (isLinkLocal(entry.address) || isCgnat(entry.address)) continue;
            if (isRfc1918(entry.address)) out.push(entry.address);
        }
    }
    return out;
}

function octets(ip: string): number[] {
    return ip.split('.').map((p) => Number.parseInt(p, 10));
}

function isRfc1918(ip: string): boolean {
    const [a, b] = octets(ip);
    if (a === 10) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

/** 100.64.0.0/10: second octet 64-127. */
function isCgnat(ip: string): boolean {
    const [a, b] = octets(ip);
    return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** 169.254.0.0/16. */
function isLinkLocal(ip: string): boolean {
    const [a, b] = octets(ip);
    return a === 169 && b === 254;
}
