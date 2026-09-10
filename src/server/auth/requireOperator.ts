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
 * Has the operator deliberately allowed admin from off-box while running
 * without sign-in? Implemented in Task 2; false until then.
 */
export function allowRemoteAdmin(): boolean {
    return false;
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
