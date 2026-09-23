// src/server/StreamDiagnostics.ts
//
// Frame-path instrumentation for issue #703 ("redroid: black screen").
//
// WHY THIS EXISTS. A black screen has several causes that are indistinguishable
// from outside: the device never emitted a config packet for the session we
// started; it emitted one but nothing decodable followed; frames arrived and we
// dropped them; or the browser got them and failed to decode. Before this,
// every one of those produced the same observable — a connected session, no
// picture, and not one line in the log. The reporter was asked for logs that
// could not have contained the answer.
//
// DELIBERATELY PURE. No timers, no Logger, no sockets: it counts what it is
// told about and formats sentences. The caller owns when to ask and where the
// lines go, which is what makes the stall wording testable without waiting real
// seconds for it. `now` is injectable for the same reason.
//
// WHAT IT WILL NOT TELL YOU. Everything here is server-side, so it can prove
// frames reached the websocket and cannot prove the browser decoded them. A
// session showing healthy counts and a black picture localises the fault to the
// client, which is itself the answer to half the question.

export type FrameKind = 'config' | 'keyframe' | 'frame';

export interface StreamMetadataSummary {
    deviceName: string;
    videoCodec: string;
    screenWidth: number;
    screenHeight: number;
    audioCodec: string;
    videoEncoder?: string | undefined;
}

function human(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class StreamDiagnostics {
    private startedAt = 0;
    private readonly counts: Record<FrameKind, number> = { config: 0, keyframe: 0, frame: 0 };
    private readonly firstAt: Partial<Record<FrameKind, number>> = {};
    private bytes = 0;
    private dropped = 0;
    private droppedReported = false;
    private stallReported = false;
    private metadata?: StreamMetadataSummary;

    constructor(private readonly now: () => number = Date.now) {}

    /** Marks t0. Every elapsed figure below is relative to this. */
    start(): void {
        this.startedAt = this.now();
    }

    noteMetadata(meta: StreamMetadataSummary): string {
        this.metadata = meta;
        const enc = meta.videoEncoder ? ` encoder=${meta.videoEncoder}` : ' encoder=(device default)';
        return (
            `stream metadata: video=${meta.videoCodec} ${meta.screenWidth}x${meta.screenHeight}${enc} ` +
            `audio=${meta.audioCodec} device="${meta.deviceName}"`
        );
    }

    /**
     * Records one packet. Returns a line ONLY for the first of each kind —
     * per-frame logging at 60fps would bury the three events that matter, and
     * the first config and first keyframe are exactly the two that gate first
     * paint.
     */
    noteFrame(kind: FrameKind, byteLength: number): string | undefined {
        this.counts[kind] += 1;
        this.bytes += byteLength;
        if (this.firstAt[kind] !== undefined) {
            return undefined;
        }
        const elapsed = this.now() - this.startedAt;
        this.firstAt[kind] = elapsed;
        const label = kind === 'config' ? 'CONFIG packet' : kind === 'keyframe' ? 'KEYFRAME' : 'media frame';
        return `first ${label} after ${elapsed}ms (${human(byteLength)})`;
    }

    /**
     * A frame the server produced but could not forward because the websocket
     * was not OPEN. Reported once, with a count in the final summary: this used
     * to be a bare `return` and is the one failure mode that consumes frames
     * while leaving no trace at all.
     */
    noteDropped(readyState: number): string | undefined {
        this.dropped += 1;
        if (this.droppedReported) return undefined;
        this.droppedReported = true;
        return (
            `dropping stream data: websocket is not OPEN (readyState=${readyState}). ` +
            'frames are being produced and discarded; the browser will show nothing.'
        );
    }

    /**
     * Called once when the no-picture window expires. Names which of the
     * competing causes is actually in play rather than reporting "no video".
     * Returns undefined when the stream is healthy, or when it has already
     * reported — a stall is a state, and repeating it every tick would make the
     * log useless in exactly the session someone is trying to read.
     */
    stallReport(afterMs: number): string | undefined {
        if (this.stallReported) return undefined;
        const decodable = this.counts.config > 0 && (this.counts.keyframe > 0 || this.counts.frame > 0);
        if (decodable) return undefined;
        this.stallReported = true;

        const seen = `config=${this.counts.config} keyframe=${this.counts.keyframe} frame=${this.counts.frame} (${human(this.bytes)})`;
        if (this.counts.config === 0 && this.counts.keyframe === 0 && this.counts.frame === 0) {
            return (
                `NO VIDEO DATA after ${afterMs}ms: the session is open and scrcpy-server was started, but not one ` +
                'packet has arrived on the video socket. The device is not encoding for this session — suspect the ' +
                'capture/display path or the encoder refusing the requested configuration, not the transport.'
            );
        }
        if (this.counts.config === 0) {
            return (
                `NO CONFIG PACKET after ${afterMs}ms, but media packets ARE arriving (${seen}). Without SPS/PPS the ` +
                'browser cannot initialise a decoder, so the picture stays black while data flows. This is a device/' +
                'encoder behaviour, not a dropped connection.'
            );
        }
        return (
            `CONFIG PACKET BUT NO FRAMES after ${afterMs}ms (${seen}). The encoder described a stream and then ` +
            'produced none of it; the decoder is initialised and starved.'
        );
    }

    /**
     * Whether a keyframe request could still rescue this session (#703).
     *
     * TRUE only when NO config packet has been seen. That is the recoverable
     * shape: `TYPE_RESET_VIDEO` makes the device emit a fresh config packet
     * together with a keyframe (proven on hardware in `WebCodecsPlayer` —
     * h264 returned config at +180ms and keyframe at +188ms), so a stream with
     * no config is exactly the one a reset can fix.
     *
     * FALSE once config HAS arrived, even if frames are starved. That session
     * has a configured decoder and is short of pictures, which a reset does not
     * address — and resetting it would discard a working decoder to chase a
     * different problem.
     */
    canRecoverWithKeyframeRequest(): boolean {
        return this.counts.config === 0;
    }

    /** End-of-session line. Written whether or not anything went wrong. */
    summary(): string {
        const el = (k: FrameKind) => (this.firstAt[k] === undefined ? 'never' : `${this.firstAt[k]}ms`);
        const total = this.now() - this.startedAt;
        const drops = this.dropped > 0 ? ` dropped=${this.dropped}` : '';
        const codec = this.metadata ? ` codec=${this.metadata.videoCodec}` : '';
        return (
            `stream summary after ${total}ms:${codec} config=${this.counts.config} keyframe=${this.counts.keyframe} ` +
            `frame=${this.counts.frame} total=${human(this.bytes)}${drops} ` +
            `(first config ${el('config')}, first keyframe ${el('keyframe')}, first frame ${el('frame')})`
        );
    }

    /** Test/inspection accessor — the numbers behind the sentences. */
    snapshot(): { config: number; keyframe: number; frame: number; bytes: number; dropped: number } {
        return { ...this.counts, bytes: this.bytes, dropped: this.dropped };
    }
}
