import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthApi } from '../api/AuthApi';
import { SESSION_COOKIE, setAuthEnabled } from '../auth/authState';
import { hashPassword } from '../auth/password';
import { SessionStore } from '../auth/session';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };
function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsauth-'));
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

describe('AuthApi', () => {
    it('login with the right password → 200, httpOnly cookie, session minted', async () => {
        setup();
        const db = Config.getInstance().db;
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('pw'));
        setAuthEnabled(db, true);
        const r = makeReqRes('POST', '/api/auth/login', { username: 'admin', password: 'pw' });
        await new AuthApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        const cookie = r.getHeader('set-cookie') ?? '';
        expect(cookie).toContain(`${SESSION_COOKIE}=`);
        expect(cookie).toContain('HttpOnly');
        expect((db.sqlite.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1);
    });
    it('login with a wrong password → 401', async () => {
        setup();
        const db = Config.getInstance().db;
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('pw'));
        setAuthEnabled(db, true);
        const r = makeReqRes('POST', '/api/auth/login', { username: 'admin', password: 'WRONG' });
        await new AuthApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(401);
    });
    it('me → implicit admin in open mode', async () => {
        setup();
        const r = makeReqRes('GET', '/api/auth/me');
        await new AuthApi().handle(r.req, r.res);
        expect(r.getJson()).toMatchObject({ authEnabled: false, user: { username: 'admin', role: 'admin' } });
    });
    it('me → user:null for an unauthenticated request when locked', async () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        const r = makeReqRes('GET', '/api/auth/me');
        await new AuthApi().handle(r.req, r.res);
        expect(r.getJson()).toEqual({ authEnabled: true, needsLockdown: true, user: null });
    });
    // Finding 18.13 — the client keyed its "Secure the admin account" block on
    // `!authEnabled`, but the server takes the lockdown branch only while no
    // enabled admin has a password. Those are different questions, and row
    // 18.11's state (login disabled, admin still passworded) is where they
    // disagree: the client offered "Secure & add user", the server answered the
    // normal-create 201, and the client announced "Login is now required.
    // Reloading…" into an app that was still wide open.
    it('me reports needsLockdown:false when login is off but the admin still has a password', async () => {
        setup();
        const db = Config.getInstance().db;
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('pw'));
        setAuthEnabled(db, false);

        const r = makeReqRes('GET', '/api/auth/me');
        await new AuthApi().handle(r.req, r.res);

        // This is the pair that used to disagree: auth is off, and yet the
        // server would NOT take the lockdown branch.
        expect(r.getJson()).toMatchObject({ authEnabled: false, needsLockdown: false });
    });

    it('me reports needsLockdown:true on a fresh install, where the two agree', async () => {
        setup();
        const r = makeReqRes('GET', '/api/auth/me');
        await new AuthApi().handle(r.req, r.res);
        expect(r.getJson()).toMatchObject({ authEnabled: false, needsLockdown: true });
    });

    it('change-password rejects a wrong current password (400)', async () => {
        setup();
        Config.getInstance().db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('right'));
        const r = makeReqRes('POST', '/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'new' });
        await new AuthApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
    });
    it('enable refused (409) with no admin password; succeeds once set', async () => {
        setup();
        const db = Config.getInstance().db;
        const r1 = makeReqRes('POST', '/api/auth/enable', {});
        await new AuthApi().handle(r1.req, r1.res);
        expect(r1.getStatus()).toBe(409);
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('pw'));
        const r2 = makeReqRes('POST', '/api/auth/enable', {});
        await new AuthApi().handle(r2.req, r2.res);
        expect(r2.getStatus()).toBe(200);
        expect(db.appSettings.get('authEnabled')).toBe(true);
    });
    it('logout clears the session for the cookie', async () => {
        setup();
        const db = Config.getInstance().db;
        const token = new SessionStore(db.sqlite).create(IMPLICIT_ADMIN_ID, Date.now());
        const r = makeReqRes('POST', '/api/auth/logout', {}, { cookie: `${SESSION_COOKIE}=${token}` });
        await new AuthApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect((db.sqlite.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    });
});
