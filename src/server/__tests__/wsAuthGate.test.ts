import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, setAuthEnabled } from '../auth/authState';
import { SessionStore } from '../auth/session';
import { Db } from '../db/Db';
import { wsSessionUserId } from '../services/WebSocketServer';

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
