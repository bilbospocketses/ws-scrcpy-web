import type { IncomingMessage, ServerResponse } from 'http';
import * as http from 'http';
import * as https from 'https';
import path from 'path';
import * as process from 'process';
import { TypedEmitter } from '../../common/TypedEmitter';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { createStaticHandler } from '../StaticFileServer';
import { Utils } from '../Utils';
import type { DependencyApi } from '../api/DependencyApi';
import type { Service } from './Service';

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
    private static apiHandler: DependencyApi | null = null;
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

    public static setApiHandler(handler: DependencyApi): void {
        HttpServer.apiHandler = handler;
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
            if (HttpServer.apiHandler) {
                HttpServer.apiHandler
                    .handle(req, res)
                    .then((handled) => {
                        if (!handled && fallback) {
                            fallback(req, res);
                        }
                    })
                    .catch((err) => {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: err.message }));
                    });
            } else if (fallback) {
                fallback(req, res);
            }
        };
    }

    public release(): void {
        this.servers.forEach((item) => {
            item.server.close();
        });
    }
}
