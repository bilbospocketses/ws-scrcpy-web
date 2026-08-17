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
