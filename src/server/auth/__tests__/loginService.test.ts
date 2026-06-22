import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Db } from '../../db/Db';
import { LOCK_MS } from '../loginPolicy';
import { login } from '../loginService';
import { hashPassword } from '../password';

let dir: string;
let db: Db;
beforeEach(() => {
    Db._resetForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslog-'));
    db = Db.getInstance(dir);
    db.users.setPasswordHash(1, hashPassword('correct')); // admin id 1
});

describe('login', () => {
    it('succeeds with the right password and returns a session token', () => {
        const r = login(db, 'admin', 'correct', 1000);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.token.length).toBeGreaterThan(20);
    });
    it('rejects an unknown user generically', () => {
        expect(login(db, 'nobody', 'x', 1000)).toEqual({ ok: false, reason: 'invalid' });
    });
    it('rejects a disabled user', () => {
        db.users.setDisabled(1, true);
        expect(login(db, 'admin', 'correct', 1000)).toEqual({ ok: false, reason: 'disabled' });
    });
    it('locks after 5 failures and reports locked', () => {
        for (let i = 0; i < 5; i++) login(db, 'admin', 'wrong', 1000);
        const r = login(db, 'admin', 'correct', 1000);
        expect(r).toEqual({ ok: false, reason: 'locked' }); // correct pw ignored while locked
        // auto-unlock after the window
        const r2 = login(db, 'admin', 'correct', 1000 + LOCK_MS + 1);
        expect(r2.ok).toBe(true);
    });
});

describe('login timing-blind paths', () => {
    it('calls blindVerify on unknown-username path and still returns invalid', async () => {
        // Dynamic import so vi.spyOn can intercept the live module binding.
        const passwordMod = await import('../password');
        const spy = vi.spyOn(passwordMod, 'blindVerify');
        const r = login(db, 'nobody', 'x', 1000);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ ok: false, reason: 'invalid' });
        spy.mockRestore();
    });

    it('calls blindVerify on disabled-user path and still returns disabled', async () => {
        const passwordMod = await import('../password');
        const spy = vi.spyOn(passwordMod, 'blindVerify');
        db.users.setDisabled(1, true);
        const r = login(db, 'admin', 'correct', 1000);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(r).toEqual({ ok: false, reason: 'disabled' });
        spy.mockRestore();
    });

    it('does NOT call blindVerify on the happy path (correct password)', async () => {
        const passwordMod = await import('../password');
        const spy = vi.spyOn(passwordMod, 'blindVerify');
        const r = login(db, 'admin', 'correct', 1000);
        expect(spy).not.toHaveBeenCalled();
        expect(r.ok).toBe(true);
        spy.mockRestore();
    });
});
