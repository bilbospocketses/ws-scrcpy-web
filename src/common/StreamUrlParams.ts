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
