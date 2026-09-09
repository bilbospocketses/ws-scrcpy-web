import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnabled, parseCookie, SESSION_COOKIE, setAuthEnabled } from '../auth/authState';
import { resolveUserId } from '../auth/currentUser';
import { login } from '../auth/loginService';
import { hashPassword, verifyPassword } from '../auth/password';
import { requireAdmin } from '../auth/requireAdmin';
import { SessionStore } from '../auth/session';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { Logger } from '../Logger';
import { cookieSecurity } from '../security/cookiePolicy';
import { isRequestSecure } from '../security/forwardedProto';
import { liveSockets } from '../services/WebSocketServer';
import { readJsonBody } from './utils';

const log = Logger.for('AuthApi');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Build the session cookie for this request — `expire: true` for the clearing
 * form. `SameSite` is `Lax` by default and relaxes where an operator has
 * allow-listed an embedder: a framed page gets no Lax cookie on its WebSocket
 * handshake either, so locked mode would otherwise close every embedded stream
 * with 4401 (#641). Set and clear share this builder because a `Partitioned`
 * cookie is keyed by partition — clearing it with different attributes leaves
 * the framed copy alive.
 */
function sessionCookie(req: IncomingMessage, value: string, expire = false): string {
    const socket = req.socket as { encrypted?: boolean; remoteAddress?: string } | undefined;
    const secure = isRequestSecure(Boolean(socket?.encrypted), socket?.remoteAddress, req.headers['x-forwarded-proto']);
    const policy = cookieSecurity('Lax', secure);
    // Attribute order is deliberate: unchanged from before the framing opt-in
    // existed, so the default deployment emits the same bytes it always has.
    let out = `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=${policy.sameSite}; Path=/`;
    if (expire) out += '; Max-Age=0';
    if (policy.secure) out += '; Secure';
    if (policy.partitioned) out += '; Partitioned';
    return out;
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
                res.setHeader('Set-Cookie', sessionCookie(req, result.token));
                sendJson(res, 200, { ok: true });
            } else {
                sendJson(res, 401, { ok: false, reason: result.reason });
            }
            return true;
        }

        if (req.method === 'POST' && pathname === '/api/auth/logout') {
            const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
            if (token) {
                new SessionStore(db.sqlite).delete(token);
                // Deleting the row refuses the NEXT handshake; it did nothing to
                // the sockets this session already had open, so a stream begun
                // before logout carried on after it (finding 18.14).
                const closed = liveSockets.revokeSession(token);
                if (closed > 0) log.info(`logout revoked ${closed} live socket(s)`);
            }
            // Clear with the SAME attributes it was set with: a Partitioned
            // cookie is keyed by partition, so an unpartitioned delete would
            // leave the framed copy alive.
            res.setHeader('Set-Cookie', sessionCookie(req, '', true));
            sendJson(res, 200, { ok: true });
            return true;
        }

        if (req.method === 'GET' && pathname === '/api/auth/me') {
            // ALLOW-LISTED route → self-validate the cookie (AuthGate did not attach req.user here).
            // `needsLockdown` is the SERVER's own first-user test, exposed so the
            // client stops guessing at it. UsersModal keyed its "Secure the admin
            // account" block on `!authEnabled`, while POST /api/users takes the
            // lockdown branch only while no enabled admin has a password. After
            // row 18.11 (login disabled, admin still passworded) the client
            // offered "Secure & add user", the server answered the normal-create
            // 201, and the client announced "Login is now required. Reloading…"
            // into an app that was still wide open (finding 18.13).
            const needsLockdown = db.users.countEnabledAdminsWithPassword() === 0;
            if (!isAuthEnabled(db)) {
                const admin = db.users.getById(IMPLICIT_ADMIN_ID);
                sendJson(res, 200, {
                    authEnabled: false,
                    needsLockdown,
                    user: admin ? { username: admin.username, role: admin.role } : null,
                });
                return true;
            }
            const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
            const session = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
            const user = session ? db.users.getById(session.userId) : undefined;
            sendJson(res, 200, {
                authEnabled: true,
                needsLockdown,
                user: user ? { username: user.username, role: user.role } : null,
            });
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
