import { isSafeEncoderName } from './security/deviceInput';
import type { ScrcpyOptions } from './ScrcpyOptions';

/**
 * Pure translation from the stream WebSocket's query string to a ScrcpyOptions
 * object. Lives outside ScrcpyConnection so it's unit-testable without the full
 * WS/ADB lifecycle around it.
 */
export function scrcpyOptionsFromQuery(params: URLSearchParams, scid: string): ScrcpyOptions {
    const options: ScrcpyOptions = { scid };

    const maxSize = params.get('maxSize');
    if (maxSize) options.maxSize = Number.parseInt(maxSize, 10);

    const bitrate = params.get('bitrate');
    if (bitrate) options.videoBitRate = Number.parseInt(bitrate, 10);

    const maxFps = params.get('maxFps');
    if (maxFps) options.maxFps = Number.parseInt(maxFps, 10);

    const displayId = params.get('displayId');
    if (displayId) options.displayId = Number.parseInt(displayId, 10);

    const videoCodec = params.get('videoCodec');
    if (videoCodec === 'h265' || videoCodec === 'av1') {
        options.videoCodec = videoCodec;
    }

    const audioCodec = params.get('audioCodec');
    if (audioCodec === 'aac' || audioCodec === 'flac' || audioCodec === 'raw') {
        options.audioCodec = audioCodec;
    }

    const audio = params.get('audio');
    if (audio === 'true') options.audio = true;
    else if (audio === 'false') options.audio = false;

    const audioSource = params.get('audioSource');
    if (audioSource === 'playback' || audioSource === 'output' || audioSource === 'mic') {
        options.audioSource = audioSource;
        // --audio-dup requires --audio-source=playback (and Android 13+). The
        // server-side SDK gate in ScrcpyConnection will force audio off entirely
        // if the device can't handle it; at this layer we just pair them.
        if (audioSource === 'playback') {
            options.audioDup = true;
        }
    }

    // videoEncoder is the only free-form string option, and it is serialized
    // into the `app_process ...` string that runs via `adb shell`. Allowlist it
    // to a safe charset so it cannot inject shell metacharacters.
    const videoEncoder = params.get('videoEncoder');
    if (videoEncoder && isSafeEncoderName(videoEncoder)) {
        options.videoEncoder = videoEncoder;
    }

    return options;
}
