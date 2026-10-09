import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApi } from '../api/AuthApi';
import { ConfigApi } from '../api/ConfigApi';
import { DependencyApi } from '../api/DependencyApi';
import { ServerShutdownApi } from '../api/ServerShutdownApi';
import { ServiceApi } from '../api/ServiceApi';
import { TlsApi } from '../api/TlsApi';
import { UpdatesApi } from '../api/UpdatesApi';
import { requireAdmin } from '../auth/requireAdmin';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { getInstanceToken } from '../security/instanceToken';
import type { CertService } from '../tls/CertService';
import { HTTP_EXPOSURE_KEY } from '../tls/httpExposure';
import { makeReqRes } from './helpers/httpMock';

// ──────────────────────────────────────────────────────────────────────────
// Harness (matches authApi.test.ts pattern)

const tmpDirs: string[] = [];
/** The cookie a page served by this process carries. */
const PAGE_TOKEN = { cookie: `ws_scrcpy_token=${getInstanceToken()}` };
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsauth-admin-'));
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

// ──────────────────────────────────────────────────────────────────────────
// requireAdmin unit tests

describe('requireAdmin', () => {
    it('403s a non-admin (a real user row with role user)', () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        let status = 0;
        const res = {
            writeHead: (s: number) => {
                status = s;
            },
            end: () => {},
        } as unknown as ServerResponse;
        const req = { user: { id: bob.id } } as unknown as IncomingMessage;
        expect(requireAdmin(req, res)).toBe(false);
        expect(status).toBe(403);
    });

    it('passes an admin and passes open mode (no req.user → implicit admin)', () => {
        setup();
        const res = { writeHead: () => {}, end: () => {} } as unknown as ServerResponse;
        expect(requireAdmin({ user: { id: 1 } } as unknown as IncomingMessage, res)).toBe(true);
        expect(requireAdmin({} as unknown as IncomingMessage, res)).toBe(true);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// ConfigApi: guard PATCH only

describe('ConfigApi admin authorization', () => {
    it('PATCH /api/config as a non-admin → 403', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const r = makeReqRes('PATCH', '/api/config', { webPort: 9000 }, {}, { remoteAddress: '127.0.0.1' });
        (r.req as any).user = { id: bob.id };
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });

    it('GET /api/config as a non-admin → NOT 403 (stays reachable)', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const r = makeReqRes('GET', '/api/config', undefined, {}, { remoteAddress: '127.0.0.1' });
        (r.req as any).user = { id: bob.id };
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).not.toBe(403);
        expect(r.getStatus()).toBe(200);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Per-handler 403 tests

describe('DependencyApi admin authorization', () => {
    it('GET /api/dependencies as a non-admin → 403', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        // Construct with a stub manager — it won't be called on the 403 path
        const stubManager = {} as any;
        const api = new DependencyApi(stubManager);
        const r = makeReqRes('GET', '/api/dependencies', undefined, {}, { remoteAddress: '127.0.0.1' });
        (r.req as any).user = { id: bob.id };
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });
});

describe('ServiceApi admin authorization', () => {
    it('GET /api/service/status as a non-admin → 403', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        // Construct with minimal injectable stubs — won't be called on 403 path
        const api = new ServiceApi();
        const r = makeReqRes('GET', '/api/service/status', undefined, {}, { remoteAddress: '127.0.0.1' });
        (r.req as any).user = { id: bob.id };
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });
});

describe('UpdatesApi admin authorization', () => {
    it('GET /api/updates/status as a non-admin → 403', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        // Stub UpdateService — won't be called on 403 path
        const stubSvc = {} as any;
        const api = new UpdatesApi(stubSvc);
        // A real page carries this process's token: without it the D15 version-only
        // reply answers first and the operator gate under test is never reached.
        const r = makeReqRes('GET', '/api/updates/status', undefined, PAGE_TOKEN, { remoteAddress: '127.0.0.1' });
        (r.req as any).user = { id: bob.id };
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });
});

describe('ServerShutdownApi admin authorization', () => {
    it('POST /api/server/shutdown as a non-admin → 403', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const api = new ServerShutdownApi();
        const r = makeReqRes('POST', '/api/server/shutdown', undefined, {}, { remoteAddress: '127.0.0.1' });
        (r.req as any).user = { id: bob.id };
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Off-box refusal (requireOperator). Distinguished from the non-admin 403s
// above by the error BODY, so a test cannot pass for the wrong reason.

const OFF_BOX = { remoteAddress: '192.168.1.50' };
const OFF_BOX_ERROR = { error: 'admin actions are limited to this machine' };

describe('off-box callers are refused in open mode', () => {
    it('PATCH /api/config', async () => {
        setup();
        const r = makeReqRes('PATCH', '/api/config', { webPort: 9000 }, {}, OFF_BOX);
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/dependencies', async () => {
        setup();
        const r = makeReqRes('GET', '/api/dependencies', undefined, {}, OFF_BOX);
        await new DependencyApi({} as any).handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/service/status', async () => {
        setup();
        const r = makeReqRes('GET', '/api/service/status', undefined, {}, OFF_BOX);
        await new ServiceApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/updates/status', async () => {
        setup();
        const r = makeReqRes('GET', '/api/updates/status', undefined, PAGE_TOKEN, OFF_BOX);
        await new UpdatesApi({} as any).handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('POST /api/auth/enable', async () => {
        setup();
        const r = makeReqRes('POST', '/api/auth/enable', {}, {}, OFF_BOX);
        await new AuthApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toEqual(OFF_BOX_ERROR);
    });

    it('GET /api/config stays 200 from off-box — probe, HEALTHCHECK, ReadyPath', async () => {
        setup();
        const r = makeReqRes('GET', '/api/config', undefined, {}, OFF_BOX);
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// TlsApi (item 153). The WRITES are operator-gated like every other admin
// action: an off-box caller in open mode could otherwise regenerate the CA
// every device trusts, revoke it, change exposure, or restart the server via
// the port. The two READS stay admin-only, because a second machine opening
// the Local HTTPS panel to download the CA is the feature (smoke 21.2).

const PEM = '-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n';

function stubCertService(): { svc: CertService; calls: string[] } {
    const calls: string[] = [];
    const svc = {
        getState: () => {
            calls.push('getState');
            return { status: 'none' };
        },
        caRootPem: () => {
            calls.push('caRootPem');
            return PEM;
        },
        generate: async () => {
            calls.push('generate');
            return { status: 'none' };
        },
        revoke: () => {
            calls.push('revoke');
        },
        currentLeafFingerprint: () => undefined,
    } as unknown as CertService;
    return { svc, calls };
}

const TLS_WRITES: ReadonlyArray<readonly [string, unknown]> = [
    ['/api/tls/generate', { kind: 'ip', value: '192.168.1.10' }],
    ['/api/tls/revoke', {}],
    ['/api/tls/exposure', { mode: 'httpsOnly' }],
    ['/api/tls/https-port', { port: 8443 }],
];

describe('TlsApi: writes are refused off-box in open mode, reads are not (item 153)', () => {
    const savedRemoteAdmin = process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    afterEach(() => {
        if (savedRemoteAdmin === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = savedRemoteAdmin;
    });

    for (const [route, body] of TLS_WRITES) {
        it(`POST ${route} → the operator refusal, and nothing runs`, async () => {
            setup();
            delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
            const { svc, calls } = stubCertService();
            const schedule = vi.fn();
            const exit = vi.fn();
            const r = makeReqRes('POST', route, body, {}, OFF_BOX);
            await new TlsApi(
                () => svc,
                () => [],
                { schedule, exit },
            ).handle(r.req, r.res);
            expect(r.getStatus()).toBe(403);
            expect(r.getJson()).toEqual(OFF_BOX_ERROR);
            expect(calls).toEqual([]);
            expect(schedule).not.toHaveBeenCalled();
            expect(exit).not.toHaveBeenCalled();
        });
    }

    it('the refused exposure write left the stored mode untouched', async () => {
        setup();
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const { svc } = stubCertService();
        const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'httpsOnly' }, {}, OFF_BOX);
        await new TlsApi(
            () => svc,
            () => [],
        ).handle(r.req, r.res);
        expect(Config.getInstance().db.appSettings.get(HTTP_EXPOSURE_KEY)).toBeUndefined();
    });

    it('control: the same exposure write from loopback succeeds and is stored', async () => {
        setup();
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const { svc } = stubCertService();
        const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'httpsOnly' }, {}, { remoteAddress: '127.0.0.1' });
        await new TlsApi(
            () => svc,
            () => [],
        ).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(Config.getInstance().db.appSettings.get(HTTP_EXPOSURE_KEY)).toBe('httpsOnly');
    });

    it('control: WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 lets the off-box write through', async () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const { svc, calls } = stubCertService();
        const r = makeReqRes('POST', '/api/tls/revoke', {}, {}, OFF_BOX);
        await new TlsApi(
            () => svc,
            () => [],
        ).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(calls).toEqual(['revoke']);
    });

    it('GET /api/tls/ca-root off-box → 200 with the certificate, so a second machine can install it', async () => {
        setup();
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const { svc } = stubCertService();
        const r = makeReqRes('GET', '/api/tls/ca-root', undefined, {}, OFF_BOX);
        await new TlsApi(
            () => svc,
            () => [],
        ).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(r.getHeader('content-disposition')).toContain('ws-scrcpy-web-local-ca.crt');
    });

    it('GET /api/tls/state off-box → answered, not refused: the panel still renders there', async () => {
        setup();
        delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        const { svc, calls } = stubCertService();
        const r = makeReqRes('GET', '/api/tls/state', undefined, {}, OFF_BOX);
        await new TlsApi(
            () => svc,
            () => [],
        ).handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(calls).toContain('getState');
    });
});
