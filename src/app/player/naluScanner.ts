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
