// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Register finding 8.14 — a session can deliver video the browser never
 * decodes, and nothing reports it.
 *
 * Witnessed on a failing smoke row 8.1: the stream socket carried
 * `{"messages":5782,"bytes":20688483,"closed":null}`, `decoded frames 0 -> 0`,
 * and the canvas was still at its untouched 300x150 default. So
 * `VideoDecoder.configure` never ran — and because the decode watchdog is armed
 * only *after* configure, the one mechanism meant to report a mute stream never
 * started. The user saw a `Connected:` line, then silence, then a black
 * rectangle. The failure was silent by construction.
 *
 * `parseConfig` returning null is the path that produces exactly this: no
 * configure, no watchdog, `configData` set anyway, and every later frame
 * dropped by the `decoder.state !== 'configured'` guard, forever, in silence.
 */

class FakeVideoDecoder {
    public state = 'unconfigured';
    configure() {
        this.state = 'configured';
    }
    decode() {}
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

// Annex B start code followed by NAL type 1 (a non-IDR slice) — a packet the
// demuxer flagged as config but which carries no SPS, so parseConfig returns
// null. This is the shape that produced the witnessed failure.
const CONFIG_WITHOUT_SPS = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0x00, 0x10, 0x20, 0x30]);
const A_DELTA_FRAME = new Uint8Array([0, 0, 0, 1, 0x41, 0x11, 0x22, 0x33]);

const WELL_PAST_THE_DEADLINE_MS = 30_000;

describe('WebCodecsPlayer — video arrives, nothing configures', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
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
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function errorMessages(): string[] {
        return errorSpy.mock.calls.map((args: unknown[]) => args.map(String).join(' '));
    }

    it('reports a session that starts and never configures a decoder', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-unconfigured-1');
        player.setMetadataSize(1080, 1920);
        // Session start — the point after which video is expected to flow.
        player.setSessionInfo('h264', 'opus');

        // Megabytes of video, none of it decodable, exactly as witnessed.
        player.pushVideoFrame(CONFIG_WITHOUT_SPS, 0n, true, false);
        for (let i = 0; i < 200; i++) {
            player.pushVideoFrame(A_DELTA_FRAME, BigInt(i * 33_000), false, false);
        }
        // The parse rejection is reported at once (that is the second test);
        // what must NOT have fired yet is the watchdog.
        expect(errorMessages().filter((m) => /never configured/i.test(m))).toHaveLength(0);

        vi.advanceTimersByTime(WELL_PAST_THE_DEADLINE_MS);

        const reported = errorMessages().filter((m) => /never configured|no config/i.test(m));
        expect(reported.length).toBeGreaterThan(0);
    });

    it('says why the config packet was rejected instead of dropping it silently', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-unconfigured-2');
        player.setMetadataSize(1080, 1920);
        player.setSessionInfo('h264', 'opus');

        player.pushVideoFrame(CONFIG_WITHOUT_SPS, 0n, true, false);

        // Immediately, not on a 5 s timer: the parse already failed.
        const parseComplaints = errorMessages().filter((m) => /config/i.test(m));
        expect(parseComplaints.length).toBeGreaterThan(0);
    });

    it('stays quiet on a session that configures normally', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-unconfigured-3');
        player.setMetadataSize(1280, 720);
        player.setSessionInfo('h264', 'opus');

        // A real H.264 config packet (SPS, NAL type 7).
        const h264Config = new Uint8Array([
            0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00, 1,
            0x68, 0xce, 0x3c, 0x80,
        ]);
        player.pushVideoFrame(h264Config, 0n, true, false);

        const unconfiguredComplaints = errorMessages().filter((m) => /never configured|no config/i.test(m));
        expect(unconfiguredComplaints).toHaveLength(0);
    });
});
