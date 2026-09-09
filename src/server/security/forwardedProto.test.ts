import { describe, expect, it } from 'vitest';
import { isRequestSecure } from './forwardedProto';

describe('forwardedProto.isRequestSecure', () => {
    it('is secure when the app itself terminates TLS, whatever the peer claims', () => {
        expect(isRequestSecure(true, '203.0.113.7', undefined)).toBe(true);
        expect(isRequestSecure(true, '203.0.113.7', 'http')).toBe(true);
    });

    it('trusts X-Forwarded-Proto from a loopback peer — the documented proxy recipe', () => {
        expect(isRequestSecure(false, '127.0.0.1', 'https')).toBe(true);
        expect(isRequestSecure(false, '::1', 'https')).toBe(true);
        // Node reports IPv4-mapped IPv6 on a dual-stack listener.
        expect(isRequestSecure(false, '::ffff:127.0.0.1', 'https')).toBe(true);
    });

    it('ignores X-Forwarded-Proto from anyone not on loopback', () => {
        // The whole point of the loopback condition: an off-box client controls
        // its own headers, so a forgeable "https" must buy it nothing.
        expect(isRequestSecure(false, '192.168.1.50', 'https')).toBe(false);
        expect(isRequestSecure(false, '203.0.113.7', 'https')).toBe(false);
    });

    it('reads the client-facing hop when proxies chain the header', () => {
        expect(isRequestSecure(false, '127.0.0.1', 'https, http')).toBe(true);
        expect(isRequestSecure(false, '127.0.0.1', 'http, https')).toBe(false);
    });

    it('accepts a repeated header (Node hands those over as an array)', () => {
        expect(isRequestSecure(false, '127.0.0.1', ['https', 'http'])).toBe(true);
        expect(isRequestSecure(false, '127.0.0.1', ['http'])).toBe(false);
    });

    it('is case-insensitive and tolerates whitespace', () => {
        expect(isRequestSecure(false, '127.0.0.1', '  HTTPS ')).toBe(true);
    });

    it('is not secure without the header, or on a plain-http proxy hop', () => {
        expect(isRequestSecure(false, '127.0.0.1', undefined)).toBe(false);
        expect(isRequestSecure(false, '127.0.0.1', 'http')).toBe(false);
        expect(isRequestSecure(false, '127.0.0.1', '')).toBe(false);
    });

    it('is not secure when the remote address is unknown', () => {
        // A destroyed socket reports undefined; fail closed rather than guess.
        expect(isRequestSecure(false, undefined, 'https')).toBe(false);
    });
});
