import { describe, expect, it } from 'vitest';
import { describeEffectiveOptions, serializeOptions } from '../ScrcpyOptions';

describe('serializeOptions — audio_source / audio_dup', () => {
    it('emits audio_source=playback + audio_dup=true when using playback with dup', () => {
        const args = serializeOptions({ scid: 'abc', audioSource: 'playback', audioDup: true });
        expect(args).toContain('audio_source=playback');
        expect(args).toContain('audio_dup=true');
    });

    it('emits audio_source=mic without audio_dup', () => {
        const args = serializeOptions({ scid: 'abc', audioSource: 'mic' });
        expect(args).toContain('audio_source=mic');
        expect(args.some((a) => a.startsWith('audio_dup'))).toBe(false);
    });

    it('omits audio_source when it matches scrcpy default (output)', () => {
        const args = serializeOptions({ scid: 'abc', audioSource: 'output' });
        expect(args.some((a) => a.startsWith('audio_source'))).toBe(false);
    });

    it('omits audio_dup when false (scrcpy default)', () => {
        const args = serializeOptions({ scid: 'abc', audioDup: false });
        expect(args.some((a) => a.startsWith('audio_dup'))).toBe(false);
    });
});

describe('serializeOptions — scid + base fields still work', () => {
    it('always emits scid last', () => {
        const args = serializeOptions({ scid: 'deadbeef' });
        expect(args[args.length - 1]).toBe('scid=deadbeef');
    });

    it('omits video_codec when it matches default (h264)', () => {
        const args = serializeOptions({ scid: 's', videoCodec: 'h264' });
        expect(args.some((a) => a.startsWith('video_codec'))).toBe(false);
    });

    it('emits video_codec when non-default (h265)', () => {
        const args = serializeOptions({ scid: 's', videoCodec: 'h265' });
        expect(args).toContain('video_codec=h265');
    });

    it('emits audio=false when disabled', () => {
        const args = serializeOptions({ scid: 's', audio: false });
        expect(args).toContain('audio=false');
    });

    it('emits video_encoder flag when set (separate code path)', () => {
        const args = serializeOptions({ scid: 's', videoEncoder: 'c2.qti.hevc.encoder' });
        expect(args).toContain('video_encoder=c2.qti.hevc.encoder');
    });
});

// #703: the effective-configuration line. `serializeOptions` deliberately omits
// anything left at its default, which is right for the argument list and wrong
// for a log meant to answer "do our settings differ from desktop scrcpy?" —
// measured against a live session, a default config serialized to exactly
// `scid=<hex>`.
describe('describeEffectiveOptions', () => {
    it('names every setting even when nothing was overridden', () => {
        const line = describeEffectiveOptions({ scid: 'abc' });
        // The three a black-screen report actually turns on.
        expect(line).toContain('video_codec=h264');
        expect(line).toContain('video_bit_rate=8000000');
        expect(line).toContain('max_fps=0');
        expect(line).toContain('video_encoder=(device default)');
        expect(line).toContain('video_codec_options=(none)');
        // Nothing was set explicitly, so nothing is starred.
        expect(line).not.toContain('*');
    });

    it('stars only the values this session set explicitly', () => {
        const line = describeEffectiveOptions({
            scid: 'abc',
            videoCodec: 'vp9',
            videoCodecOptions: 'i-frame-interval:int=2',
        });
        expect(line).toContain('video_codec=vp9*');
        expect(line).toContain('video_codec_options=i-frame-interval:int=2*');
        // Untouched neighbours stay unstarred, or the marker means nothing.
        expect(line).toContain('audio_codec=opus');
        expect(line).not.toContain('audio_codec=opus*');
    });

    it('does not star a value that merely equals the default', () => {
        // Passing h264 explicitly is not a deviation from desktop scrcpy, and
        // marking it would send a reader looking at the wrong field.
        const line = describeEffectiveOptions({ scid: 'abc', videoCodec: 'h264' });
        expect(line).toContain('video_codec=h264');
        expect(line).not.toContain('video_codec=h264*');
    });

    it('carries the settings serializeOptions drops, which is the whole point', () => {
        const opts = { scid: 'abc' } as const;
        expect(serializeOptions(opts)).toEqual(['scid=abc']);
        const line = describeEffectiveOptions(opts);
        expect(line.split(' ').length).toBeGreaterThan(10);
    });
});
