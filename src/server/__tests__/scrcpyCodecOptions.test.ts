import { describe, expect, it } from 'vitest';
import { serializeOptions } from '../ScrcpyOptions';
import { scrcpyOptionsFromQuery } from '../scrcpyOptionsFromQuery';
import { isSafeCodecOptions } from '../security/deviceInput';

/**
 * `videoCodecOptions` is browser input that ends up inside the
 * `CLASSPATH=... app_process ...` string executed via `adb shell`, exactly like
 * `videoEncoder`. It is allowlisted rather than escaped, so the allowlist is
 * the security boundary and gets tested as one.
 */

describe('isSafeCodecOptions', () => {
    it('accepts the shapes scrcpy actually takes', () => {
        expect(isSafeCodecOptions('i-frame-interval:int=2')).toBe(true);
        expect(isSafeCodecOptions('i-frame-interval:int=2,profile:int=8')).toBe(true);
        expect(isSafeCodecOptions('bitrate-mode:int=1')).toBe(true);
        expect(isSafeCodecOptions('some_key:string=baseline')).toBe(true);
    });

    it('rejects shell metacharacters', () => {
        expect(isSafeCodecOptions('a:int=1; rm -rf /')).toBe(false);
        expect(isSafeCodecOptions('a:int=$(id)')).toBe(false);
        expect(isSafeCodecOptions('a:int=`id`')).toBe(false);
        expect(isSafeCodecOptions("a:int=1'")).toBe(false);
        expect(isSafeCodecOptions('a:int=1 && whoami')).toBe(false);
        expect(isSafeCodecOptions('a:int=1|tee /tmp/x')).toBe(false);
        expect(isSafeCodecOptions('a:int=1\nb:int=2')).toBe(false);
    });

    it('rejects empty, non-string and over-long values', () => {
        expect(isSafeCodecOptions('')).toBe(false);
        expect(isSafeCodecOptions(undefined)).toBe(false);
        expect(isSafeCodecOptions(42)).toBe(false);
        expect(isSafeCodecOptions(`a:int=${'1'.repeat(300)}`)).toBe(false);
    });
});

describe('scrcpyOptionsFromQuery videoCodecOptions', () => {
    const q = (s: string) => new URLSearchParams(s);

    it('accepts a well-formed value', () => {
        const o = scrcpyOptionsFromQuery(q('videoCodecOptions=i-frame-interval%3Aint%3D2'), 'scid1');
        expect(o.videoCodecOptions).toBe('i-frame-interval:int=2');
    });

    it('drops a value that fails the allowlist rather than passing it on', () => {
        const o = scrcpyOptionsFromQuery(q('videoCodecOptions=a%3Aint%3D1%3B%20id'), 'scid1');
        expect(o.videoCodecOptions).toBeUndefined();
    });

    it('is absent when not supplied', () => {
        const o = scrcpyOptionsFromQuery(q('videoCodec=vp9'), 'scid1');
        expect(o.videoCodecOptions).toBeUndefined();
    });
});

describe('serializeOptions', () => {
    it('emits video_codec_options for scrcpy', () => {
        const args = serializeOptions({ scid: 'abc', videoCodecOptions: 'i-frame-interval:int=2' });
        expect(args).toContain('video_codec_options=i-frame-interval:int=2');
    });

    it('omits it when unset', () => {
        const args = serializeOptions({ scid: 'abc' });
        expect(args.some((a) => a.startsWith('video_codec_options='))).toBe(false);
    });

    it('does not disturb the existing arguments', () => {
        const args = serializeOptions({ scid: 'abc', videoCodec: 'vp9', videoEncoder: 'c2.exynos.vp9.encoder' });
        expect(args).toContain('video_codec=vp9');
        expect(args).toContain('video_encoder=c2.exynos.vp9.encoder');
        expect(args).toContain('scid=abc');
    });
});
