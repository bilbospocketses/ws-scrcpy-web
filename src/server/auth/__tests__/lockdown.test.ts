import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../../db/Db';
import { isAuthEnabled } from '../authState';
import { lockdown } from '../lockdown';
import { verifyPassword } from '../password';

let dir: string;
let db: Db;
beforeEach(() => {
    Db._resetForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wslk-'));
    db = Db.getInstance(dir);
});

describe('lockdown', () => {
    it('sets the admin password, creates the first user, and enables auth atomically', () => {
        lockdown(db, {
            adminUsername: 'owner',
            adminPassword: 'admin-pw',
            newUser: { username: 'bob', role: 'user', password: 'bob-pw' },
        });
        const admin = db.users.getById(1)!;
        expect(admin.username).toBe('owner');
        expect(verifyPassword('admin-pw', admin.passwordHash!)).toBe(true);
        const bob = db.users.getByUsername('bob')!;
        expect(verifyPassword('bob-pw', bob.passwordHash!)).toBe(true);
        expect(isAuthEnabled(db)).toBe(true);
    });
    it('rejects when an admin password already exists (not the first-user path)', () => {
        db.users.setPasswordHash(1, 'scrypt$...');
        expect(() =>
            lockdown(db, {
                adminUsername: 'x',
                adminPassword: 'y',
                newUser: { username: 'z', role: 'user', password: 'p' },
            }),
        ).toThrow();
    });
});
