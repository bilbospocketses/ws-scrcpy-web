import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WS, { WebSocketServer } from 'ws';
import { WAIT_FOR_TIMEOUT_MS } from '../../../testSupport/waitFor';
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
// with 12.7 MB buffered. With the watchdog, 'close' must arrive once the grace
// period's polls have run.
//
// The watchdog's poll runs on a fake clock (only setInterval is faked; the
// sockets keep their real timers), so the test drives the polls itself and
// asserts the events -- stuck in CLOSING, then terminated, then 'close' --
// rather than how long the real socket took, which a loaded box stretches.
describe('watchForStuckClosing (real ws socket)', () => {
    let server: http.Server | undefined;
    let wss: WebSocketServer | undefined;
    let client: net.Socket | undefined;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(async () => {
        client?.destroy();
        for (const c of wss?.clients ?? []) c.terminate();
        await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
        await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
        server = undefined;
        wss = undefined;
        client = undefined;
        vi.useRealTimers();
    });

    /** Poll on the real clock (only setInterval is faked) until `ready()`; a hang fails as HUNG, naming `what`. */
    async function until(what: string, ready: () => boolean): Promise<void> {
        const deadline = Date.now() + WAIT_FOR_TIMEOUT_MS;
        while (!ready()) {
            if (Date.now() > deadline) throw new Error(`HUNG: waited ${WAIT_FOR_TIMEOUT_MS / 1000} s for ${what}`);
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    it("turns a peer's FIN-without-close-frame into a 'close' once the grace period has run", async () => {
        server = http.createServer();
        wss = new WebSocketServer({ server });
        const frame = Buffer.alloc(64 * 1024, 7);
        const onStuck = vi.fn();
        const graceMs = 300;
        const pollMs = 50;
        let serverWs: WS | undefined;
        let closeCode: number | undefined;

        const closed = new Promise<number>((resolve) => {
            wss?.on('connection', (ws) => {
                serverWs = ws;
                const stop = watchForStuckClosing(ws, { graceMs, pollMs, onStuck });
                ws.on('close', (code) => {
                    stop();
                    closeCode = code;
                    resolve(code);
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
        await until('the server side of the connection', () => serverWs !== undefined);
        const ws = serverWs as WS;
        client.pause(); // stop reading: our send buffer can no longer drain

        // Send until a real backlog builds: the kernel's buffers are full and
        // `ws` holds the rest. Yielding between sends lets every write the
        // kernel can take complete, so the backlog only grows once it cannot.
        const backlog = 2 * 1024 * 1024;
        for (let sent = 0; ws.bufferedAmount < backlog; sent++) {
            if (sent > 4096) throw new Error(`the send buffer never backed up (${ws.bufferedAmount} bytes queued)`);
            ws.send(frame);
            await new Promise((r) => setImmediate(r));
        }

        client.end(); // FIN, no close frame
        await until('the server socket to enter CLOSING', () => ws.readyState === CLOSING);
        await new Promise((r) => setImmediate(r));
        expect(closeCode, 'the socket closes on its own: the stuck CLOSING was not reproduced').toBeUndefined();

        // One poll sees CLOSING first; the grace period runs from there.
        vi.advanceTimersByTime(pollMs + graceMs - 1);
        expect(onStuck).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onStuck).toHaveBeenCalledTimes(1);
        expect(onStuck).toHaveBeenCalledWith({ closingForMs: graceMs, bufferedAmount: expect.any(Number) });
        expect(onStuck.mock.calls[0]?.[0].bufferedAmount).toBeGreaterThan(0);

        await until("the socket's 'close' after terminate()", () => closeCode !== undefined);
        expect(await closed).toBe(1006);
    });
});
