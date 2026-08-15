// Test-only helper: builds a minimal valid HEVC SPS RBSP so parseHevcSPSFull
// can be exercised without a captured real-device bitstream. Only encodes the
// fields parseHevcSPSFull actually reads, in the order it reads them.

class BitWriter {
    private bytes: number[] = [];
    private curByte = 0;
    private bitPos = 0; // number of bits already written into curByte, MSB-first

    writeBit(bit: 0 | 1): void {
        this.curByte = (this.curByte << 1) | bit;
        this.bitPos++;
        if (this.bitPos === 8) {
            this.bytes.push(this.curByte);
            this.curByte = 0;
            this.bitPos = 0;
        }
    }

    writeBits(value: number, count: number): void {
        for (let i = count - 1; i >= 0; i--) {
            this.writeBit(((value >>> i) & 1) as 0 | 1);
        }
    }

    /** Exp-Golomb ue(v). */
    writeUE(value: number): void {
        const codeNum = value + 1;
        const bitLength = Math.floor(Math.log2(codeNum)) + 1;
        for (let i = 0; i < bitLength - 1; i++) this.writeBit(0);
        this.writeBits(codeNum, bitLength);
    }

    /** Flush, zero-padding the final partial byte. */
    toUint8Array(): Uint8Array {
        if (this.bitPos > 0) {
            this.bytes.push(this.curByte << (8 - this.bitPos));
            this.curByte = 0;
            this.bitPos = 0;
        }
        return new Uint8Array(this.bytes);
    }
}

export interface SyntheticHevcSpsParams {
    profileSpace?: number;
    tierFlag?: 0 | 1;
    profileIdc?: number;
    compatFlags?: number;
    levelIdc?: number;
    chromaFormatIdc?: number;
    width: number;
    height: number;
    bitDepthLumaMinus8?: number;
    bitDepthChromaMinus8?: number;
}

/** Returns the full SPS NAL (2-byte NAL header + RBSP), Annex-B-payload shaped. */
export function buildSyntheticHevcSpsNalu(params: SyntheticHevcSpsParams): Uint8Array {
    const w = new BitWriter();
    w.writeBits(0, 4); // sps_video_parameter_set_id
    w.writeBits(0, 3); // sps_max_sub_layers_minus1 = 0 (skips the sub-layer loop)
    w.writeBit(1); // sps_temporal_id_nesting_flag

    w.writeBits(params.profileSpace ?? 0, 2); // general_profile_space
    w.writeBit((params.tierFlag ?? 0) as 0 | 1); // general_tier_flag
    w.writeBits(params.profileIdc ?? 1, 5); // general_profile_idc
    w.writeBits(params.compatFlags ?? 0x60000000, 32); // general_profile_compatibility_flags
    // general_constraint_indicator_flags (48 bits) — zero is fine, box builder just copies raw bytes.
    w.writeBits(0, 24);
    w.writeBits(0, 24);
    w.writeBits(params.levelIdc ?? 93, 8); // general_level_idc

    w.writeUE(0); // sps_seq_parameter_set_id
    w.writeUE(params.chromaFormatIdc ?? 1); // chroma_format_idc
    w.writeUE(params.width); // pic_width_in_luma_samples
    w.writeUE(params.height); // pic_height_in_luma_samples
    w.writeBit(0); // conformance_window_flag = 0
    w.writeUE(params.bitDepthLumaMinus8 ?? 0);
    w.writeUE(params.bitDepthChromaMinus8 ?? 0);

    const rbsp = w.toUint8Array();
    const nal = new Uint8Array(2 + rbsp.length);
    // NAL header: forbidden_zero_bit(0) + nal_unit_type(33 = SPS) + layer_id/tid low bits.
    nal[0] = (33 << 1) & 0xff; // 0x42
    nal[1] = 0x01;
    nal.set(rbsp, 2);
    return nal;
}
