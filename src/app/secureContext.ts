/**
 * Secure-context detection for the streaming path.
 *
 * WebCodecs is exposed only in a secure context, so on `http://<lan-ip>:8000`
 * `VideoDecoder` is undefined, `WebCodecsPlayer.isSupported()` is false, and
 * `StreamClientScrcpy.players` stays empty. Every downstream consumer then does
 * nothing, quietly: the device card renders no connect link (it only calls
 * `updateLink` for a registered player), the config modal's connect button
 * returns early on a missing player name, and its video inputs are never
 * filled. A LAN user opening the container over plain HTTP — the documented way
 * to use the image — got a device list they could not stream from and no
 * explanation at all.
 *
 * Loopback is the exception the browser makes: `http://127.0.0.1` and
 * `http://localhost` are secure contexts, which is why streaming works on the
 * serving machine and nowhere else. Chromium's
 * `--unsafely-treat-insecure-origin-as-secure` was measured not to change this
 * (2026-09-03, chromium 151) — not alone, not with the matching
 * `--enable-features` flag, not through a persistent context. So the remedy is
 * a real one: use loopback, or put the app behind HTTPS.
 */

/** The subset of `window` this module reads — narrowed so it is trivially testable. */
export interface SecureContextWindow {
    isSecureContext: boolean;
    location: LocationParts;
}

export interface LocationParts {
    protocol: string;
    hostname: string;
    port: string;
}

/** The same app on loopback, port preserved so the hint can be pasted as-is. */
export function loopbackEquivalent(location: LocationParts): string {
    const port = location.port ? `:${location.port}` : '';
    return `${location.protocol}//localhost${port}`;
}

/**
 * The message to show when the browser will not give us a decoder, or `null`
 * when it will. Lowercase, per the app's text motif.
 */
export function insecureOriginNotice(win: SecureContextWindow): string | null {
    if (win.isSecureContext) return null;
    return (
        'this address is not a secure origin, so the browser will not expose the video decoder ' +
        'and no stream can start. open ' +
        loopbackEquivalent(win.location) +
        ' on the machine running ws-scrcpy-web, or serve this app over https from a trusted origin.'
    );
}
