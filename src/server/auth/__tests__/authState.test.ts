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
        expect(isAllowlisted('/login')).toBe(false); // SPA-shell-leak defense: /login is served inline by AuthGate, never allow-listed
    });
    it('allow-lists the embed-request routes, which are unauthenticated by design', () => {
        // These grant nothing — they record that another local app would like to be allowed to
        // frame us, and a human still approves that through the gated UI. Without the exemption
        // locked mode answers them with 200 + login HTML, which a JSON client reads as a
        // malformed success rather than "sign in first".
        expect(isAllowlisted('/embed-request')).toBe(true);
        expect(isAllowlisted('/embed-request/9d4c1f2e-0000-4000-8000-000000000000')).toBe(true);
        // The admin decision surface is NOT exempt — it is what actually grants permission.
        expect(isAllowlisted('/api/embed-request')).toBe(false);
        expect(isAllowlisted('/api/embed-request/decision')).toBe(false);
    });
});
