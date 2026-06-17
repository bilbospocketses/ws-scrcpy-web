// src/app/audio/pcmConvert.ts

/**
 * Convert interleaved signed-16-bit little-endian PCM into per-channel planar
 * Float32 buffers (one Float32Array per channel), de-interleaving and scaling
 * S16 -> Float32 by dividing by 32768.
 *
 * Performance: this uses a single `Int16Array` view over the input plus direct
 * indexing instead of a per-sample `DataView.getInt16(...)` call (the old hot
 * path in AudioPlayer.pushRawPcm), which fired once per sample per frame.
 *
 * Endianness: `Int16Array` is host-endian. The wire format is little-endian, so
 * the fast path assumes a little-endian host — true for all browser/Node
 * targets ws-scrcpy-web runs on (x86/ARM in LE mode). If a big-endian host were
 * ever in play this fast path would mis-read; that is the same assumption the
 * surrounding decode pipeline already makes. A trailing partial frame (when the
 * sample count isn't a whole multiple of `channelCount`) is dropped, matching
 * the original `| 0` truncation behaviour.
 *
 * Alignment: `Int16Array(buffer, byteOffset, len)` requires an even byteOffset.
 * A `Uint8Array` subarray can land on an odd offset; in that (rare) case we copy
 * into a fresh aligned buffer first so the view is always valid.
 */
export function decodeS16LEToFloat32Planar(data: Uint8Array, channelCount: number): Float32Array[] {
    const sampleCount = (data.byteLength / 2) | 0;
    const framesPerChannel = (sampleCount / channelCount) | 0;

    let samples: Int16Array;
    if (data.byteOffset % 2 === 0) {
        samples = new Int16Array(data.buffer, data.byteOffset, sampleCount);
    } else {
        // Odd byteOffset — can't view directly; copy the exact sample bytes into
        // an aligned buffer (still no per-sample DataView calls).
        const aligned = data.slice(0, sampleCount * 2);
        samples = new Int16Array(aligned.buffer, aligned.byteOffset, sampleCount);
    }

    const channels: Float32Array[] = [];
    for (let ch = 0; ch < channelCount; ch++) {
        channels.push(new Float32Array(framesPerChannel));
    }

    for (let i = 0; i < framesPerChannel; i++) {
        const base = i * channelCount;
        for (let ch = 0; ch < channelCount; ch++) {
            channels[ch]![i] = samples[base + ch]! / 32768;
        }
    }

    return channels;
}
