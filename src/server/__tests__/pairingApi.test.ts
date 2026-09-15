import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairingError } from '../AdbClient';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { PairingApi } from '../api/PairingApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import type { PairingDeps } from '../pairing/PairingService';
import { PairingService } from '../pairing/PairingService';
import { makeReqRes } from './helpers/httpMock';

// ──────────────────────────────────────────────────────────────────────────
// Harness
//
// CONFIG_PATH + DEPS_PATH are both set explicitly so no platform default is in
// play; the DB co-locates with config.json, so each test isolates in its own
// temp dir. requireAdmin reads `Config.getInstance().db`, so every test that
// reaches a route needs this even though the pairing routes never touch the DB
// themselves.

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wspair-api-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

// A QR session arms a real 1s discovery timer, so every service built here is
// stopped after the test or it re-arms past the end of the run.
const built: PairingService[] = [];

afterEach(() => {
    for (const svc of built) {
        svc.stop();
    }
    built.length = 0;
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeService(over: Partial<PairingDeps> = {}) {
    const adb = {
        pair: vi.fn().mockResolvedValue('Successfully paired to 10.0.0.5:41415 [guid=adb-SER1-xx]'),
        mdnsServices: vi.fn().mockResolvedValue([]),
        connect: vi.fn().mockResolvedValue('connected to 10.0.0.5:43777'),
    };
    const svc = new PairingService({ adb, now: () => Date.now(), ...over });
    built.push(svc);
    return { svc, adb };
}

/** An API wired to a service the test controls, rather than the singleton. */
function makeApi(over: Partial<PairingDeps> = {}) {
    setup();
    const { svc, adb } = makeService(over);
    return { api: new PairingApi(() => svc), svc, adb };
}

/** Let an awaited continuation and its `finally` run. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

async function post(api: PairingApi, url: string, body?: unknown) {
    const r = makeReqRes('POST', url, body);
    const owned = await api.handle(r.req, r.res);
    return { owned, res: { statusCode: r.getStatus() }, body: r.getJson() as Record<string, unknown> };
}

async function get(api: PairingApi, url: string) {
    const r = makeReqRes('GET', url);
    const owned = await api.handle(r.req, r.res);
    return { owned, res: { statusCode: r.getStatus() }, body: r.getJson() as Record<string, unknown> };
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/devices/pair/qr

describe('PairingApi QR', () => {
    it('returns rendered svg and never the payload or password', async () => {
        const { api } = makeApi();
        const { res, body } = await post(api, '/api/devices/pair/qr');
        expect(res.statusCode).toBe(200);
        expect(String(body['svg']).startsWith('<svg')).toBe(true);
        expect(JSON.stringify(body)).not.toContain('WIFI:T:ADB');
        expect(body['payload']).toBeUndefined();
    });

    it('returns exactly sessionId, svg and expiresAt', async () => {
        const { api } = makeApi();
        const { body } = await post(api, '/api/devices/pair/qr');
        expect(Object.keys(body).sort()).toEqual(['expiresAt', 'sessionId', 'svg']);
        expect(typeof body['expiresAt']).toBe('number');
    });

    it('does not leak the password the session actually holds', async () => {
        const { api, svc } = makeApi();
        const { body } = await post(api, '/api/devices/pair/qr');
        // White-box: read the secret off the live session and prove the exact
        // string never appears in the response. A structural assertion on the
        // shape alone would still pass if the SVG somehow embedded it.
        const session = (svc as unknown as { session: { password: string } }).session;
        expect(session.password).not.toBe('');
        expect(JSON.stringify(body)).not.toContain(session.password);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /api/devices/pair/status

describe('PairingApi status', () => {
    it('status never carries the password, including on failure', async () => {
        const { api, adb } = makeApi();
        adb.pair.mockRejectedValue(new PairingError('refused', 'pairing refused — check the code'));
        const started = await post(api, '/api/devices/pair/code', { address: '10.0.0.5:41415', code: '123456' });
        const id = String(started.body['sessionId']);
        await flush();

        const { body } = await get(api, `/api/devices/pair/status?sessionId=${id}`);
        expect(Object.keys(body).sort()).toEqual(['message', 'state']);
        expect(body['state']).toBe('failed');
    });

    it('404s an unknown sessionId rather than leaking the active one', async () => {
        const { api } = makeApi();
        const started = await post(api, '/api/devices/pair/qr');
        const { res, body } = await get(api, '/api/devices/pair/status?sessionId=nope');
        expect(res.statusCode).toBe(404);
        // Assert the BODY, not just the code: a 404 from the route-miss
        // fallthrough, from DeviceDiscoveryApi, or from this branch all look
        // identical on the status line alone.
        expect(body).toEqual({ error: 'no such pairing session' });
        // The active session's id must not come back on the miss.
        expect(JSON.stringify(body)).not.toContain(String(started.body['sessionId']));
    });

    it('404s a missing sessionId parameter', async () => {
        const { api } = makeApi();
        await post(api, '/api/devices/pair/qr');
        const { res, body } = await get(api, '/api/devices/pair/status');
        expect(res.statusCode).toBe(404);
        expect(body).toEqual({ error: 'no such pairing session' });
    });

    it('reports awaiting-scan for a live QR session', async () => {
        const { api } = makeApi();
        const started = await post(api, '/api/devices/pair/qr');
        const { res, body } = await get(api, `/api/devices/pair/status?sessionId=${String(started.body['sessionId'])}`);
        expect(res.statusCode).toBe(200);
        expect(body['state']).toBe('awaiting-scan');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/devices/pair/code

describe('PairingApi code mode', () => {
    it('rejects a code-mode body missing address or code', async () => {
        const { api } = makeApi();
        expect((await post(api, '/api/devices/pair/code', { code: '123456' })).res.statusCode).toBe(400);
        expect((await post(api, '/api/devices/pair/code', { address: '1.2.3.4:5' })).res.statusCode).toBe(400);
        expect((await post(api, '/api/devices/pair/code', {})).res.statusCode).toBe(400);
        expect((await post(api, '/api/devices/pair/code', { address: '  ', code: '  ' })).res.statusCode).toBe(400);
    });

    it('rejects an address that is not IP:port, and never runs adb on it', async () => {
        const { api, adb } = makeApi();
        for (const address of [
            '-H evil', // option injection: adb parses a leading '-' as a flag
            '10.0.0.5', // no port
            '10.0.0.5:0', // port out of range
            '10.0.0.5:70000', // port out of range
            '10.0.0.5:41415 extra',
            '10.0.0.5:41415;whoami',
        ]) {
            const r = await post(api, '/api/devices/pair/code', { address, code: '123456' });
            expect(r.res.statusCode, address).toBe(400);
        }
        await flush();
        expect(adb.pair).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric pairing code, and never runs adb on it', async () => {
        const { api, adb } = makeApi();
        for (const code of ['-H', 'abcdef', '12 34', '1', '12345678901']) {
            const r = await post(api, '/api/devices/pair/code', { address: '10.0.0.5:41415', code });
            expect(r.res.statusCode, code).toBe(400);
        }
        await flush();
        expect(adb.pair).not.toHaveBeenCalled();
    });

    it('accepts IP:port and a six-digit code, returning only a sessionId', async () => {
        const { api, adb } = makeApi();
        const { res, body } = await post(api, '/api/devices/pair/code', {
            address: '10.0.0.5:41415',
            code: '123456',
        });
        expect(res.statusCode).toBe(200);
        expect(Object.keys(body)).toEqual(['sessionId']);
        await flush();
        expect(adb.pair).toHaveBeenCalledWith('10.0.0.5:41415', '123456');
    });

    it('never echoes the pairing code back in a validation error', async () => {
        const { api } = makeApi();
        const { body } = await post(api, '/api/devices/pair/code', { address: '10.0.0.5:41415', code: 'sekrit' });
        expect(JSON.stringify(body)).not.toContain('sekrit');
    });

    it('400s a body that is not a JSON object', async () => {
        const { api } = makeApi();
        const r = makeReqRes('POST', '/api/devices/pair/code', ['not', 'an', 'object']);
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /api/devices/pair/cancel

describe('PairingApi cancel', () => {
    it('cancels the session, after which status 404s rather than reporting failed', async () => {
        const { api } = makeApi();
        const started = await post(api, '/api/devices/pair/qr');
        const sessionId = String(started.body['sessionId']);

        const cancelled = await post(api, '/api/devices/pair/cancel', { sessionId });
        expect(cancelled.res.statusCode).toBe(200);
        expect(cancelled.body).toEqual({ ok: true });

        // PairingService.cancel DROPS the session, so the very next status read
        // is a miss. The 404 is the success signal for a cancel, not an error.
        const after = await get(api, `/api/devices/pair/status?sessionId=${sessionId}`);
        expect(after.res.statusCode).toBe(404);
        expect(after.body).toEqual({ error: 'no such pairing session' });
    });

    it('is idempotent: an unknown or missing sessionId still answers ok', async () => {
        const { api } = makeApi();
        expect((await post(api, '/api/devices/pair/cancel', { sessionId: 'nope' })).body).toEqual({ ok: true });
        expect((await post(api, '/api/devices/pair/cancel', {})).body).toEqual({ ok: true });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Routing / ownership

describe('PairingApi routing', () => {
    it('returns false for a URL it does not own', async () => {
        const { api } = makeApi();
        for (const url of ['/api/devices/scan', '/api/devices/pairings', '/api/config', '/']) {
            const r = makeReqRes('GET', url);
            expect(await api.handle(r.req, r.res), url).toBe(false);
        }
    });

    it('matches on the path, so a query string cannot dodge a route', async () => {
        const { api } = makeApi();
        const r = await post(api, '/api/devices/pair/qr?whatever=1');
        expect(r.res.statusCode).toBe(200);
    });

    it('DeviceDiscoveryApi would swallow these routes — PairingApi MUST be registered first', async () => {
        setup();
        const discovery = new DeviceDiscoveryApi();
        const r = makeReqRes('POST', '/api/devices/pair/qr');
        // It claims the request (true) and answers 404: register it ahead of
        // PairingApi and every pairing route dies silently. This test exists to
        // make that ordering requirement fail loudly if it is ever reversed.
        expect(await discovery.handle(r.req, r.res)).toBe(true);
        expect(r.getStatus()).toBe(404);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Authorization

describe('PairingApi authorization', () => {
    it('403s a signed-in non-admin on every route', async () => {
        const { api } = makeApi();
        const bob = Config.getInstance().db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const routes: [string, string][] = [
            ['POST', '/api/devices/pair/qr'],
            ['POST', '/api/devices/pair/code'],
            ['GET', '/api/devices/pair/status?sessionId=x'],
            ['POST', '/api/devices/pair/cancel'],
        ];
        for (const [method, url] of routes) {
            const r = makeReqRes(method, url, {});
            (r.req as unknown as IncomingMessageWithUser).user = { id: bob.id };
            expect(await api.handle(r.req, r.res), url).toBe(true);
            expect(r.getStatus(), url).toBe(403);
        }
    });

    it('passes in open mode (no session → implicit admin)', async () => {
        const { api } = makeApi();
        expect((await post(api, '/api/devices/pair/qr')).res.statusCode).toBe(200);
    });

    it('does not 403 a URL it does not own, even for a non-admin', async () => {
        const { api } = makeApi();
        const bob = Config.getInstance().db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        // Pins the gate's PLACEMENT, not just its presence: it must sit after
        // the ownership check. Move it above and this handler starts answering
        // 403 for DeviceDiscoveryApi's routes. The open-mode ownership test
        // above cannot catch that — requireAdmin passes there either way.
        const r = makeReqRes('POST', '/api/devices/scan', {});
        (r.req as unknown as IncomingMessageWithUser).user = { id: bob.id };
        expect(await api.handle(r.req, r.res)).toBe(false);
        expect(r.getStatus()).toBe(0); // nothing written at all
    });
});

type IncomingMessageWithUser = { user?: { id: number } };
