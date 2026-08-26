import { describe, expect, it } from 'vitest';
import { CODEC_ID, codecName } from '../ScrcpyCodec';

/**
 * The ids are the 4-byte ASCII form of the codec name, assigned by scrcpy's
 * server-side `VideoCodec` / `AudioCodec` enums. They arrive on the wire in the
 * session metadata, so a wrong constant means a stream reported as
 * `unknown(0x…)` and a decoder that is never configured.
 *
 * Values verified against scrcpy v4.1 `VideoCodec.java`.
 */
describe('video codec ids', () => {
    it.each([
        ['h264', CODEC_ID.H264, 0x68323634],
        ['h265', CODEC_ID.H265, 0x68323635],
        ['av1', CODEC_ID.AV1, 0x00617631],
        ['vp8', CODEC_ID.VP8, 0x00767038],
        ['vp9', CODEC_ID.VP9, 0x00767039],
    ])('%s maps to its scrcpy id and back', (name, id, expectedId) => {
        expect(id).toBe(expectedId);
        expect(codecName(id)).toBe(name);
    });

    it('decodes each id as the ASCII of its own name', () => {
        // 0x00767038 -> "\0vp8". The high byte is padding for 3-char names.
        const asAscii = (id: number) =>
            String.fromCharCode((id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff).replace(/\0/g, '');
        expect(asAscii(CODEC_ID.VP8)).toBe('vp8');
        expect(asAscii(CODEC_ID.VP9)).toBe('vp9');
    });

    it('reports an unrecognised id rather than guessing', () => {
        expect(codecName(0x12345678)).toBe('unknown(0x12345678)');
    });
});
