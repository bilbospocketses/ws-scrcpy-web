// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Item 24 — live rotation.
 *
 * scrcpy v4 announces a rotation or resize with a session packet on the video
 * socket, which the server now forwards on ChannelId.SESSION. The player's job
 * is to treat those dimensions as the new display geometry.
 *
 * The bug this pins: `pushVideoFrame`'s config branch computes
 *
 *     const displayW = this.metadataWidth || result.width;
 *
 * and `metadataWidth` came from the opening METADATA, a snapshot of the capture
 * at connect time. It is always truthy, so it always beat the post-rotation SPS
 * and the canvas plus the ScreenInfo behind the touch mapping stayed pinned to
 * the pre-rotation size — the picture stretched and every tap landed in the
 * wrong place until the user reconnected.
 *
 * It cannot be fixed by preferring the SPS instead: scrcpy-server rejects touch
 * events whose screenSize does not match its video size, and SPS dimensions
 * carry alignment padding (1088 for 1080). The session packet is the only
 * source that agrees with scrcpy's own notion of the video size.
 */

type Chunk = { type: string; timestamp: number; data: Uint8Array };

class FakeVideoDecoder {
    public state = 'unconfigured';
    configure(_cfg: VideoDecoderConfig) {
        this.state = 'configured';
    }
    decode(_chunk: Chunk) {}
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

// Minimal H.264 config frame (SPS NAL type 7 after the 00 00 00 01 start code),
// the same fixture the keyframe test uses. Its own SPS dimensions are
// deliberately irrelevant here — display sizing never reads them while a
// metadata size is known, which is exactly the behaviour under test.
const H264_CONFIG = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00, 1, 0x68, 0xce,
    0x3c, 0x80,
]);

const PORTRAIT = { width: 1080, height: 2400 };
const LANDSCAPE = { width: 2400, height: 1080 };

describe('WebCodecsPlayer live rotation (item 24)', () => {
    beforeEach(() => {
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

    async function portraitPlayer() {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-rotation');
        player.setMetadataSize(PORTRAIT.width, PORTRAIT.height);
        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        return player;
    }

    it('starts out sized by the opening metadata', async () => {
        const player = await portraitPlayer();

        const rect = player.getScreenInfo()?.contentRect;
        expect(rect?.right).toBe(PORTRAIT.width);
        expect(rect?.bottom).toBe(PORTRAIT.height);
    });

    it('moves the touch mapping to the new geometry on rotation', async () => {
        const player = await portraitPlayer();

        player.onSourceResize(LANDSCAPE.width, LANDSCAPE.height);

        // FeaturedInteractionHandler.onInteraction maps every tap through
        // player.getScreenInfo(), so this IS the touch assertion: a stale
        // contentRect sends taps to the wrong coordinates on a screen that
        // otherwise looks correct.
        const rect = player.getScreenInfo()?.contentRect;
        expect(rect?.right).toBe(LANDSCAPE.width);
        expect(rect?.bottom).toBe(LANDSCAPE.height);
    });

    it('resizes the canvas on rotation', async () => {
        const player = await portraitPlayer();

        player.onSourceResize(LANDSCAPE.width, LANDSCAPE.height);

        const canvas = player.getTouchableElement();
        expect(canvas.width).toBe(LANDSCAPE.width);
        expect(canvas.height).toBe(LANDSCAPE.height);
    });

    it('does not let the stale opening metadata win the config packet that follows a rotation', async () => {
        const player = await portraitPlayer();

        // The realistic sequence: session packet, then the restarted encoder's
        // fresh config packet. Before item 24 the second step undid the first,
        // because the config branch preferred the opening metadata size.
        player.onSourceResize(LANDSCAPE.width, LANDSCAPE.height);
        player.pushVideoFrame(H264_CONFIG, 100n, true, false);

        const rect = player.getScreenInfo()?.contentRect;
        expect(rect?.right).toBe(LANDSCAPE.width);
        expect(rect?.bottom).toBe(LANDSCAPE.height);
    });

    it('ignores a resize to nonsense rather than blanking the canvas', async () => {
        const player = await portraitPlayer();

        player.onSourceResize(0, 0);

        const rect = player.getScreenInfo()?.contentRect;
        expect(rect?.right).toBe(PORTRAIT.width);
        expect(rect?.bottom).toBe(PORTRAIT.height);
    });
});
