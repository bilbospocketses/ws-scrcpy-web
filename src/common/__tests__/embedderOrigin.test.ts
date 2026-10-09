import { describe, expect, it } from 'vitest';
import {
    buildEmbedderOrigins,
    embedderOriginsFromInput,
    HOSTNAME_RULES_HINT,
    IPV6_EMBEDDER_ERROR,
    isEmbedderScheme,
    parseEmbedderAddress,
    parseEmbedderPort,
} from '../embedderOrigin';

/**
 * Settings → Embedding's add row (0.5.3). The validators decide what the
 * inline error says and whether add is enabled; the builder decides the exact
 * origin strings that are staged, which have to match what a browser sends and
 * what the server stores (`parseFrameAncestorOrigin` -- pinned against these
 * same outputs in src/server/__tests__/settingsBatchApi.embedOrigins.test.ts).
 */

function address(value: string): string {
    const result = parseEmbedderAddress(value);
    if (!result.ok) throw new Error(`expected ${JSON.stringify(value)} to be accepted: ${result.error}`);
    return result.value;
}

function addressError(value: string): string {
    const result = parseEmbedderAddress(value);
    if (result.ok) throw new Error(`expected ${JSON.stringify(value)} to be refused, got ${result.value}`);
    return result.error;
}

describe('parseEmbedderAddress: IPv4', () => {
    it.each(['127.0.0.1', '192.168.1.50', '0.0.0.0', '255.255.255.255', '10.0.0.1'])('accepts %s', (v) => {
        expect(address(v)).toBe(v);
    });

    it.each([
        ['256.1.1.1', 'an octet over 255'],
        ['1.2.3', 'three parts (a URL parser would read it as 1.2.0.3)'],
        ['1.2.3.4.5', 'five parts'],
        ['01.2.3.4', 'a leading zero (a URL parser reads it as octal)'],
        ['1.2.3.-4', 'a negative octet'],
        ['999.1.1.1', 'an all-numeric name'],
        ['0x7f.0.0.1', 'a hex octet'],
        ['1..3.4', 'an empty octet'],
    ])('refuses %s (%s)', (v) => {
        expect(addressError(v)).toMatch(/not a valid ipv4 address|not a valid ip address or hostname/);
    });
});

/**
 * IPv6 is refused (0.5.3 review): the CSP host-source grammar has no IPv6
 * literals, so a browser discards a `frame-ancestors` source such as
 * `http://[::1]:47812` and the embedder stays blocked while the list says it is
 * allowed. Every form gets the one specific message, not the generic one.
 */
describe('parseEmbedderAddress: IPv6 is refused', () => {
    it('pins the message', () => {
        expect(IPV6_EMBEDDER_ERROR).toBe(
            "browsers don't accept ipv6 addresses for embedding; use a hostname (such as localhost) or an ipv4 address.",
        );
    });

    it.each([
        ['::1', 'bare loopback'],
        ['[::1]', 'bracketed loopback'],
        ['fe80::1', 'bare link-local'],
        ['[fe80::1]', 'bracketed link-local'],
        ['2001:db8::1', 'a compressed global address'],
        ['2001:0DB8:0000:0000:0000:0000:0000:0001', 'a full, uppercase address'],
        ['[0:0:0:0:0:0:0:1]', 'a full, bracketed address'],
        ['::ffff:192.168.1.5', 'an IPv4-mapped address'],
        ['fe80::1%eth0', 'a zone id'],
        ['[::1]:5159', 'a bracketed address with a port (IPv6 is the first problem, not the port)'],
        ['[::1', 'an unclosed bracket'],
        ['::1]', 'an unopened bracket'],
        ['  ::1  ', 'surrounding spaces'],
    ])('refuses %s (%s) with the IPv6 message', (v) => {
        expect(addressError(v)).toBe(IPV6_EMBEDDER_ERROR);
    });

    it.each([
        ['2001:db8::g1', 'a non-hex digit'],
        ['[]', 'nothing in the brackets'],
        ['[localhost]', 'a bracketed name'],
    ])('gives %s (%s) the generic message: it is not an IPv6 address either', (v) => {
        expect(addressError(v)).toMatch(/not a valid ip address or hostname/);
    });

    it('refuses an IPv6 address as a whole add row, in the address box', () => {
        expect(embedderOriginsFromInput({ address: '::1', port: '', scheme: 'https' })).toEqual({
            ok: false,
            field: 'address',
            error: IPV6_EMBEDDER_ERROR,
        });
    });
});

describe('parseEmbedderAddress: hostnames and FQDNs', () => {
    it.each([
        ['localhost', 'localhost'],
        ['my-tool', 'my-tool'],
        ['tools.example.com', 'tools.example.com'],
        ['Tools.Example.COM', 'tools.example.com'],
        ['a.b.c.d.example', 'a.b.c.d.example'],
        ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
        ['1.2.3.4.example', '1.2.3.4.example'],
        ['  localhost  ', 'localhost'],
    ])('accepts %s', (v, expected) => {
        expect(address(v)).toBe(expected);
    });

    it('accepts a 63-character label and refuses a 64-character one', () => {
        expect(address(`${'a'.repeat(63)}.example`)).toBe(`${'a'.repeat(63)}.example`);
        expect(addressError(`${'a'.repeat(64)}.example`)).toMatch(/not a valid ip address or hostname/);
    });

    it('refuses a name longer than 253 characters', () => {
        const long = Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.'); // 304 chars
        expect(addressError(long)).toMatch(/not a valid ip address or hostname/);
    });

    it.each([
        ['-tools.example', 'a label starting with a hyphen'],
        ['tools-.example', 'a label ending with a hyphen'],
        ['tools_box', 'an underscore'],
        ['tools..example', 'an empty label'],
        ['tools.example.', 'a trailing dot'],
        ['*', 'a wildcard'],
        ['*.example.com', 'a wildcard label'],
        ['tools box', 'a space'],
        ['bücher.example', 'a non-ASCII name'],
    ])('refuses %s (%s)', (v) => {
        expect(addressError(v)).toMatch(/not a valid ip address or hostname/);
    });

    // 0.5.3 review (M7): the refusal says what a hostname may hold, naming the
    // two rules a user cannot guess -- no underscores, and punycode for an
    // internationalized name. The rules themselves are unchanged.
    it.each([['tools_box'], ['bücher.example']])('tells %s about underscores and punycode', (v) => {
        expect(addressError(v)).toBe(
            `"${v}" is not a valid ip address or hostname. a hostname uses only letters, digits, hyphens and dots (no underscores); type an internationalized name in its punycode form (xn--…).`,
        );
        expect(addressError(v)).toBe(`"${v}" is not a valid ip address or hostname. ${HOSTNAME_RULES_HINT}`);
    });

    it('accepts the punycode form the hint asks for', () => {
        expect(address('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    });
});

describe('parseEmbedderAddress: the near misses get a pointed message', () => {
    it('refuses an empty box', () => {
        expect(addressError('')).toBe('enter an ip address or hostname.');
        expect(addressError('   ')).toBe('enter an ip address or hostname.');
    });

    it('refuses a whole URL', () => {
        expect(addressError('http://localhost:5159')).toMatch(/choose the scheme from the list/);
        expect(addressError('localhost/app')).toMatch(/leave out any path/);
    });

    it('refuses host:port, naming the port box', () => {
        expect(addressError('localhost:5159')).toBe('enter the port in the port box, not after the address.');
        expect(addressError('192.168.1.5:8080')).toBe('enter the port in the port box, not after the address.');
    });
});

describe('parseEmbedderPort', () => {
    it('reads blank as the default port', () => {
        expect(parseEmbedderPort('')).toEqual({ ok: true, value: null });
        expect(parseEmbedderPort('   ')).toEqual({ ok: true, value: null });
    });

    it.each([
        ['1', 1],
        ['80', 80],
        ['5159', 5159],
        ['65535', 65535],
        [' 8080 ', 8080],
    ])('accepts %s', (v, n) => {
        expect(parseEmbedderPort(v)).toEqual({ ok: true, value: n });
    });

    it.each([
        ['0', 'below the range'],
        ['65536', 'above the range'],
        ['99999', 'five digits, above the range'],
        ['123456', 'six digits'],
        ['-1', 'negative'],
        ['80.5', 'a fraction'],
        ['8e3', 'an exponent'],
        ['+80', 'a sign'],
        ['0x50', 'hex'],
        ['eighty', 'words'],
        ['80 81', 'two numbers'],
    ])('refuses %s (%s)', (v) => {
        expect(parseEmbedderPort(v)).toEqual({ ok: false, error: 'port must be a whole number from 1 to 65535.' });
    });
});

describe('buildEmbedderOrigins', () => {
    it('emits no port when none is given', () => {
        expect(buildEmbedderOrigins('localhost', null, 'http')).toEqual(['http://localhost']);
        expect(buildEmbedderOrigins('localhost', null, 'https')).toEqual(['https://localhost']);
    });

    it('drops a port that is the scheme default, as a browser does', () => {
        expect(buildEmbedderOrigins('tools.example', 80, 'http')).toEqual(['http://tools.example']);
        expect(buildEmbedderOrigins('tools.example', 443, 'https')).toEqual(['https://tools.example']);
    });

    it('keeps a port that is not the scheme default', () => {
        expect(buildEmbedderOrigins('localhost', 5159, 'http')).toEqual(['http://localhost:5159']);
        expect(buildEmbedderOrigins('localhost', 443, 'http')).toEqual(['http://localhost:443']);
        expect(buildEmbedderOrigins('localhost', 80, 'https')).toEqual(['https://localhost:80']);
    });

    it('adds two origins for http & https, http first, each with its own default elided', () => {
        expect(buildEmbedderOrigins('localhost', 5159, 'both')).toEqual([
            'http://localhost:5159',
            'https://localhost:5159',
        ]);
        expect(buildEmbedderOrigins('localhost', null, 'both')).toEqual(['http://localhost', 'https://localhost']);
        expect(buildEmbedderOrigins('localhost', 80, 'both')).toEqual(['http://localhost', 'https://localhost:80']);
        expect(buildEmbedderOrigins('localhost', 443, 'both')).toEqual(['http://localhost:443', 'https://localhost']);
    });
});

describe('embedderOriginsFromInput', () => {
    it('combines the three boxes', () => {
        expect(embedderOriginsFromInput({ address: 'LocalHost', port: '5159', scheme: 'both' })).toEqual({
            ok: true,
            origins: ['http://localhost:5159', 'https://localhost:5159'],
        });
        expect(embedderOriginsFromInput({ address: '192.168.1.50', port: '', scheme: 'https' })).toEqual({
            ok: true,
            origins: ['https://192.168.1.50'],
        });
    });

    it('names the box an error is in, address first', () => {
        expect(embedderOriginsFromInput({ address: 'bad_host', port: '0', scheme: 'http' })).toMatchObject({
            ok: false,
            field: 'address',
        });
        expect(embedderOriginsFromInput({ address: 'localhost', port: '70000', scheme: 'http' })).toEqual({
            ok: false,
            field: 'port',
            error: 'port must be a whole number from 1 to 65535.',
        });
    });
});

describe('isEmbedderScheme', () => {
    it('accepts the three dropdown values only', () => {
        expect(['http', 'https', 'both'].every(isEmbedderScheme)).toBe(true);
        expect(['HTTP', 'ftp', '', 'http & https', undefined].some(isEmbedderScheme)).toBe(false);
    });
});
