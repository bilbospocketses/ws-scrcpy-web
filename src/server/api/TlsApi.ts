import type { IncomingMessage, ServerResponse } from 'http';
import { networkInterfaces } from 'os';
import { requireAdmin } from '../auth/requireAdmin';
import { Config, validateHttpsPortInput } from '../Config';
import { Logger } from '../Logger';
import { candidateLanIps } from '../network/candidateLanIps';
import type { CertService, CertState, CertSubjectKind } from '../tls/CertService';
import type { HttpExposure } from '../tls/httpExposure';
import { HTTP_EXPOSURE_KEY } from '../tls/httpExposure';
import { scheduleRestartForPortChange } from './restartRequest';
import { BodyTooLargeError, InvalidJsonError, readJsonBodyStrict, sendInternalError } from './utils';

const log = Logger.for('TlsApi');
const PREFIX = '/api/tls';

/**
 * `GET /api/tls/ca-root` hands out the root CA certificate for install into a
 * browser's trust store — spec §7 requires it "admin-gated ... also
 * rate-limited and logs each download". This is one operator clicking a
 * button, not a public API, so a small in-memory counter is enough; it is
 * scoped to this `TlsApi` INSTANCE (not per-connection: a fresh `req`/`res`
 * per request does not reset it), so a caller cannot dodge the limit by
 * opening a new socket per request. The composition root (`index.ts`)
 * registers exactly one `TlsApi`, which is what makes "per instance" and
 * "per process" coincide in production — the mechanism itself is per-instance.
 */
const CA_ROOT_RATE_LIMIT = 10;
const CA_ROOT_RATE_WINDOW_MS = 60_000;

export class TlsApi {
    /** Timestamps (ms) of recent CA-root downloads, oldest first. */
    private readonly caRootDownloads: number[] = [];

    constructor(
        private readonly getService: () => CertService,
        private readonly getCandidateIps: () => string[] = () => candidateLanIps(networkInterfaces()),
        // Test seams for the https-port restart (task 11), mirroring
        // SettingsBatchApiOptions -- production leaves both undefined and gets
        // the real setTimeout/process.exit; tests inject both so an
        // https-port case never actually schedules a real timer or kills the
        // vitest worker.
        private readonly seams: {
            schedule?: (cb: () => void, ms: number) => unknown;
            exit?: (code: number) => void;
        } = {},
    ) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        let pathname: string;
        try {
            pathname = new URL(req.url || '', 'http://localhost').pathname;
        } catch {
            return false;
        }
        if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;

        // Admin-gated as a whole, placed BEFORE the route table so a route
        // added later cannot land ungated. Handing out a root CA is the exact
        // shape of a malware delivery step; it does not get an anonymous
        // endpoint even though this CA is only dangerous to someone who
        // installs it.
        if (!requireAdmin(req, res)) return true;

        try {
            // Inside the try (N11): getService() can throw on first use (e.g.
            // getCertService() finding no resolvable data root), and that
            // failure deserves the same log.error + generic 500 every other
            // failure in this handler gets, rather than escaping to
            // HttpServer's last-resort guard silently.
            const svc = this.getService();

            if (req.method === 'GET' && pathname === `${PREFIX}/state`) {
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({ ...svc.getState(), candidateIps: this.getCandidateIps() }));
                return true;
            }

            if (req.method === 'GET' && pathname === `${PREFIX}/ca-root`) {
                res.setHeader('Content-Type', 'application/json');

                const pem = svc.caRootPem();
                if (pem === undefined) {
                    // No CA on disk yet — an ordinary state (first run, or a
                    // failed regenerate that deleted it — see CertService.generate's
                    // doc comment), never a 500. Checked BEFORE the rate limit
                    // (N8): the limit tracks actual CA material leaving the
                    // process, so a 404 must never spend a slot — otherwise an
                    // operator clicking "download" on a machine with no
                    // certificate yet locks themselves out of downloads that
                    // never happened.
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'no certificate has been generated yet' }));
                    return true;
                }

                if (this.isCaRootRateLimited()) {
                    res.writeHead(429);
                    res.end(JSON.stringify({ error: 'too many CA downloads; wait a moment and try again' }));
                    return true;
                }

                log.info('CA root downloaded');
                res.setHeader('Content-Type', 'application/x-pem-file');
                res.setHeader('Content-Disposition', 'attachment; filename="ws-scrcpy-web-local-ca.pem"');
                res.writeHead(200);
                res.end(pem);
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/generate`) {
                const body = await readJsonBodyStrict<{ kind?: unknown; value?: unknown }>(req);
                res.setHeader('Content-Type', 'application/json');

                // `kind` must be one of the two literals. Defaulting a missing or
                // misspelled kind to 'ip' would silently mislabel a hostname
                // subject; CertService then builds an IP-shaped name constraint
                // from the wrong kind and mkcert refuses it with no clue as to
                // why (amendment C).
                if (body.kind !== 'ip' && body.kind !== 'hostname') {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'kind must be "ip" or "hostname"' }));
                    return true;
                }
                const kind: CertSubjectKind = body.kind;

                const value = typeof body.value === 'string' ? body.value.trim() : '';
                if (!value) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'value is required' }));
                    return true;
                }

                let state: CertState;
                try {
                    state = await svc.generate(kind, value);
                } catch {
                    // Deliberately does NOT echo the message: it can contain the
                    // caller's own input, which would land in their DOM.
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'that address could not be used for a certificate' }));
                    return true;
                }

                // The certificate now genuinely EXISTS -- mkcert ran, the CA was
                // replaced, and the leaf is on disk. Everything past this point
                // is a DIFFERENT failure mode (N1): a config.json write failing
                // here must never be reported as "that address could not be
                // used for a certificate", because it was used, successfully.
                //
                // A hostname subject needs allowedHosts or requests are
                // refused as DNS-rebinding (see security/originGuard). A raw
                // IP already passes that check, so writing one here would
                // recreate the confusion issue #691 was about: a user reading
                // `allowedHosts: ["192.168.86.3"]` reasonably concludes IPs
                // belong there. Skip the write for kind 'ip' (amendment c).
                let allowedHostAdded = false;
                if (kind === 'hostname' && state.subject) {
                    try {
                        allowedHostAdded = Config.getInstance().addAllowedHost(state.subject);
                    } catch (err) {
                        log.error(
                            `certificate issued for "${state.subject}" but allowedHosts could not be updated: ${(err as Error)?.message ?? String(err)}`,
                        );
                        // allowedHostAdded stays false; the response below still
                        // reports the real, successful certificate state.
                    }
                }

                res.writeHead(200);
                res.end(JSON.stringify({ ...state, allowedHostAdded }));
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/revoke`) {
                svc.revoke();
                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/exposure`) {
                const body = await readJsonBodyStrict<{ mode?: unknown }>(req);
                res.setHeader('Content-Type', 'application/json');

                // `mode` must be one of the three literals -- defaulting a missing
                // or misspelled mode to 'open' would silently widen exposure
                // instead of applying whatever the caller actually asked for
                // (amendment C's precedent for `kind`, above).
                if (body.mode !== 'open' && body.mode !== 'httpsOnly' && body.mode !== 'redirect') {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'mode must be "open", "httpsOnly", or "redirect"' }));
                    return true;
                }
                const mode: HttpExposure = body.mode;

                try {
                    // HttpServer.ts reads this key FRESH on every plain-HTTP
                    // request (readHttpExposure) -- there is no cache to
                    // invalidate and no listener to rebind, so this write takes
                    // effect for the very next request, with no restart.
                    Config.getInstance().db.appSettings.set(HTTP_EXPOSURE_KEY, mode);
                } catch (err) {
                    log.error(`could not persist http exposure mode: ${(err as Error)?.message ?? String(err)}`);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'could not save the exposure setting' }));
                    return true;
                }

                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, mode }));
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/https-port`) {
                const body = await readJsonBodyStrict<{ port?: unknown }>(req);
                res.setHeader('Content-Type', 'application/json');

                const validated = validateHttpsPortInput(body.port);
                if (!validated.ok) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: validated.error }));
                    return true;
                }

                const cfg = Config.getInstance();
                try {
                    cfg.setHttpsPort(validated.value);
                } catch (err) {
                    log.error(`could not persist https port: ${(err as Error)?.message ?? String(err)}`);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'could not save the https port' }));
                    return true;
                }

                // Unlike exposure above: the listener set is built once at boot
                // (Config.buildServers) and nothing rebinds it in-process, so
                // this ALWAYS needs a restart. Mirrors SettingsBatchApi's
                // webPort handling exactly (same helper, same exit-75 signal).
                scheduleRestartForPortChange(cfg.restartMarkerPath, log, this.seams);

                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, port: validated.value, restartRequired: true }));
                return true;
            }

            res.setHeader('Content-Type', 'application/json');
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'no such tls route' }));
            return true;
        } catch (err) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413);
                res.end(JSON.stringify({ error: 'request body too large' }));
                return true;
            }
            if (err instanceof InvalidJsonError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'invalid JSON body' }));
                return true;
            }
            log.error(`${req.method} ${pathname} threw ${(err as Error)?.name || 'Error'}`);
            sendInternalError(res);
            return true;
        }
    }

    /**
     * Sliding-window burst check: at most `CA_ROOT_RATE_LIMIT` downloads per
     * `CA_ROOT_RATE_WINDOW_MS`, counted on THIS instance (there is exactly one,
     * held by the composition root) rather than per-request state, so it
     * cannot be reset by opening a new connection.
     */
    private isCaRootRateLimited(): boolean {
        const now = Date.now();
        const cutoff = now - CA_ROOT_RATE_WINDOW_MS;
        while (this.caRootDownloads.length > 0 && this.caRootDownloads[0]! <= cutoff) {
            this.caRootDownloads.shift();
        }
        if (this.caRootDownloads.length >= CA_ROOT_RATE_LIMIT) {
            return true;
        }
        this.caRootDownloads.push(now);
        return false;
    }
}
