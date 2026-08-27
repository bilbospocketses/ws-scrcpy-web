// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VP8/VP9 are the only codecs whose decoder is configured from session metadata
 * instead of from a config packet.
 *
 * (An earlier version of this comment said they send no config packet at all.
 * They do — 12 bytes, just ahead of the first keyframe — but it carries no
 * parameter sets we can turn into a `VideoDecoderConfig.description`, so
 * `parseConfig` returns null and the config branch configures nothing. See
 * `CONFIGLESS_CODECS`.)
 *
 * That breaks two assumptions the player made before VP8/VP9 support:
 *   1. the decoder is configured inside the `isConfig` branch, which never runs;
 *   2. `configData` is the readiness gate for decoding keyframes, and it stays
 *      unset — so every frame was dropped.
 *
 * These tests pin both halves of the fix, plus the H.264 path they must not
 * disturb.
 */

type Chunk = { type: string; timestamp: number; data: Uint8Array };

let decodedChunks: Chunk[] = [];
let lastConfig: VideoDecoderConfig | undefined;
let configureCalls = 0;

class FakeVideoDecoder {
    public state = 'unconfigured';
    configure(cfg: VideoDecoderConfig) {
        lastConfig = cfg;
        configureCalls += 1;
        this.state = 'configured';
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
        this.data = new Uint8Array(init.data);
    }
}

const VP_KEYFRAME = new Uint8Array([0x82, 0x49, 0x83, 0x42, 0x00, 0x11, 0x22, 0x33]);
const VP_DELTA = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

describe('WebCodecsPlayer VP8/VP9 (config-less codecs)', () => {
    beforeEach(() => {
        decodedChunks = [];
        lastConfig = undefined;
        configureCalls = 0;
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
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('configures the decoder from session metadata for vp9', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1080, 2400);
        player.setSessionInfo('vp9', 'opus');

        expect(configureCalls).toBe(1);
        expect(lastConfig?.codec).toBe('vp09.00.10.08');
        expect(lastConfig?.codedWidth).toBe(1080);
        expect(lastConfig?.codedHeight).toBe(2400);
        // No parameter sets exist for VP8/VP9 — description must not be set.
        expect(lastConfig?.description).toBeUndefined();
    });

    it('configures the decoder from session metadata for vp8', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);
        player.setSessionInfo('vp8', 'opus');

        expect(configureCalls).toBe(1);
        expect(lastConfig?.codec).toBe('vp8');
        expect(lastConfig?.description).toBeUndefined();
    });

    it('decodes a keyframe that arrives with no preceding config packet', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);
        player.setSessionInfo('vp9', 'opus');

        // isConfig=false, isKeyframe=true — the only shape VP8/VP9 ever produce.
        player.pushVideoFrame(VP_KEYFRAME, 0n, false, true);

        expect(decodedChunks).toHaveLength(1);
        expect(decodedChunks[0]?.type).toBe('key');
        expect(Array.from(decodedChunks[0]?.data as Uint8Array)).toEqual(Array.from(VP_KEYFRAME));
    });

    it('decodes delta frames once a keyframe has been seen', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);
        player.setSessionInfo('vp9', 'opus');

        player.pushVideoFrame(VP_KEYFRAME, 0n, false, true);
        player.pushVideoFrame(VP_DELTA, 1n, false, false);

        expect(decodedChunks).toHaveLength(2);
        expect(decodedChunks[1]?.type).toBe('delta');
    });

    it('drops delta frames that arrive before the first keyframe', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);
        player.setSessionInfo('vp9', 'opus');

        player.pushVideoFrame(VP_DELTA, 0n, false, false);

        expect(decodedChunks).toHaveLength(0);
    });

    it('does not configure up front for codecs that do send a config packet', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);
        player.setSessionInfo('h264', 'opus');

        // H.264 must still wait for its SPS/PPS config frame.
        expect(configureCalls).toBe(0);
    });
});
