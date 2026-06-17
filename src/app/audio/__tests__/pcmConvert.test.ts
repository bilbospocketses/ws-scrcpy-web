import { describe, expect, it } from 'vitest';
import { decodeS16LEToFloat32Planar } from '../pcmConvert';

/** Build a Uint8Array from a list of little-endian signed 16-bit samples. */
function s16le(...samples: number[]): Uint8Array {
    const buf = new Uint8Array(samples.length * 2);
    const view = new DataView(buf.buffer);
    samples.forEach((s, i) => {
        view.setInt16(i * 2, s, true);
    });
    return buf;
}

describe('decodeS16LEToFloat32Planar', () => {
    it('de-interleaves stereo samples into per-channel buffers', () => {
        // interleaved L,R,L,R: ch0 = [L0,L1], ch1 = [R0,R1]
        const data = s16le(100, 200, 300, 400);
        const channels = decodeS16LEToFloat32Planar(data, 2);
        expect(channels).toHaveLength(2);
        expect(channels[0]).toHaveLength(2);
        expect(channels[1]).toHaveLength(2);
        expect(Array.from(channels[0]!)).toEqual([100 / 32768, 300 / 32768]);
        expect(Array.from(channels[1]!)).toEqual([200 / 32768, 400 / 32768]);
    });

    it('converts full-scale and edge samples correctly (incl. negatives)', () => {
        // ch0 = [0, -1.0], ch1 = [0.999969..., -3.05e-5]
        const data = s16le(0, 32767, -32768, -1);
        const channels = decodeS16LEToFloat32Planar(data, 2);
        expect(channels[0]![0]).toBe(0);
        expect(channels[0]![1]).toBe(-1.0); // -32768/32768
        expect(channels[1]![0]).toBeCloseTo(32767 / 32768, 12);
        expect(channels[1]![1]).toBeCloseTo(-1 / 32768, 12);
    });

    it('matches a DataView.getInt16 reference for a random-ish pattern', () => {
        const samples = [1, -1, 12345, -12345, 32767, -32768, 0, 5, -5, 999, -1000, 31000];
        const data = s16le(...samples);
        const channelCount = 2;
        const channels = decodeS16LEToFloat32Planar(data, channelCount);

        // Reference: replicate the original DataView per-sample loop.
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const sampleCount = (data.byteLength / 2) | 0;
        const framesPerChannel = (sampleCount / channelCount) | 0;
        const ref: number[][] = [[], []];
        for (let i = 0; i < framesPerChannel; i++) {
            for (let ch = 0; ch < channelCount; ch++) {
                const int16 = view.getInt16((i * channelCount + ch) * 2, true);
                ref[ch]!.push(int16 / 32768);
            }
        }
        expect(Array.from(channels[0]!)).toEqual(ref[0]);
        expect(Array.from(channels[1]!)).toEqual(ref[1]);
    });

    it('supports mono', () => {
        const data = s16le(16384, -16384, 32767);
        const channels = decodeS16LEToFloat32Planar(data, 1);
        expect(channels).toHaveLength(1);
        expect(Array.from(channels[0]!)).toEqual([16384 / 32768, -16384 / 32768, 32767 / 32768]);
    });

    it('handles a non-zero byteOffset (subarray view) correctly', () => {
        // Place samples after a 4-byte header, hand a subarray to the decoder.
        const full = new Uint8Array(4 + 2 * 4);
        const view = new DataView(full.buffer);
        view.setInt16(4 + 0, 1000, true);
        view.setInt16(4 + 2, 2000, true);
        view.setInt16(4 + 4, 3000, true);
        view.setInt16(4 + 6, 4000, true);
        const slice = full.subarray(4);
        const channels = decodeS16LEToFloat32Planar(slice, 2);
        expect(Array.from(channels[0]!)).toEqual([1000 / 32768, 3000 / 32768]);
        expect(Array.from(channels[1]!)).toEqual([2000 / 32768, 4000 / 32768]);
    });

    it('drops a trailing partial frame (odd sample count for stereo)', () => {
        // 3 samples, stereo → 1 full frame, last sample ignored
        const data = s16le(10, 20, 30);
        const channels = decodeS16LEToFloat32Planar(data, 2);
        expect(channels[0]).toHaveLength(1);
        expect(channels[1]).toHaveLength(1);
        expect(Array.from(channels[0]!)).toEqual([10 / 32768]);
        expect(Array.from(channels[1]!)).toEqual([20 / 32768]);
    });
});
