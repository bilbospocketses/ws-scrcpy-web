import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { Config } from '../Config';
import { requireAdmin } from '../auth/requireAdmin';
import { EnvName } from '../EnvName';
import { ConfigApi } from '../api/ConfigApi';
import { DependencyApi } from '../api/DependencyApi';
import { ServiceApi } from '../api/ServiceApi';
import { UpdatesApi } from '../api/UpdatesApi';
import { ServerShutdownApi } from '../api/ServerShutdownApi';
import { makeReqRes } from './helpers/httpMock';

// ──────────────────────────────────────────────────────────────────────────
// Harness (matches authApi.test.ts pattern)

const tmpDirs: string[] = [];
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
        const res = { writeHead: (s: number) => { status = s; }, end: () => {} } as unknown as ServerResponse;
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
        const r = makeReqRes('PATCH', '/api/config', { webPort: 9000 });
        (r.req as any).user = { id: bob.id };
        await new ConfigApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });

    it('GET /api/config as a non-admin → NOT 403 (stays reachable)', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const r = makeReqRes('GET', '/api/config');
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
        const r = makeReqRes('GET', '/api/dependencies');
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
        const r = makeReqRes('GET', '/api/service/status');
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
        const r = makeReqRes('GET', '/api/updates/status');
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
        const r = makeReqRes('POST', '/api/server/shutdown');
        (r.req as any).user = { id: bob.id };
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(403);
    });
});
