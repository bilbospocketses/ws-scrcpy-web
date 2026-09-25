import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { StreamCongestion } from '../StreamCongestion';

// A browser that stops reading used to make the server buffer video without
// limit: sendChannel called ws.send() on every packet and never looked at
// ws.bufferedAmount. Measured with a raw client that stopped reading: ~12.5 MB
// buffered in 3 s, growing for as long as the socket stayed OPEN.
//
// StreamCongestion decides per packet whether to send it. Past a high-water mark
// it sheds media (video and audio) and keeps what is small and essential; once
// the backlog drains below a low-water mark it asks for a keyframe and resumes
// video only at a keyframe, because a delta frame after a gap decodes as garbage.

const HIGH = 4 * 1024 * 1024;
const LOW = 1024 * 1024;

function make(): StreamCongestion {
    let t = 0;
    return new StreamCongestion({ highWater: HIGH, lowWater: LOW, now: () => (t += 10) });
}

describe('StreamCongestion', () => {
    it('sends everything while the backlog stays under the high-water mark', () => {
        const c = make();
        for (const kind of ['config', 'keyframe', 'frame', 'frame'] as const) {
            expect(c.video(kind, HIGH).send).toBe(true);
        }
        expect(c.audio('frame', HIGH)).toBe(true);
        expect(c.state).toBe('flowing');
    });

    it('starts shedding video AND audio media once the backlog passes the high-water mark, and says so once', () => {
        const c = make();
        const first = c.video('frame', HIGH + 1);
        expect(first.send).toBe(false);
        expect(first.event).toEqual({ type: 'congested', bufferedAmount: HIGH + 1 });
        expect(c.state).toBe('congested');
        const second = c.video('frame', HIGH + 5);
        expect(second.send).toBe(false);
        expect(second.event).toBeUndefined();
        expect(c.video('keyframe', HIGH).send).toBe(false);
        expect(c.audio('frame', HIGH)).toBe(false);
    });

    it('never sheds a config packet, video or audio: it is tiny and a decoder cannot start without it', () => {
        const c = make();
        c.video('frame', HIGH + 1);
        expect(c.video('config', HIGH * 2).send).toBe(true);
        expect(c.audio('config', HIGH * 2)).toBe(true);
    });

    it('stays congested until the backlog is back under the LOW mark, not merely under high', () => {
        const c = make();
        c.video('frame', HIGH + 1);
        expect(c.video('frame', HIGH - 1).send).toBe(false);
        expect(c.video('frame', LOW + 1).send).toBe(false);
        expect(c.state).toBe('congested');
    });

    it('on draining, requests ONE keyframe, reports what was shed, and resumes video only at a keyframe', () => {
        const c = make();
        c.video('frame', HIGH + 1); // congested: shed 1 video
        c.video('frame', HIGH + 2); // shed 2
        c.audio('frame', HIGH + 2); // shed 1 audio
        const drained = c.video('frame', LOW);
        expect(drained.send).toBe(false); // a delta frame after a gap
        expect(drained.requestKeyframe).toBe(true);
        // The drain packet itself is not congestion shedding: it is the first
        // delta skipped while waiting for a keyframe, reported on 'resumed'.
        expect(drained.event).toMatchObject({
            type: 'drained',
            videoShed: 2,
            audioShed: 1,
            peakBufferedAmount: HIGH + 2,
        });
        expect(c.state).toBe('awaiting-keyframe');

        const stillWaiting = c.video('frame', 0);
        expect(stillWaiting.send).toBe(false);
        expect(stillWaiting.requestKeyframe).toBeFalsy();
        expect(c.audio('frame', 0)).toBe(true); // audio resumes as soon as the backlog drains
        expect(c.video('config', 0).send).toBe(true); // the reset's config comes first
        expect(c.state).toBe('awaiting-keyframe');

        const key = c.video('keyframe', 0);
        expect(key.send).toBe(true);
        expect(key.event).toMatchObject({ type: 'resumed', deltasSkipped: 2 });
        expect(c.state).toBe('flowing');
        expect(c.video('frame', 0).send).toBe(true);
    });

    it('re-enters congestion if the backlog climbs again while waiting for the keyframe', () => {
        const c = make();
        c.video('frame', HIGH + 1);
        c.video('frame', LOW);
        expect(c.state).toBe('awaiting-keyframe');
        const again = c.video('keyframe', HIGH + 1);
        expect(again.send).toBe(false);
        expect(again.event).toMatchObject({ type: 'congested' });
        expect(c.state).toBe('congested');
    });

    it('rejects a low-water mark that is not below the high-water mark', () => {
        expect(() => new StreamCongestion({ highWater: LOW, lowWater: LOW })).toThrow(/lowWater/);
    });
});

// The property that matters, on a real ws socket: with the gate in the send path,
// a client that stops reading can no longer grow the server's buffer without
// bound. Without it (measured): ~12.5 MB after 3 s of a 64 KB / 5 ms flood.
describe('StreamCongestion (real ws socket)', () => {
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

    it("bounds the server's unsent buffer when the client stops reading", async () => {
        server = http.createServer();
        wss = new WebSocketServer({ server });
        const frame = Buffer.alloc(64 * 1024, 7);
        const gate = new StreamCongestion({ highWater: HIGH, lowWater: LOW });
        let peak = 0;
        let shed = 0;

        const flooding = new Promise<void>((resolve) => {
            wss?.on('connection', (ws) => {
                let n = 0;
                const iv = setInterval(() => {
                    if (ws.readyState !== ws.OPEN) return;
                    const d = gate.video(n++ % 30 === 0 ? 'keyframe' : 'frame', ws.bufferedAmount);
                    if (d.send) ws.send(frame);
                    else shed += 1;
                    peak = Math.max(peak, ws.bufferedAmount);
                }, 5);
                setTimeout(() => {
                    clearInterval(iv);
                    resolve();
                }, 3500);
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
        client.pause(); // stop reading, as a stalled browser does
        await flooding;

        expect(gate.state).toBe('congested');
        expect(shed).toBeGreaterThan(0);
        // One frame past the mark at most: the check runs before each send.
        expect(peak).toBeLessThanOrEqual(HIGH + frame.length + 64);
    }, 15_000);
});
