import type WS from 'ws';
import { WebSocketServer as WSServer } from 'ws';
import { Config } from '../Config';
import { isAuthEnabled, parseCookie, SESSION_COOKIE } from '../auth/authState';
import { SessionStore } from '../auth/session';
import type { Db } from '../db/Db';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import { Logger } from '../Logger';
import type { MwFactory } from '../mw/Mw';
import { evaluateWsConnection } from '../security/requestGate';
import { HttpServer, type ServerAndPort } from './HttpServer';
import type { Service } from './Service';

/**
 * The acting user's id for a WS connection: the implicit admin in open mode, the
 * session user when locked, or `undefined` when locked and the cookie is missing/invalid
 * (→ the caller closes the socket). Exported for unit testing without a live socket.
 */
export function wsSessionUserId(db: Db, cookieHeader: string | undefined): number | undefined {
    if (!isAuthEnabled(db)) return IMPLICIT_ADMIN_ID;
    const token = parseCookie(cookieHeader)[SESSION_COOKIE];
    const s = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
    if (!s) return undefined;
    const user = db.users.getById(s.userId);
    // Fail CLOSED: an orphan (deleted) or disabled user must not get a live socket.
    if (!user || user.disabled) return undefined;
    return user.id;
}

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
        const wss = new WSServer({
            server,
            // Origin/Host allowlist at the handshake — a WebSocket is not subject
            // to the same-origin policy and sends no CORS preflight, so without
            // this a malicious page could open a control channel to the device.
            // Origin/Host allowlist + per-instance token at the handshake. A
            // WebSocket is exempt from the same-origin policy and sends no CORS
            // preflight, so without this a malicious page could open a control
            // channel to the device. Every legitimate client is the browser,
            // which carries the SameSite token cookie; a non-browser caller does
            // not. (A server restart mints a new token, so an already-open page
            // must reload to reconnect — expected for a per-instance secret.)
            verifyClient: (info, cb) => {
                const decision = evaluateWsConnection(info.origin, info.req.headers.host, info.req.headers.cookie);
                if (!decision.allowed) {
                    log.info(
                        `rejected WS connection (origin="${info.origin ?? ''}" host="${
                            info.req.headers.host ?? ''
                        }"): ${decision.reason}`,
                    );
                    cb(false, 403, 'Forbidden');
                    return;
                }
                cb(true);
            },
        });
        wss.on('connection', async (ws: WS, request) => {
            if (!request.url) {
                ws.close(4001, `[${TAG}] Invalid url`);
                return;
            }
            const url = new URL(request.url, 'https://example.org/');

            const userId = wsSessionUserId(Config.getInstance().db, request.headers.cookie);
            if (userId === undefined) {
                ws.close(4401, 'unauthorized');
                return;
            }

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
            // Initiate graceful close — stops accepting new connections and
            // sends close frames to existing clients. Without the terminate
            // loop below, this awaits client acknowledgement of the close
            // handshake forever; a browser tab still open pins the server
            // alive indefinitely (no built-in timeout in the `ws` library).
            server.close();
            // Force-terminate every open client. Triggers the per-client
            // 'close' event (code 1006, abnormal closure), which cascades
            // into RemoteShell's `term.kill()` and ScrcpyConnection's
            // `serverProcess.kill()` so their spawned children get cleaned
            // up too. Without terminate, the 4-minute hang observed in dev
            // (Ctrl+C → "Stopping..." → wait for browser to disconnect)
            // becomes the steady-state behavior whenever a client is open.
            for (const client of server.clients) {
                try {
                    client.terminate();
                } catch {
                    // best-effort — client may already be in a closing state
                }
            }
        });
    }
}
