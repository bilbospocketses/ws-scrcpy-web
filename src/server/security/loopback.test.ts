import { describe, expect, it } from 'vitest';
import { isLoopback } from './loopback';

describe('isLoopback', () => {
    it('accepts the IPv4 and IPv6 loopback literals', () => {
        expect(isLoopback('127.0.0.1')).toBe(true);
        expect(isLoopback('127.5.6.7')).toBe(true); // the whole 127/8 block is loopback
        expect(isLoopback('::1')).toBe(true);
    });

    it('accepts IPv4-mapped IPv6, which Node reports for a dual-stack listener', () => {
        expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    });

    it('rejects everything else, including an empty address', () => {
        expect(isLoopback('192.168.1.5')).toBe(false);
        expect(isLoopback('::ffff:192.168.1.5')).toBe(false);
        expect(isLoopback('10.0.0.1')).toBe(false);
        expect(isLoopback('')).toBe(false);
        // A prefix match must not be fooled by a leading "127" in a longer octet.
        expect(isLoopback('1270.0.0.1')).toBe(false);
    });
});
