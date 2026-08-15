import { describe, expect, it } from 'vitest';
import { buildAvcCBox } from '../h264-utils';

describe('buildAvcCBox', () => {
    it('assembles the exact ISO/IEC 14496-15 AVCDecoderConfigurationRecord byte layout', () => {
        const sps = Uint8Array.of(0x67, 0xaa, 0xbb);
        const pps = Uint8Array.of(0x68, 0xcc);
        const box = buildAvcCBox([sps], [pps], {
            profile_idc: 0x42,
            constraint_set_flags: 0x00,
            level_idc: 0x1e,
            seq_parameter_set_id: 0,
            pic_width_in_mbs_minus1: 0,
            pic_height_in_map_units_minus1: 0,
            frame_mbs_only_flag: 1,
            frame_crop_left_offset: 0,
            frame_crop_right_offset: 0,
            frame_crop_top_offset: 0,
            frame_crop_bottom_offset: 0,
            sar: [1, 1],
        });
        expect(Array.from(box)).toEqual([
            1, // configurationVersion
            0x42, // AVCProfileIndication
            0x00, // profile_compatibility
            0x1e, // AVCLevelIndication
            0xff, // reserved(6) + lengthSizeMinusOne(2)=3
            0xe1, // reserved(3) + numOfSequenceParameterSets(5)=1
            0x00,
            0x03, // SPS length = 3
            0x67,
            0xaa,
            0xbb,
            0x01, // numOfPictureParameterSets = 1
            0x00,
            0x02, // PPS length = 2
            0x68,
            0xcc,
        ]);
    });

    it('handles multiple SPS/PPS entries', () => {
        const sps1 = Uint8Array.of(0x67, 0x01);
        const sps2 = Uint8Array.of(0x67, 0x02);
        const pps1 = Uint8Array.of(0x68, 0x03);
        const box = buildAvcCBox([sps1, sps2], [pps1], {
            profile_idc: 0x64,
            constraint_set_flags: 0x00,
            level_idc: 0x28,
            seq_parameter_set_id: 0,
            pic_width_in_mbs_minus1: 0,
            pic_height_in_map_units_minus1: 0,
            frame_mbs_only_flag: 1,
            frame_crop_left_offset: 0,
            frame_crop_right_offset: 0,
            frame_crop_top_offset: 0,
            frame_crop_bottom_offset: 0,
            sar: [1, 1],
        });
        expect(box[5]! & 0x1f).toBe(2); // numOfSequenceParameterSets
        expect(Array.from(box)).toEqual([
            1, 0x64, 0x00, 0x28, 0xff, 0xe2, 0x00, 0x02, 0x67, 0x01, 0x00, 0x02, 0x67, 0x02, 0x01, 0x00, 0x02, 0x68,
            0x03,
        ]);
    });
});
