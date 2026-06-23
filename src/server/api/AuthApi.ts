import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnabled, parseCookie, SESSION_COOKIE, setAuthEnabled } from '../auth/authState';
import { resolveUserId } from '../auth/currentUser';
import { login } from '../auth/loginService';
import { hashPassword, verifyPassword } from '../auth/password';
import { requireAdmin } from '../auth/requireAdmin';
import { SessionStore } from '../auth/session';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { readJsonBody } from './utils';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

export class AuthApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!pathname.startsWith('/api/auth/')) return false;

        const db = Config.getInstance().db;

        if (req.method === 'POST' && pathname === '/api/auth/login') {
            const body = await readJsonBody(req);
            const username = typeof body['username'] === 'string' ? body['username'] : '';
            const password = typeof body['password'] === 'string' ? body['password'] : '';
            const result = login(db, username, password, Date.now());
            if (result.ok) {
                const secure = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
                res.setHeader(
                    'Set-Cookie',
                    `${SESSION_COOKIE}=${result.token}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`,
                );
                sendJson(res, 200, { ok: true });
            } else {
                sendJson(res, 401, { ok: false, reason: result.reason });
            }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/logout') {
            const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
            if (token) new SessionStore(db.sqlite).delete(token);
            res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/auth/me') {
            // ALLOW-LISTED route → self-validate the cookie (AuthGate did not attach req.user here).
            if (!isAuthEnabled(db)) {
                const admin = db.users.getById(IMPLICIT_ADMIN_ID);
                sendJson(res, 200, {
                    authEnabled: false,
                    user: admin ? { username: admin.username, role: admin.role } : null,
                });
                return true;
            }
            const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
            const session = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
            const user = session ? db.users.getById(session.userId) : undefined;
            sendJson(res, 200, { authEnabled: true, user: user ? { username: user.username, role: user.role } : null });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/change-password') {
            const body = await readJsonBody(req);
            const current = typeof body['currentPassword'] === 'string' ? body['currentPassword'] : '';
            const next = typeof body['newPassword'] === 'string' ? body['newPassword'] : '';
            if (next.length === 0) {
                sendJson(res, 400, { error: 'newPassword required' });
                return true;
            }
            const user = db.users.getById(resolveUserId(req));
            if (!user?.passwordHash || !verifyPassword(current, user.passwordHash)) {
                sendJson(res, 400, { error: 'current password incorrect' });
                return true;
            }
            db.users.setPasswordHash(user.id, hashPassword(next));
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/enable') {
            if (!requireAdmin(req, res)) return true;
            if (db.users.countEnabledAdminsWithPassword() < 1) {
                sendJson(res, 409, { error: 'set an admin password before enabling auth' });
                return true;
            }
            setAuthEnabled(db, true);
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/disable') {
            if (!requireAdmin(req, res)) return true;
            setAuthEnabled(db, false);
            sendJson(res, 200, { ok: true });
            return true;
        }

        return false;
    }
}
