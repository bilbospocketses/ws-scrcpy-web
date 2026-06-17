/**
 * Pure builder for the {@link VideoDecoderConfig} passed to
 * `VideoDecoder.configure()`.
 *
 * For H.264 / H.265 the SPS/PPS (and VPS) parameter sets are supplied once via
 * `description`, so the per-frame hot path no longer has to prepend the config
 * bytes to every keyframe (see finding #41). AV1 carries its sequence header in
 * the keyframe data itself, so no `description` is set for it.
 */
export interface BuildDecoderConfigParams {
    /** WebCodecs codec string, e.g. `avc1.42E01E` / `hev1.1.6.L93.B0` / `av01.0.04M.08`. */
    codec: string;
    detectedCodec: 'h264' | 'h265' | 'av1' | null;
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
