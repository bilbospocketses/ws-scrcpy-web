// src/app/player/h265-utils.ts
import { BitStream, concatUint8Arrays, stripEmulationPrevention } from './h264-utils';

// Re-export the shared NAL helper so existing importers of '../h265-utils' keep working.
export { stripEmulationPrevention };

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

/** Superset of HevcCodecInfo carrying the extra fields the hvcC box needs. */
export interface HevcSPSInfo extends HevcCodecInfo {
    profileSpace: number;
    tierFlag: number;
    profileIdc: number;
    compatFlags: number;
    /** general_constraint_indicator_flags, 48 bits, as 6 raw bytes. */
    constraintFlags: Uint8Array;
    levelIdc: number;
    chromaFormatIdc: number;
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
}

export function parseHevcSPS(data: Uint8Array): HevcCodecInfo {
    return parseHevcSPSFull(data);
}

export function parseHevcSPSFull(data: Uint8Array): HevcSPSInfo {
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
    const { profileSpace, profileIdc, tierFlag, levelIdc, compatFlags, constraintFlags } = parseProfileTierLevel(
        bs,
        maxSubLayersMinus1,
    );

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

    if (bs.readBoolean()) {
        // conformance_window_flag
        bs.skipUEG(); // conf_win_left_offset
        bs.skipUEG(); // conf_win_right_offset
        bs.skipUEG(); // conf_win_top_offset
        bs.skipUEG(); // conf_win_bottom_offset
    }

    const bitDepthLumaMinus8 = bs.readUEG();
    const bitDepthChromaMinus8 = bs.readUEG();

    // Build codec string
    const tier = tierFlag ? 'H' : 'L';
    const codec = `hev1.${profileIdc}.${compatFlags.toString(16).toUpperCase()}.${tier}${levelIdc}`;

    return {
        codec,
        width,
        height,
        profileSpace,
        tierFlag,
        profileIdc,
        compatFlags,
        constraintFlags,
        levelIdc,
        chromaFormatIdc,
        bitDepthLumaMinus8,
        bitDepthChromaMinus8,
    };
}

function parseProfileTierLevel(
    bs: BitStream,
    maxSubLayersMinus1: number,
): {
    profileSpace: number;
    profileIdc: number;
    tierFlag: number;
    levelIdc: number;
    compatFlags: number;
    constraintFlags: Uint8Array;
} {
    // general_profile_space (2 bits)
    const profileSpace = bs.readBits(2);
    // general_tier_flag (1 bit)
    const tierFlag = bs.readBits(1);
    // general_profile_idc (5 bits)
    const profileIdc = bs.readBits(5);
    // general_profile_compatibility_flags (32 bits)
    let compatFlags = 0;
    for (let i = 0; i < 32; i++) {
        compatFlags = (compatFlags | (bs.readBits(1) << (31 - i))) >>> 0;
    }
    // general_progressive_source_flag .. general_reserved_zero_43bits (48 bits) —
    // preserved as raw bytes for the hvcC's constraint_indicator_flags field.
    const constraintFlags = new Uint8Array(6);
    for (let i = 0; i < 6; i++) {
        constraintFlags[i] = bs.readUByte();
    }
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

    return { profileSpace, profileIdc, tierFlag, levelIdc, compatFlags, constraintFlags };
}

// ── HEVCDecoderConfigurationRecord (hvcC box) ───────────────────

/**
 * Build an hvcC box (ISO/IEC 14496-15) from raw VPS/SPS/PPS NAL units —
 * required for `hev1.*`/`hvc1.*` description; unlike H.264, Chrome's HEVC
 * decoder doesn't accept in-band (Annex B) parameter sets as a fallback.
 */
export function buildHvcCBox(
    vpsNalus: Uint8Array[],
    spsNalus: Uint8Array[],
    ppsNalus: Uint8Array[],
    info: HevcSPSInfo,
): Uint8Array {
    const generalProfileByte = (info.profileSpace << 6) | (info.tierFlag << 5) | info.profileIdc;
    const compatBytes = Uint8Array.of(
        (info.compatFlags >>> 24) & 0xff,
        (info.compatFlags >>> 16) & 0xff,
        (info.compatFlags >>> 8) & 0xff,
        info.compatFlags & 0xff,
    );
    const chunks: Uint8Array[] = [
        Uint8Array.of(
            1, // configurationVersion
            generalProfileByte,
        ),
        compatBytes,
        info.constraintFlags,
        Uint8Array.of(
            info.levelIdc,
            0xf0, // reserved(4)='1111' + min_spatial_segmentation_idc high nibble = 0
            0x00, // min_spatial_segmentation_idc low byte = 0
            0xfc, // reserved(6)='111111' + parallelismType(2) = 0 (unknown)
            0xfc | (info.chromaFormatIdc & 0x03), // reserved(6) + chroma_format_idc(2)
            0xf8 | (info.bitDepthLumaMinus8 & 0x07), // reserved(5) + bit_depth_luma_minus8(3)
            0xf8 | (info.bitDepthChromaMinus8 & 0x07), // reserved(5) + bit_depth_chroma_minus8(3)
            0x00, // avgFrameRate high byte = 0 (unspecified)
            0x00, // avgFrameRate low byte
            // constantFrameRate(2)=0 + numTemporalLayers(3)=1 + temporalIdNested(1)=0 + lengthSizeMinusOne(2)=3
            0b00001011,
            3, // numOfArrays: VPS, SPS, PPS
        ),
    ];
    const pushArray = (nalUnitType: number, nalus: Uint8Array[]) => {
        // array_completeness(1)=1 + reserved(1)=0 + NAL_unit_type(6)
        chunks.push(Uint8Array.of(0x80 | (nalUnitType & 0x3f), (nalus.length >> 8) & 0xff, nalus.length & 0xff));
        for (const nalu of nalus) {
            chunks.push(Uint8Array.of((nalu.length >> 8) & 0xff, nalu.length & 0xff), nalu);
        }
    };
    pushArray(HEVC_NAL_TYPE.VPS, vpsNalus);
    pushArray(HEVC_NAL_TYPE.SPS, spsNalus);
    pushArray(HEVC_NAL_TYPE.PPS, ppsNalus);
    return concatUint8Arrays(chunks);
}
