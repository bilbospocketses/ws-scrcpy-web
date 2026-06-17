import { describe, expect, it } from 'vitest';
import { findFirstNaluOffset, findNaluByHeader } from '../naluScanner';

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
