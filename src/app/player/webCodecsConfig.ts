/**
 * Pure builder for the {@link VideoDecoderConfig} passed to
 * `VideoDecoder.configure()`.
 *
 * For H.264 / H.265 the SPS/PPS (and VPS) parameter sets are supplied once via
 * `description`, so the per-frame hot path no longer has to prepend the config
 * bytes to every keyframe (see finding #41). AV1 carries its sequence header in
 * the keyframe data itself, so no `description` is set for it.
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
 * Codecs that never produce a config packet.
 *
 * scrcpy sets its config flag straight from MediaCodec's
 * `BUFFER_FLAG_CODEC_CONFIG` (`Streamer.writePacket`), with no video-codec
 * special-casing. VP8 and VP9 carry no out-of-band parameter sets — everything
 * the decoder needs is in the keyframe — so MediaCodec emits no such buffer and
 * scrcpy sends no config packet. Players must therefore configure these from
 * session metadata rather than waiting for a config frame that never arrives.
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
    // H.264/H.265: hand the parameter sets to the decoder once via `description`.
    // Copy so the decoder's view can't be mutated by later reuse of the source buffer.
    if (params.detectedCodec === 'h264' || params.detectedCodec === 'h265') {
        config.description = new Uint8Array(params.configData);
    }
    return config;
}
