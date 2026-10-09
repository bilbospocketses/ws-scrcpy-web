import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPV6_EMBEDDER_ERROR } from '../../common/embedderOrigin';
import { EmbedRequestApi } from '../api/EmbedRequestApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { _resetForTest, createRequest, getPendingRequest, getStatus } from '../security/embedRequests';
import { securityHeaders, setFrameAncestors } from '../security/frameGuard';
import { makeReqRes } from './helpers/httpMock';

/**
 * The consent routes (0.5.3 review):
 *
 * - An embed request is only marked approved once its origin is stored. A
 *   config.json write that fails rolls the live policy back
 *   (`applyAndPersistFrameAncestors`), so marking the request approved first
 *   would tell the asking app it may embed while the server still refuses to
 *   be framed. On failure the request stays pending and the admin's decision
 *   call is answered with the route's existing error.
 * - An IPv6 origin is refused when it is asked for, with its own reason, and
 *   never reaches the admin as an approvable prompt: a browser discards an
 *   IPv6 `frame-ancestors` source.
 *
 * The write is failed by wrapping the real `writeFileAtomicSync`, as in
 * config.frameAncestorsWriteFailure.test.ts.
 */
const failWrite = vi.hoisted(() => ({ on: false }));

vi.mock('../util/atomicFile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../util/atomicFile')>();
    return {
        ...actual,
        writeFileAtomicSync: (...args: Parameters<typeof actual.writeFileAtomicSync>) => {
            if (failWrite.on) {
                throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
            }
            actual.writeFileAtomicSync(...args);
        },
    };
});

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DATA_ROOT: process.env['DATA_ROOT'],
};

const BOOT = { webPort: 8000, installMode: 'user', firstRunComplete: true };
const BEFORE = ['http://localhost:5159'];
const BEFORE_CSP = "frame-ancestors 'self' http://localhost:5159";
const LOOPBACK = { remoteAddress: '127.0.0.1' };

function setup(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-embed-api-'));
    tmpDirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ ...BOOT, frameAncestors: BEFORE }));
    process.env[EnvName.CONFIG_PATH] = configPath;
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    process.env['DATA_ROOT'] = dir;
    Config._resetForTest();
    // As index.ts does at boot, so the live policy starts from config.json.
    setFrameAncestors(Config.getInstance().frameAncestors);
    return configPath;
}

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

afterEach(() => {
    failWrite.on = false;
    _resetForTest();
    Config._resetForTest();
    setFrameAncestors([]);
    restore(EnvName.CONFIG_PATH, saved.CONFIG);
    restore('DEPS_PATH', saved.DEPS);
    restore('DATA_ROOT', saved.DATA_ROOT);
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown) {
    const r = makeReqRes(method, url, body, {}, LOOPBACK);
    const handled = await new EmbedRequestApi().handle(r.req, r.res);
    expect(handled).toBe(true);
    return r;
}

function decide(id: string, approved: boolean) {
    return call('POST', '/api/embed-request/decision', { id, approved });
}

describe('approving an embed request whose origin cannot be written', () => {
    it('answers the decision with an error and leaves the request pending, not approved', async () => {
        const configPath = setup();
        const fileBefore = fs.readFileSync(configPath, 'utf-8');
        const created = createRequest('http://localhost:6000', 'Control Menu');
        if (!created) throw new Error('request not created');
        failWrite.on = true;

        const r = await decide(created.id, true);

        expect(r.getStatus()).toBe(500);
        expect(r.getJson()).toEqual({ error: 'could not apply the approved origin' });
        // The asking app reads "pending", never "approved", so it does not
        // embed into a server that still refuses to be framed by it.
        expect(getStatus(created.id)).toBe('pending');
        expect((await call('GET', `/embed-request/${created.id}`)).getJson()).toEqual({
            id: created.id,
            status: 'pending',
        });
        // Still on the admin's screen, still answerable.
        expect(getPendingRequest()?.id).toBe(created.id);
        // Nothing half-applied.
        expect(Config.getInstance().frameAncestors).toEqual(BEFORE);
        expect(securityHeaders()['Content-Security-Policy']).toBe(BEFORE_CSP);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(fileBefore);
    });

    it('can be approved once the write works again', async () => {
        const configPath = setup();
        const created = createRequest('http://localhost:6000', 'Control Menu');
        if (!created) throw new Error('request not created');
        failWrite.on = true;
        expect((await decide(created.id, true)).getStatus()).toBe(500);
        failWrite.on = false;

        const r = await decide(created.id, true);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ status: 'approved', origin: 'http://localhost:6000' });
        expect(getStatus(created.id)).toBe('approved');
        expect(getPendingRequest()).toBeNull();
        expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))['frameAncestors']).toEqual([
            'http://localhost:5159',
            'http://localhost:6000',
        ]);
        expect(securityHeaders()['Content-Security-Policy']).toBe(
            "frame-ancestors 'self' http://localhost:5159 http://localhost:6000",
        );
    });

    it('control: a denial needs no write, so it is recorded even while writes fail', async () => {
        setup();
        const created = createRequest('http://localhost:6000', 'Control Menu');
        if (!created) throw new Error('request not created');
        failWrite.on = true;

        const r = await decide(created.id, false);

        expect(r.getStatus()).toBe(200);
        expect(r.getJson()).toEqual({ status: 'denied' });
        expect(getStatus(created.id)).toBe('denied');
        expect(Config.getInstance().frameAncestors).toEqual(BEFORE);
    });

    it('a decision on a request that is not pending is still refused', async () => {
        setup();
        const created = createRequest('http://localhost:6000', 'Control Menu');
        if (!created) throw new Error('request not created');
        expect((await decide(created.id, false)).getStatus()).toBe(200);

        const r = await decide(created.id, true);

        expect(r.getStatus()).toBe(409);
        expect(r.getJson()).toEqual({ error: 'no pending request with that id' });
        expect(getStatus(created.id)).toBe('denied');
        expect(Config.getInstance().frameAncestors).toEqual(BEFORE);
    });
});

describe('asking to embed from an IPv6 origin', () => {
    it.each([['http://[::1]:47812'], ['https://[fe80::1]'], ['http://[2001:db8::1]:5159']])(
        'refuses %s when it is asked for, with the IPv6 reason, and raises no prompt',
        async (origin) => {
            setup();

            const r = await call('POST', '/embed-request', { origin, appName: 'Control Menu' });

            expect(r.getStatus()).toBe(400);
            expect(r.getJson()).toEqual({ error: IPV6_EMBEDDER_ERROR });
            expect(getPendingRequest()).toBeNull();
        },
    );

    it('control: another unusable origin keeps the generic refusal', async () => {
        setup();
        const r = await call('POST', '/embed-request', { origin: 'http://localhost:6000/app', appName: 'x' });
        expect(r.getStatus()).toBe(400);
        expect(r.getJson()).toEqual({ error: 'origin must be an http(s) origin with no path' });
    });

    it.each([['http://localhost:6000'], ['http://192.168.1.50:6000'], ['https://tools.example']])(
        'control: %s is still accepted and shown to the admin',
        async (origin) => {
            setup();

            const r = await call('POST', '/embed-request', { origin, appName: 'Control Menu' });

            expect(r.getStatus()).toBe(200);
            expect((r.getJson() as { status: string }).status).toBe('pending');
            expect(getPendingRequest()?.origin).toBe(origin);
        },
    );
});
