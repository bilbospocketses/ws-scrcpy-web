/**
 * Automatic video-codec selection: given what the device can encode and what
 * the browser can decode, pick the pair to stream with.
 *
 * Lives outside `StreamClientScrcpy` so it is unit-testable without the probe
 * request and the full stream lifecycle around it — same reasoning as
 * `scrcpyOptionsFromQuery` on the server side.
 */

/**
 * Substrings that identify a codec inside an Android encoder name.
 *
 * H.264 and H.265 each have two spellings in the wild, and the difference is
 * not cosmetic: this Pixel 10a reports **both** `c2.android.avc.encoder` (the
 * software one) and `c2.exynos.h264.encoder` (hardware). Matching only `.avc.`
 * hid the hardware encoder completely and quietly forced every h264 session
 * onto the software path.
 */
export const CODEC_ENCODER_PATTERNS: Record<string, readonly string[]> = {
    h264: ['.avc.', '.h264.'],
    h265: ['.hevc.', '.h265.'],
    av1: ['.av1.'],
    vp8: ['.vp8.'],
    vp9: ['.vp9.'],
};

/** Does this encoder name belong to `codec`, under any of its spellings? */
export function encoderMatchesCodec(encoderName: string, codec: string): boolean {
    const patterns = CODEC_ENCODER_PATTERNS[codec];
    if (!patterns) return false;
    const lower = encoderName.toLowerCase();
    return patterns.some((p) => lower.includes(p));
}

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
 * Recognise the *software* encoders rather than enumerating hardware vendors.
 *
 * This used to be an allow-list of vendor markers —
 * `.mtk.|.qcom.|.exynos.|.intel.|.nvidia.` — which meant every SoC nobody had
 * thought of silently fell through to a software encoder: Amlogic (very common
 * in Android TV boxes), HiSilicon, Rockchip, and anything shipped since. The
 * gap was invisible in testing because both TV Streamers here are MediaTek and
 * both phones Exynos, so they all matched.
 *
 * Inverting it fails safe. Android's software codecs are named by a short,
 * stable convention (`c2.android.*`, and the legacy `OMX.google.*`), so
 * anything else is vendor silicon whether or not we have heard of it.
 */
const SOFTWARE_ENCODER_RE = /(^|\.)c2\.android\.|^omx\.google\./i;

/** Whether this is one of Android's own software encoders. */
export function isSoftwareEncoder(encoderName: string): boolean {
    return SOFTWARE_ENCODER_RE.test(encoderName);
}

export interface CodecChoice {
    videoCodec: string;
    encoderName?: string | undefined;
}

/** Does this device report any encoder for `codec`? */
export function deviceHasEncoderFor(videoEncoders: readonly string[], codec: string): boolean {
    return videoEncoders.some((e) => encoderMatchesCodec(e, codec));
}

/** Best encoder for `codec` on this device — hardware if one is offered. */
export function pickEncoderForCodec(videoEncoders: readonly string[], codec: string): string | undefined {
    const matching = videoEncoders.filter((e) => encoderMatchesCodec(e, codec));
    return matching.find((e) => !isSoftwareEncoder(e)) ?? matching[0];
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
