export interface ScrcpyEncoders {
    videoEncoders: string[];
    audioEncoders: string[];
}

/**
 * Parse the output of `scrcpy-server list_encoders=true`.
 *
 * Expected format (from scrcpy v3.x LogUtils.buildEncoderListMessage):
 *
 *   [server] INFO: List of video encoders:
 *       --video-codec=h264 --video-encoder=OMX.qcom.video.encoder.avc
 *       --video-codec=h265 --video-encoder=c2.qti.hevc.encoder (hw) [vendor]
 *   [server] INFO: List of audio encoders:
 *       --audio-codec=opus --audio-encoder=c2.android.opus.encoder (sw)
 *
 * Trailing "(hw)/(sw)" / "[vendor]" / "(alias for X)" annotations (added on
 * API 29+) are ignored — we only capture the encoder name right up to the
 * first whitespace after --video-encoder= or --audio-encoder=.
 */
export function parseScrcpyEncoderList(output: string): ScrcpyEncoders {
    const videoEncoders: string[] = [];
    const audioEncoders: string[] = [];
    const videoRegex = /--video-encoder=(\S+)/g;
    const audioRegex = /--audio-encoder=(\S+)/g;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
    while ((m = videoRegex.exec(output)) !== null) videoEncoders.push(m[1]!);
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
    while ((m = audioRegex.exec(output)) !== null) audioEncoders.push(m[1]!);
    return { videoEncoders, audioEncoders };
}
