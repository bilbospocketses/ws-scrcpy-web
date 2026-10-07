import type WS from 'ws';
import { WebSocketServer as WSServer } from 'ws';
import { isAuthEnabled, parseCookie, SESSION_COOKIE } from '../auth/authState';
import { SessionStore } from '../auth/session';
import { SocketRegistry } from '../auth/socketRegistry';
import { Config } from '../Config';
import { IMPLICIT_ADMIN_ID } from '../db/constants';
import type { Db } from '../db/Db';
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
/**
 * Live sockets, keyed by the session that authorised them. Module-level rather
 * than an instance field: the auth API revokes through it without needing a
 * handle on the server singleton, and there is exactly one WS surface.
 */
export const liveSockets = new SocketRegistry();

/**
 * Who a WS handshake acts as, and which session (if any) the socket belongs to.
 *
 * `token` is the session the socket is registered under in `liveSockets`, so it
 * decides what a logout closes. It is set ONLY in locked mode, for the valid
 * session that authorised the handshake. In open mode there is no login for a
 * logout to end, so the socket carries no token even when the browser still
 * holds a valid session cookie from before login was turned off (finding 18.23:
 * the handshake used to register under the cookie's token whatever the mode,
 * and that browser's open-mode sockets were closed 4401 by its logout).
 *
 * The rule is applied here, at registration, rather than in the logout handler:
 * a socket's standing is fixed by the mode it was opened in. A check at close
 * time would read the mode at LOGOUT, so a socket opened in open mode would
 * still be closed if login had been turned back on in between, which is the
 * case socketRegistry.ts says never happens.
 */
export function wsSession(db: Db, cookieHeader: string | undefined): { userId: number; token?: string } | undefined {
    if (!isAuthEnabled(db)) return { userId: IMPLICIT_ADMIN_ID };
    const token = parseCookie(cookieHeader)[SESSION_COOKIE];
    const s = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
    if (!token || !s) return undefined;
    const user = db.users.getById(s.userId);
    // Fail CLOSED: an orphan (deleted) or disabled user must not get a live socket.
    if (!user || user.disabled) return undefined;
    return { userId: user.id, token };
}

export function wsSessionUserId(db: Db, cookieHeader: string | undefined): number | undefined {
    return wsSession(db, cookieHeader)?.userId;
}

export class WebSocketServer implements Service {
    private static instance?: WebSocketServer;
    private servers: WSServer[] = [];
    private mwFactories: Set<MwFactory> = new Set();
    private pathHandlers: Map<string, (ws: WS, userId: number) => void> = new Map();

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

    public registerPathHandler(path: string, handler: (ws: WS, userId: number) => void): void {
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

            const session = wsSession(Config.getInstance().db, request.headers.cookie);
            if (session === undefined) {
                ws.close(4401, 'unauthorized');
                return;
            }
            const { userId } = session;

            // Track the socket against the session that authorised it, so ending
            // that session ends the socket too. Refusing the next handshake was
            // never enough on its own: a stream opened while the session was
            // valid outlived the logout that ended it (finding 18.14). In open
            // mode `session.token` is absent, so no logout closes it (18.23).
            liveSockets.add(ws, userId, session.token);
            ws.on('close', () => liveSockets.remove(ws));

            // Path-based handlers take priority over action-based MW dispatch.
            const pathHandler = this.pathHandlers.get(url.pathname);
            if (pathHandler) {
                pathHandler(ws, userId);
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
        // Load-bearing, not tidiness. Given an existing `server`, ws forwards that
        // server's 'error' event to this WebSocketServer, and an EventEmitter with
        // no 'error' listener THROWS what it is given. So a listen failure that
        // HttpServer's attachListenErrorHandler had already handled (logged,
        // recorded, and either degraded or exited on) came back here as an
        // uncaught exception and killed the process. That broke degrade-never-exit
        // for every two-listener setup: a busy HTTPS port on a Local HTTPS install
        // took HTTP down with it (row 12.6, found 2026-09-25). Nothing to log:
        // HttpServer has already said everything about this error.
        wss.on('error', () => {});
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
            // Force-terminate every open client. Without it, the 4-minute
            // hang observed in dev (Ctrl+C → "Stopping..." → wait for browser
            // to disconnect) becomes the steady-state behavior whenever a
            // client is open.
            //
            // Stream sessions are NOT ended here. By the time this runs, the
            // shutdown has already closed each one with 1001 and released it
            // (liveStreams.closeAllForShutdown, before `adb kill-server`), and
            // has stopped new ones from starting; a stream socket still
            // CLOSING is just cut short. What terminate still ends is every
            // other socket: its 'close' (code 1006) releases that socket's
            // Mw, which is how RemoteShell's `term.kill()` runs.
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
