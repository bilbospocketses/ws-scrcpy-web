import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-instance bearer token, layered on top of the Origin/Host allowlist.
 *
 * The Origin check blocks cross-site *browser* attacks, but a non-browser
 * client on the LAN can spoof Origin/Host and reach the (otherwise
 * unauthenticated) API/WS surface. The token closes that gap: it is minted
 * fresh each launch, handed to the browser as a SameSite=Strict, HttpOnly
 * cookie when the SPA document is served, and required on the sensitive API
 * surface and on every WebSocket handshake. A non-browser caller that never
 * loaded the page has no cookie and is rejected.
 *
 * The launcher's `GET /api/config` upgrade probe is deliberately exempt — it
 * has no cookie and only reads non-sensitive config to detect the live server.
 */

const COOKIE_NAME = 'ws_scrcpy_token';

let cachedToken: string | null = null;

/** The token for this process. Generated lazily on first use, then stable. */
export function getInstanceToken(): string {
    if (cachedToken === null) {
        cachedToken = randomBytes(32).toString('hex');
    }
    return cachedToken;
}

/** Build the hardened Set-Cookie value that hands the token to the browser. */
export function buildTokenCookie(secure: boolean): string {
    const attrs = [`${COOKIE_NAME}=${getInstanceToken()}`, 'Path=/', 'SameSite=Strict', 'HttpOnly'];
    if (secure) {
        attrs.push('Secure');
    }
    return attrs.join('; ');
}

/** Pull the token value out of a Cookie request header. */
export function parseTokenFromCookie(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) {
        return null;
    }
    for (const part of cookieHeader.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) {
            continue;
        }
        if (part.slice(0, eq).trim() === COOKIE_NAME) {
            return part.slice(eq + 1).trim();
        }
    }
    return null;
}

/** Constant-time comparison of a provided token against this instance's token. */
export function isValidToken(provided: string | null | undefined): boolean {
    if (!provided) {
        return false;
    }
    const expected = getInstanceToken();
    if (provided.length !== expected.length) {
        return false;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
        return false;
    }
    return timingSafeEqual(a, b);
}

/**
 * Whether a request to the given API path must carry a valid token. The whole
 * API surface is protected except the launcher's `GET /api/config` probe.
 */
export function requiresToken(method: string | undefined, pathname: string): boolean {
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
        return false;
    }
    const m = (method ?? 'GET').toUpperCase();
    if ((m === 'GET' || m === 'HEAD') && pathname === '/api/config') {
        return false;
    }
    return true;
}

function pathExtension(pathname: string): string {
    const lastSlash = pathname.lastIndexOf('/');
    const lastDot = pathname.lastIndexOf('.');
    return lastDot > lastSlash && lastDot !== -1 ? pathname.slice(lastDot) : '';
}

/**
 * Whether we should attach the token cookie to this response. We set it only on
 * document responses (the SPA shell) — not static assets or API responses — so
 * the browser has the cookie before its first API/WS call.
 */
export function shouldSetTokenCookie(method: string | undefined, pathname: string): boolean {
    const m = (method ?? 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') {
        return false;
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
        return false;
    }
    const ext = pathExtension(pathname);
    return ext === '' || ext === '.html';
}
