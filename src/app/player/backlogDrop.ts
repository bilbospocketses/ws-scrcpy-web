/**
 * Pure decision for the canvas backlog-drop on the decode path.
 *
 * When a keyframe arrives and the undecoded backlog has grown past half the
 * target frame rate, the player flushes the backlog (the keyframe lets it
 * resync cleanly). This used to be gated on `BasePlayer.isIFrame`, which only
 * recognises H.264 IDR NALs and silently missed H.265/AV1 keyframes (finding
 * #43). The keyframe signal now comes from the demuxer's PTS_FLAG_KEYFRAME.
 */
export function shouldDropBacklog(isKeyframe: boolean, framesListLength: number, maxFps: number): boolean {
    return isKeyframe && framesListLength > maxFps / 2;
}
