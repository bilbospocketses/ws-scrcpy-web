import type { IncomingMessage, ServerResponse } from 'http';
import { lockdown } from '../auth/lockdown';
import { hashPassword } from '../auth/password';
import { requireAdmin } from '../auth/requireAdmin';
import { SessionStore } from '../auth/session';
import { Config } from '../Config';
import type { Role } from '../db/UserStore';
import { readJsonBody } from './utils';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function isRole(v: unknown): v is Role {
    return v === 'user' || v === 'admin';
}

export class UsersApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname !== '/api/users' && !pathname.startsWith('/api/users/')) return false;
        if (!requireAdmin(req, res)) return true;

        const db = Config.getInstance().db;

        if (req.method === 'GET' && pathname === '/api/users') {
            const users = db.users.list().map((u) => ({
                id: u.id,
                username: u.username,
                role: u.role,
                hasPassword: u.passwordHash !== null,
                disabled: u.disabled,
                lockedUntil: u.lockedUntil,
                lastLogin: u.lastLoginAt,
            }));
            sendJson(res, 200, { users });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/users') {
            const body = await readJsonBody(req);
            const username = typeof body['username'] === 'string' ? body['username'] : '';
            const role: Role = isRole(body['role']) ? body['role'] : 'user';
            const password = typeof body['password'] === 'string' ? body['password'] : '';
            if (username.length === 0 || password.length === 0) {
                sendJson(res, 400, { error: 'username and password are required' });
                return true;
            }
            const needsLockdown = db.users.countEnabledAdminsWithPassword() === 0;
            if (needsLockdown) {
                const adminUsername = typeof body['adminUsername'] === 'string' ? body['adminUsername'] : '';
                const adminPassword = typeof body['adminPassword'] === 'string' ? body['adminPassword'] : '';
                if (adminUsername.length === 0 || adminPassword.length === 0) {
                    sendJson(res, 400, {
                        error: 'adminUsername and adminPassword are required to secure the admin account',
                    });
                    return true;
                }
                try {
                    lockdown(db, { adminUsername, adminPassword, newUser: { username, role, password } });
                } catch {
                    sendJson(res, 409, {
                        error: 'could not complete first-user setup (the admin may already be secured, or the username is taken)',
                    });
                    return true;
                }
                sendJson(res, 201, { ok: true });
                return true;
            }
            try {
                const u = db.users.create({ username, role, passwordHash: hashPassword(password) });
                sendJson(res, 201, { id: u.id });
            } catch {
                sendJson(res, 409, { error: 'username already exists' });
            }
            return true;
        }

        if (req.method === 'PATCH' && pathname.startsWith('/api/users/')) {
            const idStr = pathname.slice('/api/users/'.length);
            const id = Number(idStr);
            if (!Number.isInteger(id) || String(id) !== idStr) {
                sendJson(res, 400, { error: 'invalid id' });
                return true;
            }
            const target = db.users.getById(id);
            if (!target) {
                sendJson(res, 404, { error: 'no such user' });
                return true;
            }
            const body = await readJsonBody(req);

            const isLastEnabledAdmin =
                target.role === 'admin' && !target.disabled && db.users.countEnabledAdmins() <= 1;
            if (body['disabled'] === true && isLastEnabledAdmin) {
                sendJson(res, 409, { error: 'cannot disable the last enabled admin' });
                return true;
            }
            if (body['role'] === 'user' && isLastEnabledAdmin) {
                sendJson(res, 409, { error: 'cannot demote the last enabled admin' });
                return true;
            }

            if (isRole(body['role'])) db.users.setRole(id, body['role']);
            if (typeof body['password'] === 'string' && body['password'].length > 0) {
                db.users.setPasswordHash(id, hashPassword(body['password']));
            }
            if (typeof body['disabled'] === 'boolean') {
                db.users.setDisabled(id, body['disabled']);
                if (body['disabled']) new SessionStore(db.sqlite).deleteForUser(id);
            }
            if (body['unlock'] === true) db.users.clearLockout(id);
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (req.method === 'DELETE' && pathname.startsWith('/api/users/')) {
            const idStr = pathname.slice('/api/users/'.length);
            const id = Number(idStr);
            if (!Number.isInteger(id) || String(id) !== idStr) {
                sendJson(res, 400, { error: 'invalid id' });
                return true;
            }
            const target = db.users.getById(id);
            if (!target) {
                sendJson(res, 404, { error: 'no such user' });
                return true;
            }
            if (target.role === 'admin' && !target.disabled && db.users.countEnabledAdmins() <= 1) {
                sendJson(res, 409, { error: 'cannot delete the last enabled admin' });
                return true;
            }
            db.users.delete(id); // sessions cascade via FK
            sendJson(res, 200, { ok: true });
            return true;
        }

        return false;
    }
}
