import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_ADMIN_FORCED_MESSAGE, REMOTE_ADMIN_ID } from '../../common/remoteAdmin';
import { ConfigApi } from '../api/ConfigApi';
import { remoteAdminRefusal, SettingsBatchApi, STAGEABLE_IDS } from '../api/SettingsBatchApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * Remote admin without sign-in through the settings batch (0.5.5): Settings →
 * Users stages it, and Save turns it on or off. Until then only the home page
 * banner's PATCH /api/config could set it, and nothing could turn it off.
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
    FORCED: process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(config: Record<string, unknown> = { webPort: 8000 }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsremote-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(config));
    process.env[EnvName.CONFIG_PATH] = file;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
    return file;
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
    restore('WS_SCRCPY_ALLOW_REMOTE_ADMIN', saved.FORCED);
    restore('WS_SCRCPY_DOCKER', saved.DOCKER);
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const LOOPBACK = { remoteAddress: '127.0.0.1' };
const OFF_BOX = { remoteAddress: '192.168.1.50' };

async function batch(to: unknown, socket = LOOPBACK) {
    const r = makeReqRes(
        'POST',
        '/api/settings/batch',
        { changes: [{ id: REMOTE_ADMIN_ID, label: 'Remote admin without sign-in', from: !to, to }] },
        {},
        socket,
    );
    await new SettingsBatchApi().handle(r.req, r.res);
    return r;
}

function onDisk(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

describe('allowRemoteAdmin in the settings batch', () => {
    it('is a stageable id', () => {
        expect(REMOTE_ADMIN_ID).toBe('allowRemoteAdmin');
        expect(STAGEABLE_IDS.has(REMOTE_ADMIN_ID)).toBe(true);
    });

    it('turning it on applies it and writes it to config.json', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const file = setup();
        const r = await batch(true);
        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ ok: true, applied: [REMOTE_ADMIN_ID] });
        expect(Config.getInstance().getAppConfig().allowRemoteAdmin).toBe(true);
        expect(onDisk(file)['allowRemoteAdmin']).toBe(true);
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('turning it off applies it and removes the key from config.json', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const file = setup({ webPort: 8000, allowRemoteAdmin: true });
        expect(Config.getInstance().getAppConfig().allowRemoteAdmin).toBe(true);

        const r = await batch(false);
        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ ok: true, applied: [REMOTE_ADMIN_ID] });
        expect(Config.getInstance().getAppConfig().allowRemoteAdmin).toBe(false);
        expect(onDisk(file)).not.toHaveProperty('allowRemoteAdmin');
        expect(onDisk(file)['webPort']).toBe(8000);
    });

    it('refuses a value that is not a boolean, before the WAL row', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const file = setup();
        const r = await batch('yes');
        expect(r.getStatus()).toBe(400);
        expect(r.getJson()).toEqual({
            ok: false,
            applied: [],
            failed: { id: REMOTE_ADMIN_ID, error: 'allowRemoteAdmin must be a boolean' },
        });
        expect(onDisk(file)).not.toHaveProperty('allowRemoteAdmin');
        expect(Config.getInstance().db.pendingSettings.getPending()).toHaveLength(0);
    });

    it('refuses to turn it off while WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 forces it on, saying why', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const file = setup({ webPort: 8000, allowRemoteAdmin: true });
        const r = await batch(false);
        expect(r.getStatus()).toBe(409);
        expect(r.getJson()).toEqual({
            ok: false,
            applied: [],
            failed: { id: REMOTE_ADMIN_ID, error: REMOTE_ADMIN_FORCED_MESSAGE },
        });
        // Nothing written: the stored value is untouched.
        expect(Config.getInstance().getAppConfig().allowRemoteAdmin).toBe(true);
        expect(onDisk(file)['allowRemoteAdmin']).toBe(true);
    });

    it('still accepts turning it on while forced (it changes nothing the server does)', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        setup();
        const r = await batch(true);
        expect(r.getStatus()).toBe(200);
    });

    it('stays behind the operator gate: an off-box caller without the opt-out is refused', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const file = setup();
        const r = await batch(true, OFF_BOX);
        expect(r.getStatus()).toBe(403);
        expect(onDisk(file)).not.toHaveProperty('allowRemoteAdmin');
    });

    it('lets the off-box caller who is admin through it turn it off, ending that access', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        setup({ webPort: 8000, allowRemoteAdmin: true });
        const off = await batch(false, OFF_BOX);
        expect(off.getStatus()).toBe(200);
        // The next admin call from the same device is refused.
        const again = await batch(true, OFF_BOX);
        expect(again.getStatus()).toBe(403);
    });

    it('is allowed in a container, as PATCH /api/config allows it', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        process.env['WS_SCRCPY_DOCKER'] = '1';
        setup();
        expect(Config.getInstance().dockerMode).toBe(true);
        const r = await batch(true);
        expect(r.getStatus()).toBe(200);
        expect(Config.getInstance().getAppConfig().allowRemoteAdmin).toBe(true);
    });
});

describe('remoteAdminRefusal', () => {
    it.each([
        [true, false, null],
        [false, false, null],
        [true, true, null],
        [false, true, { status: 409, error: REMOTE_ADMIN_FORCED_MESSAGE }],
        ['true', false, { status: 400, error: 'allowRemoteAdmin must be a boolean' }],
        [1, true, { status: 400, error: 'allowRemoteAdmin must be a boolean' }],
        [null, false, { status: 400, error: 'allowRemoteAdmin must be a boolean' }],
    ])('to %j, forced %j → %j', (to, forced, expected) => {
        expect(remoteAdminRefusal(to, forced)).toEqual(expected);
    });
});

describe('GET /api/config runtime.remoteAdminForced', () => {
    async function runtime(): Promise<Record<string, unknown>> {
        const { req, res, getJson } = makeReqRes('GET', '/api/config', undefined, {}, LOOPBACK);
        await new ConfigApi().handle(req, res);
        return (getJson() as { runtime: Record<string, unknown> }).runtime;
    }

    it('is true when WS_SCRCPY_ALLOW_REMOTE_ADMIN=1, and the scope is remote', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        setup();
        const rt = await runtime();
        expect(rt['remoteAdminForced']).toBe(true);
        expect(rt['adminScope']).toBe('remote');
    });

    it('is false without it, even with the stored opt-out on', async () => {
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        setup({ webPort: 8000, allowRemoteAdmin: true });
        const rt = await runtime();
        expect(rt['remoteAdminForced']).toBe(false);
        expect(rt['adminScope']).toBe('remote');
    });

    it('only an exact "1" forces it', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = 'true';
        setup();
        expect((await runtime())['remoteAdminForced']).toBe(false);
    });
});
