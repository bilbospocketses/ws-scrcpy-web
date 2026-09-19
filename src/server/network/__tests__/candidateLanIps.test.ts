import type { NetworkInterfaceInfo } from 'os';
import { describe, expect, it } from 'vitest';
import { candidateLanIps } from '../candidateLanIps';

function v4(address: string, internal = false): NetworkInterfaceInfo {
    return {
        address,
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal,
        cidr: `${address}/24`,
    };
}

function v6(address: string, internal = false): NetworkInterfaceInfo {
    return {
        address,
        netmask: 'ffff:ffff:ffff:ffff::',
        family: 'IPv6',
        mac: '00:00:00:00:00:00',
        internal,
        cidr: `${address}/64`,
        scopeid: 0,
    };
}

describe('candidateLanIps', () => {
    it('returns nothing from an empty interface set', () => {
        expect(candidateLanIps({})).toEqual([]);
    });

    it('excludes loopback / internal addresses', () => {
        const interfaces = { 'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)] };
        expect(candidateLanIps(interfaces)).toEqual([]);
    });

    it('excludes IPv6 entries -- mkcert IP subjects here are v4 candidates', () => {
        const interfaces = { Ethernet: [v6('fe80::1', false)] };
        expect(candidateLanIps(interfaces)).toEqual([]);
    });

    it('excludes link-local 169.254.0.0/16 (APIPA / no DHCP lease)', () => {
        const interfaces = { Ethernet: [v4('169.254.83.107')] };
        expect(candidateLanIps(interfaces)).toEqual([]);
    });

    it('excludes CGNAT 100.64.0.0/10 (Tailscale, and carrier-grade NAT share it)', () => {
        const interfaces = { Tailscale: [v4('100.101.102.103')] };
        expect(candidateLanIps(interfaces)).toEqual([]);
    });

    it('does not treat 100.63.x or 100.128.x as CGNAT -- the /10 boundary is exact', () => {
        // 100.64.0.0/10 covers second octet 64-127. 63 and 128 sit just outside it,
        // and neither is RFC1918, so both are excluded anyway -- but for the right
        // reason (not-private), not a boundary bug in the CGNAT check.
        expect(candidateLanIps({ eth: [v4('100.63.0.1')] })).toEqual([]);
        expect(candidateLanIps({ eth: [v4('100.128.0.1')] })).toEqual([]);
    });

    it('includes RFC1918 ranges: 10/8, 172.16/12, 192.168/16', () => {
        const interfaces = {
            a: [v4('10.8.0.2')],
            b: [v4('172.29.144.1')],
            c: [v4('192.168.86.3')],
        };
        expect(candidateLanIps(interfaces).sort()).toEqual(['10.8.0.2', '172.29.144.1', '192.168.86.3'].sort());
    });

    it('excludes 172.x outside the 16-31 second-octet band', () => {
        expect(candidateLanIps({ eth: [v4('172.15.0.1')] })).toEqual([]);
        expect(candidateLanIps({ eth: [v4('172.32.0.1')] })).toEqual([]);
    });

    it('returns ALL candidates, not a single winner -- the panel shows them and the user picks', () => {
        const interfaces = {
            Ethernet: [v4('192.168.86.3')],
            'VirtualBox Host-Only Network': [v4('192.168.56.1')],
        };
        expect(candidateLanIps(interfaces).sort()).toEqual(['192.168.56.1', '192.168.86.3'].sort());
    });

    it("matches this machine's measured nine-address shape (VirtualBox, two link-locals, WSL, Docker, two VPN adapters, the real LAN address, and loopback)", () => {
        const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
            'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
            Ethernet: [v4('192.168.86.3')],
            'VirtualBox Host-Only Network': [v4('192.168.56.1')],
            'Ethernet 3': [v4('169.254.83.107')],
            'vEthernet (Default Switch)': [v4('169.254.1.5')],
            'vEthernet (WSL)': [v4('172.29.144.1')],
            'vEthernet (Docker NAT)': [v4('172.17.0.1')],
            Tailscale: [v4('100.101.102.103')],
            OpenVPN: [v4('10.8.0.2')],
        };

        const result = candidateLanIps(interfaces);

        // The one address actually reachable from a phone on the LAN.
        expect(result).toContain('192.168.86.3');
        // Excluded categories never appear.
        expect(result).not.toContain('127.0.0.1');
        expect(result).not.toContain('169.254.83.107');
        expect(result).not.toContain('169.254.1.5');
        expect(result).not.toContain('100.101.102.103');
        // Everything else RFC1918 is still a candidate -- the function does not
        // try to guess which one is phone-reachable beyond the documented
        // exclusions; that judgment belongs to the panel and the user.
        expect(result.sort()).toEqual(
            ['10.8.0.2', '172.17.0.1', '172.29.144.1', '192.168.56.1', '192.168.86.3'].sort(),
        );
    });
});
