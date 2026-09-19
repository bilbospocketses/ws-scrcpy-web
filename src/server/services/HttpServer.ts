import type { IncomingMessage, ServerResponse } from 'http';
import * as http from 'http';
import * as https from 'https';
import path from 'path';
import * as process from 'process';
import { TypedEmitter } from '../../common/TypedEmitter';
import { sendInternalError } from '../api/utils';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { createStaticHandler } from '../StaticFileServer';
import { isRequestSecure } from '../security/forwardedProto';
import { securityHeaders } from '../security/frameGuard';
import { isLoopback } from '../security/loopback';
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
                        // turning this setting back off.
                        res.setHeader('Location', target);
                        res.writeHead(302);
                        res.end();
                        return;
                    }
                    // The Host header didn't survive the hostname check --
                    // fall through and serve rather than emit a Location we
                    // did not construct ourselves (host-header injection).
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
 * The port the HTTPS listener runs on, or `undefined` when no secure server
 * entry exists (no certificate). Deliberately does NOT fall back to a
 * default port: the caller uses the `undefined` case to skip 'refuse' and
 * 'redirect' altogether, because a mode that can only be undone through a
 * listener that doesn't exist is a lockout, not a feature.
 */
function findHttpsPort(): number | undefined {
    try {
        return Config.getInstance().servers.find((s) => s.secure)?.port;
    } catch {
        return undefined;
    }
}

/**
 * The hostname portion of a Host header, with any `:port` stripped, or
 * `undefined` if what's left isn't a plain host token. Host is
 * caller-controlled, so this is deliberately conservative: letters, digits,
 * dots and hyphens only. Anything else (control characters, slashes, stray
 * colons from a malformed header) is rejected rather than guessed at, since
 * the caller uses the result to build a redirect Location header and a
 * poisoned one is a cache-able open redirect / header injection.
 */
function extractHostname(hostHeader: string | undefined): string | undefined {
    const hostname = (hostHeader ?? '').split(':')[0] ?? '';
    return /^[a-zA-Z0-9.-]+$/.test(hostname) ? hostname : undefined;
}

/**
 * The redirect target for the 'redirect' exposure mode, or `undefined` when
 * the Host header can't be trusted enough to build one from. Never falls
 * back to emitting a Location built from unvalidated input.
 */
function buildRedirectTarget(
    hostHeader: string | undefined,
    url: string | undefined,
    securePort: number,
): string | undefined {
    const hostname = extractHostname(hostHeader);
    if (!hostname) return undefined;
    return `https://${hostname}:${securePort}${url ?? '/'}`;
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
            this.servers.push({ server, port });
            server.listen(port, () => {
                Utils.printListeningMsg(proto, port, PATHNAME);
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
