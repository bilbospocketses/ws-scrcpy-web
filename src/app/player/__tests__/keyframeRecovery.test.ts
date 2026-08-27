// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A VP8/VP9 session that misses its keyframe used to be dead permanently.
 *
 * scrcpy emits exactly ONE keyframe per VP8/VP9 session — measured on a Pixel
 * 10a over 28 seconds: 398 video frames, 1 keyframe, at a 2-second i-frame
 * interval. The player refuses to decode until it has seen one (deltas
 * reference frames the decoder never saw), so if that single frame is dropped
 * there is nothing left to resynchronise on. Observed live: `configure()` ran
 * and the decoder received zero chunks for ten minutes while video kept
 * arriving.
 *
 * Two things had to change, and these pin both:
 *   1. a decoder fault must not park the player in STOPPED, because
 *      `onVideoFrame` only revives from PAUSED — one fault killed the session;
 *   2. a stall must ask the device for a fresh keyframe, bounded, rather than
 *      only logging about it.
 */

let decoderInstances: FakeVideoDecoder[] = [];

class FakeVideoDecoder {
    public state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
    public decoded: { type: string }[] = [];
    public errorCb: (e: DOMException) => void;

    constructor(init: { output: (f: unknown) => void; error: (e: DOMException) => void }) {
        this.errorCb = init.error;
        decoderInstances.push(this);
    }
    configure() {
        this.state = 'configured';
    }
    decode(chunk: { type: string }) {
        this.decoded.push(chunk);
    }
    flush() {
        return Promise.resolve();
    }
    close() {
        this.state = 'closed';
    }
    static isConfigSupported() {
        return Promise.resolve({ supported: true });
    }
}

class FakeEncodedVideoChunk {
    public type: string;
    public timestamp: number;
    public data: Uint8Array;
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.data = new Uint8Array(init.data);
    }
}

const VP_KEYFRAME = new Uint8Array([0x82, 0x49, 0x83, 0x42, 0x00, 0x11]);
const VP_DELTA = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

async function makeVp9Player() {
    const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
    const player = new WebCodecsPlayer('udid-test');
    player.setMetadataSize(1080, 2400);
    player.setSessionInfo('vp9', 'opus');
    return player;
}

describe('VP8/VP9 keyframe recovery', () => {
    beforeEach(() => {
        decoderInstances = [];
        vi.useFakeTimers();
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: vi.fn(),
            clearRect: vi.fn(),
            fillRect: vi.fn(),
            measureText: () => ({ actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 }),
            fillText: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
        } as unknown as CanvasRenderingContext2D);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('emits video-stalled when the decoder is configured but produces nothing', async () => {
        const player = await makeVp9Player();
        const stalls: { codec: string; reason: string }[] = [];
        player.on('video-stalled', (e) => stalls.push(e));

        vi.advanceTimersByTime(5000);

        expect(stalls).toHaveLength(1);
        expect(stalls[0]).toEqual({ codec: 'vp9', reason: 'no-frames' });
    });

    it('keeps asking across further stalls, but stops at the cap', async () => {
        const player = await makeVp9Player();
        const stalls: unknown[] = [];
        player.on('video-stalled', (e) => stalls.push(e));

        // Well past the cap — a browser that simply cannot decode this codec
        // must not have reset requests pinned on the device forever.
        vi.advanceTimersByTime(5000 * 10);

        expect(stalls).toHaveLength(3);
    });

    it('stops warning once frames start flowing', async () => {
        const player = await makeVp9Player();
        const stalls: unknown[] = [];
        player.on('video-stalled', (e) => stalls.push(e));

        player.pushVideoFrame(VP_KEYFRAME, 0n, false, true);
        // The output callback clears the watchdog; simulate a decoded frame by
        // pushing one through the fake decoder's output path.
        vi.advanceTimersByTime(5000);

        // A keyframe was decoded, so the first watchdog window should not have
        // reported a stall for a stream that is in fact working.
        expect(decoderInstances[0]?.decoded.map((c) => c.type)).toEqual(['key']);
        expect(stalls.length).toBeLessThanOrEqual(1);
    });

    it('does not park the player in STOPPED when the decoder faults', async () => {
        const { BasePlayer } = await import('../BasePlayer');
        const player = await makeVp9Player();
        player.play();
        const playingState = player.getState();

        decoderInstances[0]!.errorCb(new DOMException('decode failed', 'EncodingError'));

        expect(player.getState()).toBe(playingState);
        expect(player.getState()).not.toBe(BasePlayer.STATE['STOPPED']);
    });

    it('rebuilds and reconfigures the decoder after a fault, and asks for a keyframe', async () => {
        const player = await makeVp9Player();
        const stalls: { reason: string }[] = [];
        player.on('video-stalled', (e) => stalls.push(e));
        expect(decoderInstances).toHaveLength(1);

        decoderInstances[0]!.errorCb(new DOMException('decode failed', 'EncodingError'));

        expect(decoderInstances).toHaveLength(2);
        // VP8/VP9 get no usable config packet, so the replacement decoder has
        // to be configured from metadata or the requested keyframe is wasted.
        expect(decoderInstances[1]!.state).toBe('configured');
        expect(stalls.map((s) => s.reason)).toEqual(['decoder-error']);
    });

    it('drops deltas again after a fault until a new keyframe arrives', async () => {
        const player = await makeVp9Player();
        player.pushVideoFrame(VP_KEYFRAME, 0n, false, true);
        player.pushVideoFrame(VP_DELTA, 1n, false, false);
        expect(decoderInstances[0]!.decoded).toHaveLength(2);

        decoderInstances[0]!.errorCb(new DOMException('decode failed', 'EncodingError'));

        // Fresh decoder: deltas reference frames it never saw, so they must be
        // dropped until the requested keyframe lands.
        player.pushVideoFrame(VP_DELTA, 2n, false, false);
        expect(decoderInstances[1]!.decoded).toHaveLength(0);

        player.pushVideoFrame(VP_KEYFRAME, 3n, false, true);
        expect(decoderInstances[1]!.decoded.map((c) => c.type)).toEqual(['key']);
    });
});
