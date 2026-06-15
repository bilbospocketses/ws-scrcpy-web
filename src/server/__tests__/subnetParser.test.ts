import { describe, expect, it } from 'vitest';
import { parseSubnetInput } from '../../common/SubnetParser';

describe('parseSubnetInput — CIDR', () => {
    it('parses 192.168.1.0/24', () => {
        const r = parseSubnetInput('192.168.1.0/24');
        expect('reason' in r).toBe(false);
        if ('reason' in r) return;
        expect(r.normalized).toBe('192.168.1.0/24');
        expect(r.hostCount).toBe(254);
        const hosts = [...r.hosts()];
        expect(hosts[0]).toBe('192.168.1.1');
        expect(hosts.at(-1)).toBe('192.168.1.254');
        expect(hosts).toHaveLength(254);
    });

    it('parses 10.0.0.0/16', () => {
        const r = parseSubnetInput('10.0.0.0/16');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(65534);
        const first = r.hosts().next().value;
        expect(first).toBe('10.0.0.1');
    });

    it('parses /32 single-host', () => {
        const r = parseSubnetInput('192.168.1.5/32');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(1);
        expect([...r.hosts()]).toEqual(['192.168.1.5']);
    });

    it('rejects prefix < /16 with friendly message', () => {
        const r = parseSubnetInput('10.0.0.0/15');
        expect('reason' in r).toBe(true);
        if (!('reason' in r)) return;
        expect(r.reason).toMatch(/maximum prefix is \/16/);
        expect(r.reason).toMatch(/multiple \/16 entries/);
    });

    it('rejects prefix > /32', () => {
        const r = parseSubnetInput('192.168.1.0/33');
        expect('reason' in r).toBe(true);
    });

    it('rejects invalid octet', () => {
        const r = parseSubnetInput('192.168.1.300/24');
        expect('reason' in r).toBe(true);
    });

    it('handles /31 (yields both addresses)', () => {
        const r = parseSubnetInput('192.168.1.0/31');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(2);
        expect([...r.hosts()]).toEqual(['192.168.1.0', '192.168.1.1']);
    });

    it('strips host bits from non-canonical CIDR', () => {
        const r = parseSubnetInput('192.168.1.5/24');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.normalized).toBe('192.168.1.0/24');
    });

    it('rejects CIDR with extra slashes', () => {
        const r = parseSubnetInput('192.168.1.0/24/extra');
        expect('reason' in r).toBe(true);
    });
});

describe('parseSubnetInput — bare IP', () => {
    it('treats bare IP as /32', () => {
        const r = parseSubnetInput('192.168.1.5');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.normalized).toBe('192.168.1.5/32');
        expect(r.hostCount).toBe(1);
        expect([...r.hosts()]).toEqual(['192.168.1.5']);
    });
});

describe('parseSubnetInput — range', () => {
    it('parses long form range', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.1.20');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(11);
        expect(r.normalized).toBe('192.168.1.10-192.168.1.20');
        expect([...r.hosts()]).toEqual([
            '192.168.1.10',
            '192.168.1.11',
            '192.168.1.12',
            '192.168.1.13',
            '192.168.1.14',
            '192.168.1.15',
            '192.168.1.16',
            '192.168.1.17',
            '192.168.1.18',
            '192.168.1.19',
            '192.168.1.20',
        ]);
    });

    it('parses shorthand range', () => {
        const r = parseSubnetInput('192.168.1.10-20');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(11);
        expect(r.normalized).toBe('192.168.1.10-192.168.1.20');
    });

    it('allows start == end', () => {
        const r = parseSubnetInput('192.168.1.5-5');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(1);
    });

    it('rejects start > end with friendly message', () => {
        const r = parseSubnetInput('192.168.1.20-10');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/start.*end/i);
    });

    it('accepts cross-/24 range within the 65,536-address cap', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.2.10');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(257);
        expect(r.normalized).toBe('192.168.1.10-192.168.2.10');
    });

    it('treats a literal /16 range as /16 — skips network and broadcast', () => {
        const r = parseSubnetInput('10.0.0.0-10.0.255.255');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(65534);
        const hosts = [...r.hosts()];
        expect(hosts[0]).toBe('10.0.0.1');
        expect(hosts.at(-1)).toBe('10.0.255.254');
    });

    it('treats a literal /24 range as /24 — skips network and broadcast', () => {
        const r = parseSubnetInput('192.168.1.0-192.168.1.255');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(254);
        const hosts = [...r.hosts()];
        expect(hosts[0]).toBe('192.168.1.1');
        expect(hosts.at(-1)).toBe('192.168.1.254');
    });

    it('skips only .0 when range starts at .0 but does not end at .255', () => {
        const r = parseSubnetInput('10.0.0.0-10.0.0.100');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(100);
        const hosts = [...r.hosts()];
        expect(hosts[0]).toBe('10.0.0.1');
        expect(hosts.at(-1)).toBe('10.0.0.100');
    });

    it('skips only .255 when range ends at .255 but does not start at .0', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.1.255');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(245);
        const hosts = [...r.hosts()];
        expect(hosts[0]).toBe('192.168.1.10');
        expect(hosts.at(-1)).toBe('192.168.1.254');
    });

    it('rejects range exceeding 65,536 addresses with friendly message', () => {
        const r = parseSubnetInput('10.0.0.0-10.1.0.0');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/65,?536/);
        expect(r.reason).toMatch(/CIDR/);
    });

    it('excludes .255 broadcast when range ends there', () => {
        const r = parseSubnetInput('192.168.1.254-255');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(1);
        expect([...r.hosts()]).toEqual(['192.168.1.254']);
    });

    it('rejects range with invalid start IP', () => {
        const r = parseSubnetInput('999.168.1.1-10');
        expect('reason' in r).toBe(true);
    });
});

describe('parseSubnetInput — errors', () => {
    it('returns unrecognized-format error for garbage', () => {
        const r = parseSubnetInput('not an ip');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/Unrecognized format/);
    });

    it('returns unrecognized-format error for empty input', () => {
        const r = parseSubnetInput('');
        expect('reason' in r).toBe(true);
    });

    it('trims whitespace', () => {
        const r = parseSubnetInput('  192.168.1.0/24  ');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(254);
    });

    it('embeds cheat-sheet link in errors', () => {
        const r = parseSubnetInput('not an ip');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/subnet cheat sheet/);
    });
});

describe('parseSubnetInput — RFC1918 private-range flag', () => {
    it('flags the three private blocks as private', () => {
        for (const input of ['10.0.0.0/16', '172.16.0.0/16', '192.168.1.0/24', '10.255.255.255', '172.31.255.255']) {
            const r = parseSubnetInput(input);
            if ('reason' in r) throw new Error(`${input}: ${r.reason}`);
            expect(r.isPrivate).toBe(true);
        }
    });

    it('flags public ranges as not private', () => {
        for (const input of ['8.8.8.0/24', '1.1.1.1', '203.0.113.0/24']) {
            const r = parseSubnetInput(input);
            if ('reason' in r) throw new Error(`${input}: ${r.reason}`);
            expect(r.isPrivate).toBe(false);
        }
    });

    it('treats addresses just outside the private blocks as public', () => {
        for (const input of ['11.0.0.0/24', '172.15.255.255', '172.32.0.0/16', '192.167.255.255', '192.169.0.0/16']) {
            const r = parseSubnetInput(input);
            if ('reason' in r) throw new Error(`${input}: ${r.reason}`);
            expect(r.isPrivate).toBe(false);
        }
    });

    it('flags a range that escapes a private block as public', () => {
        // Starts private (192.168.255.250) but runs past 192.168/16 into public space.
        const r = parseSubnetInput('192.168.255.250-192.169.0.5');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.isPrivate).toBe(false);
    });

    it('flags a wholly-private cross-/24 range as private', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.2.10');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.isPrivate).toBe(true);
    });
});
