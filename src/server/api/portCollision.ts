import { getCertService } from '../tls/createCertService';

/**
 * The http and https listeners cannot share a port: an http listener on the
 * https port wins and Local HTTPS is dropped for that boot (Config.buildServers,
 * `httpsCollisionWarning`). Settings refuses a change that would make them
 * meet -- but only while a certificate exists (user decision after 0.5.3).
 * Without one there is no https listener to collide with, and an http port of
 * 8443 (the default https port) is accepted, as it always was.
 *
 * Shared by `POST /api/settings/batch` and `PATCH /api/config`, the two writers
 * of the web port, so they cannot disagree about it.
 */

/** The refusal for a change that would leave the http and https ports equal. */
export function portCollisionError(port: number): string {
    return `the http and https ports must differ (both would be ${port})`;
}

/**
 * Does Local HTTPS have a certificate on disk (`CertService.getState()`'s
 * `status: 'ready'`)? `false` when that cannot be told -- `getCertService()`
 * throws without a resolvable data root -- since with no certificate known
 * there is nothing to refuse for.
 */
export function certificateExists(): boolean {
    try {
        return getCertService().getState().status === 'ready';
    } catch {
        return false;
    }
}

/**
 * Why the http port `webPort` and the https port `httpsPort` cannot both
 * stand, or null when they can. Both must already be validated integers.
 * `certReady` is asked only when the two are equal, so the common case never
 * reads the certificate's state at all.
 */
export function portCollisionRefusal(webPort: number, httpsPort: number, certReady: () => boolean): string | null {
    if (webPort !== httpsPort) return null;
    if (!certReady()) return null;
    return portCollisionError(httpsPort);
}
