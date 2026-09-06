import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WhoamiApi } from '../api/WhoamiApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

/**
 * GET /api/whoami is the sibling-instance identity probe (siblingInstance.ts).
 * It is exempt from the instance token and from AuthGate so a second instance
 * with no cookie and no session can still ask "is the process on my configured
 * port one of us?" -- and it is loopback-only precisely because it is ungated.
 */

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wswhoami-'));
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

function from(remoteAddress: string, method = 'GET') {
    const made = makeReqRes(method, '/api/whoami');
    (made.req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress };
    return made;
}

describe('WhoamiApi', () => {
    it('names the product and this process to a loopback caller', async () => {
        setup();
        const { req, res, getStatus, getJson } = from('127.0.0.1');
        expect(await new WhoamiApi().handle(req, res)).toBe(true);
        expect(getStatus()).toBe(200);
        const body = getJson() as { app: string; pid: number; installMode: unknown; version: string };
        // `app` is the positive identification the sibling probe keys on. Another
        // program's JSON 200 on the same path does not carry it.
        expect(body.app).toBe('ws-scrcpy-web');
        expect(body.pid).toBe(process.pid);
        expect(body.installMode).toBeNull();
        expect(typeof body.version).toBe('string');
    });

    it('accepts the IPv4-mapped loopback a dual-stack listener reports', async () => {
        setup();
        const { req, res, getStatus } = from('::ffff:127.0.0.1');
        await new WhoamiApi().handle(req, res);
        expect(getStatus()).toBe(200);
    });

    it('refuses a caller that is not on this machine, and tells it nothing', async () => {
        setup();
        const { req, res, getStatus, getJson } = from('192.168.1.20');
        expect(await new WhoamiApi().handle(req, res)).toBe(true);
        expect(getStatus()).toBe(403);
        const body = getJson() as Record<string, unknown>;
        expect(body['app']).toBeUndefined();
        expect(body['pid']).toBeUndefined();
        expect(body['version']).toBeUndefined();
    });

    it('answers only GET', async () => {
        setup();
        const { req, res, getStatus } = from('127.0.0.1', 'POST');
        expect(await new WhoamiApi().handle(req, res)).toBe(true);
        expect(getStatus()).toBe(405);
    });

    it('ignores every other path', async () => {
        setup();
        const { req, res } = makeReqRes('GET', '/api/whoami/extra');
        expect(await new WhoamiApi().handle(req, res)).toBe(false);
    });
});
