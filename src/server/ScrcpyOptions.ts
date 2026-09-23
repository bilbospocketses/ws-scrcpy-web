// src/server/ScrcpyOptions.ts
export interface ScrcpyOptions {
    scid: string;
    videoCodec?: 'h264' | 'h265' | 'av1' | 'vp8' | 'vp9';
    audioCodec?: 'opus' | 'aac' | 'flac' | 'raw';
    audioSource?: 'output' | 'playback' | 'mic';
    audioDup?: boolean;
    maxSize?: number;
    videoBitRate?: number;
    maxFps?: number;
    audio?: boolean;
    control?: boolean;
    displayId?: number;
    sendDeviceMeta?: boolean;
    sendCodecMeta?: boolean;
    sendFrameMeta?: boolean;
    tunnelForward?: boolean;
    cleanup?: boolean;
    videoEncoder?: string;
    /**
     * MediaFormat codec options as `key[:type]=value[,...]`, e.g.
     * `i-frame-interval:int=2`. scrcpy has no dedicated argument for the
     * keyframe interval, so it travels here.
     */
    videoCodecOptions?: string;
}

const DEFAULTS: Omit<Required<ScrcpyOptions>, 'scid' | 'videoEncoder' | 'videoCodecOptions'> = {
    videoCodec: 'h264',
    audioCodec: 'opus',
    audioSource: 'output',
    audioDup: false,
    maxSize: 0,
    videoBitRate: 8000000,
    maxFps: 0,
    audio: true,
    control: true,
    displayId: 0,
    sendDeviceMeta: true,
    sendCodecMeta: true,
    sendFrameMeta: true,
    tunnelForward: false,
    cleanup: true,
};

function toSnakeCase(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * The EFFECTIVE configuration, for the log (#703) — every setting with the
 * value actually in force, defaults included, and a `*` on the ones this
 * session set explicitly.
 *
 * `serializeOptions` cannot serve this purpose and it is worth saying why: it
 * emits only values that DIFFER from `DEFAULTS`, because that is the correct
 * argument list to hand scrcpy-server (scrcpy applies its own defaults for
 * anything omitted). A default session therefore serializes to exactly
 * `scid=<hex>` — measured 2026-09-23 against a live emulator session, where the
 * log line meant to settle "do our launch options differ from desktop scrcpy?"
 * printed one field, none of them a codec, a bit rate or a frame rate. The
 * literal argument list is what the device received; this is what it MEANS, and
 * a reporter needs the second to compare anything.
 */
export function describeEffectiveOptions(options: ScrcpyOptions): string {
    const parts: string[] = [];
    for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
        const value = (options as unknown as Record<string, unknown>)[key];
        const explicit = value !== undefined && value !== defaultValue;
        parts.push(`${toSnakeCase(key)}=${explicit ? value : defaultValue}${explicit ? '*' : ''}`);
    }
    // No entry in DEFAULTS, so the loop above cannot reach them — and these
    // two are the ones a black-screen report turns on.
    parts.push(`video_encoder=${options.videoEncoder ?? '(device default)'}${options.videoEncoder ? '*' : ''}`);
    parts.push(`video_codec_options=${options.videoCodecOptions ?? '(none)'}${options.videoCodecOptions ? '*' : ''}`);
    return parts.join(' ');
}

export function serializeOptions(options: ScrcpyOptions): string[] {
    const args: string[] = [];
    for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
        const value = (options as unknown as Record<string, unknown>)[key];
        if (value !== undefined && value !== defaultValue) {
            args.push(`${toSnakeCase(key)}=${value}`);
        }
    }
    // scid is always emitted
    args.push(`scid=${options.scid}`);
    if (options.videoEncoder) {
        args.push(`video_encoder=${options.videoEncoder}`);
    }
    if (options.videoCodecOptions) {
        args.push(`video_codec_options=${options.videoCodecOptions}`);
    }
    return args;
}
