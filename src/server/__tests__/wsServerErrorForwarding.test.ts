import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from '../services/WebSocketServer';

/**
 * `ws`'s WebSocketServer, given an existing `server`, forwards that server's
 * 'error' event to ITSELF (`error: this.emit.bind(this, 'error')` in
 * ws/lib/websocket-server.js). An EventEmitter with no 'error' listener throws
 * what it is given, so every listen failure HttpServer had already handled
 * (logged, recorded, degraded) was re-thrown here as an uncaught exception, and
 * the process died.
 *
 * Found by the row 12.6 e2e spec, 2026-09-25: with two listeners configured,
 * the first bind failure is not fatal to `exitIfNothingCanServe()`, so ws's
 * forwarder ran next and killed the app before the second listener had its
 * turn. The same path kills a Local HTTPS install whose HTTPS port is busy,
 * which is the case "HTTP survives an HTTPS failure" (M4) exists for.
 * httpServerListenErrors.test.ts could not see it: it never attaches ws.
 */
describe('WebSocketServer.attachToServer', () => {
    const opened: http.Server[] = [];
    afterEach(() => {
        for (const wss of WebSocketServer.getInstance().getServers()) wss.close();
        WebSocketServer.getInstance().getServers().length = 0;
        while (opened.length) opened.pop()!.close();
    });

    it('does not re-throw an error the http server emits (a failed bind is HttpServer’s to handle)', () => {
        const server = http.createServer();
        opened.push(server);
        WebSocketServer.getInstance().attachToServer({ server, port: 0 });
        const bindFailure = Object.assign(new Error('listen EADDRINUSE: address already in use :::8134'), {
            code: 'EADDRINUSE',
        });
        expect(() => server.emit('error', bindFailure)).not.toThrow();
    });
});
