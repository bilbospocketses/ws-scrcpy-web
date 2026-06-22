import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { Db } from '../../db/Db';
import { isAllowlisted, isAuthEnabled, parseCookie, SESSION_COOKIE, setAuthEnabled } from '../authState';

const dirs: string[] = [];
afterEach(() => {
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('authState', () => {
    it('reads/writes authEnabled (default false)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsas-'));
        dirs.push(dir);
        const db = Db.getInstance(dir);
        expect(isAuthEnabled(db)).toBe(false);
        setAuthEnabled(db, true);
        expect(isAuthEnabled(db)).toBe(true);
    });
    it('parses the session cookie', () => {
        expect(parseCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`)?.[SESSION_COOKIE]).toBe('abc.def');
        expect(parseCookie(undefined)).toEqual({});
    });
    it('allow-lists the login page + login endpoint only', () => {
        expect(isAllowlisted('/api/auth/login')).toBe(true);
        expect(isAllowlisted('/api/whoami')).toBe(true); // install port-discovery handshake stays reachable under lockdown
        expect(isAllowlisted('/api/auth/me')).toBe(true); // login page reads authEnabled pre-login
        expect(isAllowlisted('/api/devices')).toBe(false);
        expect(isAllowlisted('/')).toBe(false); // app shell is gated → AuthGate serves the login page inline
        expect(isAllowlisted('/login')).toBe(false);            // SPA-shell-leak defense: /login is served inline by AuthGate, never allow-listed
    });
});
