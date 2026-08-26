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
        // description must be a real avcC box (configurationVersion=1 header), not the
        // raw Annex B config bytes — WebCodecs rejects Annex B start codes there.
        const desc = lastConfig?.description as Uint8Array;
        expect(desc[0]).toBe(1); // configurationVersion
        expect(Array.from(desc)).not.toEqual(Array.from(H264_CONFIG));
        const { buildAvcCBox, parseSPS, stripEmulationPrevention } = await import('../h264-utils');
        // H264_CONFIG's SPS trailing zeros and the PPS start code overlap (00 00
        // 00 | 00 00 00 01); the scanner attributes all 3 shared zeros to the
        // start code, so the extracted SPS ends at index 16, not 19.
        const sps = Uint8Array.from(H264_CONFIG.subarray(4, 16));
        const pps = Uint8Array.from(H264_CONFIG.subarray(20));
        expect(Array.from(desc)).toEqual(
            Array.from(buildAvcCBox([sps], [pps], parseSPS(stripEmulationPrevention(sps)))),
        );

        // Keyframe: the chunk data must be the keyframe's NAL re-framed with a
        // 4-byte length prefix (matching the avcC's lengthSizeMinusOne=3) — NOT
        // config+frame, and NOT the raw Annex B start code either.
        player.pushVideoFrame(H264_KEYFRAME, 100n, false, true);
        expect(decodedChunks.length).toBe(1);
        const chunk = decodedChunks[0]!;
        expect(chunk.type).toBe('key');
        // H264_KEYFRAME's single 5-byte NAL (0x65,0xaa,0xbb,0xcc,0xdd) length-prefixed.
        expect(Array.from(chunk.data)).toEqual([0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd]);
    });
});
