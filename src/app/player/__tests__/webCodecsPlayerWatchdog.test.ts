// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guard for issue #498: a decoder that configures cleanly, accepts every chunk,
 * and then never emits a frame used to fail completely silently — no error
 * callback, no console output, just a black canvas forever. That shape cost
 * three round trips with a reporter to identify.
 *
 * The `error` callback already covers decoders that fault. These tests cover
 * the other shape: configured, fed, and mute.
 */

type DecoderInit = {
    output: (frame: unknown) => void;
    error: (error: unknown) => void;
};

let capturedInit: DecoderInit | undefined;

class FakeVideoDecoder {
    public state = 'unconfigured';
    constructor(init: DecoderInit) {
        capturedInit = init;
    }
    configure() {
        this.state = 'configured';
    }
    decode() {
        /* accepts everything, emits nothing */
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

// Minimal H.264 config frame (SPS NAL type 7 after the 00 00 00 01 start code).
const H264_CONFIG = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00, 1, 0x68, 0xce,
    0x3c, 0x80,
]);

const WELL_PAST_THE_DEADLINE_MS = 30_000;

function fakeFrame() {
    return { displayWidth: 1280, displayHeight: 720, codedWidth: 1280, codedHeight: 720, close: vi.fn() };
}

describe('WebCodecsPlayer decode watchdog (issue #498)', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        capturedInit = undefined;
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
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function watchdogMessages(): string[] {
        return errorSpy.mock.calls
            .map((args: unknown[]) => args.map(String).join(' '))
            .filter((message: string) => message.includes('no frames'));
    }

    it('reports a decoder that configures but never produces a frame', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-watchdog-1');
        player.setMetadataSize(1280, 720);

        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        expect(watchdogMessages()).toHaveLength(0);

        vi.advanceTimersByTime(WELL_PAST_THE_DEADLINE_MS);

        const messages = watchdogMessages();
        expect(messages).toHaveLength(1);
        // The message has to be actionable, not just "something went wrong".
        expect(messages[0]).toMatch(/h264/i);
        expect(messages[0]).toMatch(/codec|browser/i);
    });

    it('stays quiet when a frame arrives before the deadline', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-watchdog-2');
        player.setMetadataSize(1280, 720);

        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        capturedInit?.output(fakeFrame());

        vi.advanceTimersByTime(WELL_PAST_THE_DEADLINE_MS);
        expect(watchdogMessages()).toHaveLength(0);
    });

    it('stays quiet when the stream is stopped before the deadline', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-watchdog-3');
        player.setMetadataSize(1280, 720);

        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        player.stop();

        vi.advanceTimersByTime(WELL_PAST_THE_DEADLINE_MS);
        expect(watchdogMessages()).toHaveLength(0);
    });

    it('reports once, not once per config frame', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-watchdog-4');
        player.setMetadataSize(1280, 720);

        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        player.pushVideoFrame(H264_CONFIG, 0n, true, false);

        vi.advanceTimersByTime(WELL_PAST_THE_DEADLINE_MS);
        expect(watchdogMessages()).toHaveLength(1);
    });
});
