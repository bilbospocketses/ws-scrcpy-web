import { isLoopback } from './loopback';

/**
 * Is the BROWSER's side of this connection HTTPS?
 *
 * Not the same question as "did this process terminate TLS". The deployment we
 * document in the README (and the one issue #641 was filed against) puts the
 * app on plain http at `127.0.0.1:8000` behind a reverse proxy that terminates
 * TLS and sets `X-Forwarded-Proto: https`. The socket is unencrypted; the
 * browser's connection is not. Cookie attributes that are only legal over https
 * — `Secure`, and therefore `SameSite=None` and `Partitioned` — have to be
 * decided on the browser's view, or the documented deployment can never use
 * them (see cookiePolicy).
 *
 * `X-Forwarded-Proto` is client-controlled and so worth exactly nothing on its
 * own. We honour it only when the peer is on loopback, which is precisely the
 * documented topology: the proxy is the only thing that reaches the app, and it
 * reaches it over loopback. An off-box client cannot forge its way in, because
 * forging the header does not put it on loopback. That is the whole trust rule —
 * there is no configuration to get wrong.
 *
 * A deployment that puts a proxy on a DIFFERENT host is not covered, and should
 * not be: trusting a LAN peer's `X-Forwarded-Proto` would hand every LAN client
 * the same power as the proxy.
 */
export function isRequestSecure(
    serverIsTls: boolean,
    remoteAddress: string | undefined,
    forwardedProto: string | string[] | undefined,
): boolean {
    if (serverIsTls) {
        return true;
    }
    if (!remoteAddress || !isLoopback(remoteAddress)) {
        return false;
    }
    // Node collapses a repeated header into an array; a chain of proxies appends
    // to one header ("https, http"). The client-facing hop is first in both.
    const raw = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    if (!raw) {
        return false;
    }
    return raw.split(',')[0]?.trim().toLowerCase() === 'https';
}
