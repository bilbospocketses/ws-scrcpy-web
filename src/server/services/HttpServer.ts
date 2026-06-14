import type { IncomingMessage, ServerResponse } from 'http';
import * as http from 'http';
import * as https from 'https';
import path from 'path';
import * as process from 'process';
import { TypedEmitter } from '../../common/TypedEmitter';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { isRequestAllowed, requiresOriginCheck } from '../security/originGuard';
import { createStaticHandler } from '../StaticFileServer';
import { Utils } from '../Utils';
import type { Service } from './Service';

interface ApiHandler {
    handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
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
                const requestHandler = this.createRequestHandler(this.mainHandler);
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
                    handler = this.createRequestHandler(this.mainHandler);
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
    ): (req: IncomingMessage, res: ServerResponse) => void {
        return (req, res) => {
            // Origin/Host allowlist — defend the otherwise-unauthenticated API
            // surface against cross-site (CSRF) and DNS-rebinding attacks. Only
            // the sensitive surface (the API + state-changing methods) is gated;
            // static asset GETs pass through so the page can still bootstrap.
            let pathname = '/';
            try {
                pathname = new URL(req.url || '/', 'http://localhost').pathname;
            } catch {
                pathname = '/';
            }
            if (requiresOriginCheck(req.method, pathname)) {
                const verdict = isRequestAllowed(req.headers.origin, req.headers.host);
                if (!verdict.allowed) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'forbidden', reason: verdict.reason }));
                    return;
                }
            }
            const tryHandlers = async () => {
                for (const handler of HttpServer.apiHandlers) {
                    const handled = await handler.handle(req, res);
                    if (handled) return;
                }
                if (fallback) fallback(req, res);
            };
            tryHandlers().catch((err) => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            });
        };
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
