import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeReqRes } from '../../__tests__/helpers/httpMock';
import { Db } from '../../db/Db';
import { AuthGate } from '../AuthGate';
import { SESSION_COOKIE, setAuthEnabled } from '../authState';
import { SESSION_TTL_MS, SessionStore } from '../session';

const dirs: string[] = [];
afterEach(() => {
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function db(): Db {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsgate-'));
    dirs.push(d);
    return Db.getInstance(d);
}

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
        const d = db();
        setAuthEnabled(d, true);
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/api/devices', undefined);
        expect(handled).toBe(true);
        expect(status).toBe(401);
    });
    it('401s a cold GET /api/tls/ca-root when locked -- the token exemption does not open it', async () => {
        // The CA download is exempt from the per-instance TOKEN (instanceToken.ts)
        // so a device that never loaded the page can fetch it in open mode. It is
        // NOT on the AuthGate allowlist: in locked mode a caller with no session
        // is refused here, before TlsApi's admin gate is ever reached.
        const d = db();
        setAuthEnabled(d, true);
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/api/tls/ca-root', undefined);
        expect(handled).toBe(true);
        expect(status).toBe(401);
    });
    it('passes a valid session through and attaches the user', async () => {
        const d = db();
        setAuthEnabled(d, true);
        const token = new SessionStore(d.sqlite).create(1, Date.now(), SESSION_TTL_MS);
        const gate = new AuthGate(() => d);
        const { req, handled } = await runGate(gate, 'GET', '/api/devices', `${SESSION_COOKIE}=${token}`);
        expect(handled).toBe(false);
        expect((req as { user?: { id: number } }).user?.id).toBe(1);
    });
    it('serves the inline login page (200 html) for an unauthenticated navigation when locked', async () => {
        const d = db();
        setAuthEnabled(d, true);
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/', undefined);
        expect(handled).toBe(true);
        expect(status).toBe(200);
    });
    it('blocks a disabled user even with a valid session cookie (fail-closed)', async () => {
        const d = db();
        setAuthEnabled(d, true);
        const bob = d.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const token = new SessionStore(d.sqlite).create(bob.id, Date.now(), SESSION_TTL_MS);
        d.users.setDisabled(bob.id, true); // raw disable WITHOUT session revoke → exercises the gate's own check
        const gate = new AuthGate(() => d);
        const { status, handled } = await runGate(gate, 'GET', '/api/devices', `${SESSION_COOKIE}=${token}`);
        expect(handled).toBe(true);
        expect(status).toBe(401);
    });

    // Finding 12.12. An allow-listed route is never blocked, but its handler
    // may still need to know WHO is calling: /api/server/shutdown runs
    // requireAdmin, which falls back to the implicit admin when `req.user` is
    // missing. The gate used to return before it looked at the cookie, so a
    // signed-in non-admin was treated as the admin on that route.
    describe('allow-listed paths in locked mode', () => {
        it('attaches the user for a valid session and still does not block', async () => {
            const d = db();
            setAuthEnabled(d, true);
            const bob = d.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
            const token = new SessionStore(d.sqlite).create(bob.id, Date.now(), SESSION_TTL_MS);
            const gate = new AuthGate(() => d);
            const { req, handled, status } = await runGate(
                gate,
                'POST',
                '/api/server/shutdown',
                `${SESSION_COOKIE}=${token}`,
            );
            expect(handled).toBe(false);
            expect(status).toBe(0);
            expect((req as { user?: { id: number } }).user?.id).toBe(bob.id);
        });

        it('attaches nothing and does not block when there is no cookie (the tray)', async () => {
            const d = db();
            setAuthEnabled(d, true);
            const gate = new AuthGate(() => d);
            const { req, handled, status } = await runGate(gate, 'POST', '/api/server/shutdown', undefined);
            expect(handled).toBe(false);
            expect(status).toBe(0);
            expect((req as { user?: unknown }).user).toBeUndefined();
        });

        it('attaches nothing and does not block for an unknown session token', async () => {
            const d = db();
            setAuthEnabled(d, true);
            const gate = new AuthGate(() => d);
            const { req, handled, status } = await runGate(
                gate,
                'POST',
                '/api/server/shutdown',
                `${SESSION_COOKIE}=${'f'.repeat(64)}`,
            );
            expect(handled).toBe(false);
            expect(status).toBe(0);
            expect((req as { user?: unknown }).user).toBeUndefined();
        });

        it("attaches nothing for a disabled user's session and still does not block", async () => {
            const d = db();
            setAuthEnabled(d, true);
            const bob = d.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
            const token = new SessionStore(d.sqlite).create(bob.id, Date.now(), SESSION_TTL_MS);
            d.users.setDisabled(bob.id, true);
            const gate = new AuthGate(() => d);
            const { req, handled, status } = await runGate(
                gate,
                'POST',
                '/api/server/shutdown',
                `${SESSION_COOKIE}=${token}`,
            );
            expect(handled).toBe(false);
            expect(status).toBe(0);
            expect((req as { user?: unknown }).user).toBeUndefined();
        });
    });
});
