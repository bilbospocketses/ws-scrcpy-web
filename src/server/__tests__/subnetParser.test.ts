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

    it('rejects cross-/24 range with friendly message', () => {
        const r = parseSubnetInput('192.168.1.10-192.168.2.10');
        if (!('reason' in r)) throw new Error('expected error');
        expect(r.reason).toMatch(/same \/24/);
        expect(r.reason).toMatch(/CIDR/);
    });

    it('allows range across /24 boundary values (.254 to .255)', () => {
        const r = parseSubnetInput('192.168.1.254-255');
        if ('reason' in r) throw new Error(r.reason);
        expect(r.hostCount).toBe(2);
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
