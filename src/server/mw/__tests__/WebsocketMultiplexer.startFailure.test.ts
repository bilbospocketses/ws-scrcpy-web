import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * When the multiplexer fails to start, its `.catch` closes the socket. If that
 * close throws (the socket is already closing, say), the throw escaped the
 * handler as an unhandled rejection. It must be caught and logged instead.
 */

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock('../../Logger', () => {
    const log = { info() {}, warn() {}, error: logError, debug() {} };
    return { Logger: { for: () => log } };
});

import { WebsocketMultiplexer } from '../WebsocketMultiplexer';

class FakeWs extends EventEmitter {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = 1;
    public binaryType = 'nodebuffer';
    public close = vi.fn();
    public send = vi.fn();
    addEventListener(type: string, listener: (...args: unknown[]) => void): void {
        this.on(type, listener);
    }
    removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
        this.off(type, listener);
    }
}

/** Let the rejected init() and its `.catch` run, and give Node a turn to flag a leak. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

afterEach(() => {
    vi.restoreAllMocks();
    logError.mockReset();
});

describe('WebsocketMultiplexer.createMultiplexer — a failed start', () => {
    it('logs a close that throws instead of leaking an unhandled rejection', async () => {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            vi.spyOn(WebsocketMultiplexer.prototype, 'init').mockReturnValue(Promise.reject(new Error('boom')));
            const ws = new FakeWs();
            const closeError = new Error('WebSocket is already closing');
            ws.close.mockImplementation(() => {
                throw closeError;
            });

            WebsocketMultiplexer.createMultiplexer(ws as never);
            await settle();

            expect(ws.close).toHaveBeenCalledTimes(1);
            expect(unhandled).not.toHaveBeenCalled();
            expect(logError).toHaveBeenCalledWith(expect.stringContaining('Failed to close'), closeError);
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('reports a non-Error rejection by its text rather than "undefined"', async () => {
        vi.spyOn(WebsocketMultiplexer.prototype, 'init').mockReturnValue(Promise.reject('adb went away'));
        const ws = new FakeWs();

        WebsocketMultiplexer.createMultiplexer(ws as never);
        await settle();

        expect(ws.close).toHaveBeenCalledWith(4005, '[WebsocketMultiplexer] Failed to start service: adb went away');
    });
});
