import { describe, expect, it } from 'vitest';
import { buildAvcCBox, parseSPS, stripEmulationPrevention } from '../h264-utils';
import { buildHvcCBox, parseHevcSPSFull } from '../h265-utils';
import { buildDecoderConfig } from '../webCodecsConfig';
import { buildSyntheticHevcSpsNalu } from './hevcSpsFixture';

// Real H.264 baseline SPS (avc1.42001E) — same fixture as h264SpsEmulation.test.ts.
const cleanSps = new Uint8Array([
    0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00,
]);
const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);

function annexB(...nalus: Uint8Array[]): Uint8Array {
    const parts: number[] = [];
    for (const nalu of nalus) {
        parts.push(0, 0, 0, 1, ...nalu);
    }
    return new Uint8Array(parts);
}

describe('buildDecoderConfig', () => {
    it('builds a real avcC description (not raw Annex B) for H.264', () => {
        const configData = annexB(cleanSps, pps);
        const cfg = buildDecoderConfig({
            codec: 'avc1.42001E',
            detectedCodec: 'h264',
            codedWidth: 1280,
            codedHeight: 720,
            configData,
        });
        expect(cfg.codec).toBe('avc1.42001E');
        expect(cfg.codedWidth).toBe(1280);
        expect(cfg.codedHeight).toBe(720);
        expect(cfg.optimizeForLatency).toBe(true);
        expect(cfg.description).toBeInstanceOf(Uint8Array);
        // description must NOT be the raw Annex B bytes — WebCodecs rejects those outright.
        expect(Array.from(cfg.description as Uint8Array)).not.toEqual(Array.from(configData));
        // Must be byte-identical to the box built directly from the same SPS/PPS.
        const expected = buildAvcCBox([cleanSps], [pps], parseSPS(stripEmulationPrevention(cleanSps)));
        expect(Array.from(cfg.description as Uint8Array)).toEqual(Array.from(expected));
    });

    it('builds a real hvcC description (not raw Annex B) for H.265', () => {
        const vps = new Uint8Array([0x40, 0x01, 0x0c, 0x01]);
        const spsNalu = buildSyntheticHevcSpsNalu({ width: 1920, height: 1080 });
        const ppsNalu = new Uint8Array([0x44, 0x01, 0xc0]);
        const configData = annexB(vps, spsNalu, ppsNalu);
        const cfg = buildDecoderConfig({
            codec: 'hev1.1.6.L93.B0',
            detectedCodec: 'h265',
            codedWidth: 1920,
            codedHeight: 1080,
            configData,
        });
        expect(cfg.description).toBeInstanceOf(Uint8Array);
        expect(Array.from(cfg.description as Uint8Array)).not.toEqual(Array.from(configData));
        const desc = cfg.description as Uint8Array;
        expect(desc[0]).toBe(1); // configurationVersion

        const info = parseHevcSPSFull(spsNalu);
        const expected = buildHvcCBox([vps], [spsNalu], [ppsNalu], info);
        expect(Array.from(desc)).toEqual(Array.from(expected));
    });

    it('does NOT set a description for AV1 (config record is handled differently)', () => {
        const configData = new Uint8Array([0x81, 0x05, 0x0c, 0x00]);
        const cfg = buildDecoderConfig({
            codec: 'av01.0.04M.08',
            detectedCodec: 'av1',
            codedWidth: 1920,
            codedHeight: 1080,
            configData,
        });
        expect(cfg.description).toBeUndefined();
    });

    it('returns a description copy that is decoupled from the source buffer', () => {
        const configData = annexB(cleanSps, pps);
        const cfg = buildDecoderConfig({
            codec: 'avc1.42001E',
            detectedCodec: 'h264',
            codedWidth: 640,
            codedHeight: 480,
            configData,
        });
        const desc = cfg.description as Uint8Array;
        const before = desc[8];
        // Mutating the original config buffer must not corrupt the decoder description.
        configData[8] = 0xff;
        expect(desc[8]).toBe(before);
    });
});
