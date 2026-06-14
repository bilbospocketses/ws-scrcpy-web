import { isIP } from 'node:net';

export interface OriginCheckResult {
    allowed: boolean;
    reason?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Whether an HTTP request must pass the Origin/Host check. We gate the entire
 * API surface (including `GET /api/*`, to stop DNS-rebinding data exfiltration)
 * and every state-changing method on any path. Safe-method requests for static
 * assets are left ungated so the page can bootstrap (a cross-origin page that
 * loads our HTML only gets an opaque response it cannot read).
 */
export function requiresOriginCheck(method: string | undefined, pathname: string): boolean {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
        return true;
    }
    return !method || !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Parse the hostname out of a Host header value (strips the port and any IPv6
 * brackets). Returns null if the value cannot be parsed.
 */
function hostnameOf(host: string): string | null {
    try {
        const hostname = new URL(`http://${host}`).hostname.toLowerCase();
        // WHATWG URL returns IPv6 hostnames bracketed (e.g. "[::1]"); strip the
        // brackets so isIP() can recognise the literal.
        if (hostname.startsWith('[') && hostname.endsWith(']')) {
            return hostname.slice(1, -1);
        }
        return hostname;
    } catch {
        return null;
    }
}

/**
 * A Host is allowed only if its hostname is `localhost` or an IP literal.
 *
 * A DNS-rebinding attack requires a *domain name* (so the attacker can later
 * point it at a loopback/LAN address). Rejecting any Host that is neither
 * `localhost` nor a raw IP blocks rebinding without having to enumerate the
 * machine's own addresses, and still allows legitimate access by IP over the
 * LAN (e.g. http://192.168.1.5:8000).
 */
function isHostAllowed(host: string | undefined): boolean {
    if (!host) {
        return false;
    }
    const hostname = hostnameOf(host);
    if (!hostname) {
        return false;
    }
    return hostname === 'localhost' || isIP(hostname) !== 0;
}

/**
 * Decide whether an incoming HTTP/WS request may be served. Defends the
 * otherwise-unauthenticated API/WebSocket surface against cross-site (CSRF)
 * and DNS-rebinding attacks:
 *
 *   - Host must be `localhost` or an IP literal (DNS-rebinding defense).
 *   - If an Origin header is present it must match the Host's origin (CSRF
 *     defense). A *missing* Origin is allowed at this layer — non-browser
 *     clients and same-origin GET/HEAD requests omit it; the per-instance
 *     token closes that remaining gap for non-browser callers.
 */
export function isRequestAllowed(
    origin: string | undefined,
    host: string | undefined,
): OriginCheckResult {
    if (!isHostAllowed(host)) {
        return { allowed: false, reason: 'host not allowed (possible DNS rebinding)' };
    }
    if (origin) {
        const normalizedOrigin = origin.toLowerCase();
        const expectedHttp = `http://${host}`.toLowerCase();
        const expectedHttps = `https://${host}`.toLowerCase();
        if (normalizedOrigin !== expectedHttp && normalizedOrigin !== expectedHttps) {
            return { allowed: false, reason: 'cross-origin request rejected' };
        }
    }
    return { allowed: true };
}
