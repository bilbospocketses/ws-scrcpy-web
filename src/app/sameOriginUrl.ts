/**
 * The same app on another port — same scheme, same host, only the port changed.
 *
 * Every hand-off that moves the browser to a different port (service install
 * shifting to the service's port, uninstall discovering the fresh local
 * instance, a web-port save, the first-run install) used to navigate to
 * `http://localhost:<port>/`. That is right only for a browser on the serving
 * machine: a LAN client, a hostname, a reverse proxy or a container runner was
 * sent to its OWN localhost and lost the app (qa-harness Arc 1b finding,
 * 2026-09-06; smoke rows 4.3 / 12.2). The port is the one thing a hand-off
 * changes, so keep everything else the browser already has.
 *
 * `URL` does the fiddly parts: IPv6 hosts keep their brackets, and a port that
 * is the scheme's default (80 / 443) is dropped rather than printed.
 */

/** Navigation target: `<scheme>//<host>:<port>/` with path, query and hash cleared. */
export function sameOriginUrl(port: number, base: string = window.location.href): string {
    const url = new URL(base);
    url.port = String(port);
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
}

/** Display form for "this app lives at …": the origin only, no trailing slash. */
export function sameOriginBase(port: number, base: string = window.location.href): string {
    const url = new URL(base);
    url.port = String(port);
    return url.origin;
}
