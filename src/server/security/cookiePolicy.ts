import { Logger } from '../Logger';
import { hasFrameAncestors } from './frameGuard';

const log = Logger.for('cookiePolicy');

/**
 * The `SameSite`/`Secure` attributes shared by the two cookies the app issues:
 * the per-instance token (`instanceToken`, default `Strict`) and the login
 * session (`AuthApi`, default `Lax`).
 *
 * Both default to a site-scoped policy, and both were therefore invisible to
 * the one feature that is cross-site by design. `/embed.html` and the
 * `frameAncestors` opt-in exist to be loaded from another site's page, and a
 * WebSocket handshake made from inside that iframe is a cross-site request:
 * `Strict` is never sent on it, and `Lax` is not either (Lax covers top-level
 * navigations, not subresources). So the embed page authenticated in exactly
 * one deployment — the one where the embedder happens to be same-site — and
 * failed everywhere else with a 403 at the token gate, or a 4401 on the socket
 * in locked mode. That is issue #641.
 *
 * When an operator has opted a specific embedder in, the cookies relax to
 * `SameSite=None; Secure; Partitioned`:
 *
 * - `None` is what makes the browser send them from the frame at all.
 * - `Secure` is mandatory with `None`, and is why this is gated on the request
 *   being https (see `isRequestSecure`, which understands the documented
 *   reverse-proxy deployment).
 * - `Partitioned` (CHIPS) keys the cookie to the embedding top-level site, so
 *   it keeps working through the third-party-cookie phase-out instead of
 *   depending on the user permitting third-party cookies. A browser that does
 *   not know the attribute ignores it and gets the pre-CHIPS behaviour.
 *
 * **This is not a CSRF widening.** `SameSite` was never the layer holding that
 * line here — `originGuard` matches Origin against Host on the whole sensitive
 * surface and on every handshake, and it is untouched. The token's stated job
 * is to refuse a non-browser LAN client that never loaded a page, and a
 * cross-site cookie does not help such a client: it still has no token.
 *
 * With no `frameAncestors` configured — the default — the attributes are
 * exactly what they were before, so the ordinary deployment is unchanged.
 */
export type DefaultSameSite = 'Strict' | 'Lax';

// The mismatch below is an operator misconfiguration that produces no error
// anywhere: the page frames, the cookie is issued, and only the socket fails.
// Say it once per process rather than per response.
let warnedAboutInsecureFraming = false;

export function cookieSameSiteAttrs(fallback: DefaultSameSite, secure: boolean): string[] {
    if (hasFrameAncestors()) {
        if (secure) {
            return ['SameSite=None', 'Secure', 'Partitioned'];
        }
        if (!warnedAboutInsecureFraming) {
            warnedAboutInsecureFraming = true;
            log.warn(
                'frameAncestors is configured but this request is not https, so the cookie stays site-scoped ' +
                    'and cross-site embedding cannot authenticate. Serve the app over https — behind a reverse ' +
                    'proxy, forward X-Forwarded-Proto: https from the proxy (it is trusted only over loopback).',
            );
        }
    }
    const attrs = [`SameSite=${fallback}`];
    if (secure) {
        attrs.push('Secure');
    }
    return attrs;
}

/** Test seam: forget that the misconfiguration warning has been emitted. */
export function _resetCookiePolicyWarningForTest(): void {
    warnedAboutInsecureFraming = false;
}
