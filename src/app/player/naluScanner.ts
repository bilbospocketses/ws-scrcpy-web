// Shared Annex B (H.264/H.265) NAL-unit start-code scanner. Previously three
// near-identical copies lived in WebCodecsPlayer (findNaluOffset / findStartCode
// / findHevcNalu), each with the same off-by-one loop bound.

/**
 * Scan an Annex B byte stream for the first NAL unit whose header byte satisfies
 * `match`. Returns the offset of the header byte (just past the start code), or
 * -1 if none is found.
 */
export function findNaluByHeader(data: Uint8Array, match: (headerByte: number) => boolean): number {
    // `i + 3 <= length` (not the old `i < length - 4`) so a 3-byte start code in
    // the final bytes isn't missed; the `offset < length` check below still
    // rejects a start code with no payload byte after it.
    for (let i = 0; i + 3 <= data.length; i++) {
        if (data[i] !== 0 || data[i + 1] !== 0) {
            continue;
        }
        let offset: number;
        if (data[i + 2] === 1) {
            offset = i + 3;
        } else if (data[i + 2] === 0 && data[i + 3] === 1) {
            offset = i + 4;
        } else {
            continue;
        }
        if (offset < data.length && match(data[offset]!)) {
            return offset;
        }
    }
    return -1;
}

/** Offset just past the first Annex B start code (any NAL type), or -1. */
export function findFirstNaluOffset(data: Uint8Array): number {
    return findNaluByHeader(data, () => true);
}

/**
 * Split an Annex B byte stream into individual NAL units, start codes
 * stripped (emulation-prevention bytes left intact — avcC/hvcC embed NALs as
 * they appear in the bitstream, not the de-escaped RBSP).
 */
export function splitAnnexBNalUnits(data: Uint8Array): Uint8Array[] {
    // codeStart: offset of the leading 00 of each start code.
    // payloadStart: offset of the first NAL header byte just past it.
    const codeStarts: number[] = [];
    const payloadStarts: number[] = [];
    for (let i = 0; i + 3 <= data.length; i++) {
        if (data[i] !== 0 || data[i + 1] !== 0) {
            continue;
        }
        if (data[i + 2] === 1) {
            codeStarts.push(i);
            payloadStarts.push(i + 3);
            i += 2; // resume scanning at the payload, not the code's own trailing zeros
        } else if (i + 4 <= data.length && data[i + 2] === 0 && data[i + 3] === 1) {
            codeStarts.push(i);
            payloadStarts.push(i + 4);
            i += 3; // a 4-byte code's tail ("00 00 01") would otherwise self-match as a
            // spurious 3-byte code one position later, truncating the preceding NAL
        }
    }
    const nalus: Uint8Array[] = [];
    for (let i = 0; i < payloadStarts.length; i++) {
        const start = payloadStarts[i]!;
        const end = i + 1 < codeStarts.length ? codeStarts[i + 1]! : data.length;
        if (end > start) {
            nalus.push(data.subarray(start, end));
        }
    }
    return nalus;
}

/**
 * Re-frame Annex B (start-code-prefixed) NAL units into 4-byte length-prefixed
 * ones — the framing an avcC/hvcC-configured decoder expects from every
 * `EncodedVideoChunk.data`, matching this repo's fixed lengthSizeMinusOne=3.
 */
export function annexBToLengthPrefixed(data: Uint8Array): Uint8Array {
    const nalus = splitAnnexBNalUnits(data);
    const chunks: Uint8Array[] = [];
    for (const nalu of nalus) {
        const len = nalu.length;
        chunks.push(Uint8Array.of((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff), nalu);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
