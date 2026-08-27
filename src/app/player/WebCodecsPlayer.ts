import type { DisplayInfo } from '../DisplayInfo';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import Size from '../Size';
import VideoSettings from '../VideoSettings';
import { OBU_TYPE, obuType, parseAv1ConfigRecord, parseAv1SequenceHeader } from './av1-utils';
import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import { BasePlayer } from './BasePlayer';
import { decodeWatchdogMessage, detectBrowserFamily } from './decodeWatchdogMessage';
import { parseSPS, stripEmulationPrevention } from './h264-utils';
import { HEVC_NAL_TYPE, hevcNalType, parseHevcSPS } from './h265-utils';
import { annexBToLengthPrefixed, findFirstNaluOffset, findNaluByHeader } from './naluScanner';
import { buildDecoderConfig, isConfiglessCodec, type VideoCodecName, WEBCODECS_CODEC_STRING } from './webCodecsConfig';

function toHex(value: number) {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static override readonly storageKeyPrefix = 'WebCodecsPlayer';
    public static override readonly playerFullName = 'connect';
    public static override readonly playerCodeName = 'webcodecs';

    public static override readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 8000000,
        maxFps: 15,
        iFrameInterval: 2,
        bounds: new Size(0, 0),
        sendFrameMeta: false,
    });

    public static override isSupported(): boolean {
        return typeof VideoDecoder === 'function' && typeof VideoDecoder.isConfigSupported === 'function';
    }

    private static parseSPSCodecString(data: Uint8Array): { codec: string; width: number; height: number } {
        // Strip RBSP emulation-prevention bytes before bitstream parsing, mirroring
        // the H.265 path (parseHevcSPS strips internally). An SPS containing a
        // 00 00 03 triple would otherwise be mis-parsed (finding #42).
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
        } = parseSPS(stripEmulationPrevention(data));

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

    public override readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D;
    private decoder: VideoDecoder;
    private configData?: Uint8Array | undefined;
    private detectedCodec: VideoCodecName | null = null;
    /**
     * Whether a keyframe has been handed to the decoder yet. Deltas before that
     * point reference frames the decoder never saw.
     *
     * Deliberately NOT `receivedFirstFrame`: `BasePlayer.pushFrame` — which
     * `pushVideoFrame` calls first thing for stats — sets that on the first
     * frame of any kind, so it is already true by the time a delta is checked.
     * The codecs that send a config packet never noticed, because their decoder
     * stays unconfigured until it arrives and the state check drops early
     * frames instead. VP8/VP9 configure up front, so they need the real gate.
     */
    private seenKeyframe = false;
    private metadataWidth = 0;
    private metadataHeight = 0;
    private loggedFrameSize = false;
    /**
     * Grace period between configuring the decoder and the first frame landing.
     * Generous on purpose: this only has to beat "the user gives up", and a
     * cold hardware decoder plus a wait for the first keyframe can take a while.
     */
    private static readonly DECODE_WATCHDOG_MS = 5000;
    private decodeWatchdog: ReturnType<typeof setTimeout> | undefined;
    /**
     * Cap on keyframe requests per session. A stalled stream usually recovers
     * on the first one; a browser that cannot decode the codec at all never
     * will, and re-requesting forever would just pin the device's encoder.
     */
    private static readonly MAX_KEYFRAME_REQUESTS = 3;
    private keyframeRequests = 0;

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
                // Frames are flowing; whatever the watchdog was waiting for happened.
                this.clearDecodeWatchdog();
                if (!this.loggedFrameSize) {
                    console.log(
                        `[WebCodecsPlayer] First decoded frame: display=${frame.displayWidth}x${frame.displayHeight} coded=${frame.codedWidth}x${frame.codedHeight} canvas=${this.tag.width}x${this.tag.height}`,
                    );
                    this.loggedFrameSize = true;
                }
                this.onFrameDecoded(frame.displayWidth, frame.displayHeight, frame);
            },
            error: (error: DOMException) => {
                console.error('[WebCodecsPlayer]', error, `code: ${error.code}`);
                // Deliberately NOT stop(). stop() puts the player in STOPPED,
                // and `StreamClientScrcpy.onVideoFrame` only revives a player
                // from PAUSED — so a single decoder fault used to kill the
                // session permanently while video kept arriving. Recover in
                // place instead and ask for a keyframe to resynchronise on.
                this.recoverDecoder('decoder-error');
            },
        });
    }

    /**
     * Rebuild the decoder after a fault and ask for a fresh keyframe.
     *
     * The re-configure only applies to VP8/VP9: every other codec re-configures
     * when its next config packet arrives, and those codecs send one alongside
     * every keyframe. VP8/VP9 send no usable one (see `CONFIGLESS_CODECS`), so
     * the decoder has to be set up from session metadata again here or the
     * keyframe we are about to request would arrive with nowhere to go.
     */
    private recoverDecoder(reason: 'no-frames' | 'decoder-error'): void {
        const codec = this.detectedCodec;
        this.clearDecodeWatchdog();
        if (this.decoder.state !== 'closed') {
            try {
                this.decoder.close();
            } catch {
                // Already closing/closed — the replacement below is what matters.
            }
        }
        this.decoder = this.createDecoder();
        this.seenKeyframe = false;
        this.configData = undefined;
        if (codec && isConfiglessCodec(codec)) {
            this.detectedCodec = codec;
            this.configureFromMetadata(codec);
        }
        this.emit('video-stalled', { codec: codec ?? 'unknown', reason });
    }

    /**
     * Watch for a decoder that configures cleanly, accepts every chunk, and
     * then never emits a frame.
     *
     * The `error` callback covers decoders that fault. This covers the silent
     * shape: on a browser that reports support it does not actually have — or
     * delegates to an OS decoder that isn't installed — `configure()` and
     * `decode()` both succeed and nothing ever comes out, leaving a black
     * canvas and an empty console. That cost issue #498 three round trips to
     * identify, so it now says so out loud.
     */
    private armDecodeWatchdog(codec: string): void {
        this.clearDecodeWatchdog();
        this.decodeWatchdog = setTimeout(() => {
            this.decodeWatchdog = undefined;
            // The full explanation is worth saying once. Retries below add a
            // short line each instead, so a stream that never recovers does not
            // paste the same paragraph into the console every five seconds.
            if (this.keyframeRequests === 0) {
                // Prefix stays a constant in the format position; the
                // codec-bearing message goes in as a substitution arg (see
                // TECHNICAL_GUIDE §8.3).
                console.error(
                    '[WebCodecsPlayer]',
                    decodeWatchdogMessage({
                        codec,
                        timeoutMs: WebCodecsPlayer.DECODE_WATCHDOG_MS,
                        ...detectBrowserFamily(),
                    }),
                );
            }
            // Reporting the stall was never enough on its own. Ask the device
            // for a keyframe, then wait again — bounded, because a browser that
            // genuinely cannot decode this codec will never recover and should
            // not have reset requests pinned on it forever.
            if (this.keyframeRequests < WebCodecsPlayer.MAX_KEYFRAME_REQUESTS) {
                this.keyframeRequests += 1;
                console.log(
                    '[WebCodecsPlayer]',
                    `${codec}: requesting a fresh keyframe (attempt ${this.keyframeRequests}/${WebCodecsPlayer.MAX_KEYFRAME_REQUESTS})`,
                );
                this.emit('video-stalled', { codec, reason: 'no-frames' });
                this.armDecodeWatchdog(codec);
            }
        }, WebCodecsPlayer.DECODE_WATCHDOG_MS);
    }

    private clearDecodeWatchdog(): void {
        if (this.decodeWatchdog !== undefined) {
            clearTimeout(this.decodeWatchdog);
            this.decodeWatchdog = undefined;
        }
    }

    /**
     * Called by ScrcpyDemuxer via StreamClientScrcpy with pre-parsed frame metadata.
     * Replaces the old pushFrame(Uint8Array) → decode() pipeline.
     */
    public pushVideoFrame(data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void {
        // Track stats via BasePlayer. Pass the demuxer's real keyframe flag so the
        // shared signature carries it (works for H.264/H.265/AV1) — see finding #43.
        BasePlayer.prototype.pushFrame.call(this, data, isKeyframe);

        if (isConfig) {
            let result: { codec: string; width?: number; height?: number } | null = null;
            try {
                result = this.parseConfig(data);
            } catch (e) {
                console.error('[WebCodecsPlayer] parseConfig error:', e);
            }
            if (result) {
                // Coded dimensions from codec SPS (may include alignment padding, e.g. 1088 for 1080)
                const codedW = result.width || this.metadataWidth;
                const codedH = result.height || this.metadataHeight;
                // Display dimensions from scrcpy metadata (actual device screen size).
                // scrcpy-server rejects touch events whose screenSize doesn't match its video size,
                // so we must use display dimensions for canvas/touch sizing, not coded dimensions.
                const displayW = this.metadataWidth || result.width;
                const displayH = this.metadataHeight || result.height;
                if (displayW && displayH && displayW > 0 && displayH > 0) {
                    this.scaleCanvas(displayW, displayH);
                }
                if (this.decoder.state === 'configured') {
                    this.decoder.flush().catch(() => {});
                }
                // Supply SPS/PPS (and VPS for H.265) once via `description` so the
                // per-frame keyframe path no longer concatenates config + frame data.
                this.decoder.configure(
                    buildDecoderConfig({
                        codec: result.codec,
                        detectedCodec: this.detectedCodec,
                        codedWidth: codedW,
                        codedHeight: codedH,
                        configData: data,
                    }),
                );
                this.armDecodeWatchdog(this.detectedCodec ?? result.codec);
            }
            this.configData = new Uint8Array(data);
            return;
        }

        if (this.decoder.state !== 'configured') return;

        // The avcC/hvcC `description` set at configure() time declares 4-byte
        // length-prefixed NAL framing — every chunk must match it. scrcpy's wire
        // format is Annex B, so H.264/H.265 need re-framing; AV1, VP8 and VP9
        // have no NAL framing concept and pass through untouched.
        const chunkData =
            this.detectedCodec === 'h264' || this.detectedCodec === 'h265' ? annexBToLengthPrefixed(data) : data;

        // `configData` is the readiness signal for codecs that send a config
        // packet. VP8/VP9 never send one — the decoder was configured up front
        // from session metadata instead — so gate on "decoder is ready" rather
        // than "config bytes arrived", or every frame would be dropped below.
        if (isKeyframe && (this.configData || isConfiglessCodec(this.detectedCodec))) {
            if (!this.receivedFirstFrame) {
                this.receivedFirstFrame = true;
            }
            this.seenKeyframe = true;

            this.decoder.decode(
                new EncodedVideoChunk({
                    type: 'key',
                    timestamp: Number(pts),
                    data: chunkData,
                }),
            );
            return;
        }

        if (!this.seenKeyframe) return; // Skip delta frames before first keyframe

        this.decoder.decode(
            new EncodedVideoChunk({
                type: isKeyframe ? 'key' : 'delta',
                timestamp: Number(pts),
                data: chunkData,
            }),
        );
    }

    /** Find offset of NALU with given type in Annex B stream. Returns -1 if not found. */
    private findNaluOffset(data: Uint8Array, naluType: number): number {
        return findNaluByHeader(data, (b) => (b & 0x1f) === naluType);
    }

    private parseConfig(data: Uint8Array): { codec: string; width?: number; height?: number } | null {
        // Try Annex B start code detection (H.264/H.265)
        const naluOffset = this.findStartCode(data);
        if (naluOffset >= 0) {
            const firstByte = data[naluOffset]!;
            const h265Type = hevcNalType(firstByte);

            if (h265Type === HEVC_NAL_TYPE.VPS || h265Type === HEVC_NAL_TYPE.SPS) {
                this.detectedCodec = 'h265';
                const spsOffset = this.findHevcNalu(data, HEVC_NAL_TYPE.SPS);
                if (spsOffset >= 0) {
                    return parseHevcSPS(data.subarray(spsOffset));
                }
            } else {
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

        // No Annex B start code — try AV1
        if (data.length >= 4) {
            // Try AV1CodecConfigurationRecord first (4 bytes, marker=1)
            const configRecord = parseAv1ConfigRecord(data);
            if (configRecord) {
                this.detectedCodec = 'av1';
                return { ...configRecord, width: 0, height: 0 };
            }
            // Try raw OBU Sequence Header
            if (obuType(data[0]!) === OBU_TYPE.SEQUENCE_HEADER) {
                this.detectedCodec = 'av1';
                return parseAv1SequenceHeader(data);
            }
        }

        return null;
    }

    private findStartCode(data: Uint8Array): number {
        return findFirstNaluOffset(data);
    }

    private findHevcNalu(data: Uint8Array, nalType: number): number {
        return findNaluByHeader(data, (b) => hevcNalType(b) === nalType);
    }

    /** Set fallback dimensions from stream metadata (used by AV1 which doesn't include dimensions in config). */
    public setMetadataSize(width: number, height: number): void {
        this.metadataWidth = width;
        this.metadataHeight = height;
    }

    /**
     * VP8/VP9 arrive without a config packet (see `CONFIGLESS_CODECS`), so the
     * `isConfig` branch in {@link pushVideoFrame} — where every other codec has
     * its decoder configured — is never reached for them. Session metadata
     * carries everything the decoder needs, so configure from that instead.
     *
     * Safe to do here: `StreamClientScrcpy.onMetadata` calls
     * {@link setMetadataSize} before this, so the dimensions are already in
     * place by the time we run.
     */
    public override setSessionInfo(videoCodec: string, audioCodec: string, encoder?: string): void {
        super.setSessionInfo(videoCodec, audioCodec, encoder);
        const codec = videoCodec?.toLowerCase();
        if (isConfiglessCodec(codec)) {
            this.configureFromMetadata(codec as VideoCodecName);
        }
    }

    private configureFromMetadata(codec: VideoCodecName): void {
        const width = this.metadataWidth;
        const height = this.metadataHeight;
        if (!width || !height) {
            console.error(`[WebCodecsPlayer] ${codec}: no metadata dimensions, cannot configure decoder`);
            return;
        }
        const codecString = WEBCODECS_CODEC_STRING[codec];
        if (!codecString) {
            console.error(`[WebCodecsPlayer] no WebCodecs codec string for ${codec}`);
            return;
        }
        this.detectedCodec = codec;
        this.scaleCanvas(width, height);
        this.decoder.configure(
            buildDecoderConfig({
                codec: codecString,
                detectedCodec: codec,
                codedWidth: width,
                codedHeight: height,
                // These codecs have no parameter sets; buildDecoderConfig only
                // reads configData for H.264/H.265.
                configData: new Uint8Array(0),
            }),
        );
        this.armDecodeWatchdog(codec);
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
    protected override decode(_data: Uint8Array): void {
        // No-op: v3.x uses pushVideoFrame() instead
    }

    protected override drawDecoded = (): void => {
        if (this.receivedFirstFrame) {
            const data = this.decodedFrames.shift();
            if (data) {
                const frame: VideoFrame = data.frame;
                const cw = this.tag.width;
                const ch = this.tag.height;
                // Edge H.265: displayWidth differs from codedWidth. Use full coded
                // rect as source to draw the complete frame, not just the visible rect.
                if (frame.displayWidth !== frame.codedWidth || frame.displayHeight !== frame.codedHeight) {
                    this.context.drawImage(frame, 0, 0, frame.codedWidth, frame.codedHeight, 0, 0, cw, ch);
                } else {
                    this.context.drawImage(frame, 0, 0);
                }
                frame.close();
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected override dropFrame(frame: VideoFrame): void {
        frame.close();
    }

    public override getFitToScreenStatus(): boolean {
        return false;
    }

    public override getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public override loadVideoSettings(): VideoSettings {
        return WebCodecsPlayer.loadVideoSettings(this.udid, this.displayInfo);
    }

    protected override needScreenInfoBeforePlay(): boolean {
        return false;
    }

    public override stop(): void {
        super.stop();
        this.clearDecodeWatchdog();
        if (this.decoder.state === 'configured') {
            this.decoder.close();
        }
        this.decoder = this.createDecoder();
        this.configData = undefined;
        this.detectedCodec = null;
        this.seenKeyframe = false;
        this.keyframeRequests = 0;
    }
}
