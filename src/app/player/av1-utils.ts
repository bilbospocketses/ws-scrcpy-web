// src/app/player/av1-utils.ts

export const OBU_TYPE = {
    SEQUENCE_HEADER: 1,
    TEMPORAL_DELIMITER: 2,
    FRAME_HEADER: 3,
    FRAME: 6,
} as const;

export function obuType(byte: number): number {
    return (byte >> 3) & 0xf;
}

export interface Av1CodecInfo {
    codec: string;
    width: number;
    height: number;
}

/**
 * Parse a 4-byte AV1CodecConfigurationRecord (ISO 14496-15).
 * scrcpy sends this format as the config packet for AV1 streams.
 * Format: marker(1)|version(7) | seq_profile(3)|seq_level_idx(5) | seq_tier(1)|high_bitdepth(1)|twelve_bit(1)|... | reserved
 * Returns codec string but no dimensions (they come from stream metadata).
 */
export function parseAv1ConfigRecord(data: Uint8Array): { codec: string } | null {
    if (data.length < 4) return null;
    const marker = (data[0]! >> 7) & 1;
    if (marker !== 1) return null; // Not a valid AV1 config record

    const seqProfile = (data[1]! >> 5) & 0x7;
    const seqLevelIdx = data[1]! & 0x1f;
    const seqTier = (data[2]! >> 7) & 1;
    const highBitDepth = (data[2]! >> 6) & 1;
    const twelveBit = (data[2]! >> 5) & 1;

    let bitDepth = 8;
    if (seqProfile === 2 && highBitDepth) {
        bitDepth = twelveBit ? 12 : 10;
    } else if (highBitDepth) {
        bitDepth = 10;
    }

    const tierChar = seqTier ? 'H' : 'M';
    const levelStr = seqLevelIdx.toString().padStart(2, '0');
    const bdStr = bitDepth.toString().padStart(2, '0');
    const codec = `av01.${seqProfile}.${levelStr}${tierChar}.${bdStr}`;

    return { codec };
}

export function parseAv1SequenceHeader(data: Uint8Array): Av1CodecInfo {
    if (data.length < 1) {
        throw new RangeError('AV1 sequence header: empty buffer');
    }
    let pos = 0;

    // OBU header
    const headerByte = data[pos++]!;
    const hasExtension = (headerByte >> 2) & 1;
    const hasSizeField = (headerByte >> 1) & 1;

    if (hasExtension) pos++;

    if (hasSizeField) {
        const r = readLeb128(data, pos);
        pos = r.newPos;
    }

    const reader = new Av1BitReader(data, pos);

    // seq_profile (3 bits)
    const seqProfile = reader.f(3);
    // still_picture (1 bit)
    reader.f(1);
    // reduced_still_picture_header (1 bit)
    const reducedStillPicture = reader.f(1);

    let seqLevelIdx = 0;
    let seqTier = 0;
    let bitDepth = 8;

    if (reducedStillPicture) {
        seqLevelIdx = reader.f(5);
    } else {
        const timingInfoPresent = reader.f(1);
        if (timingInfoPresent) {
            reader.f(32); // num_units_in_display_tick
            reader.f(32); // time_scale
            const equalPictureInterval = reader.f(1);
            if (equalPictureInterval) {
                reader.uvlc();
            }
            const decoderModelInfoPresent = reader.f(1);
            if (decoderModelInfoPresent) {
                reader.f(5);
                reader.f(32);
                reader.f(5);
                reader.f(5);
            }
        }
        reader.f(1); // initial_display_delay_present_flag
        const opCnt = reader.f(5) + 1;
        for (let i = 0; i < opCnt; i++) {
            reader.f(12);
            const level = reader.f(5);
            if (i === 0) seqLevelIdx = level;
            if (level > 7) {
                const tier = reader.f(1);
                if (i === 0) seqTier = tier;
            }
        }
    }

    // max_frame_width/height from the sequence header. For AV1 the player prefers
    // the container/metadata dimensions, so these are advisory on the AV1 path
    // (the H.264/H.265 parsers do consume their parsed dimensions). Read rather
    // than skipped so the bit cursor stays aligned for the fields that follow. (#88)
    const widthBits = reader.f(4) + 1;
    const heightBits = reader.f(4) + 1;
    const width = reader.f(widthBits) + 1;
    const height = reader.f(heightBits) + 1;

    if (!reducedStillPicture) {
        const frameIdNumbersPresent = reader.f(1);
        if (frameIdNumbersPresent) {
            reader.f(4);
            reader.f(3);
        }
    }

    reader.f(1); // use_128x128_superblock
    reader.f(1); // enable_filter_intra
    reader.f(1); // enable_intra_edge_filter

    if (!reducedStillPicture) {
        reader.f(1); // enable_interintra_compound
        reader.f(1); // enable_masked_compound
        reader.f(1); // enable_warped_motion
        reader.f(1); // enable_dual_filter
        const enableOrderHint = reader.f(1);
        if (enableOrderHint) {
            reader.f(1); // enable_jnt_comp
            reader.f(1); // enable_ref_frame_mvs
        }
        const seqForceScreenContentTools = reader.f(1) ? 2 : reader.f(1);
        if (seqForceScreenContentTools > 0) {
            if (!reader.f(1)) {
                reader.f(1);
            }
        }
        if (enableOrderHint) {
            reader.f(3);
        }
    }

    reader.f(1); // enable_superres
    reader.f(1); // enable_cdef
    reader.f(1); // enable_restoration

    // color_config
    const highBitDepth = reader.f(1);
    if (seqProfile === 2 && highBitDepth) {
        const twelveBit = reader.f(1);
        bitDepth = twelveBit ? 12 : 10;
    } else {
        bitDepth = highBitDepth ? 10 : 8;
    }

    const tierChar = seqTier ? 'H' : 'M';
    const levelStr = seqLevelIdx.toString().padStart(2, '0');
    const bdStr = bitDepth.toString().padStart(2, '0');
    const codec = `av01.${seqProfile}.${levelStr}${tierChar}.${bdStr}`;

    return { codec, width, height };
}

function readLeb128(data: Uint8Array, pos: number): { value: number; newPos: number } {
    let value = 0;
    let i = 0;
    let byte: number;
    do {
        if (pos >= data.length) {
            throw new RangeError('AV1 leb128: out of bounds');
        }
        byte = data[pos++]!;
        value |= (byte & 0x7f) << (i * 7);
        i++;
    } while (byte & 0x80 && i < 8);
    return { value, newPos: pos };
}

export class Av1BitReader {
    private bitPos: number;
    private readonly data: Uint8Array;

    constructor(data: Uint8Array, byteOffset: number) {
        this.data = data;
        this.bitPos = byteOffset * 8;
    }

    f(n: number): number {
        let value = 0;
        for (let i = 0; i < n; i++) {
            const byteIdx = this.bitPos >> 3;
            if (byteIdx >= this.data.length) {
                throw new RangeError('Av1BitReader: out of bounds');
            }
            const bitIdx = 7 - (this.bitPos & 7);
            value = (value << 1) | ((this.data[byteIdx]! >> bitIdx) & 1);
            this.bitPos++;
        }
        return value;
    }

    uvlc(): number {
        let leadingZeros = 0;
        // Cap at 32: per the AV1 spec a uvlc with >= 32 leading zeros decodes to
        // the 32-bit max, and the cap also bounds the read on a malformed all-zero
        // stream. Use 2**n, not `1 << n` (which goes negative at n=31 and wraps to
        // 0 at n=32). (#90)
        while (leadingZeros < 32 && this.f(1) === 0) {
            leadingZeros++;
        }
        if (leadingZeros >= 32) {
            return 2 ** 32 - 1;
        }
        return 2 ** leadingZeros - 1 + this.f(leadingZeros);
    }
}
