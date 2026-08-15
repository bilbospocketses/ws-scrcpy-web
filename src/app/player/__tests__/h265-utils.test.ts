import { describe, expect, it } from 'vitest';
import { buildHvcCBox, HEVC_NAL_TYPE, parseHevcSPSFull } from '../h265-utils';
import { buildSyntheticHevcSpsNalu } from './hevcSpsFixture';

describe('parseHevcSPSFull', () => {
    it('recovers profile/level/dimensions from a synthetic SPS', () => {
        const nalu = buildSyntheticHevcSpsNalu({
            profileSpace: 0,
            tierFlag: 0,
            profileIdc: 1,
            compatFlags: 0x60000000,
            levelIdc: 93,
            chromaFormatIdc: 1,
            width: 1920,
            height: 1080,
            bitDepthLumaMinus8: 0,
            bitDepthChromaMinus8: 0,
        });
        const info = parseHevcSPSFull(nalu);
        expect(info.profileSpace).toBe(0);
        expect(info.tierFlag).toBe(0);
        expect(info.profileIdc).toBe(1);
        expect(info.compatFlags >>> 0).toBe(0x60000000);
        expect(info.levelIdc).toBe(93);
        expect(info.chromaFormatIdc).toBe(1);
        expect(info.width).toBe(1920);
        expect(info.height).toBe(1080);
        expect(info.bitDepthLumaMinus8).toBe(0);
        expect(info.bitDepthChromaMinus8).toBe(0);
        expect(info.constraintFlags).toHaveLength(6);
        expect(info.codec).toBe('hev1.1.60000000.L93');
    });

    it('recovers a high-tier, 10-bit, odd-dimension SPS', () => {
        const nalu = buildSyntheticHevcSpsNalu({
            profileSpace: 0,
            tierFlag: 1,
            profileIdc: 2,
            levelIdc: 120,
            chromaFormatIdc: 1,
            width: 3840,
            height: 2160,
            bitDepthLumaMinus8: 2,
            bitDepthChromaMinus8: 2,
        });
        const info = parseHevcSPSFull(nalu);
        expect(info.tierFlag).toBe(1);
        expect(info.profileIdc).toBe(2);
        expect(info.levelIdc).toBe(120);
        expect(info.width).toBe(3840);
        expect(info.height).toBe(2160);
        expect(info.bitDepthLumaMinus8).toBe(2);
        expect(info.bitDepthChromaMinus8).toBe(2);
    });
});

describe('buildHvcCBox', () => {
    it('assembles the exact ISO/IEC 14496-15 HEVCDecoderConfigurationRecord byte layout', () => {
        const vps = Uint8Array.of(0x40, 0x01);
        const sps = Uint8Array.of(0x42, 0x01);
        const pps = Uint8Array.of(0x44, 0x01);
        const box = buildHvcCBox([vps], [sps], [pps], {
            codec: 'hev1.1.60000000.L93',
            width: 1920,
            height: 1080,
            profileSpace: 0,
            tierFlag: 0,
            profileIdc: 1,
            compatFlags: 0x60000000,
            constraintFlags: Uint8Array.of(0x90, 0, 0, 0, 0, 0),
            levelIdc: 93,
            chromaFormatIdc: 1,
            bitDepthLumaMinus8: 0,
            bitDepthChromaMinus8: 0,
        });
        expect(Array.from(box)).toEqual([
            1,
            1, // configurationVersion, generalProfileByte (space<<6|tier<<5|profileIdc)
            0x60,
            0x00,
            0x00,
            0x00, // general_profile_compatibility_flags
            0x90,
            0,
            0,
            0,
            0,
            0, // general_constraint_indicator_flags
            0x5d, // general_level_idc = 93
            0xf0,
            0x00, // reserved + min_spatial_segmentation_idc
            0xfc, // reserved + parallelismType
            0xfd, // reserved + chroma_format_idc(1)
            0xf8, // reserved + bit_depth_luma_minus8(0)
            0xf8, // reserved + bit_depth_chroma_minus8(0)
            0x00,
            0x00, // avgFrameRate
            0b00001011, // constantFrameRate/numTemporalLayers/temporalIdNested/lengthSizeMinusOne
            3, // numOfArrays
            0x80 | HEVC_NAL_TYPE.VPS,
            0x00,
            0x01,
            0x00,
            0x02,
            0x40,
            0x01,
            0x80 | HEVC_NAL_TYPE.SPS,
            0x00,
            0x01,
            0x00,
            0x02,
            0x42,
            0x01,
            0x80 | HEVC_NAL_TYPE.PPS,
            0x00,
            0x01,
            0x00,
            0x02,
            0x44,
            0x01,
        ]);
    });
});
