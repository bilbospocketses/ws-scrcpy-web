import { describe, expect, it } from 'vitest';
import { ACTION } from '../../../../common/Action';
import { ChannelCode } from '../../../../common/ChannelCode';
import { buildFslsInitData, buildMultiplexUrl, isValidWsHostname } from '../multiplexConnection';

describe('isValidWsHostname', () => {
    it('accepts hostnames, IPv4, and bracketed IPv6', () => {
        expect(isValidWsHostname('192.168.1.5')).toBe(true);
        expect(isValidWsHostname('device.local')).toBe(true);
        expect(isValidWsHostname('localhost')).toBe(true);
        expect(isValidWsHostname('[::1]')).toBe(true);
    });

    it('rejects URL-injection vectors and empties', () => {
        expect(isValidWsHostname('')).toBe(false);
        expect(isValidWsHostname('evil.com/path')).toBe(false);
        expect(isValidWsHostname('user@evil.com')).toBe(false);
        expect(isValidWsHostname('evil.com?x=1')).toBe(false);
        expect(isValidWsHostname('evil.com#frag')).toBe(false);
        expect(isValidWsHostname('evil .com')).toBe(false);
        expect(isValidWsHostname('evil.com:1234')).toBe(false);
        expect(isValidWsHostname('evil.com\\x')).toBe(false);
    });
});

describe('buildMultiplexUrl', () => {
    it('builds a ws URL with the multiplex action for an explicit host/port', () => {
        const url = buildMultiplexUrl({ hostname: '192.168.1.5', port: 8000, pathname: '/' });
        expect(url).toBe(`ws://192.168.1.5:8000/?action=${ACTION.MULTIPLEX}`);
    });

    it('uses wss when secure', () => {
        const url = buildMultiplexUrl({ hostname: '10.0.0.2', port: 8443, secure: true, pathname: '/' });
        expect(url).toBe(`wss://10.0.0.2:8443/?action=${ACTION.MULTIPLEX}`);
    });

    it('rejects an invalid hostname (SSRF guard)', () => {
        expect(() => buildMultiplexUrl({ hostname: 'evil.com/x', port: 8000, pathname: '/' })).toThrow(/hostname/);
    });

    it('rejects an out-of-range or non-integer port', () => {
        expect(() => buildMultiplexUrl({ hostname: '10.0.0.2', port: 70000, pathname: '/' })).toThrow(/port/);
        expect(() => buildMultiplexUrl({ hostname: '10.0.0.2', port: 0, pathname: '/' })).toThrow(/port/);
        expect(() => buildMultiplexUrl({ hostname: '10.0.0.2', port: 1.5, pathname: '/' })).toThrow(/port/);
    });
});

describe('buildFslsInitData', () => {
    it('encodes the FSLS channel code, a little-endian length, and the serial', () => {
        const data = buildFslsInitData('abc');
        expect(new TextDecoder().decode(data.slice(0, 4))).toBe(ChannelCode.FSLS);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        expect(view.getUint32(4, true)).toBe(3);
        expect(new TextDecoder().decode(data.slice(8))).toBe('abc');
    });
});
