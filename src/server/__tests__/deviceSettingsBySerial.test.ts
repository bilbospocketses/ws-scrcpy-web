import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// M11: a device's stream settings follow the device, not the adb transport.
// They were keyed by the transport udid, so the same phone had one set over
// USB, another over Wi-Fi, and lost the Wi-Fi set whenever DHCP moved it.
vi.mock('../network/MacResolver', () => ({ resolveMac: vi.fn(async () => null) }));
vi.mock('dns/promises', () => ({
    lookup: vi.fn(async () => {
        throw new Error('ENOTFOUND');
    }),
}));

import { AdbClient } from '../AdbClient';
import { _resetPendingLabelsForTest, serialReadOn } from '../api/pendingLabels';
import { SERIAL_RETRY_AFTER_S, SettingsApi } from '../api/SettingsApi';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';
import { Device } from '../goog-device/Device';
import { ControlCenter } from '../goog-device/services/ControlCenter';
import { makeReqRes } from './helpers/httpMock';

const SERIAL = 'R5CN30ABCDE';
const WIFI = '10.0.0.5:5555';
const MOVED = '10.0.0.77:5555';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-setserial-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['WS_SCRCPY_DOCKER'] = '1';
    Config._resetForTest();
    vi.spyOn(AdbClient.prototype, 'shell').mockImplementation(async (_s: string, cmd: string) => {
        if (cmd.startsWith('ip -4')) return '34: wlan0    inet 10.0.0.5/24 brd 10.0.0.255 scope global wlan0\n';
        throw new Error(`unexpected shell: ${cmd}`);
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    _resetPendingLabelsForTest();
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

/** The device tracker sees the transport at `udid` and reads its properties. */
async function sight(udid: string): Promise<Device> {
    const props = vi
        .spyOn(AdbClient.prototype, 'getProperties')
        .mockResolvedValue({ 'ro.serialno': SERIAL, 'ro.product.model': 'Pixel 7' });
    const device = new Device(udid, 'device');
    await vi.waitFor(() => expect(props).toHaveBeenCalledWith(udid));
    await new Promise((r) => setImmediate(r));
    return device;
}

async function getSettings(key: string): Promise<unknown> {
    const r = makeReqRes('GET', `/api/settings/device?udid=${encodeURIComponent(key)}`);
    await new SettingsApi().handle(r.req, r.res);
    expect(r.getStatus()).toBe(200);
    return r.getJson();
}

async function patchSettings(key: string, body: Record<string, unknown>): Promise<void> {
    const r = makeReqRes('PATCH', `/api/settings/device?udid=${encodeURIComponent(key)}`, body);
    await new SettingsApi().handle(r.req, r.res);
    expect(r.getStatus()).toBe(200);
}

describe('stream settings keyed by the real serial (M11)', () => {
    it('the same device over USB, then Wi-Fi, then a new IP reads ONE settings set', async () => {
        setup();
        (await sight(SERIAL)).setState('disconnected');
        await patchSettings(SERIAL, { video: { fit: true } });

        (await sight(WIFI)).setState('disconnected');
        // The card asks by serial; a deep link still carries the transport.
        expect(await getSettings(SERIAL)).toEqual({ video: { fit: true } });

        await sight(MOVED);
        expect(await getSettings(MOVED)).toEqual({ video: { fit: true } });
        await patchSettings(MOVED, { audio: { source: 'mic' } });

        expect(await getSettings(SERIAL)).toEqual({ video: { fit: true }, audio: { source: 'mic' } });
        const db = Config.getInstance().db;
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, MOVED)).toEqual({});
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({});
    });

    it('a transport the tracker has not read a serial on is used as it is', async () => {
        setup();
        await patchSettings('e2e-fake-device', { video: { fit: true } });
        expect(await getSettings('e2e-fake-device')).toEqual({ video: { fit: true } });
    });

    it('a legacy transport-keyed set is adopted once, when the device is seen there and the serial has none', async () => {
        setup();
        const db = Config.getInstance().db;
        // Before M11 the tracker filed the transport's row with the model it saw.
        db.devices.upsertDevice({ serial: WIFI, model: 'Pixel 7', lastSeenAt: 1 });
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, WIFI, 'video', { fit: true });

        await sight(WIFI);

        expect(await getSettings(SERIAL)).toEqual({ video: { fit: true } });
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({});
    });

    it('a serial-keyed set is never overwritten by a legacy one, and the legacy rows are left in place', async () => {
        setup();
        const db = Config.getInstance().db;
        db.devices.upsertDevice({ serial: WIFI, model: 'Pixel 7', lastSeenAt: 1 });
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, SERIAL, 'video', { fit: false });
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, WIFI, 'video', { fit: true });

        await sight(WIFI);

        expect(await getSettings(SERIAL)).toEqual({ video: { fit: false } });
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({ video: { fit: true } });
    });
});

describe('a live transport whose serial is not read yet is never used as the settings key (M11 fix 1, I1)', () => {
    // Configure, or a deep-link stream tab after a server restart, can ask for
    // settings by transport before the tracker's getprop lands. Filed under the
    // transport then, the set would never reach the serial once the user had one.
    const live = new Map<string, Device>();
    function trackerHolds(device: Device): Device {
        live.set(device.udid, device);
        vi.spyOn(ControlCenter, 'hasInstance').mockReturnValue(true);
        vi.spyOn(ControlCenter, 'getInstance').mockReturnValue({
            getDevice: (udid: string) => live.get(udid),
        } as unknown as ControlCenter);
        return device;
    }
    afterEach(() => live.clear());

    /** getProperties answers only when `release` is called. */
    function slowGetprop(serial = SERIAL) {
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => (release = r));
        const props = vi.spyOn(AdbClient.prototype, 'getProperties').mockImplementation(async () => {
            await gate;
            return { 'ro.serialno': serial, 'ro.product.model': 'Pixel 7' };
        });
        return { props, release: () => release() };
    }

    function request(method: 'GET' | 'PATCH', key: string, body?: Record<string, unknown>, waitMs?: number) {
        const r = makeReqRes(method, `/api/settings/device?udid=${encodeURIComponent(key)}`, body);
        const done = new SettingsApi(waitMs).handle(r.req, r.res);
        return { r, done };
    }

    it('a PATCH before the serial is known waits for it and lands under the serial', async () => {
        setup();
        const { props, release } = slowGetprop();
        trackerHolds(new Device(WIFI, 'device'));
        await vi.waitFor(() => expect(props).toHaveBeenCalledWith(WIFI));

        const { r, done } = request('PATCH', WIFI, { video: { fit: true } });
        release();
        await done;

        expect(r.getStatus()).toBe(200);
        const db = Config.getInstance().db;
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, SERIAL)).toEqual({ video: { fit: true } });
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({});
    });

    it("a GET before the serial is known returns the serial's set", async () => {
        setup();
        Config.getInstance().db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, SERIAL, 'video', { fit: true });
        const { props, release } = slowGetprop();
        trackerHolds(new Device(WIFI, 'device'));
        await vi.waitFor(() => expect(props).toHaveBeenCalledWith(WIFI));

        const { r, done } = request('GET', WIFI);
        release();
        await done;

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ video: { fit: true } });
    });

    it('a serial that is not read in time is answered 503 with Retry-After, and nothing is filed under the transport', async () => {
        setup();
        const { props } = slowGetprop();
        trackerHolds(new Device(WIFI, 'device'));
        await vi.waitFor(() => expect(props).toHaveBeenCalledWith(WIFI));

        const { r, done } = request('PATCH', WIFI, { video: { fit: true } }, 20);
        await done;

        expect(r.getStatus()).toBe(503);
        expect(r.getHeader('Retry-After')).toBe(String(SERIAL_RETRY_AFTER_S));
        const db = Config.getInstance().db;
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({});
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, SERIAL)).toEqual({});
    });

    it('a transport that is not a device (unauthorized) is answered 503 at once', async () => {
        setup();
        trackerHolds(new Device(WIFI, 'unauthorized'));

        const { r, done } = request('PATCH', WIFI, { video: { fit: true } }, 60_000);
        await done;

        expect(r.getStatus()).toBe(503);
        expect(Config.getInstance().db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({});
    });

    it('a key the tracker does not hold is used as it is, without waiting', async () => {
        setup();
        trackerHolds(new Device(WIFI, 'unauthorized'));

        const { r, done } = request('PATCH', 'e2e-fake-device', { video: { fit: true } }, 60_000);
        await done;

        expect(r.getStatus()).toBe(200);
        expect(Config.getInstance().db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, 'e2e-fake-device')).toEqual({
            video: { fit: true },
        });
    });
});

describe('a placeholder serial keys nothing (M11 fix 1, m4)', () => {
    for (const placeholder of ['0123456789ABCDEF', 'unknown', 'EMULATOR37X1X11X0']) {
        it(`a device reporting ${placeholder} keeps its settings and row under the transport`, async () => {
            setup();
            const props = vi
                .spyOn(AdbClient.prototype, 'getProperties')
                .mockResolvedValue({ 'ro.serialno': placeholder, 'ro.product.model': 'TV Box' });
            const device = new Device(WIFI, 'device');
            await vi.waitFor(() => expect(props).toHaveBeenCalledWith(WIFI));
            await new Promise((r) => setImmediate(r));
            vi.spyOn(ControlCenter, 'hasInstance').mockReturnValue(true);
            vi.spyOn(ControlCenter, 'getInstance').mockReturnValue({
                getDevice: (udid: string) => (udid === WIFI ? device : undefined),
            } as unknown as ControlCenter);

            await patchSettings(WIFI, { video: { fit: true } });

            const db = Config.getInstance().db;
            expect(serialReadOn(WIFI)).toBeUndefined();
            expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({ video: { fit: true } });
            expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, placeholder)).toEqual({});
            expect(db.devices.getDevice(placeholder)).toBeUndefined();
        });
    }
});

describe('a reused transport forgets the previous device (M11 fix 1, m5)', () => {
    it('offline, then a different device on the same transport: neither the descriptor nor the server keeps the old serial', async () => {
        setup();
        const db = Config.getInstance().db;
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, 'OTHER0SERIAL', 'video', { fit: false });
        const device = await sight(WIFI);
        expect(serialReadOn(WIFI)).toBe(SERIAL);

        device.setState('offline');
        expect(device.descriptor['ro.serialno']).toBe('');
        expect(serialReadOn(WIFI)).toBeUndefined();

        const props = vi
            .spyOn(AdbClient.prototype, 'getProperties')
            .mockResolvedValue({ 'ro.serialno': 'OTHER0SERIAL', 'ro.product.model': 'Pixel 8' });
        device.setState('device');
        await vi.waitFor(() => expect(props).toHaveBeenCalledWith(WIFI));
        await new Promise((r) => setImmediate(r));

        expect(device.descriptor['ro.serialno']).toBe('OTHER0SERIAL');
        expect(await getSettings(WIFI)).toEqual({ video: { fit: false } });
    });
});
