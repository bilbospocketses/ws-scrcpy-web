import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { UsersApi } from '../api/UsersApi';
import { Config } from '../Config';
import { isAuthEnabled } from '../auth/authState';
import { hashPassword } from '../auth/password';
import { SessionStore } from '../auth/session';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { EnvName } from '../EnvName';
import { makeReqRes } from './helpers/httpMock';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };
function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsusers-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}
afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH]; else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH']; else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('UsersApi', () => {
    it('first POST /api/users runs lockdown and enables auth', async () => {
        setup();
        const db = Config.getInstance().db;
        const r = makeReqRes('POST', '/api/users', { adminUsername: 'owner', adminPassword: 'pw1', username: 'bob', role: 'user', password: 'pw2' });
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(201);
        expect(isAuthEnabled(db)).toBe(true);
        expect(db.users.getByUsername('bob')).toBeTruthy();
        expect(db.users.getById(IMPLICIT_ADMIN_ID)?.username).toBe('owner');
    });
    it('lists users with hasPassword field', async () => {
        setup();
        const db = Config.getInstance().db;
        db.users.create({ username: 'bob', role: 'user', passwordHash: hashPassword('x') });
        const r = makeReqRes('GET', '/api/users');
        await new UsersApi().handle(r.req, r.res);
        const body = r.getJson() as { users: Array<{ username: string; hasPassword: boolean }> };
        expect(body.users.find((u) => u.username === 'bob')?.hasPassword).toBe(true);
        expect(body.users.find((u) => u.username === 'admin')?.hasPassword).toBe(false);
    });
    it('normal create when an admin is already secured', async () => {
        setup();
        const db = Config.getInstance().db;
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('adminpw'));
        const r = makeReqRes('POST', '/api/users', { username: 'carol', role: 'admin', password: 'cpw' });
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(201);
        expect(db.users.getByUsername('carol')?.role).toBe('admin');
    });
    it('disabling a user deletes their sessions', async () => {
        setup();
        const db = Config.getInstance().db;
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword('adminpw'));
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: hashPassword('x') });
        new SessionStore(db.sqlite).create(bob.id, Date.now());
        const r = makeReqRes('PATCH', `/api/users/${bob.id}`, { disabled: true });
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(db.users.getById(bob.id)?.disabled).toBe(true);
        expect((db.sqlite.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(bob.id) as { c: number }).c).toBe(0);
    });
    it('refuses to disable the last enabled admin', async () => {
        setup();
        const db = Config.getInstance().db;
        const r = makeReqRes('PATCH', `/api/users/${IMPLICIT_ADMIN_ID}`, { disabled: true });
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(409);
        expect(db.users.getById(IMPLICIT_ADMIN_ID)?.disabled).toBe(false);
    });
    it('refuses to demote the last enabled admin', async () => {
        setup();
        const r = makeReqRes('PATCH', `/api/users/${IMPLICIT_ADMIN_ID}`, { role: 'user' });
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(409);
        expect(Config.getInstance().db.users.getById(IMPLICIT_ADMIN_ID)?.role).toBe('admin');
    });
    it('refuses to delete the last enabled admin', async () => {
        setup();
        const r = makeReqRes('DELETE', `/api/users/${IMPLICIT_ADMIN_ID}`, undefined);
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(409);
        expect(Config.getInstance().db.users.getById(IMPLICIT_ADMIN_ID)).toBeTruthy();
    });
    it('admin unlock clears a lockout', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: hashPassword('x') });
        db.users.setLockout(bob.id, { failedAttempts: 5, lockoutWindowStart: 0, lockedUntil: 9_999_999_999_999 });
        const r = makeReqRes('PATCH', `/api/users/${bob.id}`, { unlock: true });
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(db.users.getById(bob.id)?.lockedUntil).toBeNull();
    });
    it('deletes a non-last-admin user', async () => {
        setup();
        const db = Config.getInstance().db;
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: hashPassword('x') });
        const r = makeReqRes('DELETE', `/api/users/${bob.id}`, undefined);
        await new UsersApi().handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(db.users.getById(bob.id)).toBeUndefined();
    });
});
