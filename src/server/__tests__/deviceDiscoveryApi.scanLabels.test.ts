import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Smoke row 19.5: a name typed when connecting is stored under the device's
// serial and its MAC, shows on the card, and survives disconnect -> rescan.
//
// Two paths lost it. A subnet-scan (TCP-probe) hit posts its probe address as
// `serial`, so the route skipped the `getprop ro.serialno` lookup and filed the
// name under `<ip>:5555`, a key the card never reads. And in a container there
// is no MAC, while nothing on the scan UI's path recorded which address a
// device answered at, so a rescan hit had no way back to the serial the name
// lives under. The fix records that address on every successful connect.
const { resolveMac, dnsLookup } = vi.hoisted(() => ({
    resolveMac: vi.fn(async (_ip: string): Promise<string | null> => null),
    dnsLookup: vi.fn(async (_host: string, _opts: unknown): Promise<{ address: string; family: number }> => {
        throw new Error('ENOTFOUND');
    }),
}));
vi.mock('../network/MacResolver', () => ({ resolveMac }));
vi.mock('dns/promises', () => ({ lookup: dnsLookup }));

import { AdbClient } from '../AdbClient';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';
import { resolveHitIdentity } from '../network/scanIdentity';
import { makeReqRes } from './helpers/httpMock';

const SERIAL = 'R5CN30ABCDE';
const MAC = 'aa:bb:cc:dd:ee:ff';
const HIT = '10.0.0.5:5555';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(where: 'host' | 'container'): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scanlabels-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    if (where === 'container') process.env['WS_SCRCPY_DOCKER'] = '1';
    else delete process.env['WS_SCRCPY_DOCKER'];
    Config._resetForTest();
    // The device answers at HIT, and its real serial is SERIAL. On a host the
    // ARP cache knows its MAC; the route never asks in a container.
    resolveMac.mockImplementation(async () => (where === 'host' ? MAC : null));
    vi.spyOn(AdbClient.prototype, 'connect').mockImplementation(async (a: string) => `connected to ${a}`);
}

afterEach(() => {
    vi.restoreAllMocks();
    resolveMac.mockReset();
    dnsLookup.mockReset();
    Config._resetForTest();
    for (const [k, v] of [
        [EnvName.CONFIG_PATH, saved.CONFIG],
        ['DEPS_PATH', saved.DEPS],
        ['WS_SCRCPY_DOCKER', saved.DOCKER],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** `getprop ro.serialno` over the connect address answers SERIAL. */
function fakeGetprop() {
    return vi.spyOn(AdbClient.prototype, 'shell').mockImplementation(async (_s: string, cmd: string) => {
        if (cmd === 'getprop ro.serialno') return SERIAL;
        throw new Error(`unexpected shell: ${cmd}`);
    });
}

async function post(url: string, body: unknown): Promise<number> {
    const r = makeReqRes('POST', url, body);
    await new DeviceDiscoveryApi().handle(r.req, r.res);
    return r.getStatus();
}

async function rename(serial: string, label: string): Promise<void> {
    const r = makeReqRes('PUT', '/api/devices/labels', { serial, label });
    await new DeviceDiscoveryApi().handle(r.req, r.res);
    expect(r.getStatus()).toBe(200);
}

/** The map the device card reads (`GET /api/devices/labels`). */
async function cardLabels(): Promise<Record<string, string>> {
    const r = makeReqRes('GET', '/api/devices/labels');
    await new DeviceDiscoveryApi().handle(r.req, r.res);
    return r.getJson() as Record<string, string>;
}

/**
 * The label a rescan's hit carries, resolved exactly as `index.ts` wires the
 * scanner: labels by key, and the observed-device row by probe address.
 */
function rescanLabel(hit: { address: string; serial: string; mac: string | null }): string {
    const db = Config.getInstance().db;
    return resolveHitIdentity({
        address: hit.address,
        hitSerial: hit.serial,
        mac: hit.mac,
        labelFor: (key) => db.devices.getLabel(IMPLICIT_ADMIN_ID, key),
        deviceByAddress: (address) => {
            const found = db.devices.findByAddress(address);
            return found ? { serial: found.serial, model: found.model } : undefined;
        },
    }).label;
}

/** A subnet-scan (TCP-probe) hit: its serial is the probe address. */
const tcpHit = (mac: string | null) => ({ address: HIT, serial: HIT, mac });

describe('connect with a name from a subnet-scan hit (row 19.5, defect a)', () => {
    for (const where of ['host', 'container'] as const) {
        it(`stores the name under the real serial, so the card shows it (${where})`, async () => {
            setup(where);
            const shell = fakeGetprop();

            const status = await post('/api/devices/connect', { address: HIT, serial: HIT, label: 'Living Room' });

            expect(status).toBe(200);
            expect(shell).toHaveBeenCalledWith(HIT, 'getprop ro.serialno');
            const labels = await cardLabels();
            // The card keys on ro.serialno (DeviceTracker buildLabelCell).
            expect(labels[SERIAL]).toBe('Living Room');
            // No new copy under the probe address: it would go stale on rename.
            expect(labels[HIT]).toBeUndefined();
        });

        it(`a rescan hit carries the name (${where})`, async () => {
            setup(where);
            fakeGetprop();
            await post('/api/devices/connect', { address: HIT, serial: HIT, label: 'Living Room' });

            expect(rescanLabel(tcpHit(where === 'host' ? MAC : null))).toBe('Living Room');
        });
    }

    it('on a host, still files the name under the MAC as well', async () => {
        setup('host');
        fakeGetprop();
        await post('/api/devices/connect', { address: HIT, serial: HIT, label: 'Living Room' });

        expect(Config.getInstance().db.devices.getLabel(IMPLICIT_ADMIN_ID, MAC)).toBe('Living Room');
    });

    it('on a host, a hostname that does not resolve still files the name under the MAC', async () => {
        setup('host');
        fakeGetprop();
        dnsLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND qa-android'));

        const status = await post('/api/devices/connect', { address: 'qa-android:5555', label: 'Den' });

        expect(status).toBe(200);
        expect(Config.getInstance().db.devices.getLabel(IMPLICIT_ADMIN_ID, SERIAL)).toBe('Den');
        expect(Config.getInstance().db.devices.getLabel(IMPLICIT_ADMIN_ID, MAC)).toBe('Den');
    });

    it('when getprop fails, writes nothing under the probe address and still answers 200', async () => {
        setup('container');
        vi.spyOn(AdbClient.prototype, 'shell').mockRejectedValue(new Error('device unauthorized'));

        const status = await post('/api/devices/connect', { address: HIT, serial: HIT, label: 'Living Room' });

        expect(status).toBe(200);
        expect(await cardLabels()).toEqual({});
    });
});

describe('manual add, then rescan (row 19.5, defect b)', () => {
    for (const where of ['host', 'container'] as const) {
        it(`the rescan hit carries the name (${where})`, async () => {
            setup(where);
            fakeGetprop();

            // Manual add posts no serial (NetworkDiscoveryPanel.connectManual).
            await post('/api/devices/connect', { address: HIT, label: 'Kitchen' });

            expect((await cardLabels())[SERIAL]).toBe('Kitchen');
            expect(rescanLabel(tcpHit(where === 'host' ? MAC : null))).toBe('Kitchen');
        });
    }

    it('a device added by hostname is found again at its IP (container)', async () => {
        // A scan probes IPs; `adb connect qa-android:5555` is the hostname form.
        setup('container');
        fakeGetprop();
        dnsLookup.mockImplementation(async (host: string) => {
            if (host === 'qa-android') return { address: '10.0.0.5', family: 4 };
            throw new Error('ENOTFOUND');
        });

        await post('/api/devices/connect', { address: 'qa-android:5555', label: 'Kitchen' });

        expect(rescanLabel(tcpHit(null))).toBe('Kitchen');
    });
});

describe('rename on the card, then rescan (one source of truth)', () => {
    for (const where of ['host', 'container'] as const) {
        it(`the hit carries the NEW name (${where})`, async () => {
            setup(where);
            fakeGetprop();
            await post('/api/devices/connect', { address: HIT, serial: HIT, label: 'Old Name' });

            // The card's rename writes the serial key only.
            await rename(SERIAL, 'New Name');

            expect(rescanLabel(tcpHit(where === 'host' ? MAC : null))).toBe('New Name');
        });
    }

    it('naming a device only on its card survives disconnect and rescan (finding 19.4)', async () => {
        // Connected with no name, named afterwards from the device row.
        setup('container');
        fakeGetprop();
        await post('/api/devices/connect', { address: HIT });

        await rename(SERIAL, 'Den');

        expect(rescanLabel(tcpHit(null))).toBe('Den');
    });
});

describe('the mDNS and MAC paths are unchanged', () => {
    it('an mDNS hit saves the name under its real serial before connecting, with no getprop', async () => {
        setup('container');
        const shell = fakeGetprop();
        vi.spyOn(AdbClient.prototype, 'connect').mockResolvedValue('failed to connect to 10.0.0.5:37123');

        const status = await post('/api/devices/connect', {
            address: '10.0.0.5:37123',
            serial: SERIAL,
            label: 'Office',
        });

        expect(status).toBe(500);
        expect(shell).not.toHaveBeenCalled();
        expect(await cardLabels()).toEqual({ [SERIAL]: 'Office' });
    });

    it('an mDNS hit carries the name on rescan (its serial is the real one)', async () => {
        setup('host');
        const shell = fakeGetprop();
        await post('/api/devices/connect', { address: '10.0.0.5:37123', serial: SERIAL, label: 'Office' });

        expect(shell).not.toHaveBeenCalled();
        expect(rescanLabel({ address: '10.0.0.5:37123', serial: SERIAL, mac: null })).toBe('Office');
    });

    it('a hit whose only saved name is under its MAC still carries it', async () => {
        setup('host');
        Config.getInstance().db.devices.setLabel(IMPLICIT_ADMIN_ID, MAC, 'By MAC');

        expect(rescanLabel(tcpHit(MAC))).toBe('By MAC');
    });
});
