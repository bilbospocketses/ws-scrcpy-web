export interface StreamParamsInput {
    udid: string;
    videoCodec?: string | undefined;
    audioCodec?: string | undefined;
    audioEnabled?: boolean | undefined;
    audioSource?: 'playback' | 'output' | 'mic' | undefined;
    encoderName?: string | undefined;
}

export interface VideoSettingsInput {
    bitrate?: number | undefined;
    maxFps?: number | undefined;
    bounds?: { width: number; height: number } | undefined;
    displayId?: number | undefined;
    /**
     * Seconds between keyframes. Reaches the device as a MediaFormat codec
     * option rather than a top-level scrcpy argument — see
     * {@link buildVideoCodecOptions}.
     */
    iFrameInterval?: number | undefined;
    /** Free-form `key[:type]=value` codec options entered by the user. */
    codecOptions?: string | undefined;
}

/** MediaFormat key for the keyframe interval (`MediaFormat.KEY_I_FRAME_INTERVAL`). */
const I_FRAME_INTERVAL_KEY = 'i-frame-interval';

/**
 * Build scrcpy's `video_codec_options` value.
 *
 * scrcpy has no top-level argument for the keyframe interval; it is passed
 * through to `MediaFormat` as a codec option in `key:type=value` form. The UI
 * collects an i-frame interval and a free-form codec-options string
 * separately, so they have to be merged into the one argument scrcpy accepts.
 *
 * A user-supplied `i-frame-interval` wins — if someone typed it into the
 * codec-options box explicitly, that is a deliberate override of the slider,
 * and emitting the key twice would be ambiguous.
 *
 * ⚠️ Sending the interval does NOT reliably change how often keyframes arrive.
 * scrcpy applies codec options after its own `KEY_I_FRAME_INTERVAL` default of
 * 10s, so the value does reach `MediaFormat` — verified on the device command
 * line — but Android encoders commonly ignore it, because an I-frame is not
 * necessarily an IDR frame and only IDR frames carry
 * `BUFFER_FLAG_KEY_FRAME`. Measured on a Pixel 10a: keyframe spacing stayed
 * around 14s whether the interval was sent as 2 or left at scrcpy's default.
 * Upstream reports the same (Genymobile/scrcpy issues 3260 and 4857).
 *
 * So this exists to stop silently discarding settings the UI collected, not as
 * a lever on keyframe cadence. The only reliable way to obtain a keyframe on
 * demand is `TYPE_RESET_VIDEO` — see `WebCodecsPlayer`'s decode watchdog.
 */
export function buildVideoCodecOptions(
    iFrameInterval?: number | undefined,
    codecOptions?: string | undefined,
): string | undefined {
    const parts: string[] = [];
    const user = codecOptions?.trim();
    const userSetsIFrame = user ? user.split(',').some((p) => p.trim().startsWith(`${I_FRAME_INTERVAL_KEY}:`)) : false;

    if (
        !userSetsIFrame &&
        typeof iFrameInterval === 'number' &&
        Number.isFinite(iFrameInterval) &&
        iFrameInterval > 0
    ) {
        parts.push(`${I_FRAME_INTERVAL_KEY}:int=${Math.round(iFrameInterval)}`);
    }
    if (user) {
        parts.push(user);
    }
    return parts.length > 0 ? parts.join(',') : undefined;
}

/**
 * Sets the URL search params used by the server's ScrcpyConnection to build
 * scrcpy-server arguments. Pure function so client URL construction is testable
 * without a live ScrcpyClient.
 *
 * `audioEnabled` serializes as `audio=true|false` only when explicitly set —
 * omitted values let the server use its existing default (scrcpy's default
 * audio=true on SDK>=30, forced off on SDK<30).
 */
export function applyStreamParams(url: URL, params: StreamParamsInput, videoSettings?: VideoSettingsInput): void {
    url.searchParams.set('action', 'stream');
    url.searchParams.set('udid', params.udid);

    if (videoSettings) {
        if (videoSettings.bitrate) url.searchParams.set('bitrate', videoSettings.bitrate.toString());
        if (videoSettings.maxFps) url.searchParams.set('maxFps', videoSettings.maxFps.toString());
        if (videoSettings.bounds) {
            const maxDim = Math.max(videoSettings.bounds.width, videoSettings.bounds.height);
            if (maxDim > 0) url.searchParams.set('maxSize', maxDim.toString());
        }
        if (videoSettings.displayId) url.searchParams.set('displayId', videoSettings.displayId.toString());
        // Both were collected by the advanced UI and persisted in
        // VideoSettings, then silently dropped here — so the codec-options box,
        // which is scrcpy's documented escape hatch, did nothing at all.
        const videoCodecOptions = buildVideoCodecOptions(videoSettings.iFrameInterval, videoSettings.codecOptions);
        if (videoCodecOptions) {
            url.searchParams.set('videoCodecOptions', videoCodecOptions);
        }
    }

    if (params.videoCodec && params.videoCodec !== 'h264') {
        url.searchParams.set('videoCodec', params.videoCodec);
    }

    if (params.audioCodec && params.audioCodec !== 'opus') {
        url.searchParams.set('audioCodec', params.audioCodec);
    }

    if (typeof params.audioEnabled === 'boolean') {
        url.searchParams.set('audio', params.audioEnabled ? 'true' : 'false');
    }

    if (params.audioSource) {
        url.searchParams.set('audioSource', params.audioSource);
    }

    if (params.encoderName) {
        url.searchParams.set('videoEncoder', params.encoderName);
    }
}
