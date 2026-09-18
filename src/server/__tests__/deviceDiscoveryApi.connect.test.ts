import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdbClient } from '../AdbClient';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

// CONFIG_PATH + DEPS_PATH harness, as in deviceDiscoveryApi.labels.test.ts: the
// DB co-locates with config.json, so each test isolates in its own temp dir.
const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsconn-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

afterEach(() => {
    vi.restoreAllMocks();
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function connect(api: DeviceDiscoveryApi, body: unknown) {
    const r = makeReqRes('POST', '/api/devices/connect', body);
    const owned = await api.handle(r.req, r.res);
    return { owned, status: r.getStatus(), body: r.getJson() as Record<string, unknown> };
}

// The route used to check only that `address` was non-empty before handing it
// to `adb connect` as an argv element — and then, on the label-persisting path,
// to `adb shell <address> getprop`. `adb` reads a leading '-' as a flag, so
// `-H` would have pointed it at another adb server entirely.
//
// The spy is on AdbClient.prototype because DeviceDiscoveryApi constructs its
// own client in its constructor; the assertion that matters is that adb is
// never REACHED, which a response-code check alone would not prove.
describe('DeviceDiscoveryApi /api/devices/connect address validation', () => {
    it('refuses an option-injection address with 400 and never invokes adb', async () => {
        setup();
        const spy = vi.spyOn(AdbClient.prototype, 'connect').mockResolvedValue('connected to 10.0.0.5:5555');
        const api = new DeviceDiscoveryApi();

        const res = await connect(api, { address: '-Hevil.com:5555' });

        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not echo the rejected address back to the caller', async () => {
        setup();
        vi.spyOn(AdbClient.prototype, 'connect').mockResolvedValue('connected to 10.0.0.5:5555');
        const api = new DeviceDiscoveryApi();

        const res = await connect(api, { address: '-Hevil.com:5555' });

        expect(JSON.stringify(res.body)).not.toContain('evil.com');
    });

    it('refuses a value that is not an endpoint at all', async () => {
        setup();
        const spy = vi.spyOn(AdbClient.prototype, 'connect').mockResolvedValue('connected to 10.0.0.5:5555');
        const api = new DeviceDiscoveryApi();

        for (const address of ['10.0.0.5:5555 extra', '10.0.0.5:70000', '10.0.0.5:', 'a'.repeat(301)]) {
            const res = await connect(api, { address });
            expect(res.status, `address ${JSON.stringify(address)}`).toBe(400);
        }
        expect(spy).not.toHaveBeenCalled();
    });

    it('still answers 400 for a missing address, as it always did', async () => {
        setup();
        const api = new DeviceDiscoveryApi();

        const res = await connect(api, {});

        expect(res.status).toBe(400);
        expect(res.body['error']).toBe('address is required');
    });

    // The shapes `adb connect` documents must keep working: a bare host, a
    // host:port, and an IPv6 literal. Narrowing this route to the PAIRING
    // validator would have rejected the first and the third.
    it('passes the adb connect shapes through to adb', async () => {
        setup();
        const spy = vi.spyOn(AdbClient.prototype, 'connect').mockResolvedValue('connected to 10.0.0.5:5555');
        const api = new DeviceDiscoveryApi();

        for (const address of ['10.0.0.5', '10.0.0.5:5555', '[fe80::1]:5555', 'phone.local']) {
            const res = await connect(api, { address });
            expect(res.status, `address ${address}`).toBe(200);
        }
        expect(spy.mock.calls.map((c) => c[0])).toEqual(['10.0.0.5', '10.0.0.5:5555', '[fe80::1]:5555', 'phone.local']);
    });
});

// `/disconnect` was the unguarded neighbour of the route that prompted the
// check — the same unvalidated body field, reaching adb the same way. Fixing
// one and not the other would have left the file with two different answers to
// the same question.
describe('DeviceDiscoveryApi /api/devices/disconnect address validation', () => {
    async function disconnect(api: DeviceDiscoveryApi, body: unknown) {
        const r = makeReqRes('POST', '/api/devices/disconnect', body);
        await api.handle(r.req, r.res);
        return { status: r.getStatus(), body: r.getJson() as Record<string, unknown> };
    }

    it('refuses an option-injection address with 400 and never invokes adb', async () => {
        setup();
        const spy = vi.spyOn(AdbClient.prototype, 'disconnect').mockResolvedValue('disconnected');
        const api = new DeviceDiscoveryApi();

        const res = await disconnect(api, { address: '-Hevil.com:5555' });

        expect(res.status).toBe(400);
        expect(spy).not.toHaveBeenCalled();
    });

    it('still passes a well-formed address through', async () => {
        setup();
        const spy = vi.spyOn(AdbClient.prototype, 'disconnect').mockResolvedValue('disconnected 10.0.0.5:5555');
        const api = new DeviceDiscoveryApi();

        const res = await disconnect(api, { address: '10.0.0.5:5555' });

        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalledWith('10.0.0.5:5555');
    });
});
