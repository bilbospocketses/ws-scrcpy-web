// src/server/audioCodecFallback.ts
//
// Pick an audio codec the device can actually encode.
//
// WHY THIS EXISTS. scrcpy's default audio codec is Opus, and a device without
// an Opus encoder does not degrade to silence — `MediaCodec` creation throws
// `IllegalArgumentException: Failed to initialize audio/opus, error 0xfffffffe
// (NAME_NOT_FOUND)`, the exception escapes the audio thread, and scrcpy-server
// exits. VIDEO dies with it, because it is the same process. Measured
// 2026-09-23 against redroid 13 (x86_64), whose whole audio encoder list is:
//
//     OMX.google.aac.encoder
//     OMX.google.flac.encoder
//
// That list is redroid's legacy OMX stack, which it falls back to only when the
// guest kernel has no /dev/dma_heap/system. On a kernel with it (stock Ubuntu
// 24.04 generic, for one), the same image runs Codec2 and DOES list
// c2.android.opus.encoder. So redroid is not a reliable fixture for this case;
// the unit tests carry it (TECHNICAL_GUIDE 25.9/25.10).
//
// The session produced `config=0 keyframe=0 frame=0 total=0 B` and the server
// exited 137 — a completely black screen caused by AUDIO. The existing SDK gate
// does not help: it forces audio off below SDK 30, and redroid reports SDK 33.
//
// This is not redroid-specific. Any device missing the configured codec loses
// its video stream, which is the outcome item 141 established a principle
// against: degrade, never take down what still works.
//
// DELIBERATELY PURE, so the decision can be tested without a device.

export type AudioCodec = 'opus' | 'aac' | 'flac' | 'raw';

/** Preference when the configured codec is unavailable. */
const FALLBACK_ORDER: readonly AudioCodec[] = ['aac', 'opus', 'flac'];

/**
 * `raw` is passthrough — it needs no encoder, so an encoder list says nothing
 * about whether it will work and must never be "corrected" away.
 */
const NEEDS_ENCODER: ReadonlySet<AudioCodec> = new Set<AudioCodec>(['opus', 'aac', 'flac']);

export interface AudioCodecDecision {
    /** A codec to switch to, or undefined to leave the configuration alone. */
    codec?: AudioCodec | undefined;
    /** Turn audio off entirely — last resort, and only on positive evidence. */
    disable: boolean;
    /** One sentence for the log. Always set, including when nothing changes. */
    reason: string;
}

function encoderSupports(encoderNames: readonly string[], codec: AudioCodec): boolean {
    // Encoder names look like `OMX.google.aac.encoder` or
    // `c2.android.opus.encoder`. Match the dotted segment rather than a bare
    // substring: `.aac.` cannot collide the way `aac` could inside a vendor
    // name, and this is the same shape DeviceProbe already parses with.
    return encoderNames.some((name) => name.toLowerCase().includes(`.${codec}.`));
}

/**
 * Decide what to do about audio, given what the device says it can encode.
 *
 * AN EMPTY LIST MEANS "UNKNOWN", NOT "NONE", and that distinction is the whole
 * safety of this function. `dumpsys media.player` does not report encoders on
 * every device or every Android version — that is precisely why DeviceProbe
 * has a second strategy for older ones. Reading silence as "no audio encoders
 * exist" would switch off working audio on any device whose dumpsys is quiet,
 * turning a diagnostic gap into a feature regression. So an empty list changes
 * nothing and says so.
 */
export function chooseAudioCodec(requested: AudioCodec, availableEncoderNames: readonly string[]): AudioCodecDecision {
    if (!NEEDS_ENCODER.has(requested)) {
        return { disable: false, reason: `audio codec '${requested}' needs no encoder; left as configured` };
    }
    if (availableEncoderNames.length === 0) {
        return {
            disable: false,
            reason: 'device reported no audio encoder list (unknown, not empty); audio left as configured',
        };
    }
    if (encoderSupports(availableEncoderNames, requested)) {
        return { disable: false, reason: `device can encode '${requested}'` };
    }

    const alternative = FALLBACK_ORDER.find(
        (codec) => codec !== requested && encoderSupports(availableEncoderNames, codec),
    );
    if (alternative) {
        return {
            codec: alternative,
            disable: false,
            reason:
                `device has no '${requested}' encoder; falling back to '${alternative}' ` +
                `(available: ${availableEncoderNames.join(', ')})`,
        };
    }

    return {
        disable: true,
        // Names what WAS found. "No usable encoder" with no list is the kind of
        // line that sends the next person to look at the wrong thing.
        reason:
            `device has no encoder for '${requested}' and none of ${FALLBACK_ORDER.join('/')} either ` +
            `(available: ${availableEncoderNames.join(', ')}); continuing WITHOUT audio so video survives`,
    };
}

/**
 * Pull audio encoder names out of `dumpsys media.player`.
 *
 * Deliberately the same regex DeviceProbe uses, kept here rather than imported
 * because DeviceProbe is a websocket endpoint driven by the browser — reaching
 * into it from the streaming path would couple a session start to a class whose
 * job is answering a different client request.
 */
export function parseAudioEncodersFromDumpsys(output: string): string[] {
    const regex = /Encoder "([^"]+)" supports/g;
    const found: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
        const name = match[1];
        if (name === undefined) continue;
        if (['opus', 'aac', 'flac'].some((c) => name.toLowerCase().includes(`.${c}.`))) {
            found.push(name);
        }
    }
    return found;
}
