import { describe, expect, it, vi } from 'vitest';
import type * as os from 'os';
import { detectSubnet, __internals } from '../network/SubnetDetector';

describe('SubnetDetector', () => {
    it('returns null when no interfaces and no gateway', async () => {
        const result = await detectSubnet({
            getInterfaces: () => ({}),
            runCommand: async () => { throw new Error('no route'); },
            platform: 'linux',
        });
        expect(result).toBeNull();
    });

    it('falls back to interface when gateway detection fails', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.86.50',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.86.50/24',
            }],
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => { throw new Error('no gateway'); },
            platform: 'linux',
        });
        expect(result).not.toBeNull();
        expect(result?.cidr).toBe('192.168.86.0/24');
        expect(result?.source).toBe('interface');
        expect(result?.hostCount).toBe(254);
    });

    it('uses gateway detection on Linux (ip route)', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.1.42',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.1.42/24',
            }],
        };
        const runCommand = vi.fn(async (cmd: string) => {
            if (cmd.startsWith('ip route show default')) {
                return 'default via 192.168.1.1 dev eth0 proto dhcp metric 100';
            }
            if (cmd.startsWith('ip -o -4 addr show dev eth0')) {
                return '2: eth0    inet 192.168.1.42/24 brd 192.168.1.255 scope global eth0';
            }
            throw new Error(`unexpected: ${cmd}`);
        });
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand,
            platform: 'linux',
        });
        expect(result?.cidr).toBe('192.168.1.0/24');
        expect(result?.source).toBe('gateway');
    });

    it('skips internal and non-IPv4 interfaces in fallback', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            lo: [{
                address: '127.0.0.1',
                netmask: '255.0.0.0',
                family: 'IPv4',
                mac: '00:00:00:00:00:00',
                internal: true,
                cidr: '127.0.0.1/8',
            }],
            eth0: [{
                address: 'fe80::1',
                netmask: 'ffff:ffff:ffff:ffff::',
                family: 'IPv6',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: 'fe80::1/64',
                scopeid: 0,
            }],
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => { throw new Error('no gateway'); },
            platform: 'linux',
        });
        expect(result).toBeNull();
    });

    it('prefers smallest netmask when multiple RFC1918 interfaces match', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.1.5',
                netmask: '255.255.255.0', // /24
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.1.5/24',
            }],
            eth1: [{
                address: '10.0.0.5',
                netmask: '255.255.0.0', // /16
                family: 'IPv4',
                mac: '11:22:33:44:55:66',
                internal: false,
                cidr: '10.0.0.5/16',
            }],
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => { throw new Error('no gateway'); },
            platform: 'linux',
        });
        expect(result?.cidr).toBe('10.0.0.0/16');
    });

    it('picks the real-gateway default route on Windows with multiple defaults (skips On-link)', async () => {
        // Real `route print -4` output from a machine with a static-IP adapter (no
        // gateway, 192.168.87.3) plus a DHCP adapter with a real gateway (192.168.86.1).
        // Windows lists BOTH as default routes — the On-link one must be filtered out.
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            '10 Gbps Adapter': [{
                address: '192.168.87.3',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'c8:7f:54:67:f3:39',
                internal: false,
                cidr: '192.168.87.3/24',
            }],
            'vEthernet (LAN)': [{
                address: '192.168.86.3',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'c8:7f:54:67:ee:d6',
                internal: false,
                cidr: '192.168.86.3/24',
            }],
        };
        const routeOutput = [
            '===========================================================================',
            'IPv4 Route Table',
            '===========================================================================',
            'Active Routes:',
            'Network Destination        Netmask          Gateway       Interface  Metric',
            '          0.0.0.0          0.0.0.0         On-link         192.168.87.3    271',
            '          0.0.0.0          0.0.0.0     192.168.86.1      192.168.86.3     25',
            '         10.5.0.0      255.255.0.0         On-link          10.5.0.2    261',
            '===========================================================================',
        ].join('\n');
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => routeOutput,
            platform: 'win32',
        });
        expect(result?.cidr).toBe('192.168.86.0/24');
        expect(result?.source).toBe('gateway');
        expect(result?.interfaceName).toBe('vEthernet (LAN)');
    });

    it('returns null on Windows when all default routes are On-link', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.87.3',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.87.3/24',
            }],
        };
        const routeOutput = [
            'Active Routes:',
            '          0.0.0.0          0.0.0.0         On-link         192.168.87.3    271',
        ].join('\n');
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand: async () => routeOutput,
            platform: 'win32',
        });
        // Gateway detection returns null (no real default); interface fallback then
        // returns the only RFC1918 interface available.
        expect(result?.source).toBe('interface');
        expect(result?.cidr).toBe('192.168.87.0/24');
    });

    it('skips 0.0.0.0 gateway on Linux and picks real gateway', async () => {
        const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
            eth0: [{
                address: '192.168.1.42',
                netmask: '255.255.255.0',
                family: 'IPv4',
                mac: 'aa:bb:cc:dd:ee:ff',
                internal: false,
                cidr: '192.168.1.42/24',
            }],
        };
        const runCommand = async (cmd: string) => {
            if (cmd.startsWith('ip route show default')) {
                return [
                    'default via 0.0.0.0 dev eth1 metric 500',
                    'default via 192.168.1.1 dev eth0 metric 100',
                ].join('\n');
            }
            if (cmd.startsWith('ip -o -4 addr show dev eth0')) {
                return '2: eth0    inet 192.168.1.42/24 brd 192.168.1.255 scope global eth0';
            }
            throw new Error(`unexpected: ${cmd}`);
        };
        const result = await detectSubnet({
            getInterfaces: () => interfaces,
            runCommand,
            platform: 'linux',
        });
        expect(result?.cidr).toBe('192.168.1.0/24');
        expect(result?.source).toBe('gateway');
    });
});

describe('SubnetDetector internals', () => {
    it('netmaskToPrefix handles common masks', () => {
        expect(__internals.netmaskToPrefix('255.255.255.0')).toBe(24);
        expect(__internals.netmaskToPrefix('255.255.0.0')).toBe(16);
        expect(__internals.netmaskToPrefix('255.255.255.255')).toBe(32);
    });

    it('netmaskToPrefix rejects non-contiguous masks', () => {
        expect(__internals.netmaskToPrefix('255.255.0.255')).toBeNull();
        expect(__internals.netmaskToPrefix('255.0.255.0')).toBeNull();
    });

    it('netmaskToPrefix rejects invalid octet values', () => {
        expect(__internals.netmaskToPrefix('255.255.256.0')).toBeNull();
        expect(__internals.netmaskToPrefix('notamask')).toBeNull();
    });
});
