import { AUTH_ENABLED_KEY } from '../db/constants';
import type { Db } from '../db/Db';

export const SESSION_COOKIE = 'wsscrcpy_sid';

// `/login` is NOT here: AuthGate serves the login page body itself (see Task 8) so it never
// falls through to the SPA catch-all (`createStaticHandler` serves index.html for any non-file
// path — Auditor finding: app-shell leak). `/api/auth/me` is exempt so the login page can read
// authEnabled pre-login. `/api/whoami` is the sibling identity probe (siblingInstance.ts): a
// second instance of this app asking whether the process on its configured port is one of us,
// with no session and no cookie — so it is exempt here AND from the instance token
// (requestGate), and its handler refuses any caller that is not on loopback. Nothing it says
// reaches the LAN.
// `/embed-request` is exempt because it is unauthenticated BY DESIGN and grants nothing — it only
// records that another local app would like to be allowed to frame us, and a human still has to
// approve that in the (gated) UI. Without the exemption, locked mode answers it with 200 + the
// login HTML, which a JSON client reads as a malformed success rather than "you must sign in".
// `/api/server/shutdown` is the tray helper's quit (item 114, user decision
// 2026-09-06). The tray is a process: no cookie, no session, and in service
// mode its Exit is the only stop affordance the product has, so a locked-mode
// 401 left it dead. `ServerShutdownApi` does the authorizing instead — a
// loopback caller may stop the app (the operator's own machine), while an
// off-box caller still needs the instance token AND, in locked mode, a signed-in
// admin, which is what this allowlist entry would otherwise have given away.
// The trade is deliberate and recorded: any local process can stop the server.
const ALLOWLIST_EXACT = new Set([
    '/api/auth/login',
    '/api/auth/me',
    '/api/whoami',
    '/api/server/shutdown',
    '/embed-request',
]);
// '/login-assets/' used to sit here too. Nothing ever served that prefix and
// there is no /login route at all — the login page is served inline — so it was
// an unauthenticated hole reserved for a directory that did not exist, waiting
// for someone to mount something under it by accident (finding 18.15).
const ALLOWLIST_PREFIX = ['/embed-request/']; // embed-request status polls

export function isAuthEnabled(db: Db): boolean {
    return db.appSettings.get(AUTH_ENABLED_KEY) === true;
}
export function setAuthEnabled(db: Db, on: boolean): void {
    db.appSettings.set(AUTH_ENABLED_KEY, on);
}

export function parseCookie(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

export function isAllowlisted(pathname: string): boolean {
    return ALLOWLIST_EXACT.has(pathname) || ALLOWLIST_PREFIX.some((p) => pathname.startsWith(p));
}
