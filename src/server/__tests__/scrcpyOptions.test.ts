import { describe, expect, it } from 'vitest';
import { serializeOptions } from '../ScrcpyOptions';

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
