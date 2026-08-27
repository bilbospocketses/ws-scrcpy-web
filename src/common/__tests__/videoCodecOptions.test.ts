import { describe, expect, it } from 'vitest';
import { applyStreamParams, buildVideoCodecOptions } from '../StreamUrlParams';

/**
 * The advanced settings collected an i-frame interval and a free-form codec
 * options string, stored both in `VideoSettings`, and then never sent them:
 * `applyStreamParams` had no field for either. The codec-options box — which
 * is scrcpy's documented escape hatch for arbitrary `MediaFormat` keys — did
 * nothing whatsoever.
 *
 * scrcpy has no dedicated argument for the keyframe interval; it travels as a
 * codec option, so the two UI fields have to merge into the one value scrcpy
 * accepts. That merge is what these tests pin.
 *
 * ⚠️ Deliberately NOT claimed here: that sending the interval changes keyframe
 * cadence. It does not, measurably — see `buildVideoCodecOptions` for the
 * evidence and the reason (I-frame ≠ IDR frame).
 */

describe('buildVideoCodecOptions', () => {
    it('turns an interval into a MediaFormat codec option', () => {
        expect(buildVideoCodecOptions(2, undefined)).toBe('i-frame-interval:int=2');
    });

    it('passes user codec options through untouched', () => {
        expect(buildVideoCodecOptions(undefined, 'profile:int=8')).toBe('profile:int=8');
    });

    it('merges the interval with user options', () => {
        expect(buildVideoCodecOptions(2, 'profile:int=8')).toBe('i-frame-interval:int=2,profile:int=8');
    });

    it('lets an explicit user i-frame-interval win, without emitting the key twice', () => {
        // Typing the key by hand is a deliberate override of the slider, and
        // scrcpy would have no way to resolve the key appearing twice.
        const result = buildVideoCodecOptions(2, 'i-frame-interval:int=10');
        expect(result).toBe('i-frame-interval:int=10');
        expect(result?.match(/i-frame-interval/g)).toHaveLength(1);
    });

    it('still merges when the user sets a different key that merely contains the name', () => {
        const result = buildVideoCodecOptions(2, 'my-i-frame-interval-ish:int=1');
        expect(result).toBe('i-frame-interval:int=2,my-i-frame-interval-ish:int=1');
    });

    it('returns undefined when there is nothing to send', () => {
        expect(buildVideoCodecOptions(undefined, undefined)).toBeUndefined();
        expect(buildVideoCodecOptions(0, '')).toBeUndefined();
    });

    it('ignores a nonsensical interval rather than sending it', () => {
        expect(buildVideoCodecOptions(-1, undefined)).toBeUndefined();
        expect(buildVideoCodecOptions(Number.NaN, undefined)).toBeUndefined();
    });

    it('rounds a fractional interval, since MediaFormat wants an int', () => {
        expect(buildVideoCodecOptions(2.4, undefined)).toBe('i-frame-interval:int=2');
        expect(buildVideoCodecOptions(2.6, undefined)).toBe('i-frame-interval:int=3');
    });

    it('trims surrounding whitespace from user options', () => {
        expect(buildVideoCodecOptions(undefined, '  profile:int=8  ')).toBe('profile:int=8');
    });
});

describe('applyStreamParams video codec options', () => {
    const url = () => new URL('ws://localhost:8001/');

    it('sends the i-frame interval that the UI collected', () => {
        const u = url();
        applyStreamParams(u, { udid: 'dev' }, { iFrameInterval: 2 });
        expect(u.searchParams.get('videoCodecOptions')).toBe('i-frame-interval:int=2');
    });

    it('sends nothing when the settings carry neither', () => {
        const u = url();
        applyStreamParams(u, { udid: 'dev' }, { bitrate: 8000000 });
        expect(u.searchParams.has('videoCodecOptions')).toBe(false);
    });

    it('leaves the existing params alone', () => {
        const u = url();
        applyStreamParams(u, { udid: 'dev', videoCodec: 'vp9' }, { bitrate: 8000000, maxFps: 15, iFrameInterval: 2 });
        expect(u.searchParams.get('udid')).toBe('dev');
        expect(u.searchParams.get('videoCodec')).toBe('vp9');
        expect(u.searchParams.get('bitrate')).toBe('8000000');
        expect(u.searchParams.get('maxFps')).toBe('15');
        expect(u.searchParams.get('videoCodecOptions')).toBe('i-frame-interval:int=2');
    });
});
