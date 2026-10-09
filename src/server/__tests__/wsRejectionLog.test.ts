import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WS from 'ws';
import { RejectionLogLimiter } from '../security/rejectionLogLimiter';
import { WebSocketServer, wsRejectionLog, wsRejectionLogLine } from '../services/WebSocketServer';

/**
 * Item 174 (2026-10-08): after a local-mode update, the first launch's tab
 * still holds the previous process's instance token, and its device list
 * retries the websocket every 2 s. Each refusal was logged, ~25 lines a minute
 * for as long as the tab stayed open.
 */

const TOKEN = 'missing or invalid token';
const line = (now: number, limiter: RejectionLogLimiter, remote = '127.0.0.1', reason = TOKEN) =>
    wsRejectionLogLine('http://localhost:8000', 'localhost:8000', remote, reason, now, limiter);

describe('RejectionLogLimiter', () => {
    it('logs the first, counts the repeats inside the window, then logs again with the count', () => {
        const l = new RejectionLogLimiter(60_000);
        expect(l.note('a', 0)).toBe(0);
        for (let t = 2_000; t < 60_000; t += 2_000) expect(l.note('a', t)).toBeNull();
        // 29 repeats at 2 s intervals were left out; the next one after the window says so.
        expect(l.note('a', 60_000)).toBe(29);
        expect(l.note('a', 62_000)).toBeNull();
    });

    it('a key that went quiet for a whole window starts over, with nothing to report', () => {
        const l = new RejectionLogLimiter(60_000);
        expect(l.note('a', 0)).toBe(0);
        expect(l.note('a', 500_000)).toBe(0);
    });

    it('keeps each key apart', () => {
        const l = new RejectionLogLimiter(60_000);
        expect(l.note('a', 0)).toBe(0);
        expect(l.note('b', 1)).toBe(0);
        expect(l.note('a', 2)).toBeNull();
        expect(l.note('b', 3)).toBeNull();
    });

    it('stays bounded under a flood of distinct keys', () => {
        const l = new RejectionLogLimiter(60_000, 8);
        for (let i = 0; i < 100; i++) l.note(`k${i}`, i);
        expect(l.size).toBeLessThanOrEqual(8);
        // The newest key is the one kept, so it is still a repeat.
        expect(l.note('k99', 100)).toBeNull();
    });
});

describe('wsRejectionLogLine', () => {
    it('keeps the old text up to the reason, and appends the remote address', () => {
        const l = new RejectionLogLimiter();
        expect(line(0, l)).toBe(
            `rejected WS connection (origin="http://localhost:8000" host="localhost:8000"): ${TOKEN} [from 127.0.0.1]`,
        );
    });

    it('a stale tab retrying every 2 s for a minute logs two lines, not thirty', () => {
        const l = new RejectionLogLimiter(60_000);
        const logged: string[] = [];
        for (let t = 0; t <= 60_000; t += 2_000) {
            const out = line(t, l);
            if (out !== null) logged.push(out);
        }
        expect(logged).toHaveLength(2);
        expect(logged[1]).toBe(
            `rejected WS connection (origin="http://localhost:8000" host="localhost:8000"): ${TOKEN} [from 127.0.0.1; 29 more like it in the last 60s not logged]`,
        );
    });

    it('a different address, or a different reason, is its own line', () => {
        const l = new RejectionLogLimiter();
        expect(line(0, l)).not.toBeNull();
        expect(line(1, l, '192.168.1.20')).not.toBeNull();
        expect(line(2, l, '127.0.0.1', 'cross-origin request rejected')).not.toBeNull();
        expect(line(3, l)).toBeNull();
    });

    it('names an unknown remote address rather than dropping the line', () => {
        const l = new RejectionLogLimiter();
        expect(wsRejectionLogLine(undefined, undefined, undefined, TOKEN, 0, l)).toBe(
            `rejected WS connection (origin="" host=""): ${TOKEN} [from unknown]`,
        );
    });
});

describe('the WebSocket server logs refusals through wsRejectionLogLine (M8)', () => {
    const opened: http.Server[] = [];
    afterEach(() => {
        vi.restoreAllMocks();
        for (const wss of WebSocketServer.getInstance().getServers()) wss.close();
        WebSocketServer.getInstance().getServers().length = 0;
        while (opened.length) opened.pop()!.close();
    });

    it('a refused handshake is answered 403 and noted in the shared limiter, keyed by the peer address and reason', async () => {
        const server = http.createServer();
        opened.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const { port } = server.address() as AddressInfo;
        WebSocketServer.getInstance().attachToServer({ server, port });
        const note = vi.spyOn(wsRejectionLog, 'note');

        const status = await new Promise<number>((resolve, reject) => {
            const ws = new WS(`ws://127.0.0.1:${port}/?action=multiplex`, { headers: { Origin: 'http://evil.test' } });
            ws.on('unexpected-response', (_req, res) => {
                resolve(res.statusCode ?? 0);
                ws.terminate();
            });
            ws.on('open', () => reject(new Error('the handshake must be refused')));
            ws.on('error', () => undefined);
        });

        expect(status).toBe(403);
        expect(note).toHaveBeenCalledTimes(1);
        const [key] = note.mock.calls[0]!;
        const [remote, reason] = key.split('\u0000');
        expect(remote).toMatch(/127\.0\.0\.1$/);
        expect(reason).toBe('cross-origin request rejected');
    });
});
