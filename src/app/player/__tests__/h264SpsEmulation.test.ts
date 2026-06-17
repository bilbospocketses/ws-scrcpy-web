import { describe, expect, it } from 'vitest';
import { parseSPS, stripEmulationPrevention } from '../h264-utils';

/**
 * Finding #42 (b): the H.264 SPS path must strip RBSP emulation-prevention bytes
 * (00 00 03 -> 00 00) before bitstream parsing, exactly as the H.265 path does.
 * Without stripping, an SPS containing a 00 00 03 triple is mis-parsed (the bit
 * reader consumes the stray 0x03), corrupting the dimensions handed to
 * VideoDecoder.configure().
 */

/** Inverse of stripEmulationPrevention: insert 0x03 to RBSP-protect 00 00 0x runs. */
function addEmulationPrevention(rbsp: Uint8Array): Uint8Array {
    const out: number[] = [];
    let zeros = 0;
    for (const b of rbsp) {
        if (zeros >= 2 && b <= 0x03) {
            out.push(0x03);
            zeros = 0;
        }
        out.push(b);
        zeros = b === 0x00 ? zeros + 1 : 0;
    }
    return new Uint8Array(out);
}

// A real H.264 baseline SPS (avc1.42001E), no emulation bytes — parses cleanly.
// The trailing 00 00 00 sits past the SPS fields parseSPS reads (it stops after
// the VUI), so it does not affect the parse; it gives addEmulationPrevention a
// 00 00 <small> run to protect, proving the strip round-trips.
const cleanSps = new Uint8Array([
    0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00,
]);

describe('H.264 SPS emulation-prevention handling', () => {
    it('exposes stripEmulationPrevention from h264-utils (shared NAL helper)', () => {
        expect(typeof stripEmulationPrevention).toBe('function');
        expect(Array.from(stripEmulationPrevention(new Uint8Array([0x00, 0x00, 0x03, 0x01])))).toEqual([
            0x00, 0x00, 0x01,
        ]);
    });

    it('strip() exactly reverses emulation-prevention insertion', () => {
        const protectedSps = addEmulationPrevention(cleanSps);
        expect(Array.from(stripEmulationPrevention(protectedSps))).toEqual(Array.from(cleanSps));
    });

    it('parseSPS on a stripped emulation-protected SPS matches the clean parse', () => {
        const baseline = parseSPS(cleanSps);
        const protectedSps = addEmulationPrevention(cleanSps);
        // Sanity: ensure the protected form actually differs (an emulation byte was inserted).
        expect(protectedSps.length).toBeGreaterThan(cleanSps.length);
        const viaStrip = parseSPS(stripEmulationPrevention(protectedSps));
        expect(viaStrip).toEqual(baseline);
    });
});
