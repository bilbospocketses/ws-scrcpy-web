import { describe, expect, it, vi } from 'vitest';
import { sanitizeFrameAncestors } from '../Config';
import { isIpv6FrameAncestor, parseFrameAncestorOrigin } from '../security/frameGuard';

describe('sanitizeFrameAncestors', () => {
    it('returns an empty list when the key is absent', () => {
        expect(sanitizeFrameAncestors(undefined, vi.fn())).toEqual([]);
    });

    it('accepts absolute origins and normalises them', () => {
        const warn = vi.fn();

        // new URL().origin drops the default port and any trailing slash, so
        // "http://localhost:80/" and "http://localhost" agree.
        expect(sanitizeFrameAncestors(['http://localhost:5159', 'https://tools.example.com'], warn)).toEqual([
            'http://localhost:5159',
            'https://tools.example.com',
        ]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns and ignores a non-array instead of throwing', () => {
        const warn = vi.fn();

        // Contract 1: a bad config.json must not stop the server booting.
        expect(sanitizeFrameAncestors('http://localhost:5159', warn)).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('skips blank and non-string entries but keeps the good ones', () => {
        const warn = vi.fn();

        expect(sanitizeFrameAncestors(['', '   ', 42, 'http://localhost:5159'], warn)).toEqual([
            'http://localhost:5159',
        ]);
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('rejects "*" outright', () => {
        const warn = vi.fn();

        // Allowing any embedder is precisely what the header exists to prevent,
        // so this is never treated as a shortcut for "disable framing checks".
        expect(sanitizeFrameAncestors(['*'], warn)).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('rejects entries that are not absolute origins', () => {
        const warn = vi.fn();

        expect(sanitizeFrameAncestors(['localhost:5159', 'not a url'], warn)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('rejects an origin carrying a path, query or fragment', () => {
        const warn = vi.fn();

        // frame-ancestors matches origins; a path is an operator mistake that
        // would otherwise be silently dropped by the browser.
        expect(sanitizeFrameAncestors(['http://localhost:5159/embed', 'http://localhost:5159/?a=1'], warn)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    // 0.5.3 review (I3): an entry the hardened parseFrameAncestorOrigin now
    // refuses is skipped with a warning, keeping the good ones -- an entry an
    // older build accepted must not stop the server booting.
    it('skips a wildcard or CSP-injecting entry with a warning, keeping the good ones', () => {
        const warn = vi.fn();

        expect(
            sanitizeFrameAncestors(
                ['http://*.example.com', 'http://localhost:5159', 'http://a;sandbox', 'http://a,b', 'http://a_b.lan'],
                warn,
            ),
        ).toEqual(['http://localhost:5159']);
        expect(warn).toHaveBeenCalledTimes(4);
        expect(warn.mock.calls[0]?.[0]).toMatch(/no wildcard/);
    });

    // 0.5.3 review: an IPv6 entry, which builds before 0.5.3 accepted, is skipped
    // with a warning that says why (a browser never honored it), not a crash.
    it('skips an IPv6 entry with a warning naming the reason, keeping the good ones', () => {
        const warn = vi.fn();

        expect(
            sanitizeFrameAncestors(
                ['http://[::1]:47812', 'http://localhost:5159', 'https://[fe80::1]', 'http://192.168.1.20:8080'],
                warn,
            ),
        ).toEqual(['http://localhost:5159', 'http://192.168.1.20:8080']);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[0]?.[0]).toBe(
            'config.json: frameAncestors entry "http://[::1]:47812" is an IPv6 address, which browsers do not ' +
                'accept in frame-ancestors, so it never allowed embedding; use a hostname (such as localhost) or ' +
                'an IPv4 address. Skipping; it is removed from config.json the next time the list of allowed ' +
                'embedders changes',
        );
        expect(warn.mock.calls[1]?.[0]).toMatch(/"https:\/\/\[fe80::1\]" is an IPv6 address/);
    });

    it('does not give a non-IPv6 refusal the IPv6 reason', () => {
        const warn = vi.fn();
        sanitizeFrameAncestors(['http://a_b.lan', 'http://[::1]/path'], warn);
        expect(warn).toHaveBeenCalledTimes(2);
        for (const [msg] of warn.mock.calls) {
            expect(msg).toMatch(/must be an http\(s\) origin only/);
            expect(msg).not.toMatch(/IPv6/);
        }
    });
});

describe('isIpv6FrameAncestor', () => {
    it.each([
        ['http://[::1]:5159'],
        ['https://[fd00::20]'],
        ['  HTTP://[0:0:0:0:0:0:0:1]  '],
        ['http://[::ffff:1.2.3.4]'],
    ])('is true for %j', (value) => {
        expect(isIpv6FrameAncestor(value)).toBe(true);
    });

    it.each([
        ['http://localhost:5159'],
        ['http://192.168.1.20'],
        // Refused for another reason first: a path, a scheme, a separator.
        ['http://[::1]/embed'],
        ['ftp://[::1]'],
        ['http://[::1];sandbox'],
        ['not a url'],
        [''],
    ])('is false for %j', (value) => {
        expect(isIpv6FrameAncestor(value)).toBe(false);
    });
});

/**
 * The validator itself (0.5.3 review, I3). Its output is interpolated into a
 * `Content-Security-Policy: frame-ancestors` header, and before this round a
 * plain `new URL().origin` let a wildcard, a directive separator and a header
 * separator straight through. Every entry path -- config.json load, the consent
 * route and the settings batch -- calls this one function.
 */
describe('parseFrameAncestorOrigin', () => {
    it.each([
        ['http://*'],
        ['https://*'],
        ['http://*.com'],
        ['https://*.example.com:8443'],
        ['*'],
        // `;` ends a CSP directive: this would add a `sandbox` directive.
        ['http://a;sandbox'],
        // `,` splits a header value.
        ['http://a,b'],
        // Percent-encoded, the parser decodes them into the hostname.
        ['http://a%3Bsandbox'],
        ['http://a%2Cb'],
        // Whitespace, including the tab the URL parser would silently strip.
        ['http://a b'],
        ['http://a\tb'],
        ['http://a\nb'],
        // Quotes delimit CSP keywords.
        ['http://a"b'],
        ["http://a'b"],
        ['http://a`b'],
        // Hidden in userinfo, which the parser drops from the origin.
        ['http://x;sandbox@host'],
        // Not a hostname character.
        ['http://a_b.example'],
        ['http://a!b'],
        ['http://a$b'],
        ['http://a+b'],
        ['http://a(b)'],
    ])('refuses %j', (value) => {
        expect(parseFrameAncestorOrigin(value)).toBeNull();
    });

    it.each([
        ['http://localhost:5159', 'http://localhost:5159'],
        ['https://tools.example.com', 'https://tools.example.com'],
        ['HTTP://LocalHost:80/', 'http://localhost'],
        ['  https://Tools.Example:443  ', 'https://tools.example'],
        ['http://192.168.1.20:8080', 'http://192.168.1.20:8080'],
        ['http://xn--bcher-kva.example', 'http://xn--bcher-kva.example'],
        // A Unicode name normalizes to the same punycode a browser sends.
        ['http://bücher.example', 'http://xn--bcher-kva.example'],
        ['http://my-tool.lan', 'http://my-tool.lan'],
    ])('accepts %j as %j', (value, origin) => {
        expect(parseFrameAncestorOrigin(value)).toBe(origin);
    });

    // 0.5.3 review: the CSP host-source grammar has no IPv6 literals, so a
    // browser discards `http://[::1]:47812` from frame-ancestors (proved in
    // Chromium) and an "allowed" IPv6 embedder stays blocked. Refused at the one
    // parser, which covers config.json load, the consent route and the batch.
    it.each([
        ['http://[::1]:5159'],
        ['https://[fd00::20]'],
        ['http://[fe80::1]'],
        ['http://[2001:db8::1]:8080'],
        ['http://[0:0:0:0:0:0:0:1]'],
        ['http://[::ffff:192.168.1.5]'],
    ])('refuses the IPv6 origin %j', (value) => {
        expect(parseFrameAncestorOrigin(value)).toBeNull();
    });

    it('still refuses a path, query, fragment or non-http scheme', () => {
        for (const value of ['http://a/x', 'http://a/?q=1', 'http://a/#f', 'ftp://a', 'javascript:alert(1)']) {
            expect(parseFrameAncestorOrigin(value)).toBeNull();
        }
    });
});
