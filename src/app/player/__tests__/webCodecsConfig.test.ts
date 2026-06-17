import { describe, expect, it } from 'vitest';
import { buildDecoderConfig } from '../webCodecsConfig';

describe('buildDecoderConfig', () => {
    it('carries the SPS/PPS config bytes via description for H.264', () => {
        const configData = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0, 0, 0, 1, 0x68, 0xce]);
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
        // The whole point of #41: the SPS/PPS travels in `description`, not prepended per frame.
        expect(cfg.description).toBeInstanceOf(Uint8Array);
        expect(Array.from(cfg.description as Uint8Array)).toEqual(Array.from(configData));
    });

    it('carries the VPS/SPS/PPS config bytes via description for H.265', () => {
        const configData = new Uint8Array([0, 0, 0, 1, 0x40, 0x01, 0, 0, 0, 1, 0x42, 0x01]);
        const cfg = buildDecoderConfig({
            codec: 'hev1.1.6.L93.B0',
            detectedCodec: 'h265',
            codedWidth: 1920,
            codedHeight: 1088,
            configData,
        });
        expect(cfg.description).toBeInstanceOf(Uint8Array);
        expect(Array.from(cfg.description as Uint8Array)).toEqual(Array.from(configData));
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
        const configData = new Uint8Array([0, 0, 0, 1, 0x67, 0x42]);
        const cfg = buildDecoderConfig({
            codec: 'avc1.42001E',
            detectedCodec: 'h264',
            codedWidth: 640,
            codedHeight: 480,
            configData,
        });
        const desc = cfg.description as Uint8Array;
        // Mutating the original config buffer must not corrupt the decoder description.
        configData[4] = 0xff;
        expect(desc[4]).toBe(0x67);
    });
});
