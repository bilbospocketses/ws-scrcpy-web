import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigApi } from '../api/ConfigApi';
import { SettingsBatchApi } from '../api/SettingsBatchApi';
import { systemServicePortRefusal } from '../api/systemServicePortGuard';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * The Linux system service binds config.json's webPort EXACTLY (no walk
 * forward, reconcileWebPort.ts), so a Settings change to a port another
 * program holds would leave the service failing its bind until systemd gave up.
 * Both write routes refuse that change with 409 BEFORE anything is written:
 * PATCH /api/config and the settings batch (decided 2026-10-04). Every other
 * install mode keeps walking forward on the restart, so they still accept it.
 */

const tmpDirs: string[] = [];
const held: net.Server[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Config._resetForTest();
    restore(EnvName.CONFIG_PATH, saved.CONFIG);
    restore('DEPS_PATH', saved.DEPS);
    restore('DATA_ROOT', saved.DATA_ROOT);
    while (held.length) {
        const srv = held.pop()!;
        await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Temp config.json + data root, so `.restart` and the store stay in the temp dir. */
function setup(): { dir: string; configPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssysport-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ webPort: 8000, channel: 'stable' }));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
    return { dir, configPath };
}

async function freePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

/** A port another program holds for the length of the test (the same wildcard bind the probe makes). */
async function heldPort(): Promise<number> {
    const port = await freePort();
    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, () => resolve());
    });
    held.push(srv);
    return port;
}

const LOOPBACK = { remoteAddress: '127.0.0.1' };
const systemService = { isLinuxSystemServiceInstance: () => true };
const otherMode = { isLinuxSystemServiceInstance: () => false };
const inUse = (port: number) => `port ${port} is in use; the system service binds its port exactly, so pick a free one`;

/** Fake the restart timer and stub exit, so a 200 never ends the vitest worker. */
function noRealRestart() {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

describe('PATCH /api/config -- the system service refuses a busy web port', () => {
    it('409s with a message naming the port, and writes nothing', async () => {
        const { dir, configPath } = setup();
        const busy = await heldPort();
        const before = fs.readFileSync(configPath, 'utf-8');

        const r = makeReqRes('PATCH', '/api/config', { webPort: busy }, {}, LOOPBACK);
        await new ConfigApi(systemService).handle(r.req, r.res);

        expect(r.getStatus()).toBe(409);
        expect(r.getJson()).toEqual({ error: inUse(busy), field: 'webPort' });
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
        expect(Config.getInstance().getAppConfig().webPort).toBe(8000);
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(false);
    });

    it('accepts a free port as before', async () => {
        const { dir } = setup();
        const exit = noRealRestart();
        const free = await freePort();

        const r = makeReqRes('PATCH', '/api/config', { webPort: free }, {}, LOOPBACK);
        await new ConfigApi(systemService).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { redirectPort: number }).redirectPort).toBe(free);
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(true);
        expect(exit).not.toHaveBeenCalled();
    });

    it('leaves an out-of-range port to the validation 400, not the in-use 409', async () => {
        setup();
        const r = makeReqRes('PATCH', '/api/config', { webPort: 80 }, {}, LOOPBACK);
        await new ConfigApi(systemService).handle(r.req, r.res);

        expect(r.getStatus()).toBe(400);
        expect((r.getJson() as { field: string }).field).toBe('webPort');
    });

    it('every other install mode still accepts a busy port: it walks forward on the restart', async () => {
        const { configPath } = setup();
        noRealRestart();
        const busy = await heldPort();

        const r = makeReqRes('PATCH', '/api/config', { webPort: busy }, {}, LOOPBACK);
        await new ConfigApi(otherMode).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).webPort).toBe(busy);
    });
});

describe('POST /api/settings/batch -- the system service refuses a busy web port', () => {
    /**
     * The channel change goes AWAY from whatever channel the config loaded on.
     * That is the build's channel unless pinned (config.channelPin.test.ts), so a
     * fixed `stable` -> `beta` would be a no-op on a beta build, and asserting
     * `stable` afterwards failed once the package version became a beta.
     */
    const batch = (webPort: number) => {
        const from = Config.getInstance().getAppConfig().channel;
        return {
            changes: [
                { id: 'webPort', label: 'HTTP port', from: 8000, to: webPort },
                { id: 'channel', label: 'Update channel', from, to: from === 'beta' ? 'stable' : 'beta' },
            ],
        };
    };

    it('409s before the WAL row and before any change in the batch is applied', async () => {
        const { dir, configPath } = setup();
        const busy = await heldPort();
        const before = fs.readFileSync(configPath, 'utf-8');
        const channelBefore = Config.getInstance().getAppConfig().channel;
        const schedule = vi.fn();
        const exit = vi.fn();

        const r = makeReqRes('POST', '/api/settings/batch', batch(busy), {}, LOOPBACK);
        await new SettingsBatchApi({ schedule, exit, ...systemService }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(409);
        // The rejected-apply shape, which the Settings dialog shows as
        // "couldn't save HTTP port: <error>" (settingsSave.test.ts).
        expect(r.getJson()).toEqual({ ok: false, applied: [], failed: { id: 'webPort', error: inUse(busy) } });
        const cfg = Config.getInstance();
        expect(cfg.getAppConfig().channel).toBe(channelBefore);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
        const rows = cfg.db.sqlite.prepare('SELECT COUNT(*) AS n FROM pending_settings').get() as { n: number };
        expect(rows.n).toBe(0);
        expect(schedule).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(dir, '.restart'))).toBe(false);
    });

    it('applies a batch with a free port as before', async () => {
        setup();
        const free = await freePort();
        const schedule = vi.fn();

        const r = makeReqRes('POST', '/api/settings/batch', batch(free), {}, LOOPBACK);
        await new SettingsBatchApi({ schedule, exit: vi.fn(), ...systemService }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toMatchObject({ ok: true, applied: ['channel', 'webPort'], redirectPort: free });
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('every other install mode still applies a busy port', async () => {
        setup();
        const busy = await heldPort();

        const r = makeReqRes('POST', '/api/settings/batch', batch(busy), {}, LOOPBACK);
        await new SettingsBatchApi({ schedule: vi.fn(), exit: vi.fn(), ...otherMode }).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(Config.getInstance().getAppConfig().webPort).toBe(busy);
    });
});

describe('systemServicePortRefusal', () => {
    it('uses the reconcile probe: one exact port, no walk', async () => {
        const findAvailablePort = vi.fn(async () => null);
        const why = await systemServicePortRefusal(8123, [8000], { ...systemService, findAvailablePort });
        expect(findAvailablePort).toHaveBeenCalledWith(8123, 8123);
        expect(why).toBe(inUse(8123));
    });

    it('does not count a port THIS process listens on as another program', async () => {
        // The current web port, or the Local HTTPS port: both are ours and are
        // released by the restart, so the probe is not asked about them.
        const findAvailablePort = vi.fn(async () => null);
        for (const own of [8000, 8443]) {
            expect(await systemServicePortRefusal(own, [8000, 8443], { ...systemService, findAvailablePort })).toBe(
                null,
            );
        }
        expect(findAvailablePort).not.toHaveBeenCalled();
    });

    it('says nothing off the system service, and nothing for a value validation will refuse', async () => {
        const findAvailablePort = vi.fn(async () => null);
        expect(await systemServicePortRefusal(8123, [8000], { ...otherMode, findAvailablePort })).toBe(null);
        for (const bad of [80, 70000, '8123', undefined]) {
            expect(await systemServicePortRefusal(bad, [8000], { ...systemService, findAvailablePort })).toBe(null);
        }
        expect(findAvailablePort).not.toHaveBeenCalled();
    });
});
