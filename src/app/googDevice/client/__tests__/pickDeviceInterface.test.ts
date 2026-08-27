import { describe, expect, it } from 'vitest';
import { isPrivateLanAddress, pickDeviceInterface } from '../pickDeviceInterface';

/**
 * The exact device state that produced the bug: a Pixel 10a with mobile data
 * on, reporting its cellular interface alongside Wi-Fi, and an empty
 * `wifi.interface` property.
 *
 *   rmnet16  100.90.22.137/32   <- carrier CGNAT, not routable from the LAN
 *   wlan0    192.168.86.190/24  <- what we want
 *
 * The old picker fell back to `interfaces[0]` of an alphabetically sorted list,
 * so `rmnet16` won and the stream URL pointed at an unreachable address.
 */

const WLAN = { name: 'wlan0', ipv4: '192.168.86.190' };
const CELLULAR = { name: 'rmnet16', ipv4: '100.90.22.137' };
const ETH = { name: 'eth0', ipv4: '192.168.86.43' };
const TUN = { name: 'tun0', ipv4: '100.90.22.137' };
const USB = { name: 'rndis0', ipv4: '192.168.42.129' };

describe('pickDeviceInterface', () => {
    it('prefers wlan over cellular even when cellular sorts first', () => {
        // Alphabetical order, exactly as the server hands it over.
        expect(pickDeviceInterface([CELLULAR, WLAN])).toEqual(WLAN);
    });

    it('still prefers wlan when wifi.interface is empty', () => {
        expect(pickDeviceInterface([CELLULAR, WLAN], '')).toEqual(WLAN);
        expect(pickDeviceInterface([CELLULAR, WLAN], undefined)).toEqual(WLAN);
    });

    it('honours wifi.interface when the device actually reports one', () => {
        // Device naming its own Wi-Fi interface beats any heuristic, even one
        // pointing at an interface the ranking would not have chosen.
        expect(pickDeviceInterface([CELLULAR, WLAN], 'rmnet16')).toEqual(CELLULAR);
    });

    it('ignores a wifi.interface naming an interface that is not present', () => {
        expect(pickDeviceInterface([CELLULAR, WLAN], 'wlan9')).toEqual(WLAN);
    });

    it('picks the only interface on a single-homed device', () => {
        // The Google TV Streamer — why this bug stayed hidden.
        expect(pickDeviceInterface([ETH])).toEqual(ETH);
    });

    it('prefers wlan over wired when both are present', () => {
        expect(pickDeviceInterface([ETH, WLAN])).toEqual(WLAN);
    });

    it('prefers wired over cellular', () => {
        expect(pickDeviceInterface([CELLULAR, ETH])).toEqual(ETH);
    });

    it('prefers a real network interface over USB tethering', () => {
        expect(pickDeviceInterface([USB, WLAN])).toEqual(WLAN);
    });

    it('deprioritises tunnels, which share the CGNAT range with carriers', () => {
        expect(pickDeviceInterface([TUN, WLAN])).toEqual(WLAN);
    });

    it('returns undefined when the device reports no interfaces', () => {
        expect(pickDeviceInterface([])).toBeUndefined();
    });

    it('falls back to a private address when no name family is recognised', () => {
        const odd = { name: 'zz-unknown0', ipv4: '10.0.0.5' };
        const oddCgnat = { name: 'aa-unknown0', ipv4: '100.70.1.2' };
        expect(pickDeviceInterface([oddCgnat, odd])).toEqual(odd);
    });

    it('keeps the device ordering when candidates tie', () => {
        const first = { name: 'wlan0', ipv4: '192.168.1.2' };
        const second = { name: 'wlan1', ipv4: '192.168.1.3' };
        expect(pickDeviceInterface([first, second])).toEqual(first);
    });
});

describe('isPrivateLanAddress', () => {
    it('accepts the RFC1918 ranges', () => {
        expect(isPrivateLanAddress('10.0.0.1')).toBe(true);
        expect(isPrivateLanAddress('192.168.86.190')).toBe(true);
        expect(isPrivateLanAddress('172.16.0.1')).toBe(true);
        expect(isPrivateLanAddress('172.31.255.254')).toBe(true);
    });

    it('rejects CGNAT, which is what carriers and Tailscale both use', () => {
        expect(isPrivateLanAddress('100.90.22.137')).toBe(false);
        expect(isPrivateLanAddress('100.64.0.1')).toBe(false);
    });

    it('rejects addresses just outside the 172.16/12 block', () => {
        expect(isPrivateLanAddress('172.15.0.1')).toBe(false);
        expect(isPrivateLanAddress('172.32.0.1')).toBe(false);
    });

    it('rejects public addresses and malformed input', () => {
        expect(isPrivateLanAddress('8.8.8.8')).toBe(false);
        expect(isPrivateLanAddress('not-an-ip')).toBe(false);
        expect(isPrivateLanAddress('192.168.1')).toBe(false);
        expect(isPrivateLanAddress('192.168.1.999')).toBe(false);
    });
});
