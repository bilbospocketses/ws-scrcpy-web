import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigApi } from '../api/ConfigApi';
import { getAppVersion } from '../appVersion';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * GET /api/config names the running version on its runtime envelope, for the
 * Settings dialog's footer. It is the one read every dialog makes, whoever the
 * caller is and whether or not the in-app updater was started -- in a container
 * it never is, so /api/updates/status reports an empty version there.
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wscfgver-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
}

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

afterEach(() => {
    Config._resetForTest();
    restore(EnvName.CONFIG_PATH, saved.CONFIG);
    restore('DEPS_PATH', saved.DEPS);
    restore('DATA_ROOT', saved.DATA_ROOT);
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('GET /api/config runtime.appVersion', () => {
    it('carries the running version, for loopback and off-box callers alike', async () => {
        setup();
        for (const remoteAddress of ['127.0.0.1', '192.168.1.50']) {
            const { req, res, getStatus, getJson } = makeReqRes('GET', '/api/config', undefined, {}, { remoteAddress });
            expect(await new ConfigApi().handle(req, res)).toBe(true);
            expect(getStatus()).toBe(200);
            const body = getJson() as { runtime: Record<string, unknown> };
            expect(body.runtime['appVersion']).toBe(getAppVersion());
            expect(String(body.runtime['appVersion']).length).toBeGreaterThan(0);
        }
    });
});
