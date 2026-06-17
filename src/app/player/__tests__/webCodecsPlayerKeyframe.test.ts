// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioural guard for finding #41: on a keyframe, WebCodecsPlayer must hand the
 * raw frame bytes to the decoder UNPREPENDED (the SPS/PPS now travel via the
 * VideoDecoderConfig.description set at configure() time), and the configure()
 * call must include that `description`.
 *
 * We stub the WebCodecs globals and the canvas 2d context so the player can be
 * instantiated and driven in jsdom without real WebCodecs support.
 */

type Chunk = { type: string; timestamp: number; data: Uint8Array };

let decodedChunks: Chunk[] = [];
let lastConfig: VideoDecoderConfig | undefined;
let decoderState: string;

class FakeVideoDecoder {
    public state = 'unconfigured';
    constructor(_init: unknown) {
        decoderState = 'unconfigured';
    }
    configure(cfg: VideoDecoderConfig) {
        lastConfig = cfg;
        this.state = 'configured';
        decoderState = 'configured';
    }
    decode(chunk: Chunk) {
        decodedChunks.push(chunk);
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
    constructor(init: Chunk) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        // Copy the bytes the player handed us so later buffer reuse can't rewrite history.
        this.data = new Uint8Array(init.data);
    }
}

// Minimal H.264 config frame (SPS NAL type 7 after the 00 00 00 01 start code).
const H264_CONFIG = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00, 1, 0x68, 0xce,
    0x3c, 0x80,
]);
// A keyframe payload that does NOT contain the SPS/PPS — proves we don't rely on prepend.
const H264_KEYFRAME = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0xcc, 0xdd]);

describe('WebCodecsPlayer keyframe decode (finding #41)', () => {
    beforeEach(() => {
        decodedChunks = [];
        lastConfig = undefined;
        decoderState = 'unconfigured';
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        // jsdom's canvas has no 2d context without the `canvas` pkg — stub it.
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: vi.fn(),
            clearRect: vi.fn(),
            fillRect: vi.fn(),
            measureText: () => ({ actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 }),
            fillText: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
        } as unknown as CanvasRenderingContext2D);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('configures with a description and decodes keyframe data unprepended', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);

        // Config frame: should drive a configure() carrying the SPS/PPS via description.
        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        expect(decoderState).toBe('configured');
        expect(lastConfig).toBeDefined();
        expect(lastConfig?.description).toBeInstanceOf(Uint8Array);
        expect(Array.from(lastConfig?.description as Uint8Array)).toEqual(Array.from(H264_CONFIG));

        // Keyframe: the chunk data must equal the raw keyframe bytes — NOT config+frame.
        player.pushVideoFrame(H264_KEYFRAME, 100n, false, true);
        expect(decodedChunks.length).toBe(1);
        const chunk = decodedChunks[0]!;
        expect(chunk.type).toBe('key');
        expect(chunk.data.length).toBe(H264_KEYFRAME.length); // would be longer if prepended
        expect(Array.from(chunk.data)).toEqual(Array.from(H264_KEYFRAME));
    });
});
