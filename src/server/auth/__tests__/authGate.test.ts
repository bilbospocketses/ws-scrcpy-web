import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { Db } from '../../db/Db';
import { AuthGate } from '../AuthGate';
import { SessionStore, SESSION_TTL_MS } from '../session';
import { setAuthEnabled, SESSION_COOKIE } from '../authState';
import { makeReqRes } from '../../__tests__/helpers/httpMock';

const dirs: string[] = [];
afterEach(() => { Db._resetForTest(); while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
function db(): Db { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsgate-')); dirs.push(d); return Db.getInstance(d); }

async function runGate(gate: AuthGate, method: string, url: string, cookie: string | undefined) {
    const { req, res, getStatus } = makeReqRes(method, url, undefined, cookie ? { cookie } : {});
    const handled = await gate.handle(req, res);
    return { req, res, handled, status: getStatus() };
}

describe('AuthGate', () => {
    it('passes through entirely in open mode', async () => {
        const gate = new AuthGate(() => db());
        const { handled } = await runGate(gate, 'GET', '/api/devices', undefined);
        expect(handled).toBe(false);
    });
    it('401s an unauthenticated API request when locked', async () => {
        const d = db(); setAuthEnabled(d, true);
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/api/devices', undefined);
        expect(handled).toBe(true);
        expect(status).toBe(401);
    });
    it('passes a valid session through and attaches the user', async () => {
        const d = db(); setAuthEnabled(d, true);
        const token = new SessionStore(d.sqlite).create(1, Date.now(), SESSION_TTL_MS);
        const gate = new AuthGate(() => d);
        const { req, handled } = await runGate(gate, 'GET', '/api/devices', `${SESSION_COOKIE}=${token}`);
        expect(handled).toBe(false);
        expect((req as { user?: { id: number } }).user?.id).toBe(1);
    });
    it('serves the inline login page (200 html) for an unauthenticated navigation when locked', async () => {
        const d = db(); setAuthEnabled(d, true);
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/', undefined);
        expect(handled).toBe(true);
        expect(status).toBe(200);
    });
    it('blocks a disabled user even with a valid session cookie (fail-closed)', async () => {
        const d = db(); setAuthEnabled(d, true);
        const bob = d.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const token = new SessionStore(d.sqlite).create(bob.id, Date.now(), SESSION_TTL_MS);
        d.users.setDisabled(bob.id, true); // raw disable WITHOUT session revoke → exercises the gate's own check
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/api/devices', `${SESSION_COOKIE}=${token}`);
        expect(handled).toBe(true);
        expect(status).toBe(401);
    });
});
