import { describe, expect, it } from 'vitest';
import { expandConnectedAddresses, resolveHitIdentity } from '../network/scanIdentity';

/**
 * Findings 7.6, 7.7 and 19.4 share one cause: a scan hit's identity is the
 * probe address (`NetworkScanner` sets `serial: address`), while a device's
 * identity everywhere else is its `ro.serialno`. Nothing bridged the two except
 * a MAC alias written only when a label happened to be supplied at connect
 * time, so a device named from the list, disconnected, then re-scanned came
 * back unnamed — the label was filed under a key the scan never asks for.
 *
 * The `devices` table already records serial -> address for every device it has
 * observed, which is the bridge these helpers use.
 */

describe('expandConnectedAddresses (finding 7.7)', () => {
    it('keeps an address that is already an IP, without a lookup', async () => {
        const looked: string[] = [];
        const set = await expandConnectedAddresses(['192.168.87.3:5555'], async (h) => {
            looked.push(h);
            return null;
        });
        expect(set.has('192.168.87.3:5555')).toBe(true);
        expect(looked).toEqual([]);
    });

    it('adds the resolved IP form for a device connected by hostname', async () => {
        // The exact case: `adb connect qa-android:5555` leaves the device listed
        // under that serial, so a hit at <ip>:5555 was not suppressed and the
        // same device appeared as both connected and freshly discovered.
        const set = await expandConnectedAddresses(['qa-android:5555'], async (h) =>
            h === 'qa-android' ? '192.168.87.3' : null,
        );
        expect(set.has('qa-android:5555')).toBe(true);
        expect(set.has('192.168.87.3:5555')).toBe(true);
    });

    it('keeps the hostname form when the lookup fails', async () => {
        const set = await expandConnectedAddresses(['nosuchhost:5555'], async () => null);
        expect(set.has('nosuchhost:5555')).toBe(true);
        expect(set.size).toBe(1);
    });

    it('ignores a serial that is not an address at all (a USB device)', async () => {
        const set = await expandConnectedAddresses(['R5CN30ABCDE'], async () => {
            throw new Error('should not look up a USB serial');
        });
        expect(set.has('R5CN30ABCDE')).toBe(true);
    });

    it('survives a lookup that throws', async () => {
        const set = await expandConnectedAddresses(['qa-android:5555'], async () => {
            throw new Error('EAI_AGAIN');
        });
        expect(set.has('qa-android:5555')).toBe(true);
    });
});

describe('resolveHitIdentity (findings 19.4 and 7.6)', () => {
    const observed = (address: string) =>
        address === '192.168.87.3:5555' ? { serial: 'R5CN30ABCDE', model: 'Pixel 8' } : undefined;

    it('prefers an explicit label over everything else', () => {
        const out = resolveHitIdentity({
            address: '192.168.87.3:5555',
            hitSerial: '192.168.87.3:5555',
            mac: 'aa:bb:cc:dd:ee:ff',
            explicitLabel: 'from the caller',
            labelFor: () => 'should not be used',
            deviceByAddress: observed,
        });
        expect(out.label).toBe('from the caller');
    });

    it('falls back to the MAC alias before anything else is tried', () => {
        const out = resolveHitIdentity({
            address: '192.168.87.3:5555',
            hitSerial: '192.168.87.3:5555',
            mac: 'aa:bb:cc:dd:ee:ff',
            labelFor: (key) => (key === 'aa:bb:cc:dd:ee:ff' ? 'by mac' : undefined),
            deviceByAddress: observed,
        });
        expect(out.label).toBe('by mac');
    });

    it("finds a label saved under the device's real serial (19.4)", () => {
        // Name the device from the list, disconnect it, scan: the hit carries
        // the probe address, the label is under ro.serialno. This is the bridge.
        const out = resolveHitIdentity({
            address: '192.168.87.3:5555',
            hitSerial: '192.168.87.3:5555',
            mac: null,
            labelFor: (key) => (key === 'R5CN30ABCDE' ? 'Living Room' : undefined),
            deviceByAddress: observed,
        });
        expect(out.label).toBe('Living Room');
    });

    it('carries the remembered model for a hit with no live banner (7.6)', () => {
        const out = resolveHitIdentity({
            address: '192.168.87.3:5555',
            hitSerial: '192.168.87.3:5555',
            mac: null,
            labelFor: () => undefined,
            deviceByAddress: observed,
        });
        expect(out.model).toBe('Pixel 8');
    });

    it('reports no label and no model for a device never observed', () => {
        const out = resolveHitIdentity({
            address: '10.0.0.9:5555',
            hitSerial: '10.0.0.9:5555',
            mac: null,
            labelFor: () => undefined,
            deviceByAddress: observed,
        });
        expect(out.label).toBe('');
        expect(out.model).toBeNull();
    });

    it('works with no observed-device lookup wired at all', () => {
        const out = resolveHitIdentity({
            address: '192.168.87.3:5555',
            hitSerial: '192.168.87.3:5555',
            mac: null,
            labelFor: () => undefined,
        });
        expect(out.label).toBe('');
        expect(out.model).toBeNull();
    });
});

describe('scanHitDisplayName (finding 7.6, client half)', () => {
    it('prefers the live probe name when there is one', async () => {
        const { scanHitDisplayName } = await import('../../app/client/NetworkDiscoveryPanel');
        expect(scanHitDisplayName({ name: 'Pixel 8', model: 'stale' })).toBe('Pixel 8');
    });

    it('falls back to the remembered model when the probe returned no banner', async () => {
        const { scanHitDisplayName } = await import('../../app/client/NetworkDiscoveryPanel');
        expect(scanHitDisplayName({ name: '', model: 'Pixel 8' })).toBe('Pixel 8');
    });

    it('renders nothing when neither is known, so CSS hides the top line', async () => {
        const { scanHitDisplayName } = await import('../../app/client/NetworkDiscoveryPanel');
        expect(scanHitDisplayName({})).toBe('');
    });
});
