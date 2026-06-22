import { IMPLICIT_ADMIN_ID } from '../db/constants';
import type { Db } from '../db/Db';
import { setAuthEnabled } from './authState';
import { hashPassword } from './password';

export interface LockdownParams {
    adminUsername: string;
    adminPassword: string;
    newUser: { username: string; role: 'user' | 'admin'; password: string };
}

export function lockdown(db: Db, params: LockdownParams): void {
    const admin = db.users.getById(IMPLICIT_ADMIN_ID);
    if (!admin) throw new Error('implicit admin missing');
    if (admin.passwordHash !== null) throw new Error('admin password already set; not the first-user lockdown path');

    const sqlite = db.sqlite;
    sqlite.exec('BEGIN');
    try {
        db.users.setUsername(IMPLICIT_ADMIN_ID, params.adminUsername);
        db.users.setPasswordHash(IMPLICIT_ADMIN_ID, hashPassword(params.adminPassword));
        db.users.create({
            username: params.newUser.username,
            role: params.newUser.role,
            passwordHash: hashPassword(params.newUser.password),
        });
        setAuthEnabled(db, true);
        sqlite.exec('COMMIT');
    } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
    }
}
