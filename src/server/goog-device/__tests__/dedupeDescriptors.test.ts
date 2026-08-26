import { describe, expect, it } from 'vitest';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { dedupeByHardwareSerial, isNetworkTransportUdid, survivesDedupe } from '../dedupeDescriptors';

/**
 * One physical Android 11+ device reaches `adb devices` twice: once as the
 * `ip:port` transport we opened with `adb connect`, and once as the
 * `_adb-tls-connect._tcp` transport adb's own mDNS auto-connect opened. Both
 * report the same `ro.serialno`, so the hardware serial is the only safe key —
 * two Google TV Streamers on one network share a model string, so model is not.
 *
 * Observed on a Pixel 10a, 2026-08-26:
 *   192.168.86.190:37571                            ro.serialno=5C061JEA327610
 *   adb-5C061JEA327610-bo0E0q._adb-tls-connect._tcp ro.serialno=5C061JEA327610
 */

function descriptor(udid: string, serialNo: string, over: Partial<GoogDeviceDescriptor> = {}) {
    return {
        udid,
        state: 'device',
        'ro.serialno': serialNo,
        'ro.product.model': 'Pixel_10a',
        'ro.product.manufacturer': 'Google',
        'ro.build.version.release': '17',
        'ro.build.version.sdk': '37',
        'ro.product.cpu.abi': 'arm64-v8a',
        'wifi.interface': 'wlan0',
        interfaces: [],
        pid: 0,
        'last.update.timestamp': 0,
        'screen.state': 'awake',
        ...over,
    } as GoogDeviceDescriptor;
}

const IP_PORT = '192.168.86.190:37571';
const MDNS = 'adb-5C061JEA327610-bo0E0q._adb-tls-connect._tcp';
const SERIAL = '5C061JEA327610';

describe('dedupeByHardwareSerial', () => {
    it('collapses the two transports of one device to a single entry', () => {
        const out = dedupeByHardwareSerial([descriptor(IP_PORT, SERIAL), descriptor(MDNS, SERIAL)]);
        expect(out).toHaveLength(1);
    });

    it('keeps the ip:port transport, not the mDNS one', () => {
        // The mDNS-form entry has no host:port to disconnect from, which is why
        // its card renders without a disconnect button. Keeping the ip:port
        // transport fixes the duplicate and that missing action together.
        const out = dedupeByHardwareSerial([descriptor(MDNS, SERIAL), descriptor(IP_PORT, SERIAL)]);
        expect(out.map((d) => d.udid)).toEqual([IP_PORT]);
    });

    it('keeps the ip:port transport regardless of input order', () => {
        const out = dedupeByHardwareSerial([descriptor(IP_PORT, SERIAL), descriptor(MDNS, SERIAL)]);
        expect(out.map((d) => d.udid)).toEqual([IP_PORT]);
    });

    it('never merges two physical devices that share a model', () => {
        // Two Google TV Streamers on one network: same model, different serials.
        const a = descriptor('192.168.86.43:5555', 'TV-AAAA', { 'ro.product.model': 'Google_TV_Streamer' });
        const b = descriptor('192.168.86.159:5555', 'TV-BBBB', { 'ro.product.model': 'Google_TV_Streamer' });
        const out = dedupeByHardwareSerial([a, b]);
        expect(out.map((d) => d.udid).sort()).toEqual(['192.168.86.159:5555', '192.168.86.43:5555']);
    });

    it('passes through a device whose serial is not known yet', () => {
        // Descriptors start with 'ro.serialno': '' and are filled in once
        // getprop lands. An unidentified device must still be listed, never
        // silently merged with another unidentified one.
        const out = dedupeByHardwareSerial([descriptor(IP_PORT, ''), descriptor('10.0.0.5:5555', '')]);
        expect(out).toHaveLength(2);
    });

    it('leaves a single-transport device untouched', () => {
        const out = dedupeByHardwareSerial([descriptor(MDNS, SERIAL)]);
        expect(out.map((d) => d.udid)).toEqual([MDNS]);
    });

    it('preserves the surviving descriptor object identity', () => {
        // Callers hold references to descriptors; dedupe must select, not rebuild.
        const winner = descriptor(IP_PORT, SERIAL);
        const out = dedupeByHardwareSerial([descriptor(MDNS, SERIAL), winner]);
        expect(out[0]).toBe(winner);
    });
});

describe('survivesDedupe', () => {
    // Gates the incremental `device` event. Without it, the losing transport's
    // own update would push a second card to a client that already has the
    // survivor from the initial device list.
    const all = [descriptor(IP_PORT, SERIAL), descriptor(MDNS, SERIAL)];

    it('is true for the transport the list keeps', () => {
        expect(survivesDedupe(descriptor(IP_PORT, SERIAL), all)).toBe(true);
    });

    it('is false for the transport the list drops', () => {
        expect(survivesDedupe(descriptor(MDNS, SERIAL), all)).toBe(false);
    });

    it('is true for a device with only one transport', () => {
        const solo = [descriptor(MDNS, SERIAL)];
        expect(survivesDedupe(descriptor(MDNS, SERIAL), solo)).toBe(true);
    });

    it('is true for a device whose serial is not known yet', () => {
        const unknown = [descriptor(IP_PORT, ''), descriptor('10.0.0.5:5555', '')];
        expect(survivesDedupe(descriptor('10.0.0.5:5555', ''), unknown)).toBe(true);
    });
});

describe('isNetworkTransportUdid', () => {
    it.each(['192.168.86.190:37571', '10.0.0.5:5555', '100.64.1.20:33001'])('accepts %s', (udid) => {
        expect(isNetworkTransportUdid(udid)).toBe(true);
    });

    it.each(['adb-5C061JEA327610-bo0E0q._adb-tls-connect._tcp', '5C061JEA327610', 'emulator-5554', ''])(
        'rejects %s',
        (udid) => {
            expect(isNetworkTransportUdid(udid)).toBe(false);
        },
    );
});
