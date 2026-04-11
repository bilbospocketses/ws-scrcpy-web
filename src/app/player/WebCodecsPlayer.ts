import type { DisplayInfo } from '../DisplayInfo';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import Size from '../Size';
import VideoSettings from '../VideoSettings';
import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import { BasePlayer } from './BasePlayer';
import { parseSPS } from './h264-utils';
import { hevcNalType, HEVC_NAL_TYPE, parseHevcSPS } from './h265-utils';
import { obuType, OBU_TYPE, parseAv1SequenceHeader } from './av1-utils';

function toHex(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static readonly storageKeyPrefix = 'WebCodecsPlayer';
    public static readonly playerFullName = 'WebCodecs';
    public static readonly playerCodeName = 'webcodecs';

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 8000000,
        maxFps: 60,
        iFrameInterval: 10,
        bounds: new Size(0, 0),
        sendFrameMeta: false,
    });

    public static isSupported(): boolean {
        return typeof VideoDecoder === 'function' && typeof VideoDecoder.isConfigSupported === 'function';
    }

    private static parseSPSCodecString(data: Uint8Array): { codec: string; width: number; height: number } {
        const {
            profile_idc,
            constraint_set_flags,
            level_idc,
            pic_width_in_mbs_minus1,
            frame_crop_left_offset,
            frame_crop_right_offset,
            frame_mbs_only_flag,
            pic_height_in_map_units_minus1,
            frame_crop_top_offset,
            frame_crop_bottom_offset,
            sar,
        } = parseSPS(data);

        const sarScale = sar[0] / sar[1];
        const codec = `avc1.${[profile_idc, constraint_set_flags, level_idc].map(toHex).join('')}`;
        const width = Math.ceil(
            ((pic_width_in_mbs_minus1 + 1) * 16 - frame_crop_left_offset * 2 - frame_crop_right_offset * 2) * sarScale,
        );
        const height =
            (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16 -
            (frame_mbs_only_flag ? 2 : 4) * (frame_crop_top_offset + frame_crop_bottom_offset);
        return { codec, width, height };
    }

    public readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D;
    private decoder: VideoDecoder;
    private configData?: Uint8Array;
    private detectedCodec: 'h264' | 'h265' | 'av1' | null = null;

    constructor(udid: string, displayInfo?: DisplayInfo, name = WebCodecsPlayer.playerFullName) {
        super(udid, displayInfo, name, WebCodecsPlayer.storageKeyPrefix);
        const context = this.tag.getContext('2d');
        if (!context) {
            throw Error('Failed to get 2d context from canvas');
        }
        this.context = context;
        this.decoder = this.createDecoder();
    }

    private createDecoder(): VideoDecoder {
        return new VideoDecoder({
            output: (frame) => {
                this.onFrameDecoded(0, 0, frame);
            },
            error: (error: DOMException) => {
                console.error('[WebCodecsPlayer]', error, `code: ${error.code}`);
                this.stop();
            },
        });
    }

    /**
     * Called by ScrcpyDemuxer via StreamClientScrcpy with pre-parsed frame metadata.
     * Replaces the old pushFrame(Uint8Array) → decode() pipeline.
     */
    public pushVideoFrame(data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void {
        // Track stats via BasePlayer
        BasePlayer.prototype.pushFrame.call(this, data);

        if (isConfig) {
            const result = this.parseConfig(data);
            if (result) {
                this.scaleCanvas(result.width, result.height);
                if (this.decoder.state === 'configured') {
                    this.decoder.flush().catch(() => {});
                }
                this.decoder.configure({
                    codec: result.codec,
                    optimizeForLatency: true,
                } as VideoDecoderConfig);
            }
            this.configData = new Uint8Array(data);
            return;
        }

        if (this.decoder.state !== 'configured') return;

        if (isKeyframe && this.configData) {
            if (!this.receivedFirstFrame) {
                this.receivedFirstFrame = true;
            }

            if (this.detectedCodec === 'av1') {
                // AV1: no config prepending needed
                this.decoder.decode(
                    new EncodedVideoChunk({
                        type: 'key',
                        timestamp: Number(pts),
                        data,
                    }),
                );
            } else {
                // H.264/H.265: prepend config (SPS/PPS or VPS/SPS/PPS)
                const fullData = new Uint8Array(this.configData.length + data.length);
                fullData.set(this.configData);
                fullData.set(data, this.configData.length);
                this.decoder.decode(
                    new EncodedVideoChunk({
                        type: 'key',
                        timestamp: Number(pts),
                        data: fullData,
                    }),
                );
            }
            return;
        }

        if (!this.receivedFirstFrame) return; // Skip delta frames before first keyframe

        this.decoder.decode(
            new EncodedVideoChunk({
                type: isKeyframe ? 'key' : 'delta',
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Find offset of NALU with given type in Annex B stream. Returns -1 if not found. */
    private findNaluOffset(data: Uint8Array, naluType: number): number {
        for (let i = 0; i < data.length - 4; i++) {
            // Look for start code 00 00 00 01 or 00 00 01
            if (data[i] === 0 && data[i + 1] === 0) {
                let offset: number;
                if (data[i + 2] === 1) {
                    offset = i + 3;
                } else if (data[i + 2] === 0 && data[i + 3] === 1) {
                    offset = i + 4;
                } else {
                    continue;
                }
                if (offset < data.length && (data[offset] & 0x1f) === naluType) {
                    return offset;
                }
            }
        }
        return -1;
    }

    private parseConfig(data: Uint8Array): { codec: string; width: number; height: number } | null {
        // Try Annex B start code detection (H.264/H.265)
        const naluOffset = this.findStartCode(data);
        if (naluOffset >= 0) {
            const firstByte = data[naluOffset];
            const h265Type = hevcNalType(firstByte);

            if (h265Type === HEVC_NAL_TYPE.VPS || h265Type === HEVC_NAL_TYPE.SPS) {
                this.detectedCodec = 'h265';
                const spsOffset = this.findHevcNalu(data, HEVC_NAL_TYPE.SPS);
                if (spsOffset >= 0) {
                    return parseHevcSPS(data.subarray(spsOffset));
                }
            } else {
                // H.264: check for SPS (type 7)
                const h264Type = firstByte & 0x1f;
                if (h264Type === 7) {
                    this.detectedCodec = 'h264';
                    const spsOffset = this.findNaluOffset(data, 7);
                    if (spsOffset >= 0) {
                        return WebCodecsPlayer.parseSPSCodecString(data.subarray(spsOffset));
                    }
                }
            }
            return null;
        }

        // No Annex B start code — try AV1 OBU
        if (data.length > 0 && obuType(data[0]) === OBU_TYPE.SEQUENCE_HEADER) {
            this.detectedCodec = 'av1';
            return parseAv1SequenceHeader(data);
        }

        return null;
    }

    private findStartCode(data: Uint8Array): number {
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0 && data[i + 1] === 0) {
                if (data[i + 2] === 1) return i + 3;
                if (data[i + 2] === 0 && data[i + 3] === 1) return i + 4;
            }
        }
        return -1;
    }

    private findHevcNalu(data: Uint8Array, nalType: number): number {
        for (let i = 0; i < data.length - 4; i++) {
            if (data[i] === 0 && data[i + 1] === 0) {
                let offset: number;
                if (data[i + 2] === 1) {
                    offset = i + 3;
                } else if (data[i + 2] === 0 && data[i + 3] === 1) {
                    offset = i + 4;
                } else {
                    continue;
                }
                if (offset < data.length && hevcNalType(data[offset]) === nalType) {
                    return offset;
                }
            }
        }
        return -1;
    }

    protected scaleCanvas(width: number, height: number): void {
        const videoSize = new Size(width, height);
        let scale = 1;
        if (this.bounds && !this.bounds.intersect(videoSize).equals(videoSize)) {
            scale = Math.min(this.bounds.w / width, this.bounds.h / height);
        }
        const w = width * scale;
        const h = height * scale;
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(w, h), 0);
        this.emit('input-video-resize', screenInfo);
        this.setScreenInfo(screenInfo);
        this.initCanvas(width, height);
        if (scale !== 1) {
            this.tag.style.transform = `scale(${scale.toFixed(4)})`;
        } else {
            this.tag.style.transform = '';
        }
        this.tag.style.transformOrigin = 'top left';
    }

    /** Legacy decode path — not used with v3.x demuxer. */
    protected decode(_data: Uint8Array): void {
        // No-op: v3.x uses pushVideoFrame() instead
    }

    protected drawDecoded = (): void => {
        if (this.receivedFirstFrame) {
            const data = this.decodedFrames.shift();
            if (data) {
                const frame: VideoFrame = data.frame;
                this.context.drawImage(frame, 0, 0);
                frame.close();
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected dropFrame(frame: VideoFrame): void {
        frame.close();
    }

    public getFitToScreenStatus(): boolean {
        return false;
    }

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public loadVideoSettings(): VideoSettings {
        return WebCodecsPlayer.loadVideoSettings(this.udid, this.displayInfo);
    }

    protected needScreenInfoBeforePlay(): boolean {
        return false;
    }

    public stop(): void {
        super.stop();
        if (this.decoder.state === 'configured') {
            this.decoder.close();
        }
        this.decoder = this.createDecoder();
        this.configData = undefined;
        this.detectedCodec = null;
    }
}
