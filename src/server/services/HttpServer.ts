import { X509Certificate } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import * as http from 'http';
import * as https from 'https';
import path from 'path';
import * as process from 'process';
import { TypedEmitter } from '../../common/TypedEmitter';
import { sendInternalError } from '../api/utils';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { Logger } from '../Logger';
import { createStaticHandler } from '../StaticFileServer';
import { isRequestSecure } from '../security/forwardedProto';
import { securityHeaders } from '../security/frameGuard';
import { isLoopback } from '../security/loopback';
import { hostnameOf, isHostAllowed } from '../security/originGuard';
import { evaluateHttpRequest } from '../security/requestGate';
import type { HttpExposure } from '../tls/httpExposure';
import { decideHttpRequest, HTTP_EXPOSURE_KEY } from '../tls/httpExposure';
import { Utils } from '../Utils';
import type { Service } from './Service';

interface ApiHandler {
    handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

/**
 * Build the single HTTP request handler: baseline security headers, then the
 * request gate, then the API handler chain, then the static fallback.
 *
 * Exported (rather than living only as a private method) so the gate's 403 and
 * the API JSON responses can be driven directly in tests — those two paths are
 * exactly the ones that used to escape securityHeaders().
 */
export function createHttpRequestHandler(
    apiHandlers: readonly ApiHandler[],
    fallback: ((req: IncomingMessage, res: ServerResponse) => void) | undefined,
    serverIsTls: boolean,
): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        // Baseline security headers for EVERY response this server writes.
        // Applying them here rather than per-handler is what makes the coverage
        // total: the gate's 403 below and the ~78 bare `writeHead` calls across
        // api/* all used to answer without them, because only the paths routed
        // through the shared helper (static, the login page, the login 401) ever
        // set them. `writeHead(status, headers)` merges over anything set here,
        // so a handler that spreads securityHeaders() itself is unaffected.
        for (const [name, value] of Object.entries(securityHeaders())) {
            res.setHeader(name, value);
        }

        // Plain-HTTP exposure. Runs BEFORE the request gate and the API chain
        // so a narrowed mode applies to every route uniformly, including
        // static assets.
        //
        // M4: the exposure modes govern the PLAIN-HTTP listener only -- this
        // whole block is gated on `!serverIsTls` and stays that way on
        // purpose. Applying 'httpsOnly' or 'redirect' to the HTTPS listener
        // itself would be meaningless (a TLS caller already has HTTPS; there
        // is nothing to redirect it to) or a lockout (421-ing the one
        // listener a client reached over the right protocol). Do not "fix"
        // this by widening the condition.
        //
        // Loopback is exempt in every mode; see decideHttpRequest. Without
        // that, a certificate that goes bad removes the only route to the
        // Settings page that could turn the mode back off.
        if (!serverIsTls) {
            // No secure server entry means no HTTPS listener exists at all --
            // 'refuse' would 421 the only listener that exists, and
            // 'redirect' would point at a certificate that isn't there.
            // Either locks the user out of the server that hosts the very
            // setting which caused it, so this is the same fail-open the
            // unrecognised-mode default already takes.
            const httpsPort = findHttpsPort();
            if (httpsPort !== undefined) {
                const mode = readHttpExposure();
                const decision = decideHttpRequest(mode, isLoopback(req.socket?.remoteAddress ?? ''));
                if (decision === 'refuse') {
                    // 421 Misdirected Request: the right name on the wrong listener.
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    // Belt-and-braces against a non-conforming intermediary
                    // holding this response past the user turning the
                    // setting back off (amendment D's cache concern, applied
                    // here too even though a 421 is not heuristically
                    // cacheable either).
                    res.setHeader('Cache-Control', 'no-store');
                    res.writeHead(421);
                    res.end(
                        'this server is configured for https only. open it over https, or browse from the machine itself.',
                    );
                    return;
                }
                if (decision === 'redirect') {
                    const target = buildRedirectTarget(req.headers.host, req.url, httpsPort);
                    if (target) {
                        // 302, not 301: a permanent redirect is cached by
                        // browsers indefinitely and would outlive the user
                        // turning this setting back off. Cache-Control:
                        // no-store closes the same gap against an
                        // intermediary that doesn't honour the status-code
                        // default (amendment D's stated concern).
                        res.setHeader('Location', target);
                        res.setHeader('Cache-Control', 'no-store');
                        res.writeHead(302);
                        res.end();
                        return;
                    }
                    // The Host header isn't one this app would ever agree to
                    // serve -- fall through and serve plain HTTP rather than
                    // emit a Location built from it (host-header injection /
                    // open redirect).
                }
            }
        }

        let pathname = '/';
        try {
            pathname = new URL(req.url || '/', 'http://localhost').pathname;
        } catch {
            pathname = '/';
        }
        // Defend the otherwise-unauthenticated API/WS surface: Origin + Host
        // allowlist (CSRF / DNS-rebinding) plus a per-instance token, with
        // the SPA's token cookie attached on document responses. See
        // requestGate for the composed policy.
        const decision = evaluateHttpRequest(
            req.method,
            pathname,
            req.headers.origin,
            req.headers.host,
            req.headers.cookie,
            // The BROWSER's scheme, not this socket's: behind the reverse proxy
            // we document, the app is plain http on loopback while the browser
            // is on https, and the cookie's attributes have to follow the
            // browser. See forwardedProto for the trust rule. (#641)
            isRequestSecure(serverIsTls, req.socket?.remoteAddress, req.headers['x-forwarded-proto']),
        );
        if (!decision.allowed) {
            res.writeHead(decision.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden', reason: decision.reason }));
            return;
        }
        if (decision.setCookie) {
            res.setHeader('Set-Cookie', decision.setCookie);
        }
        const tryHandlers = async () => {
            for (const handler of apiHandlers) {
                const handled = await handler.handle(req, res);
                if (handled) return;
            }
            if (fallback) fallback(req, res);
        };
        tryHandlers().catch(() => {
            // Last-resort guard for an unhandled rejection from a handler:
            // emit a generic 500 (no internal detail) and skip re-`writeHead`
            // if a handler already started streaming the response. (#74)
            sendInternalError(res);
        });
    };
}

/**
 * The persisted exposure mode. Defaults to 'open', so a fresh install and a
 * database that has never seen this key both behave exactly as today.
 */
function readHttpExposure(): HttpExposure {
    try {
        const v = Config.getInstance().db.appSettings.get(HTTP_EXPOSURE_KEY);
        return v === 'httpsOnly' || v === 'redirect' ? v : 'open';
    } catch {
        // A database that will not answer must not be able to refuse requests.
        return 'open';
    }
}

/**
 * Ports whose HTTPS listener was configured but failed to BIND (as opposed
 * to a later runtime error on an already-live listener -- see
 * attachListenErrorHandler's `!server.listening` guard) -- see also M3/M5
 * below. findHttpsPort() treats one of these exactly like "no secure entry
 * exists": a configured port that nothing is actually listening on is worse
 * than no port at all, because 'redirect' would send a caller at a dead end
 * and 'httpsOnly' would 421 the only listener still standing.
 *
 * No reset seam (M5, widened by N1: its sibling `boundSecurePorts` below has
 * the identical gap). Nothing removes a port from this Set, including a
 * later successful bind (there is none -- see attachListenErrorHandler) or
 * `HttpServer.release()`. Not a leak in production (the process exits and
 * restarts fresh rather than re-listening in place -- see
 * restartRequest.ts), but a test file that emits an 'error' on a shared
 * module instance and adds more cases afterward without its own
 * `vi.resetModules()` would see every subsequent case treated as
 * HTTPS-failed. `httpServerListenErrors.test.ts` resets per test for this
 * reason.
 */
const failedSecurePorts = new Set<number>();

/**
 * Plain-HTTP ports that were configured for this boot but failed to bind
 * (item 141). The exact mirror of `failedSecurePorts` above, and it exists
 * for the same reason: once an HTTP bind failure stops being fatal, "this
 * port is configured" and "this port is serving" are no longer the same
 * statement, and the difference has to be recorded somewhere.
 *
 * Read by `attachListenErrorHandler` itself to decide whether the
 * nothing-is-serving line is warranted. Same no-reset-seam caveat as its
 * twin -- there is no in-process re-listen, so an entry here is true for the
 * life of the process.
 */
const failedPlainPorts = new Set<number>();

/** The shape `getHttpsListenerStatus()` (below) answers with. */
export interface HttpsListenerStatus {
    /** True when an HTTPS listener is actually bound and serving right now. */
    listening: boolean;
    /** The actually-bound port -- present only when `listening` is true. */
    boundPort?: number;
    /**
     * True when `Config.servers` configured a secure entry for this boot but
     * it failed to bind. Distinct from "no secure entry configured at all"
     * (both leave `listening: false`) -- only this one means "was supposed to
     * work and didn't"; the other means there is nothing here a restart
     * (alone) would fix.
     */
    bindFailed: boolean;
    /**
     * Fingerprint of the leaf THIS listener was created with -- present only
     * when `listening` is true AND the cert content was parseable (NF-1).
     * `bound: true` does not by itself mean "serving the CURRENT
     * certificate"; compare this against `CertService.currentLeafFingerprint()`
     * to find out.
     */
    leafFingerprint?: string;
}

/**
 * Whether HTTPS is actually being served right now, and on what port --
 * reality, not configuration (C1, whole-branch review). `GET /api/tls/state`
 * reports only files on disk (`CertService.getState()`), so the panel could
 * claim "streaming already works" in at least four states where nothing was
 * bound to the port: right after `generate` (the listener set is built once
 * at boot, so a fresh certificate has no listener until a restart); an
 * advanced `server` array in `config.json` (the generated HTTPS entry is
 * never added, restart or not); `httpsPort === webPort` (the collision guard
 * in `Config.buildServers` skips the entry); and a bind failure recorded
 * here in `failedSecurePorts`. This is the export that lets a caller outside
 * this module tell those apart from "genuinely serving".
 *
 * Prefers the actually-BOUND port (`boundSecurePorts`, set from
 * `server.address()` once `.listen()` succeeds) over the configured one
 * (M7): with an ephemeral `port: 0` entry, the configured value is 0 and a
 * redirect built from it would be `https://host:0/`. Same precedence
 * `findHttpsPort()` below now delegates to this for -- one interpretation of
 * these two facts, not two that could drift apart.
 */
export function getHttpsListenerStatus(): HttpsListenerStatus {
    try {
        const entry = Config.getInstance().servers.find((s) => s.secure);
        if (!entry) return { listening: false, bindFailed: false };
        if (failedSecurePorts.has(entry.port)) return { listening: false, bindFailed: true };
        const boundPort = boundSecurePorts.get(entry.port) ?? entry.port;
        return boundLeafFingerprint === undefined
            ? { listening: true, boundPort, bindFailed: false }
            : { listening: true, boundPort, bindFailed: false, leafFingerprint: boundLeafFingerprint };
    } catch {
        return { listening: false, bindFailed: false };
    }
}

/**
 * The port the HTTPS listener runs on, or `undefined` when no secure server
 * entry exists (no certificate) OR the configured one failed to bind (see
 * failedSecurePorts) -- this reads runtime reality, not just configuration.
 * Deliberately does NOT fall back to a default port: the caller uses the
 * `undefined` case to skip 'refuse' and 'redirect' altogether, because a mode
 * that can only be undone through a listener that doesn't exist is a
 * lockout, not a feature.
 */
function findHttpsPort(): number | undefined {
    const status = getHttpsListenerStatus();
    return status.listening ? status.boundPort : undefined;
}

/**
 * Configured secure port -> the port actually bound (see the `.listen()`
 * callback in `start()`). Only ever differs from the configured port when
 * that port is `0` (ephemeral, OS-assigned) -- see M7 / findHttpsPort.
 *
 * No reset seam (N1): the identical gap `failedSecurePorts` documents above
 * -- nothing ever removes an entry, including `HttpServer.release()`. Same
 * "harmless in production, latent test trap" reasoning applies (no
 * in-process re-listen). A contrived edge exists only through a
 * user-authored `fileConfig.server` array: two secure entries sharing one
 * configured port would collide on this Map's key (last `.listen()`
 * callback wins) while `findHttpsPort()` reads the *first* secure entry --
 * not reachable from any in-tree config.
 */
const boundSecurePorts = new Map<number, number>();

/**
 * Fingerprint (SHA-256, `X509Certificate.fingerprint256`) of the leaf cert
 * content this listener was actually created with -- captured once the bind
 * succeeds, from the SAME PEM string passed to `https.createServer` (NF-1,
 * whole-branch re-review).
 *
 * WHY: the listener is created ONCE, at boot, from whatever `Config.servers`
 * held then. `generate()` later replaces the leaf FILE on disk, but this
 * listener keeps serving the OLD, in-memory material until a restart -- so
 * `bound: true` alone no longer means "serving the current certificate".
 * `getHttpsListenerStatus()` exposes this so a caller (TlsApi's
 * `buildHttpsListenerField`) can compare it against the CURRENT leaf's
 * fingerprint (`CertService.currentLeafFingerprint()`) and report
 * `restart-required` even while genuinely bound.
 *
 * `undefined` until a secure listener has bound at least once, or if the
 * cert content wasn't parseable (caught, never thrown -- a status/diagnostic
 * export must not be able to crash the caller). No reset seam, same as
 * `boundSecurePorts`/`failedSecurePorts` above -- no in-process re-listen.
 */
let boundLeafFingerprint: string | undefined;

/**
 * Attaches the 'error' listener a bind failure needs, before `.listen()` is
 * called. Node's http/https Server emits 'error' asynchronously when a port
 * can't be bound (EADDRINUSE, EACCES on ports < 1024, ...); an EventEmitter
 * with no 'error' listener re-throws that error as an uncaught exception,
 * which is how one busy port used to take the whole process down with it --
 * HTTPS and HTTP alike, even though HTTP may have bound fine.
 *
 * HTTPS is optional (see M4 above): a BIND failure degrades. Log the port
 * and cause, record it in failedSecurePorts so the exposure-mode logic above
 * stops treating it as live, and keep running on whatever else came up. The
 * `!server.listening` guard is load-bearing, not decoration: `'error'` on an
 * http/https Server fires for any runtime socket error, not only a failed
 * bind, and `server.listening` is only false before a successful bind (or
 * after `.close()`). Without the guard, a transient error on an
 * already-serving HTTPS listener (e.g. EMFILE under load) would mark the
 * port "failed to bind" -- a false log line -- and silently disable both
 * narrowed exposure modes for the rest of the process's life on a listener
 * that is still up.
 *
 * Plain HTTP degrades too, as of item 141 (user ruling, 2026-09-22). It used
 * to re-throw -- which meant a busy port 80, or `EACCES` on a sub-1024 port
 * the port model explicitly invites the user to pick, destroyed a perfectly
 * healthy HTTPS listener along with it. That is precisely the outcome this
 * handler was created to prevent, one protocol over: the spec guaranteed
 * that HTTP survives an HTTPS failure and simply never said the reverse, so
 * the old behaviour was defensible rather than wrong. Both directions now
 * follow the same degrade-never-exit principle as the rest of the feature.
 *
 * The HTTP branch therefore needs the SAME `!server.listening` guard the
 * secure branch has, and for the same reason -- now that a runtime error is
 * no longer fatal, an EMFILE on an already-serving HTTP listener would
 * otherwise be logged as "failed to bind", a false statement about a
 * listener that is still up.
 *
 * The one thing degrading costs: a boot where BOTH listeners fail to bind no
 * longer exits, so the process would sit serving nothing while looking
 * healthy -- worse than crashing, because a crash is legible. So that exact
 * condition gets its own log line, stated once, rather than left to be
 * inferred from two unrelated bind-failure lines.
 */
function attachListenErrorHandler(server: http.Server | https.Server, port: number, secure: boolean): void {
    server.on('error', (err: NodeJS.ErrnoException) => {
        const cause = err.code ?? err.message;
        if (secure) {
            if (!server.listening) {
                failedSecurePorts.add(port);
                Logger.for('HttpServer').error(
                    `HTTPS listener on port ${port} failed to bind (${cause}); continuing without HTTPS.`,
                );
            } else {
                Logger.for('HttpServer').error(
                    `HTTPS listener on port ${port} reported a runtime error (${cause}); it may be degraded.`,
                );
            }
            return;
        }
        if (!server.listening) {
            failedPlainPorts.add(port);
            Logger.for('HttpServer').error(
                `HTTP listener on port ${port} failed to bind (${cause}); continuing without plain HTTP.`,
            );
            // Gated, not unconditional: an HTTP failure while HTTPS is live
            // is a degraded app, not an unreachable one, and saying otherwise
            // would be the same kind of false claim NF-1 was about.
            if (!getHttpsListenerStatus().listening) {
                Logger.for('HttpServer').error(
                    `no listener is serving: plain HTTP on port ${port} failed to bind and no HTTPS listener is ` +
                        'live. the app is running but unreachable -- free the port (or change it in config.json) ' +
                        'and restart.',
                );
            }
            return;
        }
        Logger.for('HttpServer').error(
            `HTTP listener on port ${port} reported a runtime error (${cause}); it may be degraded.`,
        );
    });
}

/**
 * The hostname to redirect to, or `undefined` when the Host header isn't one
 * this app would ever agree to serve. Reuses `isHostAllowed` -- the app's
 * OWN Host allowlist (`localhost` / IP literals / operator `allowedHosts`),
 * consulted three statements later in this same handler for the request
 * gate -- rather than a second, independent notion of "looks like a
 * hostname". A plain DNS name like `evil.com` matches a charset check but
 * fails `isHostAllowed`, so it can't reach here: redirecting toward a host
 * this app refuses to serve is exactly the open redirect a caller-controlled
 * `Location` header would otherwise be. One allowlist, so the two can never
 * drift apart.
 *
 * `hostnameOf` is the same WHATWG-URL parse `isHostAllowed` uses internally,
 * imported rather than reimplemented so a `user:pass@host` userinfo prefix or
 * a bracketed IPv6 literal parses identically in both places. It strips
 * IPv6 brackets for `isIP()`'s sake; they're re-added here when composing a
 * URL authority.
 */
function redirectHostname(hostHeader: string | undefined): string | undefined {
    if (!isHostAllowed(hostHeader)) return undefined;
    const hostname = hostnameOf(hostHeader ?? '');
    if (!hostname) return undefined;
    return hostname.includes(':') ? `[${hostname}]` : hostname;
}

/**
 * The request path to redirect to. Only an origin-form request-target
 * (starting with `/`, the normal case for a browser navigation) is safe to
 * carry into a `Location` header verbatim -- an absolute-form target (what a
 * proxy sends, e.g. `GET http://evil.com/x HTTP/1.1` -> `req.url ===
 * 'http://evil.com/x'`) or asterisk-form (`OPTIONS *` -> `req.url === '*'`)
 * would otherwise land as-is, producing a malformed authority
 * (`https://host:port*` or a scheme-doubled URL). Falls back to `/` rather
 * than reject the whole redirect over an edge-case request line.
 */
function safeRedirectPath(url: string | undefined): string {
    return url?.startsWith('/') ? url : '/';
}

/**
 * The redirect target for the 'redirect' exposure mode, or `undefined` when
 * the Host header can't be trusted enough to build one from. Never falls
 * back to emitting a Location built from unvalidated input.
 *
 * Exported (like createHttpRequestHandler above) so the open-redirect defense
 * can be pinned directly: driven only through the full request handler, a
 * disallowed Host is independently rejected by the downstream request gate
 * (same `isHostAllowed` policy, by design -- that's the whole point of C1),
 * so a test asserting the FINAL response status there cannot tell "the
 * redirect branch correctly refused to build a Location" apart from "the
 * whole exposure block was deleted and the request gate caught it anyway".
 * Testing this function directly closes that gap.
 */
export function buildRedirectTarget(
    hostHeader: string | undefined,
    url: string | undefined,
    securePort: number,
): string | undefined {
    const hostname = redirectHostname(hostHeader);
    if (!hostname) return undefined;
    return `https://${hostname}:${securePort}${safeRedirectPath(url)}`;
}

const DEFAULT_STATIC_DIR = path.join(__dirname, './public');

const PATHNAME = process.env[EnvName.WS_SCRCPY_PATHNAME] || __PATHNAME__;

export type ServerAndPort = {
    server: https.Server | http.Server;
    port: number;
};

interface HttpServerEvents {
    started: boolean;
}

export class HttpServer extends TypedEmitter<HttpServerEvents> implements Service {
    private static instance: HttpServer;
    private static PUBLIC_DIR = DEFAULT_STATIC_DIR;
    private static SERVE_STATIC = true;
    private static apiHandlers: ApiHandler[] = [];
    private servers: ServerAndPort[] = [];
    private mainHandler?: (req: IncomingMessage, res: ServerResponse) => void;
    private started = false;

    protected constructor() {
        super();
    }

    public static getInstance(): HttpServer {
        if (!this.instance) {
            this.instance = new HttpServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public static setPublicDir(dir: string): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.PUBLIC_DIR = dir;
    }

    public static setServeStatic(enabled: boolean): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.SERVE_STATIC = enabled;
    }

    public static addApiHandler(handler: ApiHandler): void {
        HttpServer.apiHandlers.push(handler);
    }

    public static addFirstApiHandler(handler: ApiHandler): void {
        HttpServer.apiHandlers.unshift(handler);
    }

    public async getServers(): Promise<ServerAndPort[]> {
        if (this.started) {
            return [...this.servers];
        }
        return new Promise<ServerAndPort[]>((resolve) => {
            this.once('started', () => {
                resolve([...this.servers]);
            });
        });
    }

    public getName(): string {
        return 'HTTP(s) Server Service';
    }

    public async start(): Promise<void> {
        if (HttpServer.SERVE_STATIC && HttpServer.PUBLIC_DIR) {
            this.mainHandler = createStaticHandler(HttpServer.PUBLIC_DIR);
        }
        const config = Config.getInstance();
        config.servers.forEach((serverItem) => {
            const { secure, port, redirectToSecure } = serverItem;
            let proto: string;
            let server: http.Server | https.Server;
            if (secure) {
                if (!serverItem.options) {
                    throw Error('Must provide option for secure server configuration');
                }
                const requestHandler = this.createRequestHandler(this.mainHandler, true);
                server = https.createServer(serverItem.options, requestHandler);
                proto = 'https';
            } else {
                const options = serverItem.options ? { ...serverItem.options } : {};
                proto = 'http';
                let redirectHost = '';
                let redirectPort = 443;
                let doRedirect = false;
                if (redirectToSecure === true) {
                    doRedirect = true;
                } else if (typeof redirectToSecure === 'object') {
                    doRedirect = true;
                    if (typeof redirectToSecure.port === 'number') {
                        redirectPort = redirectToSecure.port;
                    }
                    if (typeof redirectToSecure.host === 'string') {
                        redirectHost = redirectToSecure.host;
                    }
                }
                let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
                if (doRedirect) {
                    // Redirect handler is passed through as-is — no API interception
                    handler = (req: IncomingMessage, res: ServerResponse) => {
                        const url = new URL(`https://${redirectHost ? redirectHost : req.headers.host}${req.url}`);
                        if (redirectPort && redirectPort !== 443) {
                            url.port = redirectPort.toString();
                        }
                        res.writeHead(301, { Location: url.toString() });
                        res.end();
                    };
                } else {
                    handler = this.createRequestHandler(this.mainHandler, false);
                }
                server = http.createServer(options, handler);
            }
            // M3: pushed unconditionally, before the bind is even attempted --
            // an entry whose HTTPS bind later fails (see
            // attachListenErrorHandler) is NOT removed from `this.servers`,
            // so `getServers()` can report a secure entry that isn't
            // actually listening. Harmless today (the only consumer,
            // WebSocketServer.start(), attaches to a socket that will never
            // accept); a future status/capabilities endpoint reading this to
            // answer "is HTTPS up" would need `failedSecurePorts` too.
            this.servers.push({ server, port });
            // Attached before `.listen()`, on EVERY server (not only the
            // secure one) -- see attachListenErrorHandler for why a bind
            // failure on one listener must not be able to take the other
            // down with it.
            attachListenErrorHandler(server, port, secure);
            server.listen(port, () => {
                Utils.printListeningMsg(proto, port, PATHNAME);
                if (secure) {
                    // Record the port actually bound, not just the
                    // configured one (M7): with an ephemeral `port: 0` entry
                    // they differ, and findHttpsPort() needs the real one to
                    // build a working redirect target.
                    const address = server.address();
                    if (address && typeof address === 'object') {
                        boundSecurePorts.set(port, address.port);
                    }
                    // NF-1: record the fingerprint of the leaf THIS listener
                    // was just created with -- `serverItem.options.cert` is
                    // the exact PEM handed to `https.createServer` above. A
                    // later generate() replaces the file on disk, but this
                    // in-memory material (and its fingerprint) is what keeps
                    // getting served until a restart. Caught, never thrown:
                    // this is diagnostic bookkeeping, not allowed to affect
                    // whether the listener itself came up.
                    try {
                        const cert = serverItem.options?.cert;
                        if (typeof cert === 'string') {
                            boundLeafFingerprint = new X509Certificate(cert).fingerprint256;
                        }
                    } catch {
                        boundLeafFingerprint = undefined;
                    }
                }
            });
        });
        this.started = true;
        this.emit('started', true);
    }

    private createRequestHandler(
        fallback?: (req: IncomingMessage, res: ServerResponse) => void,
        serverIsTls = false,
    ): (req: IncomingMessage, res: ServerResponse) => void {
        return createHttpRequestHandler(HttpServer.apiHandlers, fallback, serverIsTls);
    }

    public release(): void {
        this.servers.forEach((item) => {
            // Initiate graceful close — stops accepting new connections; the
            // 'close' event fires when existing sockets finish. Without the
            // forceful call below, HTTP keepalive sockets held by browser
            // tabs prolong the close indefinitely the same way WS does.
            item.server.close();
            // Force-close every idle and active connection. closeAllConnections
            // is Node 18.2+; the supervisor + fetch-node.mjs pin Node v24.15.0
            // so this is always available in our runtime.
            if (typeof item.server.closeAllConnections === 'function') {
                item.server.closeAllConnections();
            }
        });
    }
}
