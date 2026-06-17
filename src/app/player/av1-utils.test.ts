import { describe, expect, it } from 'vitest';
import { Av1BitReader, parseAv1SequenceHeader } from './av1-utils';

describe('av1-utils parseAv1SequenceHeader bounds checking', () => {
    it('throws on an empty buffer instead of reading undefined', () => {
        expect(() => parseAv1SequenceHeader(new Uint8Array([]))).toThrow();
    });

    it('throws on a truncated sequence header rather than fabricating bits', () => {
        // Far too short for a full sequence header: the bit reader must run out
        // of bounds and throw, not silently read 0 bits past the buffer and
        // return a bogus codec/dimensions to VideoDecoder.configure().
        expect(() => parseAv1SequenceHeader(new Uint8Array([0x00, 0x00]))).toThrow(RangeError);
    });
});

describe('Av1BitReader.uvlc', () => {
    it('returns the 32-bit-max sentinel for >= 32 leading zero bits (no shift overflow, no OOB throw)', () => {
        // Per the AV1 spec a uvlc with >= 32 leading zeros decodes to 2^32 - 1.
        // The old code computed `(1 << 32) - 1` === 0 (JS shifts are mod-32) and,
        // on an all-zero buffer, read a 33rd terminator bit off the end → RangeError. (#90)
        const reader = new Av1BitReader(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 0);
        expect(reader.uvlc()).toBe(2 ** 32 - 1);
    });

    it('decodes a small value (leadingZeros=1) without sign overflow', () => {
        // 0b01000000 → bit0=0 (leadingZeros=1), bit1=1 (stop), value bit2=0 → 2^1 - 1 + 0 = 1
        const reader = new Av1BitReader(new Uint8Array([0b0100_0000]), 0);
        expect(reader.uvlc()).toBe(1);
    });
});
