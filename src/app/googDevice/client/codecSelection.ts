/**
 * Automatic video-codec selection: given what the device can encode and what
 * the browser can decode, pick the pair to stream with.
 *
 * Lives outside `StreamClientScrcpy` so it is unit-testable without the probe
 * request and the full stream lifecycle around it — same reasoning as
 * `scrcpyOptionsFromQuery` on the server side.
 */

/** Substring that identifies a codec inside an Android encoder name. */
export const CODEC_ENCODER_PATTERN: Record<string, string> = {
    h264: '.avc.',
    h265: '.hevc.',
    av1: '.av1.',
    vp8: '.vp8.',
    vp9: '.vp9.',
};

/**
 * Preference order for automatic selection.
 *
 * H.265 → H.264 → AV1 is unchanged and stays first: those are the codecs with
 * broad hardware encode and browser decode support, and they are what the vast
 * majority of devices should end up on.
 *
 * VP8/VP9 sit at the tail deliberately. They were added for devices that ship
 * no H.264/H.265/AV1 encoder at all, but automatic selection never considered
 * them — it walked the first three and then returned a bare `h264`, handing
 * exactly those devices a codec their hardware cannot produce. Appending them
 * closes that hole without changing what any other device gets, because a
 * device reaching the tail has already failed every entry ahead of it.
 */
export const CODEC_PREFERENCE: readonly string[] = ['h265', 'h264', 'av1', 'vp8', 'vp9'];

/**
 * Last resort when no codec in the preference order is usable.
 *
 * Still H.264: it is the one codec essentially every device and browser has
 * some path for, so it remains the best blind guess. Reaching it now means
 * genuinely nothing matched, rather than "the device only does VP8/VP9".
 */
export const FALLBACK_CODEC = 'h264';

/**
 * Hardware encoder vendor markers, preferred over the software `c2.android.*`
 * encoders.
 *
 * Known to be incomplete — Amlogic, HiSilicon and Rockchip are missing, so
 * Android TV boxes on those SoCs silently take the software path.
 */
const HW_ENCODER_RE = /\.mtk\.|\.qcom\.|\.exynos\.|\.intel\.|\.nvidia\./i;

export interface CodecChoice {
    videoCodec: string;
    encoderName?: string | undefined;
}

/** Does this device report any encoder for `codec`? */
export function deviceHasEncoderFor(videoEncoders: readonly string[], codec: string): boolean {
    const pattern = CODEC_ENCODER_PATTERN[codec];
    if (!pattern) return false;
    return videoEncoders.some((e) => e.toLowerCase().includes(pattern));
}

/** Best encoder for `codec` on this device — hardware if one is offered. */
export function pickEncoderForCodec(videoEncoders: readonly string[], codec: string): string | undefined {
    const pattern = CODEC_ENCODER_PATTERN[codec];
    if (!pattern) return undefined;
    const matching = videoEncoders.filter((e) => e.toLowerCase().includes(pattern));
    return matching.find((e) => HW_ENCODER_RE.test(e)) ?? matching[0];
}

/**
 * Walk the preference order and return the first codec the device can encode
 * and the browser can decode, together with the encoder to ask for.
 *
 * `canDecode` is injected rather than imported so the browser probe can be
 * substituted in tests; it is asked only about codecs the device can actually
 * produce, so a device with one encoder costs one probe rather than five.
 */
export async function chooseCodec(
    videoEncoders: readonly string[],
    canDecode: (codec: string) => Promise<boolean>,
    log: (message: string) => void = () => {},
): Promise<CodecChoice> {
    for (const codec of CODEC_PREFERENCE) {
        if (!deviceHasEncoderFor(videoEncoders, codec)) continue;
        if (!(await canDecode(codec))) {
            log(`Device has ${codec} encoder but browser cannot decode it`);
            continue;
        }
        const encoderName = pickEncoderForCodec(videoEncoders, codec);
        log(`Auto-detected: codec=${codec}, encoder=${encoderName}`);
        return { videoCodec: codec, encoderName };
    }
    return { videoCodec: FALLBACK_CODEC };
}

/**
 * Selection with no device information — used when the encoder probe fails.
 *
 * Browser support is the only signal available, so this is speculative for
 * every codec it can return; the device may not be able to encode the answer.
 * It walks the same preference order so the two paths cannot disagree about
 * what "preferred" means.
 */
export async function chooseCodecWithoutProbe(
    canDecode: (codec: string) => Promise<boolean>,
    log: (message: string) => void = () => {},
): Promise<CodecChoice> {
    for (const codec of CODEC_PREFERENCE) {
        if (await canDecode(codec)) {
            log(`Auto-detected best codec (no probe): ${codec}`);
            return { videoCodec: codec };
        }
    }
    return { videoCodec: FALLBACK_CODEC };
}
