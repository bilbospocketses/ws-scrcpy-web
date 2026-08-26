import { describe, expect, it } from 'vitest';
import { annexBToLengthPrefixed, findFirstNaluOffset, findNaluByHeader, splitAnnexBNalUnits } from '../naluScanner';

describe('findNaluByHeader', () => {
    it('finds a NAL unit after a 4-byte start code', () => {
        const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xab]);
        expect(findNaluByHeader(data, (b) => (b & 0x1f) === 7)).toBe(4);
    });

    it('finds a NAL unit after a 3-byte start code', () => {
        const data = new Uint8Array([0, 0, 1, 0x67, 0xab]);
        expect(findNaluByHeader(data, (b) => (b & 0x1f) === 7)).toBe(3);
    });

    it('finds a 3-byte start code whose payload byte is the final byte (tail off-by-one regression)', () => {
        // Only start code begins at i = length-4 (= 3). The old `i < length - 4`
        // bound stopped at i < 3 and missed it, returning -1.
        const data = new Uint8Array([0xff, 0xff, 0xff, 0, 0, 1, 0x67]);
        expect(findNaluByHeader(data, (b) => (b & 0x1f) === 7)).toBe(6);
    });

    it('returns -1 when no matching NAL unit is present', () => {
        const data = new Uint8Array([0, 0, 1, 0x41, 0xab]);
        expect(findNaluByHeader(data, (b) => (b & 0x1f) === 7)).toBe(-1);
    });

    it('returns -1 for a start code with no payload byte after it', () => {
        const data = new Uint8Array([0xff, 0, 0, 1]);
        expect(findNaluByHeader(data, () => true)).toBe(-1);
    });
});

describe('findFirstNaluOffset', () => {
    it('returns the offset past the first start code of any NAL type', () => {
        expect(findFirstNaluOffset(new Uint8Array([0, 0, 0, 1, 0x67]))).toBe(4);
        expect(findFirstNaluOffset(new Uint8Array([0xff, 0, 0, 1, 0x41]))).toBe(4);
    });

    it('returns -1 when there is no start code', () => {
        expect(findFirstNaluOffset(new Uint8Array([1, 2, 3, 4, 5]))).toBe(-1);
    });
});

describe('splitAnnexBNalUnits', () => {
    it('splits multiple NALs separated by 4-byte start codes', () => {
        const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xaa, 0xbb, 0, 0, 0, 1, 0x68, 0xcc]);
        const nalus = splitAnnexBNalUnits(data);
        expect(nalus.map((n) => Array.from(n))).toEqual([
            [0x67, 0xaa, 0xbb],
            [0x68, 0xcc],
        ]);
    });

    it('handles a mix of 3-byte and 4-byte start codes', () => {
        const data = new Uint8Array([0, 0, 1, 0x40, 0x01, 0, 0, 0, 1, 0x42, 0x01, 0, 0, 1, 0x44, 0x01]);
        const nalus = splitAnnexBNalUnits(data);
        expect(nalus.map((n) => Array.from(n))).toEqual([
            [0x40, 0x01],
            [0x42, 0x01],
            [0x44, 0x01],
        ]);
    });

    it('returns the single NAL when there is exactly one', () => {
        const data = new Uint8Array([0, 0, 0, 1, 0x67, 0x11, 0x22]);
        expect(splitAnnexBNalUnits(data).map((n) => Array.from(n))).toEqual([[0x67, 0x11, 0x22]]);
    });

    it('returns an empty array when there is no start code', () => {
        expect(splitAnnexBNalUnits(new Uint8Array([1, 2, 3]))).toEqual([]);
    });

    it('does not emit a spurious extra NAL when a 4-byte start code follows immediately', () => {
        // Not skipping past a matched start code re-matches its own trailing
        // "00 00 01" as a spurious 3-byte code one byte later, corrupting the
        // next NAL's bounds. Only one start code's worth of zeros here (3 + the
        // 1), so all of it is the second NAL's start code, none of it payload.
        const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xaa, 0, 0, 0, 1, 0x68, 0xcc]);
        const nalus = splitAnnexBNalUnits(data);
        expect(nalus.map((n) => Array.from(n))).toEqual([
            [0x67, 0xaa],
            [0x68, 0xcc],
        ]);
    });

    it('keeps a NAL payload byte-for-byte when its own trailing zeros are followed by a full separate start code', () => {
        // 6 zero bytes: 3 genuinely belong to the first NAL's trailing padding,
        // 3 more are the next start code's own lead-in.
        const data = new Uint8Array([0, 0, 0, 1, 0x67, 0xaa, 0, 0, 0, 0, 0, 0, 1, 0x68, 0xcc]);
        const nalus = splitAnnexBNalUnits(data);
        expect(nalus.map((n) => Array.from(n))).toEqual([
            [0x67, 0xaa, 0, 0, 0],
            [0x68, 0xcc],
        ]);
    });
});

describe('annexBToLengthPrefixed', () => {
    it('replaces each start code with a 4-byte big-endian length prefix', () => {
        const data = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0xcc, 0xdd]);
        expect(Array.from(annexBToLengthPrefixed(data))).toEqual([0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd]);
    });

    it('re-frames multiple NALs independently', () => {
        const data = new Uint8Array([0, 0, 0, 1, 0x67, 0x11, 0, 0, 1, 0x68, 0x22, 0x33]);
        expect(Array.from(annexBToLengthPrefixed(data))).toEqual([
            0, 0, 0, 2, 0x67, 0x11, 0, 0, 0, 3, 0x68, 0x22, 0x33,
        ]);
    });

    it('returns an empty array for data with no start code', () => {
        expect(Array.from(annexBToLengthPrefixed(new Uint8Array([1, 2, 3])))).toEqual([]);
    });
});
