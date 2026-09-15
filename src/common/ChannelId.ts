// src/common/ChannelId.ts
export enum ChannelId {
    VIDEO = 0,
    AUDIO = 1,
    CONTROL = 2,
    DEVICE_MSG = 3,
    METADATA = 4,
    /**
     * A mid-stream capture-session change: the device rotated, or the capture
     * was resized (item 24). Its own channel rather than a re-sent METADATA,
     * because METADATA is the once-per-session envelope — `StreamClientScrcpy`
     * builds the AudioPlayer from it, so re-firing it on every rotation would
     * spawn a fresh audio pipeline each time. A rotation is not "the session
     * metadata arrived", it is "the capture session changed".
     */
    SESSION = 5,
}
