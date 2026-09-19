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
 *   - anything outside the RFC1918 ranges below. That alone already excludes
 *     169.254.0.0/16 (link-local / APIPA -- a NIC with no DHCP lease) and
 *     100.64.0.0/10 (CGNAT -- Tailscale and carrier-grade NAT both live here;
 *     it routes, but not to a LAN a phone shares with this machine), since
 *     neither range is RFC1918. (N5: this file used to also run explicit
 *     isCgnat/isLinkLocal early-exits for those two ranges; they were
 *     unreachable dead code -- isRfc1918 already returns false for both, so
 *     removing them changed nothing observable. See candidateLanIps.test.ts
 *     for the boundary tests that prove the exclusion at the top level.)
 *
 * Included: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 -- the RFC1918 ranges,
 * with no further narrowing. A VPN adapter handing out a 10.x address looks
 * identical to a real LAN NIC from here; the panel showing every candidate
 * (rather than one silently-wrong guess) is the point.
 *
 * De-duplicated (N15): a multi-homed NIC or a teamed adapter can expose the
 * same address on more than one `os.networkInterfaces()` entry, which would
 * otherwise render as a duplicate row in the panel.
 */
export function candidateLanIps(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
    const out = new Set<string>();
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.family !== 'IPv4' || entry.internal) continue;
            if (isRfc1918(entry.address)) out.add(entry.address);
        }
    }
    return [...out];
}

function isRfc1918(ip: string): boolean {
    const [a, b] = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (a === 10) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}
