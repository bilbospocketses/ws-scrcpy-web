import type { IncomingMessage, ServerResponse } from 'http';
import { Config } from '../Config';
import { isLoopback } from '../security/loopback';
import { isAuthEnabled } from './authState';
import { requireAdmin } from './requireAdmin';

/** True when AuthGate attached a session to this request. */
export function hasAuthenticatedUser(req: IncomingMessage): boolean {
    return (req as IncomingMessage & { user?: unknown }).user !== undefined;
}

/**
 * Has the operator deliberately allowed admin from off-box while running without sign-in?
 *
 * The env var is first-class and checked first: a container or headless install has nobody at a
 * browser on loopback, so it is the only path that does not require `docker exec`. qa-harness sets
 * it. The value must be exactly '1' — a loose truthiness check would let an empty string or the
 * string 'false' through.
 *
 * The config key is what the banner's confirmation modal writes, and that PATCH is itself
 * operator-gated, so the switch cannot be thrown from off-box.
 */
export function allowRemoteAdmin(): boolean {
    if (process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] === '1') return true;
    return Config.getInstance().getAppConfig().allowRemoteAdmin === true;
}

/**
 * Admin AND proof that the caller is the operator.
 *
 * `requireAdmin` alone is not sufficient. In open mode (the default) it resolves to the implicit
 * admin, and the per-instance token that gates /api is handed to any unauthenticated GET of an
 * extensionless path — so a LAN client can mint a token and administer the server. This adds the
 * missing half: the caller must prove they ARE the operator.
 *
 * That proof is loopback (they are at the machine) or a signed-in admin session (they said who they
 * are). A container has neither by default — nobody is ever on loopback there — which is why the
 * explicit opt-out exists and why the banner leads with "set up sign-in".
 *
 * Fails closed: a request with no socket is not loopback.
 *
 * NOT applied to GET /api/config (the launcher probe, the image HEALTHCHECK and qa-harness's
 * ReadyPath all depend on it answering unauthenticated from off-box), and NOT applied wholesale to
 * ServerShutdownApi, whose cookieless tray caller needs its own ladder.
 */
export function requireOperator(req: IncomingMessage, res: ServerResponse): boolean {
    if (!isLoopback(req.socket?.remoteAddress ?? '')) {
        const proven = isAuthEnabled(Config.getInstance().db) ? hasAuthenticatedUser(req) : allowRemoteAdmin();
        if (!proven) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'admin actions are limited to this machine' }));
            return false;
        }
    }
    return requireAdmin(req, res);
}

/** Which admin policy this deployment is running under, for the client to render. */
export type AdminScope = 'local' | 'remote' | 'authenticated';

/**
 * The policy in force — NOT a statement about the current caller.
 *
 * 'authenticated' outranks the opt-out: once sign-in is on, a session is the proof and
 * `allowRemoteAdmin` is moot (requireOperator ignores it in that branch too).
 */
export function resolveAdminScope(): AdminScope {
    if (isAuthEnabled(Config.getInstance().db)) return 'authenticated';
    if (allowRemoteAdmin()) return 'remote';
    return 'local';
}

/** Whether THIS request came from the machine the server runs on. */
export function callerIsLocal(req: IncomingMessage): boolean {
    return isLoopback(req.socket?.remoteAddress ?? '');
}
