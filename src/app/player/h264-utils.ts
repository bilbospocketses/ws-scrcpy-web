/**
 * Minimal H.264 SPS parser and NALU type constants.
 *
 * Inlined from xevojapan/h264-converter (MIT) to eliminate the
 * external dependency — we only need parseSPS() and a handful of
 * NALU type constants for WebCodecsPlayer.
 */

// ── NALU type constants ─────────────────────────────────────────

export const NALU_TYPE = {
    NDR: 1,
    IDR: 5,
    SEI: 6,
    SPS: 7,
    PPS: 8,
} as const;

// ── BitStream (Exp-Golomb reader) ───────────────────────────────

export class BitStream {
    private index = 0;
    private readonly bitLength: number;

    constructor(private data: Uint8Array) {
        this.bitLength = data.byteLength * 8;
    }

    get bitsAvailable(): number {
        return this.bitLength - this.index;
    }

    public skipBits(size: number): void {
        if (this.bitsAvailable < size) {
            throw new Error('no bytes available');
        }
        this.index += size;
    }

    public readBits(size: number): number {
        return this.getBits(size, this.index);
    }

    private getBits(size: number, offsetBits: number, moveIndex = true): number {
        if (this.bitsAvailable < size) {
            throw new Error('no bytes available');
        }
        const offset = offsetBits % 8;
        const byte = this.data[(offsetBits / 8) | 0]! & (0xff >>> offset);
        const bits = 8 - offset;
        if (bits >= size) {
            if (moveIndex) {
                this.index += size;
            }
            return byte >> (bits - size);
        }
        if (moveIndex) {
            this.index += bits;
        }
        const nextSize = size - bits;
        return (byte << nextSize) | this.getBits(nextSize, offsetBits + bits, moveIndex);
    }

    public skipLZ(): number {
        let leadingZeroCount: number;
        for (leadingZeroCount = 0; leadingZeroCount < this.bitLength - this.index; ++leadingZeroCount) {
            if (0 !== this.getBits(1, this.index + leadingZeroCount, false)) {
                this.index += leadingZeroCount;
                return leadingZeroCount;
            }
        }
        return leadingZeroCount;
    }

    public skipUEG(): void {
        this.skipBits(1 + this.skipLZ());
    }

    public skipEG(): void {
        this.skipBits(1 + this.skipLZ());
    }

    public readUEG(): number {
        const prefix = this.skipLZ();
        return this.readBits(prefix + 1) - 1;
    }

    public readEG(): number {
        const value = this.readUEG();
        if (0x01 & value) {
            return (1 + value) >>> 1;
        }
        return -1 * (value >>> 1);
    }

    public readBoolean(): boolean {
        return 1 === this.readBits(1);
    }

    public readUByte(): number {
        return this.readBits(8);
    }
}

// ── SPS result type ─────────────────────────────────────────────

export type SPS = {
    profile_idc: number;
    constraint_set_flags: number;
    level_idc: number;
    seq_parameter_set_id: number;
    pic_width_in_mbs_minus1: number;
    pic_height_in_map_units_minus1: number;
    frame_mbs_only_flag: number;
    frame_crop_left_offset: number;
    frame_crop_right_offset: number;
    frame_crop_top_offset: number;
    frame_crop_bottom_offset: number;
    sar: [number, number];
};

// ── parseSPS ────────────────────────────────────────────────────

function skipScalingList(decoder: BitStream, count: number): void {
    let lastScale = 8;
    let nextScale = 8;
    for (let j = 0; j < count; j++) {
        if (nextScale !== 0) {
            const deltaScale = decoder.readEG();
            nextScale = (lastScale + deltaScale + 256) % 256;
        }
        lastScale = nextScale === 0 ? lastScale : nextScale;
    }
}

export function parseSPS(data: Uint8Array): SPS {
    const decoder = new BitStream(data);
    let frame_crop_left_offset = 0;
    let frame_crop_right_offset = 0;
    let frame_crop_top_offset = 0;
    let frame_crop_bottom_offset = 0;

    decoder.readUByte(); // skip first byte (NALU header)

    const profile_idc = decoder.readUByte();
    const constraint_set_flags = decoder.readUByte();
    const level_idc = decoder.readBits(8);
    const seq_parameter_set_id = decoder.readUEG();

    if (
        profile_idc === 100 ||
        profile_idc === 110 ||
        profile_idc === 122 ||
        profile_idc === 244 ||
        profile_idc === 44 ||
        profile_idc === 83 ||
        profile_idc === 86 ||
        profile_idc === 118 ||
        profile_idc === 128 ||
        profile_idc === 138 ||
        profile_idc === 139 ||
        profile_idc === 134
    ) {
        const chromaFormatIdc = decoder.readUEG();
        if (chromaFormatIdc === 3) {
            decoder.skipBits(1);
        }
        decoder.skipUEG(); // bit_depth_luma_minus8
        decoder.skipUEG(); // bit_depth_chroma_minus8
        decoder.skipBits(1); // qpprime_y_zero_transform_bypass_flag
        if (decoder.readBoolean()) {
            // seq_scaling_matrix_present_flag
            const scalingListCount = chromaFormatIdc !== 3 ? 8 : 12;
            for (let i = 0; i < scalingListCount; ++i) {
                if (decoder.readBoolean()) {
                    if (i < 6) {
                        skipScalingList(decoder, 16);
                    } else {
                        skipScalingList(decoder, 64);
                    }
                }
            }
        }
    }

    decoder.skipUEG(); // log2_max_frame_num_minus4
    const picOrderCntType = decoder.readUEG();
    if (picOrderCntType === 0) {
        decoder.readUEG(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
        decoder.skipBits(1);
        decoder.skipEG();
        decoder.skipEG();
        const numRefFramesInPicOrderCntCycle = decoder.readUEG();
        for (let i = 0; i < numRefFramesInPicOrderCntCycle; ++i) {
            decoder.skipEG();
        }
    }

    decoder.skipUEG(); // max_num_ref_frames
    decoder.skipBits(1); // gaps_in_frame_num_value_allowed_flag
    const pic_width_in_mbs_minus1 = decoder.readUEG();
    const pic_height_in_map_units_minus1 = decoder.readUEG();
    const frame_mbs_only_flag = decoder.readBits(1);
    if (frame_mbs_only_flag === 0) {
        decoder.skipBits(1); // mb_adaptive_frame_field_flag
    }
    decoder.skipBits(1); // direct_8x8_inference_flag

    if (decoder.readBoolean()) {
        // frame_cropping_flag
        frame_crop_left_offset = decoder.readUEG();
        frame_crop_right_offset = decoder.readUEG();
        frame_crop_top_offset = decoder.readUEG();
        frame_crop_bottom_offset = decoder.readUEG();
    }

    let sar: [number, number] = [1, 1];
    if (decoder.readBoolean()) {
        // vui_parameters_present_flag
        if (decoder.readBoolean()) {
            // aspect_ratio_info_present_flag
            const aspectRatioIdc = decoder.readUByte();
            switch (aspectRatioIdc) {
                case 1:
                    sar = [1, 1];
                    break;
                case 2:
                    sar = [12, 11];
                    break;
                case 3:
                    sar = [10, 11];
                    break;
                case 4:
                    sar = [16, 11];
                    break;
                case 5:
                    sar = [40, 33];
                    break;
                case 6:
                    sar = [24, 11];
                    break;
                case 7:
                    sar = [20, 11];
                    break;
                case 8:
                    sar = [32, 11];
                    break;
                case 9:
                    sar = [80, 33];
                    break;
                case 10:
                    sar = [18, 11];
                    break;
                case 11:
                    sar = [15, 11];
                    break;
                case 12:
                    sar = [64, 33];
                    break;
                case 13:
                    sar = [160, 99];
                    break;
                case 14:
                    sar = [4, 3];
                    break;
                case 15:
                    sar = [3, 2];
                    break;
                case 16:
                    sar = [2, 1];
                    break;
                case 255:
                    sar = [
                        (decoder.readUByte() << 8) | decoder.readUByte(),
                        (decoder.readUByte() << 8) | decoder.readUByte(),
                    ];
                    break;
                default:
                    console.warn(`H264: Unknown aspectRatioIdc=${aspectRatioIdc}`);
            }
        }
    }

    return {
        profile_idc,
        constraint_set_flags,
        level_idc,
        seq_parameter_set_id,
        pic_width_in_mbs_minus1,
        pic_height_in_map_units_minus1,
        frame_mbs_only_flag,
        frame_crop_left_offset,
        frame_crop_right_offset,
        frame_crop_top_offset,
        frame_crop_bottom_offset,
        sar,
    };
}
