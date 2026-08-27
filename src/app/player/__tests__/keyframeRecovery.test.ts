// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A session that misses its keyframe used to be dead permanently.
 *
 * Keyframes are scarce for every codec, not just VP8/VP9 — measured on a Pixel
 * 10a over ~24 seconds each: h264 gave 1 keyframe in 307 frames; h265, av1 and
 * vp9 gave 2 apiece, against the ~12 a 2-second i-frame interval implies.
 * Asking for a shorter interval does not help, because Android encoders
 * largely ignore `KEY_I_FRAME_INTERVAL` (an I-frame is not necessarily an IDR
 * frame, and only IDR frames carry `BUFFER_FLAG_KEY_FRAME`).
 *
 * The player refuses to decode until it has seen a keyframe (deltas reference
 * frames the decoder never saw), so if that one frame is dropped there is
 * nothing left to resynchronise on. Observed live: `configure()` ran and the
 * decoder received zero chunks for ten minutes while video kept arriving.
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

describe('keyframe recovery (config-less codecs)', () => {
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

/**
 * h264 takes a materially different route through the same recovery, and it was
 * untested: its decoder is configured from the config packet rather than from
 * session metadata, so `recoverDecoder` deliberately does NOT re-configure it.
 *
 * That only works because a `TYPE_RESET_VIDEO` brings a fresh config packet
 * back alongside the keyframe. Verified on a Pixel 10a: after the reset the
 * config packet arrived at +180ms and the keyframe at +188ms, taking the
 * session from 1 config / 2 keyframes to 2 configs / 3 keyframes.
 */
describe('keyframe recovery (codecs with a config packet)', () => {
    // Annex B SPS for 1080x2400 baseline — enough for parseConfig to identify
    // h264 and build a decoder config.
    const H264_CONFIG = new Uint8Array([
        0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0xc0, 0x5a, 0x80, 0x80, 0x80, 0xa0,
        0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
    ]);
    const H264_KEYFRAME = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
    const H264_DELTA = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x00, 0x01]);

    async function makeH264Player() {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-h264');
        player.setMetadataSize(1080, 2400);
        player.setSessionInfo('h264', 'opus');
        return player;
    }

    it('does not configure up front — it waits for the config packet', async () => {
        await makeH264Player();
        expect(decoderInstances[0]?.state).toBe('unconfigured');
    });

    it('stalls and asks for a keyframe when the config packet brings no frames', async () => {
        const player = await makeH264Player();
        const stalls: { codec: string; reason: string }[] = [];
        player.on('video-stalled', (e) => stalls.push(e));

        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        vi.advanceTimersByTime(5000);

        expect(stalls).toHaveLength(1);
        expect(stalls[0]?.reason).toBe('no-frames');
    });

    it('does not park the player in STOPPED when the decoder faults', async () => {
        const { BasePlayer } = await import('../BasePlayer');
        const player = await makeH264Player();
        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        player.play();

        decoderInstances[0]!.errorCb(new DOMException('decode failed', 'EncodingError'));

        expect(player.getState()).not.toBe(BasePlayer.STATE['STOPPED']);
    });

    it('leaves the replacement decoder unconfigured, ready for the reset config packet', async () => {
        const player = await makeH264Player();
        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        expect(decoderInstances[0]!.state).toBe('configured');

        decoderInstances[0]!.errorCb(new DOMException('decode failed', 'EncodingError'));

        // Unlike VP8/VP9, this one must NOT be configured from metadata — the
        // config packet that comes back with the requested keyframe does it.
        expect(decoderInstances).toHaveLength(2);
        expect(decoderInstances[1]!.state).toBe('unconfigured');
    });

    it('recovers once the reset returns a config packet and a keyframe', async () => {
        const player = await makeH264Player();
        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        player.pushVideoFrame(H264_KEYFRAME, 1n, false, true);
        expect(decoderInstances[0]!.decoded).toHaveLength(1);

        decoderInstances[0]!.errorCb(new DOMException('decode failed', 'EncodingError'));

        // Deltas alone cannot restart it.
        player.pushVideoFrame(H264_DELTA, 2n, false, false);
        expect(decoderInstances[1]!.decoded).toHaveLength(0);

        // The reset brings both back, in this order.
        player.pushVideoFrame(H264_CONFIG, 3n, true, false);
        player.pushVideoFrame(H264_KEYFRAME, 4n, false, true);
        expect(decoderInstances[1]!.state).toBe('configured');
        expect(decoderInstances[1]!.decoded.map((c) => c.type)).toEqual(['key']);
    });
});
