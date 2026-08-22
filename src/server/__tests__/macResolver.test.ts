import { describe, expect, it, vi } from 'vitest';
import { __internals, resolveMac } from '../network/MacResolver';

describe('parseWindowsArp', () => {
    it('extracts MAC from a typical arp -a <ip> response', () => {
        const out = [
            'Interface: 192.168.86.3 --- 0x15',
            '  Internet Address      Physical Address      Type',
            '  192.168.86.231        aa-bb-cc-dd-ee-ff     dynamic',
        ].join('\n');
        expect(__internals.parseWindowsArp(out, '192.168.86.231')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('normalizes uppercase Windows dash format to lowercase colons', () => {
        const out = '  192.168.1.50        AA-BB-CC-DD-EE-FF     dynamic';
        expect(__internals.parseWindowsArp(out, '192.168.1.50')).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('returns null when IP is not present', () => {
        const out = ['Interface: 192.168.86.3 --- 0x15', '  192.168.86.50        aa-bb-cc-dd-ee-ff     dynamic'].join(
            '\n',
        );
        expect(__internals.parseWindowsArp(out, '192.168.86.231')).toBeNull();
    });

    it('returns null on completely empty output', () => {
        expect(__internals.parseWindowsArp('', '192.168.1.1')).toBeNull();
    });

    it('ignores rows where the IP is a prefix but not exact match', () => {
        // 192.168.1.23 should not match 192.168.1.231
        const out = '  192.168.1.231        aa-bb-cc-dd-ee-ff     dynamic';
        expect(__internals.parseWindowsArp(out, '192.168.1.23')).toBeNull();
    });

    it('ignores rows with malformed MAC', () => {
        const out = '  192.168.1.1        garbage        dynamic';
        expect(__internals.parseWindowsArp(out, '192.168.1.1')).toBeNull();
    });
});

describe('parseDarwinArp', () => {
    it('extracts MAC from typical BSD arp -n <ip> output', () => {
        const out = '? (192.168.86.231) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]';
        expect(__internals.parseDarwinArp(out)).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('zero-pads single-digit octets (BSD arp omits leading zeros)', () => {
        const out = '? (192.168.1.5) at 8:0:20:ae:fd:7a on en0 ifscope [ethernet]';
        expect(__internals.parseDarwinArp(out)).toBe('08:00:20:ae:fd:7a');
    });

    it('normalizes uppercase to lowercase', () => {
        const out = '? (192.168.1.5) at AA:BB:CC:DD:EE:FF on en0 ifscope [ethernet]';
        expect(__internals.parseDarwinArp(out)).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('returns null when the entry is incomplete', () => {
        const out = '? (192.168.1.5) at (incomplete) on en0 ifscope [ethernet]';
        expect(__internals.parseDarwinArp(out)).toBeNull();
    });

    it('returns null on empty output', () => {
        expect(__internals.parseDarwinArp('')).toBeNull();
    });
});

describe('parseLinuxIpNeigh', () => {
    it('extracts MAC from typical ip neigh output', () => {
        const out = '192.168.86.231 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE';
        expect(__internals.parseLinuxIpNeigh(out)).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('normalizes uppercase to lowercase', () => {
        const out = '192.168.1.5 dev eth0 lladdr AA:BB:CC:DD:EE:FF STALE';
        expect(__internals.parseLinuxIpNeigh(out)).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('handles ip neigh output without state suffix', () => {
        const out = '192.168.1.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff';
        expect(__internals.parseLinuxIpNeigh(out)).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('returns null when no lladdr present (FAILED state)', () => {
        const out = '192.168.1.5 dev eth0  FAILED';
        expect(__internals.parseLinuxIpNeigh(out)).toBeNull();
    });

    it('returns null on empty output', () => {
        expect(__internals.parseLinuxIpNeigh('')).toBeNull();
    });
});

describe('resolveMac', () => {
    it('dispatches to arp on Windows', async () => {
        const runCommand = vi.fn(async (bin: string, args: string[]) => {
            expect(bin).toBe('arp');
            expect(args).toEqual(['-a', '192.168.86.231']);
            return '  192.168.86.231        aa-bb-cc-dd-ee-ff     dynamic';
        });
        const mac = await resolveMac('192.168.86.231', { runCommand, platform: 'win32' });
        expect(mac).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('dispatches to ip neigh on Linux', async () => {
        const runCommand = vi.fn(async (bin: string, args: string[]) => {
            expect(bin).toBe('ip');
            expect(args).toEqual(['neigh', 'show', 'to', '192.168.1.5']);
            return '192.168.1.5 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE';
        });
        const mac = await resolveMac('192.168.1.5', { runCommand, platform: 'linux' });
        expect(mac).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('dispatches to arp -n on macOS', async () => {
        const runCommand = vi.fn(async (bin: string, args: string[]) => {
            expect(bin).toBe('arp');
            expect(args).toEqual(['-n', '192.168.1.5']);
            return '? (192.168.1.5) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]';
        });
        const mac = await resolveMac('192.168.1.5', { runCommand, platform: 'darwin' });
        expect(mac).toBe('aa:bb:cc:dd:ee:ff');
    });

    it('returns null on unsupported platform', async () => {
        const runCommand = vi.fn();
        const mac = await resolveMac('192.168.1.5', { runCommand, platform: 'aix' });
        expect(mac).toBeNull();
        expect(runCommand).not.toHaveBeenCalled();
    });

    it('returns null when the command throws', async () => {
        const runCommand = async () => {
            throw new Error('exec failed');
        };
        const mac = await resolveMac('192.168.1.5', { runCommand, platform: 'linux' });
        expect(mac).toBeNull();
    });
});

describe('__internals helpers', () => {
    it('isMacString accepts both dash and colon forms', () => {
        expect(__internals.isMacString('aa:bb:cc:dd:ee:ff')).toBe(true);
        expect(__internals.isMacString('AA-BB-CC-DD-EE-FF')).toBe(true);
        expect(__internals.isMacString('garbage')).toBe(false);
        expect(__internals.isMacString('aa:bb:cc:dd:ee')).toBe(false);
    });

    it('normalizeMac lowercases and uses colons', () => {
        expect(__internals.normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
        expect(__internals.normalizeMac('Aa:Bb:Cc:Dd:Ee:Ff')).toBe('aa:bb:cc:dd:ee:ff');
    });
});
