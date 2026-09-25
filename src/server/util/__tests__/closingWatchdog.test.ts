import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WS, { WebSocketServer } from 'ws';
import { watchForStuckClosing } from '../closingWatchdog';

// Item 151. A stream session is released only when its websocket emits 'close',
// and `ws` has a CLOSING path with no bound: a peer that half-closes TCP (FIN)
// without a close frame, while our send buffer cannot drain, leaves the socket
// CLOSING until TCP itself gives up. qa-harness saw a closed viewer hold the
// device for ~4 minutes. The watchdog terminates a socket that has left OPEN and
// not reached CLOSED within a grace period, which is what makes 'close' fire.

type FakeSocket = { readyState: number; bufferedAmount: number; terminate: ReturnType<typeof vi.fn> };
const OPEN = WS.OPEN;
const CLOSING = WS.CLOSING;
const CLOSED = WS.CLOSED;

function fakeSocket(): FakeSocket {
    return { readyState: OPEN, bufferedAmount: 0, terminate: vi.fn() };
}

describe('watchForStuckClosing (fake timers)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('leaves an OPEN socket alone indefinitely', () => {
        const ws = fakeSocket();
        const onStuck = vi.fn();
        const stop = watchForStuckClosing(ws as unknown as WS, { graceMs: 5000, pollMs: 1000, onStuck });
        vi.advanceTimersByTime(60_000);
        expect(ws.terminate).not.toHaveBeenCalled();
        expect(onStuck).not.toHaveBeenCalled();
        stop();
    });

    it('does not interfere with a close that completes inside the grace period', () => {
        const ws = fakeSocket();
        const onStuck = vi.fn();
        const stop = watchForStuckClosing(ws as unknown as WS, { graceMs: 5000, pollMs: 1000, onStuck });
        ws.readyState = CLOSING;
        vi.advanceTimersByTime(2000);
        ws.readyState = CLOSED;
        vi.advanceTimersByTime(60_000);
        expect(ws.terminate).not.toHaveBeenCalled();
        expect(onStuck).not.toHaveBeenCalled();
        stop();
    });

    it('terminates a socket still CLOSING after the grace period, exactly once, and reports how long it waited', () => {
        const ws = fakeSocket();
        ws.bufferedAmount = 12_781_470;
        const onStuck = vi.fn();
        const stop = watchForStuckClosing(ws as unknown as WS, { graceMs: 5000, pollMs: 1000, onStuck });
        vi.advanceTimersByTime(1000); // still OPEN at the first poll
        ws.readyState = CLOSING;
        vi.advanceTimersByTime(1000); // CLOSING first observed here
        vi.advanceTimersByTime(4000); // 4 s in: not yet
        expect(ws.terminate).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000); // 5 s in: stuck
        expect(ws.terminate).toHaveBeenCalledTimes(1);
        expect(onStuck).toHaveBeenCalledTimes(1);
        expect(onStuck).toHaveBeenCalledWith({ closingForMs: 5000, bufferedAmount: 12_781_470 });
        vi.advanceTimersByTime(60_000);
        expect(ws.terminate).toHaveBeenCalledTimes(1);
        stop();
    });

    it('stop() ends the watch, so a released session is never terminated after the fact', () => {
        const ws = fakeSocket();
        const onStuck = vi.fn();
        const stop = watchForStuckClosing(ws as unknown as WS, { graceMs: 5000, pollMs: 1000, onStuck });
        ws.readyState = CLOSING;
        vi.advanceTimersByTime(1000);
        stop();
        vi.advanceTimersByTime(60_000);
        expect(ws.terminate).not.toHaveBeenCalled();
        expect(onStuck).not.toHaveBeenCalled();
    });
});

// The mechanism itself, on a real `ws` server, with the peer behaviour that
// produces the unbounded CLOSING: stop reading, then FIN without a close frame.
// Measured before the fix (scratch repro, 2026-09-25): still CLOSING after 75 s
// with 12.7 MB buffered. With the watchdog, 'close' must arrive within the grace
// period plus one poll.
describe('watchForStuckClosing (real ws socket)', () => {
    let server: http.Server | undefined;
    let wss: WebSocketServer | undefined;
    let client: net.Socket | undefined;

    afterEach(async () => {
        client?.destroy();
        for (const c of wss?.clients ?? []) c.terminate();
        await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
        await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
        server = undefined;
        wss = undefined;
        client = undefined;
    });

    it("turns a peer's FIN-without-close-frame into a prompt 'close'", async () => {
        server = http.createServer();
        wss = new WebSocketServer({ server });
        const frame = Buffer.alloc(64 * 1024, 7);
        const onStuck = vi.fn();
        let flood: NodeJS.Timeout | undefined;
        let stop: (() => void) | undefined;

        const closed = new Promise<{ code: number; afterMs: number }>((resolve) => {
            wss?.on('connection', (ws) => {
                stop = watchForStuckClosing(ws, { graceMs: 300, pollMs: 50, onStuck });
                flood = setInterval(() => {
                    if (ws.readyState === ws.OPEN) ws.send(frame);
                }, 5);
                ws.on('close', (code) => {
                    clearInterval(flood);
                    stop?.();
                    resolve({ code, afterMs: Date.now() - finAt });
                });
            });
        });

        await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
        const port = (server.address() as net.AddressInfo).port;
        client = net.connect(port, '127.0.0.1');
        await new Promise<void>((r) => client?.once('connect', () => r()));
        const key = crypto.randomBytes(16).toString('base64');
        client.write(
            'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
        await new Promise<void>((r) => client?.once('data', () => r()));
        await new Promise((r) => setTimeout(r, 300)); // let the flood start
        client.pause(); // stop reading: our send buffer can no longer drain
        await new Promise((r) => setTimeout(r, 500));
        const finAt = Date.now();
        client.end(); // FIN, no close frame

        const result = await closed;
        expect(result.code).toBe(1006);
        expect(result.afterMs).toBeLessThan(2000);
        expect(onStuck).toHaveBeenCalledTimes(1);
    }, 15_000);
});
