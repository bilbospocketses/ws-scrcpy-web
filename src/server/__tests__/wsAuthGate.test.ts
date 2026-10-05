import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, setAuthEnabled } from '../auth/authState';
import { SessionStore } from '../auth/session';
import { SocketRegistry, WS_SESSION_REVOKED } from '../auth/socketRegistry';
import { Db } from '../db/Db';
import { wsSession, wsSessionUserId } from '../services/WebSocketServer';

const dirs: string[] = [];
afterEach(() => {
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('wsSessionUserId', () => {
    it('returns the implicit admin in open mode', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsws-'));
        dirs.push(dir);
        expect(wsSessionUserId(Db.getInstance(dir), undefined)).toBe(1);
    });
    it('returns undefined for a missing/invalid cookie when locked, and the userId for a valid one', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsws-'));
        dirs.push(dir);
        const db = Db.getInstance(dir);
        setAuthEnabled(db, true);
        expect(wsSessionUserId(db, undefined)).toBeUndefined();
        expect(wsSessionUserId(db, 'garbage=1')).toBeUndefined();
        const token = new SessionStore(db.sqlite).create(1, Date.now());
        expect(wsSessionUserId(db, `${SESSION_COOKIE}=${token}`)).toBe(1);
    });
    it('returns undefined for a disabled user even with a valid session (fail-closed)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsws-'));
        dirs.push(dir);
        const db = Db.getInstance(dir);
        setAuthEnabled(db, true);
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const token = new SessionStore(db.sqlite).create(bob.id, Date.now());
        db.users.setDisabled(bob.id, true);
        expect(wsSessionUserId(db, `${SESSION_COOKIE}=${token}`)).toBeUndefined();
    });
});

// Finding 18.23. Which session a socket is registered under decides what a
// logout closes. The handshake used to register every socket under the cookie's
// token whatever the mode, so a browser that kept its cookie after login was
// turned off had its OPEN-mode sockets closed 4401 by a logout. The rule
// (socketRegistry.ts): a socket carries a token only when auth is on and the
// session is valid.
describe('wsSession (the registration rule)', () => {
    function lockedDb(): Db {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsws-'));
        dirs.push(dir);
        const db = Db.getInstance(dir);
        setAuthEnabled(db, true);
        return db;
    }

    it('carries the session token in locked mode for a valid session', () => {
        const db = lockedDb();
        const token = new SessionStore(db.sqlite).create(1, Date.now());
        expect(wsSession(db, `${SESSION_COOKIE}=${token}`)).toEqual({ userId: 1, token });
    });

    it('carries NO token in open mode, even when the browser still has a valid session cookie', () => {
        const db = lockedDb();
        const token = new SessionStore(db.sqlite).create(1, Date.now());
        setAuthEnabled(db, false); // 18.11: login turned off, the cookie stays
        expect(wsSession(db, `${SESSION_COOKIE}=${token}`)).toEqual({ userId: 1 });
    });

    it('so an open-mode socket is not closed by a logout of that session, and a locked-mode one is', () => {
        const db = lockedDb();
        const token = new SessionStore(db.sqlite).create(1, Date.now());
        const cookie = `${SESSION_COOKIE}=${token}`;
        const lockedSocket = { close: vi.fn() };
        const openSocket = { close: vi.fn() };
        const registry = new SocketRegistry();

        const locked = wsSession(db, cookie)!;
        registry.add(lockedSocket, locked.userId, locked.token);
        setAuthEnabled(db, false);
        const open = wsSession(db, cookie)!;
        registry.add(openSocket, open.userId, open.token);

        expect(registry.revokeSession(token)).toBe(1);
        expect(lockedSocket.close).toHaveBeenCalledWith(WS_SESSION_REVOKED, 'session ended');
        expect(openSocket.close).not.toHaveBeenCalled();
    });

    it('is undefined in locked mode with no valid session (the handshake refuses it)', () => {
        const db = lockedDb();
        expect(wsSession(db, undefined)).toBeUndefined();
        expect(wsSession(db, `${SESSION_COOKIE}=${'f'.repeat(64)}`)).toBeUndefined();
    });
});
