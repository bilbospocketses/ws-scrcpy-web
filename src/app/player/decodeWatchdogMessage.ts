/**
 * Message for a decoder that configures cleanly, accepts every chunk, and then
 * never emits a frame — see `WebCodecsPlayer.armDecodeWatchdog`.
 *
 * Kept apart from the player because the text prescribes a browser, and a
 * message that prescribes a browser has to know which one it is talking to.
 * The first cut said "try a Chromium-based browser" unconditionally and pinned
 * a Firefox H.264/H.265 explanation to the end of every failure, so issue
 * #498's reporter got told to switch to Chromium while sitting in Chrome, and
 * read about H.264 decoding after a VP9 stream went black.
 */

export interface BrowserFamily {
    /** Chrome, Edge, Opera, Brave — anything on the Chromium engine. */
    isChromium: boolean;
    /** Firefox and other Gecko browsers. */
    isFirefox: boolean;
}

export interface WatchdogMessageContext extends BrowserFamily {
    /** scrcpy-side codec name, e.g. `h264` / `vp9`. */
    codec: string;
    timeoutMs: number;
}

/** Minimal shape of `navigator.userAgentData`, which only Chromium ships. */
interface UserAgentDataLike {
    brands?: { brand: string; version: string }[] | undefined;
}

/**
 * Work out the browser family from the user agent.
 *
 * Chromium exposes `navigator.userAgentData`; nothing else does, so its
 * presence is a positive signal on its own. The UA string is the fallback, and
 * has to reject Safari explicitly: Safari and Chrome both carry the
 * `AppleWebKit`/`Safari` tokens, and only Chrome adds `Chrome`.
 */
export function detectBrowserFamily(
    userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
    userAgentData: UserAgentDataLike | undefined = typeof navigator === 'undefined'
        ? undefined
        : (navigator as Navigator & { userAgentData?: UserAgentDataLike }).userAgentData,
): BrowserFamily {
    const isFirefox = /firefox|fxios/i.test(userAgent);
    const hasChromiumBrands = Boolean(userAgentData?.brands?.length);
    const isChromium = !isFirefox && (hasChromiumBrands || /chrome|chromium|crios|edg\/|opr\//i.test(userAgent));
    return { isChromium, isFirefox };
}

/**
 * Codec-and-browser-specific tail, or an empty string when we have nothing
 * useful to add. Only ever mentions the codec that actually failed.
 */
function decoderNote({ codec, isChromium, isFirefox }: WatchdogMessageContext): string {
    if (isFirefox && codec === 'h264') {
        return (
            ' Firefox delegates H.264 to the operating system, so a missing or outdated system decoder ' +
            'produces exactly this.'
        );
    }
    if (isFirefox && codec === 'h265') {
        return ' Firefox cannot decode H.265 at all.';
    }
    if (isChromium) {
        return ' An outdated or blocklisted graphics driver can also cause this — chrome://gpu reports the decoder status.';
    }
    return '';
}

export function decodeWatchdogMessage(context: WatchdogMessageContext): string {
    const { codec, timeoutMs, isChromium } = context;
    const remedy = isChromium
        ? 'try a different video codec'
        : 'try a different video codec, or a Chromium-based browser';
    return (
        `${codec}: decoder configured but produced no frames after ${timeoutMs}ms. ` +
        `Video is arriving but this browser is not decoding it — ${remedy}.` +
        decoderNote(context)
    );
}
