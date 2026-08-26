// src/common/ScrcpyCodec.ts
export const CODEC_ID = {
    H264: 0x68323634,
    H265: 0x68323635,
    AV1: 0x00617631,
    // 4-byte ASCII ids, same scheme as the others. Source: scrcpy v4.1
    // server VideoCodec.java (VP8 0x00_76_70_38, VP9 0x00_76_70_39).
    VP8: 0x00767038,
    VP9: 0x00767039,
    OPUS: 0x6f707573,
    AAC: 0x00616163,
    FLAC: 0x666c6163,
    RAW: 0x00726177,
} as const;

export const AUDIO_DISABLED = 0x00000000;
export const AUDIO_ERROR = 0x00000001;

export function codecName(id: number): string {
    switch (id) {
        case CODEC_ID.H264:
            return 'h264';
        case CODEC_ID.H265:
            return 'h265';
        case CODEC_ID.AV1:
            return 'av1';
        case CODEC_ID.VP8:
            return 'vp8';
        case CODEC_ID.VP9:
            return 'vp9';
        case CODEC_ID.OPUS:
            return 'opus';
        case CODEC_ID.AAC:
            return 'aac';
        case CODEC_ID.FLAC:
            return 'flac';
        case CODEC_ID.RAW:
            return 'raw';
        default:
            return `unknown(0x${id.toString(16)})`;
    }
}
