import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

// CONFIG_PATH + DEPS_PATH harness (DATA_ROOT is ignored on Windows): the DB
// co-locates with config.json, so each test isolates in its own temp dir.
const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };
function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdd-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}
afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('DeviceDiscoveryApi labels via DeviceStore', () => {
    it('PUT writes device_labels for the implicit admin; GET reads them back', async () => {
        setup();
        const cfg = Config.getInstance(); // opens the DB at the temp config dir
        const api = new DeviceDiscoveryApi();

        const put = makeReqRes('PUT', '/api/devices/labels', { serial: 'S1', label: 'Living Room' });
        await api.handle(put.req, put.res);
        expect(put.getStatus()).toBe(200);
        expect(cfg.db.devices.getLabel(IMPLICIT_ADMIN_ID, 'S1')).toBe('Living Room');

        const get = makeReqRes('GET', '/api/devices/labels');
        await api.handle(get.req, get.res);
        expect(get.getJson()).toEqual({ S1: 'Living Room' });
    });

    it('PUT with an empty label deletes it', async () => {
        setup();
        const cfg = Config.getInstance();
        const api = new DeviceDiscoveryApi();

        await api.handle(...reqResArgs('PUT', '/api/devices/labels', { serial: 'S1', label: 'X' }));
        expect(cfg.db.devices.getLabel(IMPLICIT_ADMIN_ID, 'S1')).toBe('X');

        await api.handle(...reqResArgs('PUT', '/api/devices/labels', { serial: 'S1', label: '' }));
        expect(cfg.db.devices.getLabel(IMPLICIT_ADMIN_ID, 'S1')).toBeUndefined();
    });
});

// Helper: spread the mock's req/res straight into api.handle(req, res).
function reqResArgs(
    method: string,
    url: string,
    body?: unknown,
): [Parameters<DeviceDiscoveryApi['handle']>[0], Parameters<DeviceDiscoveryApi['handle']>[1]] {
    const { req, res } = makeReqRes(method, url, body);
    return [req, res];
}
