import { describe, expect, it } from 'vitest';
import { parseAv1SequenceHeader } from './av1-utils';

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
