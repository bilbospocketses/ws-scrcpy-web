import { buildAvcCBox, NALU_TYPE, parseSPS, stripEmulationPrevention } from './h264-utils';
import { buildHvcCBox, HEVC_NAL_TYPE, hevcNalType, parseHevcSPSFull } from './h265-utils';
import { splitAnnexBNalUnits } from './naluScanner';

/**
 * Pure builder for the {@link VideoDecoderConfig} passed to
 * `VideoDecoder.configure()`.
 *
 * For H.264/H.265, `description` must be a real avcC/hvcC ISOBMFF box, not
 * raw Annex B — WebCodecs rejects Annex B start codes there. This extracts
 * the SPS/PPS (and VPS) NALs out of the Annex B config packet and builds the
 * real box. AV1 carries its sequence header in the keyframe data itself, so
 * no `description` is set for it.
 */
/** Video codecs scrcpy can stream, by their scrcpy-side names. */
export type VideoCodecName = 'h264' | 'h265' | 'av1' | 'vp8' | 'vp9';

/**
 * WebCodecs codec strings, one per scrcpy video codec. Used both to configure
 * the decoder and to probe support via `VideoDecoder.isConfigSupported()`.
 *
 * VP9 needs the full `vp09.<profile>.<level>.<bitDepth>` form — a bare "vp9"
 * is not a registered WebCodecs string. `vp09.00.10.08` is profile 0 / level
 * 1.0 / 8-bit, the generic form; decoders do not enforce the declared level
 * for playback. VP8 has no parameters, so it is just "vp8".
 */
export const WEBCODECS_CODEC_STRING: Record<string, string> = {
    h264: 'avc1.42E01E',
    h265: 'hev1.1.6.L93.B0',
    av1: 'av01.0.04M.08',
    vp8: 'vp8',
    vp9: 'vp09.00.10.08',
};

/**
 * Candidate codec strings to probe for support, per scrcpy codec name.
 *
 * H.264 carries three profiles because Firefox answers a definite `false` for
 * individual profile strings it can in fact decode; probing baseline alone
 * under-reports. Any one candidate reporting `supported` proves the codec is
 * usable, so the list only has to contain something the browser will admit to.
 */
export const CODEC_PROBE_STRINGS: Record<string, readonly string[]> = {
    h264: ['avc1.42E01E', 'avc1.4D401E', 'avc1.640028'],
    h265: ['hev1.1.6.L93.B0'],
    av1: ['av01.0.04M.08'],
    vp8: ['vp8'],
    vp9: ['vp09.00.10.08'],
};

/**
 * Ask the browser whether it can decode `codec`.
 *
 * `true` / `false` are real answers from `VideoDecoder.isConfigSupported()`.
 * `undefined` means no answer was obtainable — WebCodecs is missing, or every
 * candidate string threw — and the caller decides what to assume, because the
 * two call sites want different fallbacks.
 *
 * A definite `false` is authoritative and must never be overridden. Both call
 * sites used to special-case H.264 to "supported" without asking, which meant a
 * machine with no H.264 decoder at all (Windows N lacking the Media Feature
 * Pack, for instance) still got h264 auto-selected, fed to a decoder that
 * emitted nothing, and shown a black screen with no error. See issue #498.
 */
export async function probeDecodeSupport(codec: string): Promise<boolean | undefined> {
    const candidates = CODEC_PROBE_STRINGS[codec];
    if (!candidates || candidates.length === 0) return undefined;
    if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
        return undefined;
    }
    let answered = false;
    for (const codecString of candidates) {
        try {
            const result = await VideoDecoder.isConfigSupported({ codec: codecString });
            answered = true;
            if (result.supported) return true;
        } catch {
            // A throw is a refusal to answer (malformed string, unimplemented
            // path), not a "no" — keep asking about the remaining candidates.
        }
    }
    return answered ? false : undefined;
}

/**
 * Codecs whose decoder must be configured from session metadata rather than
 * from a config packet.
 *
 * ⚠️ The name is about what we can *use*, not about what arrives. An earlier
 * version of this comment claimed VP8/VP9 send no config packet at all. That is
 * wrong, and a wire capture disproves it: every VP9 session opens with a frame
 * carrying MediaCodec's `BUFFER_FLAG_CODEC_CONFIG` — 12 bytes, ~15ms ahead of
 * the first keyframe.
 *
 * What is true is that those 12 bytes are not parameter sets we can build a
 * `VideoDecoderConfig.description` from. `parseConfig` looks for Annex B
 * SPS/PPS (H.264/H.265) or an AV1 sequence header, finds neither, and returns
 * null — so the config branch never configures anything for these codecs.
 * Everything the decoder actually needs is in the keyframe, and the dimensions
 * come from session metadata. Hence: configure up front, ignore the packet.
 *
 * The consequence that matters is in the keyframe gate, not here — see
 * `WebCodecsPlayer.pushVideoFrame`. scrcpy emits exactly ONE keyframe per
 * VP8/VP9 session (measured: 398 frames, 1 keyframe, over 28s at a 2s i-frame
 * interval), so a session that misses it cannot resynchronise without asking
 * the device for a new one.
 */
export const CONFIGLESS_CODECS: readonly VideoCodecName[] = ['vp8', 'vp9'];

export function isConfiglessCodec(codec: string | null | undefined): boolean {
    return codec !== null && codec !== undefined && (CONFIGLESS_CODECS as readonly string[]).includes(codec);
}

export interface BuildDecoderConfigParams {
    /** WebCodecs codec string, e.g. `avc1.42E01E` / `hev1.1.6.L93.B0` / `av01.0.04M.08`. */
    codec: string;
    detectedCodec: VideoCodecName | null;
    codedWidth: number;
    codedHeight: number;
    /** Raw config NAL bytes (Annex B SPS/PPS or VPS/SPS/PPS) captured from the config frame. */
    configData: Uint8Array;
}

export function buildDecoderConfig(params: BuildDecoderConfigParams): VideoDecoderConfig {
    const config: VideoDecoderConfig = {
        codec: params.codec,
        codedWidth: params.codedWidth,
        codedHeight: params.codedHeight,
        optimizeForLatency: true,
    };
    if (params.detectedCodec === 'h264') {
        const nalus = splitAnnexBNalUnits(params.configData);
        const spsNalus = nalus.filter((n) => (n[0]! & 0x1f) === NALU_TYPE.SPS);
        const ppsNalus = nalus.filter((n) => (n[0]! & 0x1f) === NALU_TYPE.PPS);
        if (spsNalus.length > 0 && ppsNalus.length > 0) {
            const sps = parseSPS(stripEmulationPrevention(spsNalus[0]!));
            config.description = buildAvcCBox(spsNalus, ppsNalus, sps);
        }
    } else if (params.detectedCodec === 'h265') {
        const nalus = splitAnnexBNalUnits(params.configData);
        const vpsNalus = nalus.filter((n) => hevcNalType(n[0]!) === HEVC_NAL_TYPE.VPS);
        const spsNalus = nalus.filter((n) => hevcNalType(n[0]!) === HEVC_NAL_TYPE.SPS);
        const ppsNalus = nalus.filter((n) => hevcNalType(n[0]!) === HEVC_NAL_TYPE.PPS);
        if (vpsNalus.length > 0 && spsNalus.length > 0 && ppsNalus.length > 0) {
            const info = parseHevcSPSFull(spsNalus[0]!);
            config.description = buildHvcCBox(vpsNalus, spsNalus, ppsNalus, info);
        }
    }
    return config;
}
