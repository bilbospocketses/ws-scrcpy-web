import { describe, expect, it, vi } from 'vitest';
import { CODEC_PREFERENCE, chooseCodec, pickEncoderForCodec } from '../codecSelection';

/**
 * VP8/VP9 shipped for devices that offer no H.264, H.265 or AV1 encoder — but
 * automatic selection only ever looked at those three and then returned a bare
 * `h264` when none matched. So the exact devices the feature was added for
 * were handed a codec their hardware cannot produce, and the manual dropdown
 * was the only way to reach it.
 *
 * These tests pin the preference order (H.265 → H.264 → AV1 first, unchanged)
 * and the new tail that closes the hole.
 */

/** Browser that decodes everything. */
const decodesAll = () => Promise.resolve(true);

/** Browser that decodes only the listed codecs. */
const decodesOnly =
    (...codecs: string[]) =>
    (codec: string) =>
        Promise.resolve(codecs.includes(codec));

const SW_VP8 = 'c2.android.vp8.encoder';
const SW_VP9 = 'c2.android.vp9.encoder';
const SW_AVC = 'c2.android.avc.encoder';
const HW_AVC = 'c2.exynos.avc.encoder';
const HW_HEVC = 'c2.mtk.hevc.encoder';

describe('CODEC_PREFERENCE', () => {
    it('keeps H.265, H.264 and AV1 ahead of VP8 and VP9', () => {
        expect(CODEC_PREFERENCE).toEqual(['h265', 'h264', 'av1', 'vp8', 'vp9']);
    });
});

describe('chooseCodec', () => {
    it('prefers h265 when the device and browser both support it', async () => {
        const result = await chooseCodec([HW_HEVC, SW_AVC], decodesAll);
        expect(result.videoCodec).toBe('h265');
        expect(result.encoderName).toBe(HW_HEVC);
    });

    it('selects vp8 on a device whose only encoder is vp8', async () => {
        const result = await chooseCodec([SW_VP8], decodesAll);
        expect(result.videoCodec).toBe('vp8');
        expect(result.encoderName).toBe(SW_VP8);
    });

    it('selects vp9 on a device whose only encoder is vp9', async () => {
        const result = await chooseCodec([SW_VP9], decodesAll);
        expect(result.videoCodec).toBe('vp9');
        expect(result.encoderName).toBe(SW_VP9);
    });

    it('still prefers h264 over vp9 when the device offers both', async () => {
        const result = await chooseCodec([SW_AVC, SW_VP9], decodesAll);
        expect(result.videoCodec).toBe('h264');
    });

    it('falls through to vp9 when the browser refuses the codecs ahead of it', async () => {
        const result = await chooseCodec([SW_AVC, SW_VP9], decodesOnly('vp9'));
        expect(result.videoCodec).toBe('vp9');
        expect(result.encoderName).toBe(SW_VP9);
    });

    it('returns the bare h264 fallback when nothing at all matches', async () => {
        const result = await chooseCodec([SW_VP8], decodesOnly('av1'));
        expect(result.videoCodec).toBe('h264');
        expect(result.encoderName).toBeUndefined();
    });

    it('returns the bare h264 fallback for a device that reports no encoders', async () => {
        const result = await chooseCodec([], decodesAll);
        expect(result.videoCodec).toBe('h264');
        expect(result.encoderName).toBeUndefined();
    });

    it('does not ask the browser about codecs the device cannot encode', async () => {
        const canDecode = vi.fn(() => Promise.resolve(true));
        await chooseCodec([SW_VP8], canDecode);
        expect(canDecode).toHaveBeenCalledTimes(1);
        expect(canDecode).toHaveBeenCalledWith('vp8');
    });
});

describe('pickEncoderForCodec', () => {
    it('prefers a hardware encoder over the software one', () => {
        expect(pickEncoderForCodec([SW_AVC, HW_AVC], 'h264')).toBe(HW_AVC);
    });

    it('takes the software encoder when no hardware one is offered', () => {
        expect(pickEncoderForCodec([SW_AVC], 'h264')).toBe(SW_AVC);
    });

    it('matches vp8 and vp9 encoders without crossing them over', () => {
        expect(pickEncoderForCodec([SW_VP8, SW_VP9], 'vp8')).toBe(SW_VP8);
        expect(pickEncoderForCodec([SW_VP8, SW_VP9], 'vp9')).toBe(SW_VP9);
    });

    it('returns undefined when the device has no encoder for the codec', () => {
        expect(pickEncoderForCodec([SW_AVC], 'vp9')).toBeUndefined();
    });
});
