import {
    buildTokenCookie,
    isValidToken,
    parseTokenFromCookie,
    requiresToken,
    shouldSetTokenCookie,
} from './instanceToken';
import { isHostAllowed, isRequestAllowed, requiresOriginCheck } from './originGuard';

export type HttpGateDecision =
    | { allowed: true; setCookie?: string }
    | { allowed: false; status: number; reason: string };

export interface WsGateDecision {
    allowed: boolean;
    reason?: string;
}

/**
 * Decide what to do with an incoming HTTP request. Composes the two defence
 * layers in order — Origin/Host allowlist first, then the per-instance token —
 * and, for allowed document requests, signals that the SPA's token cookie
 * should be attached. This is the single decision the HttpServer applies; the
 * server only translates it into `res` calls.
 */
export function evaluateHttpRequest(
    method: string | undefined,
    pathname: string,
    origin: string | undefined,
    host: string | undefined,
    cookieHeader: string | undefined,
    secure: boolean,
): HttpGateDecision {
    // The Host allowlist is universal — a rebinding/foreign Host is never served
    // (and never handed a token cookie), even for documents and static assets.
    if (!isHostAllowed(host)) {
        return { allowed: false, status: 403, reason: 'host not allowed (possible DNS rebinding)' };
    }
    // The Origin match only applies to the sensitive surface, so top-level
    // navigations (which carry no Origin) and asset loads still work.
    if (requiresOriginCheck(method, pathname)) {
        const verdict = isRequestAllowed(origin, host);
        if (!verdict.allowed) {
            return { allowed: false, status: 403, reason: verdict.reason ?? 'forbidden' };
        }
    }
    if (requiresToken(method, pathname) && !isValidToken(parseTokenFromCookie(cookieHeader))) {
        return { allowed: false, status: 403, reason: 'missing or invalid token' };
    }
    if (shouldSetTokenCookie(method, pathname)) {
        return { allowed: true, setCookie: buildTokenCookie(secure) };
    }
    return { allowed: true };
}

/**
 * Decide whether a WebSocket handshake may upgrade. Every legitimate WS client
 * is the browser, which sends both a same-origin Origin header and the token
 * cookie, so both layers are always enforced here.
 */
export function evaluateWsConnection(
    origin: string | undefined,
    host: string | undefined,
    cookieHeader: string | undefined,
): WsGateDecision {
    const verdict = isRequestAllowed(origin, host);
    if (!verdict.allowed) {
        return { allowed: false, reason: verdict.reason ?? 'forbidden' };
    }
    if (!isValidToken(parseTokenFromCookie(cookieHeader))) {
        return { allowed: false, reason: 'missing or invalid token' };
    }
    return { allowed: true };
}
