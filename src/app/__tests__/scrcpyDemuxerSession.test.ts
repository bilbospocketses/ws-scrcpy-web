// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelId } from '../../common/ChannelId';

/**
 * Item 24 — the rotation channel.
 *
 * ChannelId.SESSION is deliberately NOT a re-sent METADATA. `StreamClientScrcpy`
 * builds the AudioPlayer inside its metadata handler, so re-firing that message
 * on every rotation would spawn a fresh audio pipeline each time. These tests
 * pin the separation as much as the routing.
 */

class FakeWebSocket {
    public static readonly OPEN = 1;
    public readyState = FakeWebSocket.OPEN;
    public binaryType = '';
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onopen: (() => void) | null = null;
    public onclose: ((ev: CloseEvent) => void) | null = null;
    public onerror: (() => void) | null = null;
    public sent: unknown[] = [];
    constructor(public readonly url: string) {}
    send(data: unknown) {
        this.sent.push(data);
    }
    close() {}
}

let socket: FakeWebSocket;

function channelMessage(channel: ChannelId, body: string): MessageEvent {
    const bytes = new TextEncoder().encode(body);
    const raw = new Uint8Array(1 + bytes.length);
    raw[0] = channel;
    raw.set(bytes, 1);
    // The demuxer only accepts an ArrayBuffer — mirror the real `binaryType`.
    return { data: raw.buffer } as MessageEvent;
}

describe('ScrcpyDemuxer session channel (item 24)', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'WebSocket',
            class extends FakeWebSocket {
                constructor(url: string) {
                    super(url);
                    socket = this;
                }
            },
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function demuxer() {
        const { ScrcpyDemuxer } = await import('../ScrcpyDemuxer');
        return new ScrcpyDemuxer('ws://localhost/stream');
    }

    it('reports a session change to the session callback', async () => {
        const d = await demuxer();
        const changes: unknown[] = [];
        d.onSessionChange((c) => changes.push(c));

        socket.onmessage?.(channelMessage(ChannelId.SESSION, JSON.stringify({ width: 2400, height: 1080 })));

        expect(changes).toEqual([{ width: 2400, height: 1080 }]);
    });

    it('reports every rotation, not just the first', async () => {
        const d = await demuxer();
        const changes: unknown[] = [];
        d.onSessionChange((c) => changes.push(c));

        socket.onmessage?.(channelMessage(ChannelId.SESSION, JSON.stringify({ width: 2400, height: 1080 })));
        socket.onmessage?.(channelMessage(ChannelId.SESSION, JSON.stringify({ width: 1080, height: 2400 })));

        expect(changes).toHaveLength(2);
    });

    it('does not route a session change to the metadata callback', async () => {
        const d = await demuxer();
        const metas: unknown[] = [];
        d.onMetadata((m) => metas.push(m));
        d.onSessionChange(() => undefined);

        socket.onmessage?.(channelMessage(ChannelId.SESSION, JSON.stringify({ width: 2400, height: 1080 })));

        // Firing onMetadata here would build a second AudioPlayer per rotation.
        expect(metas).toEqual([]);
    });

    it('survives a malformed session payload without killing the stream', async () => {
        const d = await demuxer();
        const changes: unknown[] = [];
        d.onSessionChange((c) => changes.push(c));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(() => socket.onmessage?.(channelMessage(ChannelId.SESSION, 'not json'))).not.toThrow();
        expect(changes).toEqual([]);

        socket.onmessage?.(channelMessage(ChannelId.SESSION, JSON.stringify({ width: 1080, height: 2400 })));
        expect(changes).toEqual([{ width: 1080, height: 2400 }]);
        errors.mockRestore();
    });
});
