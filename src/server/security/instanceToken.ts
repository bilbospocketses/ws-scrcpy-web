import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookieSecurity } from './cookiePolicy';

/**
 * Per-instance bearer token, layered on top of the Origin/Host allowlist.
 *
 * The Origin check blocks cross-site *browser* attacks, but a non-browser
 * client on the LAN can spoof Origin/Host and reach the (otherwise
 * unauthenticated) API/WS surface. The token closes that gap: it is minted
 * fresh each launch, handed to the browser as a site-scoped, HttpOnly cookie
 * when the SPA document is served, and required on the sensitive API surface
 * and on every WebSocket handshake. A non-browser caller that never loaded the
 * page has no cookie and is rejected.
 *
 * `SameSite` is `Strict` by default and relaxes only where an operator has
 * allow-listed an embedder, because `Strict` is never sent from a cross-site
 * iframe and so left `/embed.html` unable to authenticate (#641). `cookiePolicy`
 * owns that decision, and states why the Origin check — not SameSite — is what
 * holds the CSRF line here.
 *
 * Three requests are deliberately exempt, all sent by a process rather than a
 * browser and so cookieless: the launcher's `GET /api/config` upgrade probe,
 * which only reads non-sensitive config to detect the live server; the sibling
 * guard's `GET /api/whoami` identity probe (siblingInstance.ts); and the tray
 * helper's `POST /api/server/shutdown` quit (tray/src/main.rs). None of them
 * gives an off-box caller anything the token would have kept back: `/api/config`
 * answers every machine, as the readiness probe and the Docker HEALTHCHECK must,
 * and its envelope holds no secrets; `/api/whoami` answers this machine only;
 * and `ServerShutdownApi` re-imposes the token on an off-box caller, then the
 * operator ladder.
 *
 * A fourth, `GET /api/tls/ca-root`, is exempt so that an off-box caller can
 * use it, deliberately: a device installing the local CA has never loaded the page.
 * It returns a public certificate, and it does not bypass sign-in: AuthGate and
 * TlsApi's admin gate still apply in locked mode — see `requiresToken`.
 *
 * A fifth, `GET /api/updates/status`, also reaches off-box (D15): after an
 * in-app update the page that clicked "apply" holds the old process's token.
 * UpdatesApi answers a caller without a valid token with the running version
 * ONLY; the full status still needs the token.
 *
 * The shutdown exemption is a fix, not a widening (item 114, 2026-09-06): the
 * tray has POSTed that path cookieless since v0.1.8, and once this token landed
 * the gate answered it 403 — measured, with the handler's own log line absent —
 * so the tray's Exit silently stopped working. It is the ONLY stop affordance
 * in service mode, where Settings' "stop server & exit" is disabled by design.
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

/**
 * Build the hardened Set-Cookie value that hands the token to the browser.
 *
 * `SameSite` is `Strict` unless an operator has allow-listed an embedder, in
 * which case it relaxes so the app can authenticate inside that frame — see
 * `cookiePolicy` for the whole rule and why it is not a CSRF widening.
 */
export function buildTokenCookie(secure: boolean): string {
    const policy = cookieSecurity('Strict', secure);
    const attrs = [`${COOKIE_NAME}=${getInstanceToken()}`, 'Path=/', `SameSite=${policy.sameSite}`, 'HttpOnly'];
    if (policy.secure) {
        attrs.push('Secure');
    }
    if (policy.partitioned) {
        attrs.push('Partitioned');
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
 * API surface is protected except the five exemptions described above.
 * Exact path and method only: `/api/whoami/` or a POST are gated as usual.
 */
export function requiresToken(method: string | undefined, pathname: string): boolean {
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
        return false;
    }
    const m = (method ?? 'GET').toUpperCase();
    if ((m === 'GET' || m === 'HEAD') && pathname === '/api/config') {
        return false;
    }
    if (m === 'GET' && pathname === '/api/whoami') {
        return false;
    }
    // The tray helper's quit. Cookieless by nature (a process, not a browser);
    // `ServerShutdownApi` asks an off-box caller for the token anyway (then the
    // operator ladder), and the Origin check still rejects a cross-origin
    // browser POST.
    if (m === 'POST' && pathname === '/api/server/shutdown') {
        return false;
    }
    // The root CA certificate, for a device to install: a phone following a
    // link or a QR code, `curl` from another machine. That caller never loaded
    // the page, so it has no cookie. Unlike whoami and shutdown, this one
    // serves an off-box caller with no token, on purpose (user decision
    // 2026-09-27): what it returns is a public certificate, never the key. It
    // does not bypass sign-in: in locked mode AuthGate answers a caller with no session 401 before TlsApi
    // runs, and TlsApi's admin gate answers a signed-in non-admin 403.
    // Rate-limited and logged by TlsApi as before.
    if (m === 'GET' && pathname === '/api/tls/ca-root') {
        return false;
    }
    // The in-app update's reconnect poll (D15; user decision 2026-09-29). The
    // relaunched server mints a new token, so the page that clicked "apply" holds
    // a dead one, and every build before the D15 client fix only reloads on a 200
    // carrying a new currentVersion. UpdatesApi answers a caller WITHOUT a valid
    // token with `{ currentVersion }` and nothing else; the full status still
    // needs the token. Like /api/tls/ca-root this is reachable off-box: what it
    // discloses is the running version. The Origin check and AuthGate still apply.
    if (m === 'GET' && pathname === '/api/updates/status') {
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
