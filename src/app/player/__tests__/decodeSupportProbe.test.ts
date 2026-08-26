import { afterEach, describe, expect, it, vi } from 'vitest';

import { CODEC_PROBE_STRINGS, probeDecodeSupport } from '../webCodecsConfig';

/**
 * Guard for issue #498: the app used to hardcode H.264 as supported and never
 * ask the browser at all —
 *
 *     if (codec === 'h264') return true;
 *
 * That was written to dodge Firefox answering a definite `false` for individual
 * H.264 profile strings it can in fact decode. But it also overrode the honest
 * `false` from a machine with no H.264 decoder at all (Windows N without the
 * Media Feature Pack, for one), so the app auto-selected h264, handed it to a
 * decoder that produced nothing, and rendered a black screen with no error.
 *
 * The rule these tests pin down: a definite `false` is authoritative, a throw
 * is not an answer, and probing several profile strings absorbs the Firefox
 * pessimism the original workaround was reaching for.
 */

type ProbeResult = { supported: boolean };

function stubVideoDecoder(impl: (codec: string) => Promise<ProbeResult>): void {
    vi.stubGlobal('VideoDecoder', {
        isConfigSupported: (config: { codec: string }) => impl(config.codec),
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('probeDecodeSupport', () => {
    it('reports supported when the only candidate says yes', async () => {
        stubVideoDecoder(async () => ({ supported: true }));
        await expect(probeDecodeSupport('av1')).resolves.toBe(true);
    });

    it('reports UNSUPPORTED when every H.264 candidate gives a definite no', async () => {
        // A box with no H.264 decoder. The old code returned true here and
        // produced the black screen in issue #498.
        stubVideoDecoder(async () => ({ supported: false }));
        await expect(probeDecodeSupport('h264')).resolves.toBe(false);
    });

    it('reports supported when only a later H.264 candidate says yes', async () => {
        // The Firefox case the original workaround existed for: pessimistic
        // about baseline, fine with high. One yes is enough.
        stubVideoDecoder(async (codec) => ({ supported: codec === 'avc1.640028' }));
        await expect(probeDecodeSupport('h264')).resolves.toBe(true);
    });

    it('tries every H.264 candidate before concluding no', async () => {
        const seen: string[] = [];
        stubVideoDecoder(async (codec) => {
            seen.push(codec);
            return { supported: false };
        });
        await probeDecodeSupport('h264');
        expect(seen).toEqual([...CODEC_PROBE_STRINGS['h264']!]);
        expect(seen.length).toBeGreaterThan(1);
    });

    it('returns undefined — not false — when every candidate throws', async () => {
        // A refusal to answer is not a "no". Callers decide what to assume.
        stubVideoDecoder(async () => {
            throw new TypeError('Unsupported configuration');
        });
        await expect(probeDecodeSupport('h264')).resolves.toBeUndefined();
    });

    it('still reports supported when one candidate throws and another says yes', async () => {
        stubVideoDecoder(async (codec) => {
            if (codec === 'avc1.42E01E') throw new TypeError('malformed');
            return { supported: true };
        });
        await expect(probeDecodeSupport('h264')).resolves.toBe(true);
    });

    it('returns undefined when the WebCodecs API is absent', async () => {
        vi.stubGlobal('VideoDecoder', undefined);
        await expect(probeDecodeSupport('h264')).resolves.toBeUndefined();
    });

    it('returns undefined when isConfigSupported is missing', async () => {
        vi.stubGlobal('VideoDecoder', {});
        await expect(probeDecodeSupport('h264')).resolves.toBeUndefined();
    });

    it('returns undefined for a codec it has no probe strings for', async () => {
        stubVideoDecoder(async () => ({ supported: true }));
        await expect(probeDecodeSupport('theora')).resolves.toBeUndefined();
    });

    it('covers every streamable codec with at least one probe string', () => {
        for (const codec of ['h264', 'h265', 'av1', 'vp8', 'vp9']) {
            expect(CODEC_PROBE_STRINGS[codec]?.length ?? 0).toBeGreaterThan(0);
        }
    });
});
