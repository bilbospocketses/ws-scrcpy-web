import { describe, expect, it } from 'vitest';
import { StreamDiagnostics } from '../StreamDiagnostics';

// #703 frame-path instrumentation.
//
// These assert the WORDING, not just that a string came back, because the
// whole point of the class is to tell three indistinguishable failures apart
// in someone else's log. A stall report that fires correctly but says "no
// video" for all three cases would pass a truthiness test and be worthless in
// the issue it exists for.
//
// `now` is injected so the elapsed figures are exact and the stall cases need
// no real waiting.

function atTimes(...times: number[]): () => number {
    let i = 0;
    return () => times[Math.min(i++, times.length - 1)]!;
}

const META = {
    deviceName: 'redroid13',
    videoCodec: 'h264',
    screenWidth: 1280,
    screenHeight: 720,
    audioCodec: 'opus',
};

describe('StreamDiagnostics', () => {
    it('reports the first of each kind once, with elapsed time, and nothing after', () => {
        const d = new StreamDiagnostics(atTimes(1000, 1240, 1300, 1310, 1320));
        d.start();

        expect(d.noteFrame('config', 37)).toBe('first CONFIG packet after 240ms (37 B)');
        expect(d.noteFrame('keyframe', 12400)).toBe('first KEYFRAME after 300ms (12.1 kB)');
        // Second of the same kind is silent — per-frame logging would bury the
        // two events that gate first paint.
        expect(d.noteFrame('config', 37)).toBeUndefined();
        expect(d.noteFrame('keyframe', 900)).toBeUndefined();

        expect(d.snapshot()).toEqual({ config: 2, keyframe: 2, frame: 0, bytes: 13374, dropped: 0 });
    });

    // The three stall cases are the reason this class exists: each names a
    // different component, and picking the wrong one sends the next
    // investigation to the wrong place.
    it('distinguishes NO VIDEO DATA from a transport problem', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        const line = d.stallReport(8000);
        expect(line).toContain('NO VIDEO DATA after 8000ms');
        expect(line).toContain('not one packet has arrived on the video socket');
        expect(line).toContain('not the transport');
    });

    it('distinguishes a missing CONFIG packet from a dead stream', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('frame', 500);
        d.noteFrame('frame', 500);
        const line = d.stallReport(8000);
        expect(line).toContain('NO CONFIG PACKET after 8000ms');
        expect(line).toContain('media packets ARE arriving');
        expect(line).toContain('config=0 keyframe=0 frame=2');
        // The distinguishing claim: data is flowing, so this is not a dropped
        // connection — the exact wrong turn #703 could otherwise take.
        expect(line).toContain('not a dropped connection');
    });

    it('distinguishes a starved decoder from a missing config', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('config', 37);
        const line = d.stallReport(8000);
        expect(line).toContain('CONFIG PACKET BUT NO FRAMES after 8000ms');
        expect(line).toContain('initialised and starved');
    });

    it('stays SILENT when the stream is healthy', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('config', 37);
        d.noteFrame('keyframe', 9000);
        expect(d.stallReport(8000)).toBeUndefined();
    });

    it('a config packet alone is not healthy, and a frame alone is not either', () => {
        // Guards the `config > 0 && (keyframe > 0 || frame > 0)` predicate in
        // both directions — a one-sided check would call each of these fine.
        const onlyConfig = new StreamDiagnostics(() => 0);
        onlyConfig.start();
        onlyConfig.noteFrame('config', 37);
        expect(onlyConfig.stallReport(8000)).toBeDefined();

        const onlyFrame = new StreamDiagnostics(() => 0);
        onlyFrame.start();
        onlyFrame.noteFrame('frame', 500);
        expect(onlyFrame.stallReport(8000)).toBeDefined();
    });

    it('reports a stall once — a state, not an event', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        expect(d.stallReport(8000)).toBeDefined();
        expect(d.stallReport(8000)).toBeUndefined();
    });

    it('reports dropped data once and keeps counting it', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        const line = d.noteDropped(2);
        expect(line).toContain('websocket is not OPEN (readyState=2)');
        expect(line).toContain('produced and discarded');
        expect(d.noteDropped(2)).toBeUndefined();
        expect(d.noteDropped(2)).toBeUndefined();
        expect(d.snapshot().dropped).toBe(3);
    });

    it('names the encoder, or says explicitly that the device chose', () => {
        const d = new StreamDiagnostics(() => 0);
        const chosen = d.noteMetadata({ ...META, videoEncoder: 'c2.android.avc.encoder' });
        expect(chosen).toContain('video=h264 1280x720 encoder=c2.android.avc.encoder');
        expect(chosen).toContain('device="redroid13"');

        const def = new StreamDiagnostics(() => 0).noteMetadata(META);
        // Not blank: "no encoder line" and "we did not ask for one" look the
        // same in a log otherwise.
        expect(def).toContain('encoder=(device default)');
    });

    it('summarises a healthy session and a black one differently', () => {
        const healthy = new StreamDiagnostics(atTimes(0, 100, 200, 5000));
        healthy.start();
        healthy.noteMetadata(META);
        healthy.noteFrame('config', 37);
        healthy.noteFrame('keyframe', 9000);
        const h = healthy.summary();
        expect(h).toContain('codec=h264');
        expect(h).toContain('config=1 keyframe=1 frame=0');
        expect(h).toContain('first config 100ms');

        const black = new StreamDiagnostics(atTimes(0, 5000));
        black.start();
        const b = black.summary();
        expect(b).toContain('config=0 keyframe=0 frame=0 total=0 B');
        // "never" rather than an absent field: a missing number reads as a
        // logging gap, which is what this whole change is fixing.
        expect(b).toContain('first config never');
        expect(b).toContain('first keyframe never');
    });

    it('includes the drop count in the summary only when something was dropped', () => {
        const clean = new StreamDiagnostics(() => 0);
        clean.start();
        expect(clean.summary()).not.toContain('dropped=');

        const lossy = new StreamDiagnostics(() => 0);
        lossy.start();
        lossy.noteDropped(3);
        expect(lossy.summary()).toContain('dropped=1');
    });
});

// #703 config-recovery gate. `TYPE_RESET_VIDEO` makes the device emit a fresh
// config packet WITH the keyframe, so it rescues a stream that never got
// SPS/PPS — and does nothing for a stream that has a configured decoder and is
// merely short of frames. Getting this predicate backwards would either miss
// the case the feature exists for, or throw away a working decoder.
describe('StreamDiagnostics.canRecoverWithKeyframeRequest', () => {
    it('is TRUE when nothing has arrived at all', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        expect(d.canRecoverWithKeyframeRequest()).toBe(true);
    });

    it('is TRUE when media frames arrive but no config — the #703 shape', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('frame', 500);
        d.noteFrame('frame', 500);
        expect(d.canRecoverWithKeyframeRequest()).toBe(true);
    });

    it('is FALSE once a config packet has arrived, even with no frames', () => {
        // A configured decoder that is starved is a different problem, and a
        // reset would discard the decoder to chase it.
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('config', 37);
        expect(d.canRecoverWithKeyframeRequest()).toBe(false);
    });

    it('is FALSE on a healthy stream', () => {
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('config', 37);
        d.noteFrame('keyframe', 9000);
        expect(d.canRecoverWithKeyframeRequest()).toBe(false);
    });

    it('flips to FALSE as soon as config arrives, so a retry loop stops on its own', () => {
        // This is what bounds the retry in practice: the caller re-checks, and
        // a successful reset ends the sequence without needing the attempt cap.
        const d = new StreamDiagnostics(() => 0);
        d.start();
        d.noteFrame('frame', 500);
        expect(d.canRecoverWithKeyframeRequest()).toBe(true);
        d.noteFrame('config', 37);
        expect(d.canRecoverWithKeyframeRequest()).toBe(false);
    });
});
