/** How the plain-HTTP listener behaves once a certificate exists. */
export type HttpExposure = 'open' | 'httpsOnly' | 'redirect';

/** app_settings key holding the HttpExposure value. */
export const HTTP_EXPOSURE_KEY = 'httpExposure';

/**
 * What the plain-HTTP listener should do with one request.
 *
 * LOOPBACK IS EXEMPT FROM BOTH NARROWED MODES, and that is the whole design.
 * Without it, a certificate that goes bad -- expired, IP moved under DHCP,
 * CAROOT wiped by a container recreate -- removes the only route to the
 * Settings page that could turn the mode back off, and the recovery becomes
 * hand-editing config.json. It also keeps /api/whoami answering over loopback
 * HTTP, which the Control Menu integration probes.
 *
 * An unrecognised mode serves. The value is read from the database, and a
 * hand-edited or newer-version row must not be able to brick access.
 */
export function decideHttpRequest(mode: HttpExposure, isLoopback: boolean): 'serve' | 'refuse' | 'redirect' {
    if (isLoopback) return 'serve';
    if (mode === 'httpsOnly') return 'refuse';
    if (mode === 'redirect') return 'redirect';
    return 'serve';
}
