// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelId } from '../../../common/ChannelId';
import DeviceMessage from '../DeviceMessage';
import { DEVICE_MSG_MAX_SIZE, DeviceMessageFramer, deviceMessageLength } from '../DeviceMessageFramer';

/**
 * The server relays the scrcpy control socket's bytes as TCP hands them over, so
 * a DEVICE_MSG frame is a chunk, not a message. These pin the reassembly: a long
 * clipboard split over several frames arrives whole, and two messages in one
 * frame both arrive. Layouts per upstream DeviceMessageWriter.java (v5.0).
 */

function clipboard(text: string): Uint8Array {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(5 + body.length);
    out[0] = DeviceMessage.TYPE_CLIPBOARD;
    new DataView(out.buffer).setUint32(1, body.length);
    out.set(body, 5);
    return out;
}

function ack(sequence: bigint): Uint8Array {
    const out = new Uint8Array(9);
    out[0] = DeviceMessage.TYPE_ACK_CLIPBOARD;
    new DataView(out.buffer).setBigUint64(1, sequence);
    return out;
}

function uhidOutput(id: number, data: number[]): Uint8Array {
    const out = new Uint8Array(5 + data.length);
    out[0] = DeviceMessage.TYPE_UHID_OUTPUT;
    const view = new DataView(out.buffer);
    view.setUint16(1, id);
    view.setUint16(3, data.length);
    out.set(data, 5);
    return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function collect() {
    const messages: Uint8Array[] = [];
    const framer = new DeviceMessageFramer((m) => messages.push(m));
    const texts = () => messages.map((m) => DeviceMessage.fromRaw(m).getText());
    return { framer, messages, texts };
}

describe('deviceMessageLength', () => {
    it('reads each known layout from its header', () => {
        expect(deviceMessageLength(clipboard('hello'))).toBe(10);
        expect(deviceMessageLength(ack(7n))).toBe(9);
        expect(deviceMessageLength(uhidOutput(1, [1, 2, 3]))).toBe(8);
    });

    it('waits when the length field has not arrived', () => {
        expect(deviceMessageLength(new Uint8Array(0))).toBe(0);
        expect(deviceMessageLength(clipboard('hello').subarray(0, 4))).toBe(0);
        expect(deviceMessageLength(uhidOutput(1, [1]).subarray(0, 3))).toBe(0);
    });

    it('cannot size an unknown type', () => {
        expect(deviceMessageLength(Uint8Array.of(42, 0, 0))).toBe(-1);
    });
});

describe('DeviceMessageFramer', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        warn.mockRestore();
    });

    it('delivers a message that arrives in one chunk (control)', () => {
        const { framer, texts } = collect();
        framer.push(clipboard('one chunk'));
        expect(texts()).toEqual(['one chunk']);
        expect(framer.pendingBytes).toBe(0);
    });

    it('reassembles one message split across 2 chunks', () => {
        const { framer, texts } = collect();
        const text = 'x'.repeat(70_000);
        const whole = clipboard(text);
        framer.push(whole.subarray(0, 65_536));
        expect(texts()).toEqual([]);
        framer.push(whole.subarray(65_536));
        expect(texts()).toEqual([text]);
        expect(framer.pendingBytes).toBe(0);
    });

    it('reassembles one message split across 3 chunks, the first cutting the length field', () => {
        const { framer, texts } = collect();
        const whole = clipboard('split three ways — with UTF-8 ✓');
        framer.push(whole.subarray(0, 3));
        framer.push(whole.subarray(3, 12));
        expect(texts()).toEqual([]);
        framer.push(whole.subarray(12));
        expect(texts()).toEqual(['split three ways — with UTF-8 ✓']);
    });

    it('delivers both of two messages that share a chunk', () => {
        const { framer, messages } = collect();
        framer.push(concat(clipboard('first'), ack(5n)));
        expect(messages).toHaveLength(2);
        expect(DeviceMessage.fromRaw(messages[0]!).getText()).toBe('first');
        expect(DeviceMessage.fromRaw(messages[1]!).getAckSequence()).toBe(5n);
    });

    it('delivers a whole message and holds the start of the next until it completes', () => {
        const { framer, messages } = collect();
        const second = uhidOutput(3, [9, 8, 7, 6]);
        framer.push(concat(clipboard('done'), second.subarray(0, 4)));
        expect(messages).toHaveLength(1);
        expect(framer.pendingBytes).toBe(4);
        framer.push(second.subarray(4));
        expect(messages).toHaveLength(2);
        expect(Array.from(messages[1]!)).toEqual(Array.from(second));
        expect(framer.pendingBytes).toBe(0);
    });

    describe('an unknown type stops the framer for the rest of the connection', () => {
        it('delivers nothing after it, not even a valid CLIPBOARD, and warns once naming the type', () => {
            const { framer, messages } = collect();
            framer.push(Uint8Array.of(42, 1, 2, 3));
            framer.push(clipboard('after'));
            framer.push(Uint8Array.of(43, 1));
            framer.push(ack(1n));

            expect(messages).toEqual([]);
            expect(framer.pendingBytes).toBe(0);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]![1])).toContain('unknown device message type 42');
        });

        it('cannot read a 0x00 from the middle of the unknown message as a CLIPBOARD', () => {
            // The unknown message's own bytes, split by TCP so the next chunk
            // starts with what looks like a CLIPBOARD header for "abc".
            const { framer, messages } = collect();
            framer.push(Uint8Array.of(42, 9, 9));
            framer.push(Uint8Array.of(DeviceMessage.TYPE_CLIPBOARD, 0, 0, 0, 3, 0x61, 0x62, 0x63));
            expect(messages, 'garbage must never reach the host clipboard').toEqual([]);
        });

        it('still delivers the messages that completed before it in the same chunk', () => {
            const { framer, texts } = collect();
            framer.push(concat(clipboard('before'), Uint8Array.of(42, 1, 2), clipboard('after')));
            expect(texts()).toEqual(['before']);
        });
    });

    describe('a handler that throws', () => {
        let error: ReturnType<typeof vi.spyOn>;
        beforeEach(() => {
            error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        });
        afterEach(() => {
            error.mockRestore();
        });

        /** Records every delivery, then throws on the ones listed. */
        function throwingOn(...bad: string[]) {
            const delivered: string[] = [];
            const framer = new DeviceMessageFramer((m) => {
                const text = DeviceMessage.fromRaw(m).getText();
                delivered.push(text);
                if (bad.includes(text)) throw new Error(`handler failed on ${text}`);
            });
            return { framer, delivered };
        }

        it('does not cost the messages after it in the same chunk', () => {
            const { framer, delivered } = throwingOn('one');
            expect(() => framer.push(concat(clipboard('one'), clipboard('two')))).not.toThrow();
            expect(delivered).toEqual(['one', 'two']);
            expect(error).toHaveBeenCalledTimes(1);
        });

        it('does not get its message again on the next push', () => {
            const { framer, delivered } = throwingOn('one');
            framer.push(concat(clipboard('one'), clipboard('two')));
            expect(framer.pendingBytes).toBe(0);
            framer.push(clipboard('three'));
            expect(delivered).toEqual(['one', 'two', 'three']);
        });

        it('keeps a partial message that followed it, and completes it on the next push', () => {
            const { framer, delivered } = throwingOn('one');
            const second = clipboard('two');
            framer.push(concat(clipboard('one'), second.subarray(0, 6)));
            expect(framer.pendingBytes).toBe(6);
            framer.push(second.subarray(6));
            expect(delivered).toEqual(['one', 'two']);
        });
    });

    it('drops an oversized message that arrives WHOLE in one chunk and delivers the message after it', () => {
        const { framer, texts } = collect();
        const oversize = clipboard('w'.repeat(DEVICE_MSG_MAX_SIZE));
        framer.push(concat(oversize, clipboard('right after')));
        expect(texts()).toEqual(['right after']);
        expect(framer.pendingBytes).toBe(0);
        framer.push(clipboard('and the next one'));
        expect(texts()).toEqual(['right after', 'and the next one']);
    });

    it('drops a message larger than the 256 KiB device limit and stays aligned on what follows', () => {
        const { framer, texts } = collect();
        const oversize = clipboard('y'.repeat(DEVICE_MSG_MAX_SIZE));
        expect(oversize.length).toBeGreaterThan(DEVICE_MSG_MAX_SIZE);
        // Arrives in pieces, followed in the last piece by a normal message.
        const tail = concat(oversize.subarray(200_000), clipboard('next'));
        framer.push(oversize.subarray(0, 100_000));
        expect(framer.pendingBytes).toBe(0);
        framer.push(oversize.subarray(100_000, 200_000));
        framer.push(tail);
        expect(texts()).toEqual(['next']);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![1])).toContain('exceeds');
    });

    it('accepts a clipboard message exactly at the device limit', () => {
        const { framer, messages } = collect();
        const atLimit = clipboard('z'.repeat(DEVICE_MSG_MAX_SIZE - 5));
        expect(atLimit.length).toBe(DEVICE_MSG_MAX_SIZE);
        framer.push(atLimit.subarray(0, 131_072));
        framer.push(atLimit.subarray(131_072));
        expect(messages).toHaveLength(1);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('ScrcpyDemuxer feeds DEVICE_MSG frames through the framer', () => {
    class FakeWebSocket {
        public static readonly OPEN = 1;
        public static last: FakeWebSocket;
        public readyState = FakeWebSocket.OPEN;
        public binaryType = '';
        public onmessage: ((ev: MessageEvent) => void) | null = null;
        public onopen: (() => void) | null = null;
        public onclose: ((ev: CloseEvent) => void) | null = null;
        public onerror: (() => void) | null = null;
        constructor(public readonly url: string) {
            FakeWebSocket.last = this;
        }
        send() {}
        close() {}
    }

    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeWebSocket);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function frame(chunk: Uint8Array): MessageEvent {
        const raw = new Uint8Array(1 + chunk.length);
        raw[0] = ChannelId.DEVICE_MSG;
        raw.set(chunk, 1);
        return { data: raw.buffer } as MessageEvent;
    }

    async function demuxer() {
        const { ScrcpyDemuxer } = await import('../../ScrcpyDemuxer');
        const d = new ScrcpyDemuxer('ws://localhost/stream');
        const socket = FakeWebSocket.last;
        const texts: string[] = [];
        d.onDeviceMessage((m) => texts.push(DeviceMessage.fromRaw(m).getText()));
        return { socket, texts };
    }

    it('delivers a clipboard split over two frames once, whole', async () => {
        const { socket, texts } = await demuxer();
        const whole = clipboard('a long clipboard');
        socket.onmessage?.(frame(whole.subarray(0, 8)));
        socket.onmessage?.(frame(whole.subarray(8)));
        expect(texts).toEqual(['a long clipboard']);
    });

    it('delivers both messages of a frame that carries two', async () => {
        const { socket, texts } = await demuxer();
        socket.onmessage?.(frame(concat(clipboard('one'), clipboard('two'))));
        expect(texts).toEqual(['one', 'two']);
    });

    it('starts a reconnected stream (a new demuxer) with an empty buffer', async () => {
        const first = await demuxer();
        first.socket.onmessage?.(frame(clipboard('cut off by the reconnect').subarray(0, 9)));
        const second = await demuxer();
        second.socket.onmessage?.(frame(clipboard('fresh session')));
        expect(second.texts).toEqual(['fresh session']);
        expect(first.texts).toEqual([]);
    });
});
