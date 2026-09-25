// src/server/StreamCongestion.ts
//
// Shed stream media when the browser is not keeping up.
//
// WHY THIS EXISTS. `ScrcpyConnection.sendChannel` used to call `ws.send()` for
// every packet and never looked at `ws.bufferedAmount`. A browser that stops
// reading (a stalled network, a frozen tab) therefore made the server buffer
// video in memory without limit: measured ~12.5 MB after 3 s with a raw client
// that stopped reading, growing for as long as the socket stayed OPEN.
//
// WHY SHED, NOT PAUSE. Pausing the device socket would push the backlog back to
// scrcpy-server and deliver it later, which for a live mirror means a picture
// that is seconds or minutes stale. Dropping media and restarting at a fresh
// keyframe keeps the picture live, at the cost of a visible skip.
//
// WHAT IS NEVER SHED. Config packets (tiny, and a decoder cannot start without
// one). Device messages and session packets do not pass through here at all.
//
// WHY RESUME AT A KEYFRAME. After a gap, the next delta frame refers to frames
// the browser never received and decodes as garbage. So once the backlog drains
// the caller asks the device for a keyframe (`TYPE_RESET_VIDEO`, the same reset
// #703 uses, which also brings a fresh config) and video resumes only when a
// keyframe arrives. Audio resumes as soon as the backlog drains: its packets
// decode independently.
//
// Pure: the caller passes `bufferedAmount` in, so the state machine is
// testable without a socket.

export type StreamFrameKind = 'config' | 'keyframe' | 'frame';
export type CongestionState = 'flowing' | 'congested' | 'awaiting-keyframe';

/** 4 MiB: about 4 s of scrcpy's default 8 Mb/s video. Past this the picture is already badly late. */
export const DEFAULT_HIGH_WATER = 4 * 1024 * 1024;
/** 1 MiB: resume only once the backlog is well clear of the mark, so the gate does not flap. */
export const DEFAULT_LOW_WATER = 1024 * 1024;

export type CongestionEvent =
    | { type: 'congested'; bufferedAmount: number }
    | { type: 'drained'; afterMs: number; videoShed: number; audioShed: number; peakBufferedAmount: number }
    | { type: 'resumed'; waitedMs: number; deltasSkipped: number };

export interface VideoDecision {
    send: boolean;
    /** Ask the device for a fresh keyframe now (once per drain). */
    requestKeyframe?: boolean;
    /** A state change worth one log line. */
    event?: CongestionEvent;
}

export interface StreamCongestionOptions {
    highWater?: number;
    lowWater?: number;
    now?: () => number;
}

export class StreamCongestion {
    private readonly highWater: number;
    private readonly lowWater: number;
    private readonly now: () => number;
    private current: CongestionState = 'flowing';
    private congestedAt = 0;
    private videoShed = 0;
    private audioShed = 0;
    private peak = 0;
    /** Delta frames dropped after the drain, waiting for a keyframe to resume on. */
    private deltasSkipped = 0;
    private drainedAt = 0;

    constructor(options: StreamCongestionOptions = {}) {
        this.highWater = options.highWater ?? DEFAULT_HIGH_WATER;
        this.lowWater = options.lowWater ?? DEFAULT_LOW_WATER;
        this.now = options.now ?? Date.now;
        if (!(this.lowWater < this.highWater)) {
            throw new Error(
                `StreamCongestion: lowWater (${this.lowWater}) must be below highWater (${this.highWater})`,
            );
        }
    }

    public get state(): CongestionState {
        return this.current;
    }

    /** Decide one video packet. `bufferedAmount` is the socket's unsent bytes right now. */
    public video(kind: StreamFrameKind, bufferedAmount: number): VideoDecision {
        const entered = this.update(bufferedAmount);
        if (kind === 'config') return { send: true, ...(entered ? { event: entered } : {}) };

        if (this.current === 'congested') {
            this.videoShed += 1;
            return { send: false, ...(entered ? { event: entered } : {}) };
        }
        if (this.current === 'awaiting-keyframe') {
            if (kind === 'keyframe') {
                this.current = 'flowing';
                return {
                    send: true,
                    event: {
                        type: 'resumed',
                        waitedMs: this.now() - this.drainedAt,
                        deltasSkipped: this.deltasSkipped,
                    },
                };
            }
            this.deltasSkipped += 1;
            // `entered` is the 'drained' event on the packet that caused it,
            // and that packet carries the one keyframe request.
            return entered ? { send: false, requestKeyframe: true, event: entered } : { send: false };
        }
        return { send: true };
    }

    /** Decide one audio packet. Shed only while congested; config always passes. */
    public audio(kind: StreamFrameKind, bufferedAmount: number): boolean {
        this.update(bufferedAmount);
        if (kind === 'config') return true;
        if (this.current === 'congested') {
            this.audioShed += 1;
            return false;
        }
        return true;
    }

    /** Apply the water marks. Returns the event for a transition made on this call. */
    private update(bufferedAmount: number): CongestionEvent | undefined {
        if (this.current === 'congested') {
            this.peak = Math.max(this.peak, bufferedAmount);
            if (bufferedAmount > this.lowWater) return undefined;
            this.current = 'awaiting-keyframe';
            this.drainedAt = this.now();
            this.deltasSkipped = 0;
            return {
                type: 'drained',
                afterMs: this.now() - this.congestedAt,
                videoShed: this.videoShed,
                audioShed: this.audioShed,
                peakBufferedAmount: this.peak,
            };
        }
        if (bufferedAmount <= this.highWater) return undefined;
        this.current = 'congested';
        this.congestedAt = this.now();
        this.videoShed = 0;
        this.audioShed = 0;
        this.peak = bufferedAmount;
        return { type: 'congested', bufferedAmount };
    }
}
