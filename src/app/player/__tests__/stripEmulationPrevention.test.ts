import { describe, expect, it } from 'vitest';
import { stripEmulationPrevention } from '../h265-utils';

describe('stripEmulationPrevention', () => {
    it('returns a Uint8Array', () => {
        const out = stripEmulationPrevention(new Uint8Array([1, 2, 3]));
        expect(out).toBeInstanceOf(Uint8Array);
    });

    it('removes a single emulation-prevention sequence (00 00 03 -> 00 00)', () => {
        const input = new Uint8Array([0x00, 0x00, 0x03, 0x01]);
        const out = stripEmulationPrevention(input);
        expect(Array.from(out)).toEqual([0x00, 0x00, 0x01]);
    });

    it('removes multiple non-adjacent emulation sequences', () => {
        const input = new Uint8Array([0xaa, 0x00, 0x00, 0x03, 0x12, 0x34, 0x00, 0x00, 0x03, 0x56]);
        const out = stripEmulationPrevention(input);
        expect(Array.from(out)).toEqual([0xaa, 0x00, 0x00, 0x12, 0x34, 0x00, 0x00, 0x56]);
    });

    it('handles adjacent/overlapping emulation runs (00 00 03 00 00 03 ..)', () => {
        // 00 00 03 00 00 03 00 -> after removing the first 03 we get 00 00 [00] ...
        // Decoder semantics: each "00 00 03" with the 03 as emulation byte collapses to "00 00".
        const input = new Uint8Array([0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x04]);
        const out = stripEmulationPrevention(input);
        expect(Array.from(out)).toEqual([0x00, 0x00, 0x00, 0x00, 0x04]);
    });

    it('does NOT strip 00 00 03 when not the start of an emulation triple boundary (e.g. 00 03)', () => {
        // No "00 00 03" anywhere — nothing should change.
        const input = new Uint8Array([0x00, 0x03, 0x00, 0x01, 0x02]);
        const out = stripEmulationPrevention(input);
        expect(Array.from(out)).toEqual([0x00, 0x03, 0x00, 0x01, 0x02]);
    });

    it('does not strip a trailing 00 00 with no following 03', () => {
        const input = new Uint8Array([0x05, 0x06, 0x00, 0x00]);
        const out = stripEmulationPrevention(input);
        expect(Array.from(out)).toEqual([0x05, 0x06, 0x00, 0x00]);
    });

    it('leaves data without emulation bytes unchanged', () => {
        const input = new Uint8Array([0x67, 0x42, 0x00, 0x1e, 0x8c]);
        const out = stripEmulationPrevention(input);
        expect(Array.from(out)).toEqual([0x67, 0x42, 0x00, 0x1e, 0x8c]);
    });

    it('handles an empty input', () => {
        const out = stripEmulationPrevention(new Uint8Array([]));
        expect(Array.from(out)).toEqual([]);
    });
});
