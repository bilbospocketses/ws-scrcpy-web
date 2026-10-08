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
import { _resetPendingLabelsForTest } from '../api/pendingLabels';
import { SettingsApi } from '../api/SettingsApi';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';
import { Device } from '../goog-device/Device';
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
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, WIFI, 'video', { fit: true });

        await sight(WIFI);

        expect(await getSettings(SERIAL)).toEqual({ video: { fit: true } });
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({});
    });

    it('a serial-keyed set is never overwritten by a legacy one, and the legacy rows are left in place', async () => {
        setup();
        const db = Config.getInstance().db;
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, SERIAL, 'video', { fit: false });
        db.devices.setDeviceSetting(IMPLICIT_ADMIN_ID, WIFI, 'video', { fit: true });

        await sight(WIFI);

        expect(await getSettings(SERIAL)).toEqual({ video: { fit: false } });
        expect(db.devices.getDeviceSettings(IMPLICIT_ADMIN_ID, WIFI)).toEqual({ video: { fit: true } });
    });
});
