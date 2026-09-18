import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairingError } from '../AdbClient';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { PairingApi } from '../api/PairingApi';
import { MAX_BODY_BYTES } from '../api/utils';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { Logger } from '../Logger';
import type { PairingDeps } from '../pairing/PairingService';
import { PairingService } from '../pairing/PairingService';
import { getInstanceToken } from '../security/instanceToken';
import { createHttpRequestHandler } from '../services/HttpServer';
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

    it('returns exactly sessionId, svg and expiresInMs', async () => {
        const { api } = makeApi();
        const { body } = await post(api, '/api/devices/pair/qr');
        expect(Object.keys(body).sort()).toEqual(['expiresInMs', 'sessionId', 'svg']);
        // A DURATION, not a deadline. An absolute timestamp would force the
        // browser to difference its own clock against this process's, and report
        // the skew between them as time the user does or does not have.
        expect(body['expiresInMs']).toBe(180_000);
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

    it('returns only the sessionId, whatever else the service hands back', async () => {
        // The route builds its response object explicitly rather than
        // serialising the service's return value. That distinction is invisible
        // today — `startCode` happens to return exactly `{ sessionId }` — so it
        // is asserted against the hazard it exists for: a field added to that
        // return for server-side reasons must not ship to the browser, and for
        // THIS service the field that could be added is the pairing secret.
        const { api, svc } = makeApi();
        vi.spyOn(svc, 'startCode').mockReturnValue({
            sessionId: 's1',
            password: 'SUPERSECRET',
        } as unknown as ReturnType<PairingService['startCode']>);

        const { body } = await post(api, '/api/devices/pair/code', { address: '10.0.0.5:41415', code: '123456' });
        expect(Object.keys(body)).toEqual(['sessionId']);
        expect(JSON.stringify(body)).not.toContain('SUPERSECRET');
    });

    it('rejects an address that is not IP:port, and never runs adb on it', async () => {
        const { api, adb } = makeApi();
        for (const address of [
            '-H evil', // option injection: adb parses a leading '-' as a flag
            // ...and that one does NOT test the hyphen: it fails on the space
            // and the missing port, so a pattern that allowed a leading hyphen
            // still rejected it. This is the shape that actually tests it —
            // well-formed in every other respect, and still an adb option.
            '-Hevil.com:5555',
            '10.0.0.5', // no port
            '10.0.0.5:0', // port out of range
            '10.0.0.5:70000', // port out of range
            '10.0.0.5:41415 extra',
            '10.0.0.5:41415;whoami',
            // Refused deliberately, though adb would accept it: PairingService
            // derives its connect-fallback IP with `address.split(':')[0]`,
            // which yields '[' here, so an IPv6 pairing could only ever end
            // paired-not-connected. Better a clear 400 than a half-finish.
            '[fe80::1]:5555',
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

    // The other half of the same boundary: a session the user CANCELLED is
    // gone and 404s (above), but a session the user DISPLACED by starting a
    // new one still has a client polling it, and that client gets a real
    // status. Both behaviours live here so a future change cannot quietly
    // collapse them into one answer.
    it('a superseded session reports why it ended, instead of 404ing like a cancel', async () => {
        const { api } = makeApi();
        const first = await post(api, '/api/devices/pair/qr');
        const firstId = String(first.body['sessionId']);

        await post(api, '/api/devices/pair/qr'); // displaces the first, no cancel

        const after = await get(api, `/api/devices/pair/status?sessionId=${firstId}`);
        expect(after.res.statusCode).toBe(200);
        expect(after.body['state']).toBe('failed');
        expect(String(after.body['message'])).toMatch(/replaced/i);
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

    it('falls through for an owned prefix with no matching route', async () => {
        const { api } = makeApi();
        // Wrong method on a real route, and a trailing slash that is not one.
        // Both are inside the owned prefix but match no route, so they must
        // return false and let the chain answer — not be claimed and 404'd here.
        const wrongMethod = makeReqRes('GET', '/api/devices/pair/qr');
        expect(await api.handle(wrongMethod.req, wrongMethod.res)).toBe(false);
        expect(wrongMethod.getStatus()).toBe(0);

        const trailingSlash = makeReqRes('POST', '/api/devices/pair/qr/');
        expect(await api.handle(trailingSlash.req, trailingSlash.res)).toBe(false);
        expect(trailingSlash.getStatus()).toBe(0);
    });

    it('documents why the order matters: DeviceDiscoveryApi alone claims a pairing route and 404s it', async () => {
        setup();
        const discovery = new DeviceDiscoveryApi();
        const r = makeReqRes('POST', '/api/devices/pair/qr');
        // DOCUMENTS the hazard; it does not pin the order. This assertion holds
        // whichever way index.ts registers the two, so reversing the
        // registration would not fail it. The chain tests below are what prove
        // the ordering mechanism; index.ts's own order is held by the comment
        // there, not by this suite.
        expect(await discovery.handle(r.req, r.res)).toBe(true);
        expect(r.getStatus()).toBe(404);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Registration order, through the REAL dispatch chain
//
// createHttpRequestHandler is the production chain: it walks the handler array
// and stops at the first one returning true. Driving it with the array in each
// order is what makes the ordering requirement executable rather than folklore.

/** Drive the real request chain and wait for its async handler walk to settle. */
async function driveChain(handlers: { handle: PairingApi['handle'] }[], method: string, url: string, body?: unknown) {
    const chain = createHttpRequestHandler(handlers, undefined, false);
    const r = makeReqRes(method, url, body, {
        host: 'localhost:8000',
        origin: 'http://localhost:8000',
        // The per-instance token gate sits ahead of every handler on the
        // sensitive API surface; without it the chain 403s before PairingApi
        // is ever consulted and the test would prove nothing about ordering.
        cookie: `ws_scrcpy_token=${getInstanceToken()}`,
    });
    chain(r.req, r.res);
    for (let i = 0; i < 20 && r.getStatus() === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return r;
}

describe('PairingApi registration order (real dispatch chain)', () => {
    it('serves a pairing route when PairingApi is registered BEFORE DeviceDiscoveryApi', async () => {
        const { svc } = makeApi();
        const r = await driveChain(
            [new PairingApi(() => svc), new DeviceDiscoveryApi()],
            'POST',
            '/api/devices/pair/qr',
        );
        expect(r.getStatus()).toBe(200);
        expect(String((r.getJson() as Record<string, unknown>)['svg']).startsWith('<svg')).toBe(true);
    });

    it('404s the same route when DeviceDiscoveryApi is registered first', async () => {
        const { svc } = makeApi();
        // The failing half of the pair. DeviceDiscoveryApi claims any
        // /api/devices url and 404s what it does not recognise, so it never
        // reaches PairingApi — the exact silent failure the ordering exists to
        // prevent, reproduced here so the mechanism is proven in both directions.
        const r = await driveChain(
            [new DeviceDiscoveryApi(), new PairingApi(() => svc)],
            'POST',
            '/api/devices/pair/qr',
        );
        expect(r.getStatus()).toBe(404);
        expect(r.getJson()).toEqual({ error: 'Not found' });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Failure handling — the catch block's two security properties

describe('PairingApi failure handling', () => {
    it('answers a generic 500 and keeps the error text out of BOTH the body and the log', async () => {
        setup();
        // The sentinel stands in for anything an unaudited throw could carry —
        // in this handler that would be the pairing code or the QR payload.
        const boom = new Error('boom SENTINEL');
        (boom as { code?: string }).code = 'ECONNRESET';
        const svc = {
            startQr() {
                throw boom;
            },
        } as unknown as PairingService;
        // Logger.for() returns a fresh instance, so the module-level `log` in
        // PairingApi cannot be reached directly — but it dispatches through the
        // prototype at call time, so spying there captures exactly what was
        // written to the real sink.
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        try {
            const r = makeReqRes('POST', '/api/devices/pair/qr');
            expect(await new PairingApi(() => svc).handle(r.req, r.res)).toBe(true);

            expect(r.getStatus()).toBe(500);
            expect(r.getJson()).toEqual({ error: 'internal error' });

            const logged = errorSpy.mock.calls.flat().map(String).join(' ');
            expect(errorSpy).toHaveBeenCalled(); // a silent catch would pass the two below vacuously
            expect(JSON.stringify(r.getJson())).not.toContain('SENTINEL');
            expect(logged).not.toContain('SENTINEL');
            // Finding 3: the name alone is 'Error' and says nothing, so the
            // code has to survive for the line to be worth writing.
            expect(logged).toContain('ECONNRESET');
            expect(logged).toContain('/api/devices/pair/qr');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('413s a body over the cap instead of buffering it', async () => {
        const { api } = makeApi();
        const oversized = 'x'.repeat(MAX_BODY_BYTES + 1024);
        const r = makeReqRes('POST', '/api/devices/pair/cancel', { sessionId: oversized });
        expect(await api.handle(r.req, r.res)).toBe(true);
        expect(r.getStatus()).toBe(413);
        expect(r.getJson()).toEqual({ error: 'request body too large' });
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
