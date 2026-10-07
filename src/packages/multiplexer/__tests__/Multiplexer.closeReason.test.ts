import { describe, expect, it, vi } from 'vitest';
import { Multiplexer } from '../Multiplexer';

/**
 * The root multiplexer hands its close reason to a real socket, and both the
 * browser (SyntaxError) and `ws` (RangeError) throw for a reason over 123 bytes
 * of UTF-8 -- so the close never happens. The root branch must cut the reason.
 */

/** Throws on a long reason exactly as a real socket does. */
class FakeSocket extends EventTarget {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = 1;
    public binaryType = 'blob';
    public close = vi.fn((_code?: number, reason?: string) => {
        if (reason !== undefined && new TextEncoder().encode(reason).byteLength > 123) {
            throw new SyntaxError('The message must not be greater than 123 bytes');
        }
        this.readyState = this.CLOSING;
    });
    public send = vi.fn();
}

describe('Multiplexer.close on the root socket', () => {
    it('cuts a long multi-byte reason to 123 bytes on a character boundary', () => {
        const ws = new FakeSocket();
        const mux = Multiplexer.wrap(ws as unknown as WebSocket);
        // 100 x 2-byte characters = 200 bytes; a plain 123-byte cut would split one.
        const long = 'é'.repeat(100);

        mux.close(1000, long);

        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ws.close.mock.calls[0]?.[0]).toBe(1000);
        const reason = ws.close.mock.calls[0]?.[1] as string;
        const bytes = new TextEncoder().encode(reason);
        expect(bytes.byteLength).toBeLessThanOrEqual(123);
        // Valid UTF-8: decoding with `fatal` throws on a split character.
        expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(reason);
        expect(reason).toBe('é'.repeat(61));
        expect(ws.readyState).toBe(ws.CLOSING);
    });

    it('passes a short reason unchanged and leaves an absent reason undefined', () => {
        const ws = new FakeSocket();
        Multiplexer.wrap(ws as unknown as WebSocket).close(4000, 'bye');
        expect(ws.close).toHaveBeenCalledWith(4000, 'bye');

        const ws2 = new FakeSocket();
        Multiplexer.wrap(ws2 as unknown as WebSocket).close();
        expect(ws2.close).toHaveBeenCalledWith(1000, undefined);
    });
});
