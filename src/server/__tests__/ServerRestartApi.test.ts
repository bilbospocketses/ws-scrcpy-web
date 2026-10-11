import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerRestartApi } from '../api/ServerRestartApi';
import { AuthGate } from '../auth/AuthGate';
import { SESSION_COOKIE, setAuthEnabled } from '../auth/authState';
import { SESSION_TTL_MS, SessionStore } from '../auth/session';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    ALLOW_REMOTE: process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'],
};
beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsrestart-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    Config._resetForTest();
    // On Windows the marker sits in the data root, which the test setup shares
    // across a file, not in this test's temp dir: start every test without one.
    fs.rmSync(Config.getInstance().restartMarkerPath, { force: true });
});
afterEach(() => {
    fs.rmSync(Config.getInstance().restartMarkerPath, { force: true });
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    // The opt-out is process-global; never leave it set for the next test.
    if (saved.ALLOW_REMOTE === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = saved.ALLOW_REMOTE;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeReqRes(url: string, method: string, remoteAddress = '127.0.0.1') {
    const req = { url, method, socket: { remoteAddress }, headers: {} } as unknown as IncomingMessage;
    let statusCode = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(code: number) {
            statusCode = code;
            return this;
        },
        setHeader() {
            return this;
        },
        end(data?: string) {
            if (data) chunks.push(data);
        },
        getStatus: () => statusCode,
        getBody: () => chunks.join(''),
    } as unknown as ServerResponse & { getStatus(): number; getBody(): string };
    return { req, res };
}

/** An api whose timer and exit are captured, so nothing restarts the test worker. */
function makeApi() {
    let scheduled: (() => void) | undefined;
    const exits: number[] = [];
    const api = new ServerRestartApi({
        schedule: (cb) => {
            scheduled = cb;
        },
        exit: (code) => exits.push(code),
    });
    return { api, exits, fire: () => scheduled?.(), wasScheduled: () => scheduled !== undefined };
}

describe('ServerRestartApi', () => {
    it('ignores other paths and other methods', async () => {
        const { api } = makeApi();
        for (const [url, method] of [
            ['/api/server/restart', 'GET'],
            ['/api/server/restart/', 'POST'],
            ['/api/server/shutdown', 'POST'],
        ] as const) {
            const { req, res } = makeReqRes(url, method);
            expect(await api.handle(req, res)).toBe(false);
        }
    });

    it('from this machine: answers 200, writes the marker, then exits 75', async () => {
        const { api, exits, fire } = makeApi();
        const { req, res } = makeReqRes('/api/server/restart', 'POST');

        expect(await api.handle(req, res)).toBe(true);
        expect(res.getStatus()).toBe(200);
        expect(JSON.parse(res.getBody())).toEqual({ ok: true });
        expect(fs.existsSync(Config.getInstance().restartMarkerPath)).toBe(true);
        // The exit waits for its beat, so the response can flush first.
        expect(exits).toEqual([]);

        fire();
        expect(exits).toEqual([75]);
    });

    it('from off-box with no sign-in and remote admin off: 403, and nothing is scheduled', async () => {
        const { api, wasScheduled } = makeApi();
        const { req, res } = makeReqRes('/api/server/restart', 'POST', '192.168.1.20');

        expect(await api.handle(req, res)).toBe(true);
        expect(res.getStatus()).toBe(403);
        expect(wasScheduled()).toBe(false);
        expect(fs.existsSync(Config.getInstance().restartMarkerPath)).toBe(false);
    });

    // Locked mode, through the real AuthGate the way a request goes in
    // production: the route is not allow-listed, so the gate attaches the
    // session's user (or refuses), and requireAdmin decides on it.
    describe('behind AuthGate (locked mode)', () => {
        async function throughGate(remoteAddress: string, cookie: string | undefined) {
            const db = Config.getInstance().db;
            const { api, wasScheduled } = makeApi();
            const { req, res } = makeReqRes('/api/server/restart', 'POST', remoteAddress);
            if (cookie) (req.headers as Record<string, string>)['cookie'] = cookie;
            const blocked = await new AuthGate(() => db).handle(req, res);
            if (!blocked) expect(await api.handle(req, res)).toBe(true);
            return { blocked, status: res.getStatus(), wasScheduled };
        }

        it('refuses a signed-in non-admin on this machine with 403', async () => {
            const db = Config.getInstance().db;
            setAuthEnabled(db, true);
            const viewer = db.users.create({ username: 'viewer', role: 'user', passwordHash: null });
            const sid = new SessionStore(db.sqlite).create(viewer.id, Date.now(), SESSION_TTL_MS);

            const r = await throughGate('127.0.0.1', `${SESSION_COOKIE}=${sid}`);
            expect(r.blocked).toBe(false);
            expect(r.status).toBe(403);
            expect(r.wasScheduled()).toBe(false);
        });

        it('refuses a caller with no session on this machine, at the gate', async () => {
            setAuthEnabled(Config.getInstance().db, true);
            const r = await throughGate('127.0.0.1', undefined);
            expect(r.blocked).toBe(true);
            expect(r.status).toBe(401);
            expect(r.wasScheduled()).toBe(false);
        });

        it('restarts for a signed-in admin from another machine', async () => {
            const db = Config.getInstance().db;
            setAuthEnabled(db, true);
            const sid = new SessionStore(db.sqlite).create(IMPLICIT_ADMIN_ID, Date.now(), SESSION_TTL_MS);

            const r = await throughGate('192.168.1.50', `${SESSION_COOKIE}=${sid}`);
            expect(r.blocked).toBe(false);
            expect(r.status).toBe(200);
            expect(r.wasScheduled()).toBe(true);
        });
    });

    it('from off-box with remote admin allowed: restarts', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const { api, exits, fire } = makeApi();
        const { req, res } = makeReqRes('/api/server/restart', 'POST', '192.168.1.20');

        expect(await api.handle(req, res)).toBe(true);
        expect(res.getStatus()).toBe(200);
        fire();
        expect(exits).toEqual([75]);
    });
});
