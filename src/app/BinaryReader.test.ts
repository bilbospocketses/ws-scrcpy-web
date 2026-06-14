import { describe, expect, it } from 'vitest';
import { BinaryReader } from './BinaryReader';

describe('BinaryReader', () => {
    it('reads in-bounds values correctly', () => {
        const r = new BinaryReader(new Uint8Array([0x00, 0x00, 0x00, 0x2a]));
        expect(r.readUInt32BE()).toBe(42);
    });

    it('returns exactly the requested in-bounds slice from readBytes', () => {
        const r = new BinaryReader(new Uint8Array([10, 20, 30, 40]));
        expect(Array.from(r.readBytes(2))).toEqual([10, 20]);
        expect(r.remaining).toBe(2);
    });

    it('readBytes must not read past the logical view into the backing buffer', () => {
        // The logical message is only the first 4 bytes, but the backing
        // ArrayBuffer has 8. readBytes(8) must throw, not alias bytes 5-8.
        const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const view = backing.subarray(0, 4);
        const r = new BinaryReader(view);
        expect(() => r.readBytes(8)).toThrow(RangeError);
    });

    it('throws when a fixed-width read runs past the end', () => {
        const r = new BinaryReader(new Uint8Array([1, 2]));
        expect(() => r.readUInt32BE()).toThrow(RangeError);
    });

    it('throws when readUInt8 runs past the end', () => {
        const r = new BinaryReader(new Uint8Array([1]));
        expect(r.readUInt8()).toBe(1);
        expect(() => r.readUInt8()).toThrow(RangeError);
    });

    it('rejects a negative or non-finite length', () => {
        const r = new BinaryReader(new Uint8Array([1, 2, 3, 4]));
        expect(() => r.readBytes(-1)).toThrow(RangeError);
    });
});
