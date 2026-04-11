// src/app/player/h265-utils.ts
import { BitStream } from './h264-utils';

export const HEVC_NAL_TYPE = {
    VPS: 32,
    SPS: 33,
    PPS: 34,
} as const;

export function hevcNalType(byte: number): number {
    return (byte >> 1) & 0x3f;
}

export interface HevcCodecInfo {
    codec: string;
    width: number;
    height: number;
}

/**
 * Strip RBSP emulation prevention bytes (00 00 03 → 00 00).
 * Must be done before bitstream parsing on any NAL unit data.
 */
function stripEmulationPrevention(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    let i = 0;
    while (i < data.length) {
        if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
            out.push(0, 0);
            i += 3; // skip the 0x03 byte
        } else {
            out.push(data[i]);
            i++;
        }
    }
    return new Uint8Array(out);
}

export function parseHevcSPS(data: Uint8Array): HevcCodecInfo {
    const bs = new BitStream(stripEmulationPrevention(data));

    // NAL unit header: 2 bytes
    bs.skipBits(16);

    // sps_video_parameter_set_id (4 bits)
    bs.skipBits(4);
    // sps_max_sub_layers_minus1 (3 bits)
    const maxSubLayersMinus1 = bs.readBits(3);
    // sps_temporal_id_nesting_flag (1 bit)
    bs.skipBits(1);

    // profile_tier_level(1, maxSubLayersMinus1)
    const { profileIdc, tierFlag, levelIdc, compatFlags } = parseProfileTierLevel(bs, maxSubLayersMinus1);

    // sps_seq_parameter_set_id
    bs.skipUEG();

    // chroma_format_idc
    const chromaFormatIdc = bs.readUEG();
    if (chromaFormatIdc === 3) {
        bs.skipBits(1); // separate_colour_plane_flag
    }

    // pic_width_in_luma_samples, pic_height_in_luma_samples
    const width = bs.readUEG();
    const height = bs.readUEG();

    // Build codec string
    const tier = tierFlag ? 'H' : 'L';
    const codec = `hev1.${profileIdc}.${compatFlags.toString(16).toUpperCase()}.${tier}${levelIdc}`;

    return { codec, width, height };
}

function parseProfileTierLevel(
    bs: BitStream,
    maxSubLayersMinus1: number,
): { profileIdc: number; tierFlag: number; levelIdc: number; compatFlags: number } {
    // general_profile_space (2 bits)
    bs.skipBits(2);
    // general_tier_flag (1 bit)
    const tierFlag = bs.readBits(1);
    // general_profile_idc (5 bits)
    const profileIdc = bs.readBits(5);
    // general_profile_compatibility_flags (32 bits)
    let compatFlags = 0;
    for (let i = 0; i < 32; i++) {
        compatFlags = (compatFlags | (bs.readBits(1) << (31 - i))) >>> 0;
    }
    // general_progressive_source_flag .. general_reserved_zero_43bits (48 bits)
    bs.skipBits(48);
    // general_level_idc (8 bits)
    const levelIdc = bs.readBits(8);

    // sub_layer profiles (skip)
    if (maxSubLayersMinus1 > 0) {
        const subLayerProfilePresentFlag: boolean[] = [];
        const subLayerLevelPresentFlag: boolean[] = [];
        for (let i = 0; i < maxSubLayersMinus1; i++) {
            subLayerProfilePresentFlag.push(bs.readBoolean());
            subLayerLevelPresentFlag.push(bs.readBoolean());
        }
        if (maxSubLayersMinus1 < 8) {
            bs.skipBits(2 * (8 - maxSubLayersMinus1));
        }
        for (let i = 0; i < maxSubLayersMinus1; i++) {
            if (subLayerProfilePresentFlag[i]) {
                bs.skipBits(88);
            }
            if (subLayerLevelPresentFlag[i]) {
                bs.skipBits(8);
            }
        }
    }

    return { profileIdc, tierFlag, levelIdc, compatFlags };
}
