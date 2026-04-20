import type WS from 'ws';
import { WebSocketServer as WSServer } from 'ws';
import { Logger } from '../Logger';
import type { MwFactory } from '../mw/Mw';
import { HttpServer, type ServerAndPort } from './HttpServer';
import type { Service } from './Service';

export class WebSocketServer implements Service {
    private static instance?: WebSocketServer;
    private servers: WSServer[] = [];
    private mwFactories: Set<MwFactory> = new Set();
    private pathHandlers: Map<string, (ws: WS) => void> = new Map();

    protected constructor() {
        // nothing here
    }

    public static getInstance(): WebSocketServer {
        if (!this.instance) {
            this.instance = new WebSocketServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public registerMw(mwFactory: MwFactory): void {
        this.mwFactories.add(mwFactory);
    }

    public registerPathHandler(path: string, handler: (ws: WS) => void): void {
        this.pathHandlers.set(path, handler);
    }

    public attachToServer(item: ServerAndPort): WSServer {
        const { server, port } = item;
        const TAG = `WebSocket Server {tcp:${port}}`;
        const log = Logger.for(TAG);
        const wss = new WSServer({ server });
        wss.on('connection', async (ws: WS, request) => {
            if (!request.url) {
                ws.close(4001, `[${TAG}] Invalid url`);
                return;
            }
            const url = new URL(request.url, 'https://example.org/');

            // Path-based handlers take priority over action-based MW dispatch.
            const pathHandler = this.pathHandlers.get(url.pathname);
            if (pathHandler) {
                pathHandler(ws);
                return;
            }

            const action = url.searchParams.get('action') || '';
            let processed = false;
            for (const mwFactory of this.mwFactories.values()) {
                const service = mwFactory.processRequest(ws, { action, request, url });
                if (service) {
                    processed = true;
                }
            }
            if (!processed) {
                ws.close(4002, `[${TAG}] Unsupported request`);
            }
            return;
        });
        wss.on('close', () => {
            log.info('stopped');
        });
        this.servers.push(wss);
        return wss;
    }

    public getServers(): WSServer[] {
        return this.servers;
    }

    public getName(): string {
        return 'WebSocket Server Service';
    }

    public async start(): Promise<void> {
        const service = HttpServer.getInstance();
        const servers = await service.getServers();
        servers.forEach((item) => {
            this.attachToServer(item);
        });
    }

    public release(): void {
        this.servers.forEach((server) => {
            server.close();
        });
    }
}
