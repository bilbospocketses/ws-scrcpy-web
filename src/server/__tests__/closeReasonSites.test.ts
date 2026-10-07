import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION } from '../../common/Action';

/**
 * A WebSocket close reason is capped at 123 bytes of UTF-8 (RFC 6455), and `ws`
 * throws a RangeError past that — before the socket leaves OPEN, so the close
 * never happens. Close sites that build their reason from an error message must
 * cut it with `closeReason()`; `String.slice(0, 123)` counts UTF-16 units, not
 * bytes, so a non-English message still crossed the limit.
 */

vi.mock('../AdbClient', () => ({ AdbClient: class {} }));

vi.mock('../Config', () => ({
    Config: { getInstance: () => ({ adbPath: 'adb', dependenciesPath: '/deps' }) },
}));

vi.mock('../goog-device/services/ControlCenter', () => ({
    ControlCenter: { hasInstance: () => false },
}));

vi.mock('../ensureScrcpyServerPushed', () => ({ ensureScrcpyServerPushed: () => Promise.resolve() }));

vi.mock('../scrcpyServerVersion', () => ({ getInstalledScrcpyServerVersion: () => '4.0' }));

vi.mock('../Logger', () => {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    return { Logger: { for: () => quiet } };
});

import { DeviceProbe } from '../DeviceProbe';
import { WebsocketMultiplexer } from '../mw/WebsocketMultiplexer';

/** Throws on a long reason exactly as `ws` does (node_modules/ws/lib/sender.js). */
class FakeWs extends EventEmitter {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = 1;
    public binaryType = 'nodebuffer';
    public close = vi.fn((_code?: number, reason?: string) => {
        if (reason !== undefined && Buffer.byteLength(reason) > 123) {
            throw new RangeError('The message must not be greater than 123 bytes');
        }
        this.readyState = this.CLOSING;
    });
    public send = vi.fn();
    addEventListener(type: string, listener: (...args: unknown[]) => void): void {
        this.on(type, listener);
    }
    removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
        this.off(type, listener);
    }
}

function expectValidReason(reason: unknown, prefix: string): void {
    expect(typeof reason).toBe('string');
    const text = reason as string;
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(123);
    expect(text.startsWith(prefix)).toBe(true);
    // Cut on a character boundary: the reason survives a UTF-8 round trip.
    expect(Buffer.from(text, 'utf-8').toString('utf-8')).toBe(text);
    expect(text).not.toContain('�');
}

const LONG_MESSAGES = [
    ['a long ASCII', 'x'.repeat(300)],
    ['a multi-byte', 'é'.repeat(100)],
    ['an emoji', '😀'.repeat(60)],
];

afterEach(() => {
    vi.restoreAllMocks();
});

describe('DeviceProbe — a failed probe closes cleanly whatever the error says', () => {
    it.each(LONG_MESSAGES)(
        '%s error message closes with 4005 and a reason within 123 bytes',
        async (_kind, message) => {
            vi.spyOn(DeviceProbe.prototype as unknown as { probe(): Promise<void> }, 'probe').mockReturnValue(
                Promise.reject(new Error(message)),
            );
            const ws = new FakeWs();

            const probe = DeviceProbe.processRequest(ws as never, {
                action: ACTION.PROBE_DEVICE,
                url: new URL('http://localhost/?action=probe&udid=device-1'),
                request: {} as never,
            });
            expect(probe).toBeDefined();

            await vi.waitFor(() => expect(ws.close).toHaveBeenCalled());

            expect(ws.close.mock.calls[0]?.[0]).toBe(4005);
            expectValidReason(ws.close.mock.calls[0]?.[1], message.slice(0, 10));
            // The close went through rather than throwing with the socket left OPEN.
            expect(ws.readyState).toBe(ws.CLOSING);
        },
    );

    it('a short error message is sent unchanged', async () => {
        vi.spyOn(DeviceProbe.prototype as unknown as { probe(): Promise<void> }, 'probe').mockReturnValue(
            Promise.reject(new Error('device offline')),
        );
        const ws = new FakeWs();

        DeviceProbe.processRequest(ws as never, {
            action: ACTION.PROBE_DEVICE,
            url: new URL('http://localhost/?action=probe&udid=device-1'),
            request: {} as never,
        });

        await vi.waitFor(() => expect(ws.close).toHaveBeenCalled());
        expect(ws.close).toHaveBeenCalledWith(4005, 'device offline');
    });
});

describe('WebsocketMultiplexer — a failed start closes cleanly whatever the error says', () => {
    const prefix = '[WebsocketMultiplexer] Failed to start service: ';

    it.each(LONG_MESSAGES)(
        '%s error message closes with 4005 and a reason within 123 bytes',
        async (_kind, message) => {
            vi.spyOn(WebsocketMultiplexer.prototype, 'init').mockReturnValue(Promise.reject(new Error(message)));
            const ws = new FakeWs();

            WebsocketMultiplexer.createMultiplexer(ws as never);

            await vi.waitFor(() => expect(ws.close).toHaveBeenCalled());

            expect(ws.close.mock.calls[0]?.[0]).toBe(4005);
            expectValidReason(ws.close.mock.calls[0]?.[1], prefix);
            expect(ws.readyState).toBe(ws.CLOSING);
        },
    );

    it('a short error message is sent unchanged', async () => {
        vi.spyOn(WebsocketMultiplexer.prototype, 'init').mockReturnValue(Promise.reject(new Error('boom')));
        const ws = new FakeWs();

        WebsocketMultiplexer.createMultiplexer(ws as never);

        await vi.waitFor(() => expect(ws.close).toHaveBeenCalled());
        expect(ws.close).toHaveBeenCalledWith(4005, `${prefix}boom`);
    });
});
