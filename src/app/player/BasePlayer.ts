import { TypedEmitter } from '../../common/TypedEmitter';
import { DisplayInfo } from '../DisplayInfo';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import Size from '../Size';
import Util from '../Util';
import VideoSettings from '../VideoSettings';
import { AnimationFrameGuard } from './animationFrameGuard';
import { stringArraysDiffer } from './statsDiff';

interface BitrateStat {
    timestamp: number;
    bytes: number;
}

interface FramesPerSecondStats {
    avgInput: number;
    avgDecoded: number;
    avgDropped: number;
    avgSize: number;
}

export interface PlaybackQuality {
    decodedFrames: number;
    droppedFrames: number;
    inputFrames: number;
    inputBytes: number;
    timestamp: number;
}

export interface PlayerEvents {
    'video-view-resize': Size;
    'input-video-resize': ScreenInfo;
    'video-settings': VideoSettings;
}

export interface PlayerClass {
    playerFullName: string;
    playerCodeName: string;
    storageKeyPrefix: string;
    isSupported(): boolean;
    getPreferredVideoSetting(): VideoSettings;
    getFitToScreenStatus(deviceName: string, displayInfo?: DisplayInfo): boolean;
    loadVideoSettings(deviceName: string, displayInfo?: DisplayInfo): VideoSettings;
    saveVideoSettings(
        deviceName: string,
        videoSettings: VideoSettings,
        fitToScreen: boolean,
        displayInfo?: DisplayInfo,
    ): void;
    new (udid: string, displayInfo?: DisplayInfo): BasePlayer;
}

export abstract class BasePlayer extends TypedEmitter<PlayerEvents> {
    private static readonly STAT_BACKGROUND: string = 'rgba(0, 0, 0, 0.5)';
    private static readonly STAT_TEXT_COLOR: string = 'hsl(24, 85%, 50%)';
    public static readonly DEFAULT_SHOW_QUALITY_STATS = false;
    public static STATE: Record<string, number> = {
        PLAYING: 1,
        PAUSED: 2,
        STOPPED: 3,
    };
    private static STATS_HEIGHT = 12;
    protected screenInfo?: ScreenInfo | undefined;
    protected videoSettings: VideoSettings;
    protected parentElement?: HTMLElement | undefined;
    protected touchableCanvas: HTMLCanvasElement;
    protected inputBytes: BitrateStat[] = [];
    protected perSecondQualityStats?: FramesPerSecondStats | undefined;
    protected momentumQualityStats?: PlaybackQuality | undefined;
    protected bounds: Size | null = null;
    protected sessionVideoCodec?: string | undefined;
    protected sessionAudioCodec?: string | undefined;
    protected sessionEncoder?: string | undefined;
    private totalStats: PlaybackQuality = {
        decodedFrames: 0,
        droppedFrames: 0,
        inputFrames: 0,
        inputBytes: 0,
        timestamp: 0,
    };
    private totalStatsCounter = 0;
    private dirtyStatsWidth = 0;
    private state: number = BasePlayer.STATE['STOPPED']!;
    // Single guarded rAF handle for the quality-stats loop — prevents the
    // double-start / cancel-leak the raw id allowed (finding #44).
    private readonly qualityStatsRaf = new AnimationFrameGuard();
    private showQualityStats = BasePlayer.DEFAULT_SHOW_QUALITY_STATS;
    protected receivedFirstFrame = false;
    private statLines: string[] = [];
    public readonly supportsScreenshot: boolean = false;
    public readonly resizeVideoToBounds: boolean = false;
    protected videoHeight = -1;
    protected videoWidth = -1;

    public static storageKeyPrefix = 'BaseDecoder';
    public static playerFullName = 'BasePlayer';
    public static playerCodeName = 'baseplayer';
    public static preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 524288,
        maxFps: 15,
        iFrameInterval: 5,
        bounds: new Size(480, 480),
        sendFrameMeta: false,
    });

    public static isSupported(): boolean {
        // Implement the check in a child class
        return false;
    }

    constructor(
        public readonly udid: string,
        protected displayInfo?: DisplayInfo,
        protected name = 'BasePlayer',
        protected storageKeyPrefix = 'Dummy',
        protected tag: HTMLElement = document.createElement('div'),
    ) {
        super();
        this.touchableCanvas = document.createElement('canvas');
        this.touchableCanvas.className = 'touch-layer';
        this.touchableCanvas.oncontextmenu = (event: MouseEvent): void => {
            event.preventDefault();
        };
        const preferred = this.getPreferredVideoSetting();
        this.videoSettings = BasePlayer.getVideoSettingFromStorage(preferred, this.storageKeyPrefix, udid, displayInfo);
    }

    protected calculateScreenInfoForBounds(videoWidth: number, videoHeight: number): void {
        this.videoWidth = videoWidth;
        this.videoHeight = videoHeight;
        if (this.resizeVideoToBounds) {
            let w = videoWidth;
            let h = videoHeight;
            if (this.bounds) {
                let { w: boundsWidth, h: boundsHeight } = this.bounds;
                if (w > boundsWidth || h > boundsHeight) {
                    let scaledHeight;
                    let scaledWidth;
                    if (boundsWidth > w) {
                        scaledHeight = h;
                    } else {
                        scaledHeight = (boundsWidth * h) / w;
                    }
                    if (boundsHeight > scaledHeight) {
                        boundsHeight = scaledHeight;
                    }
                    if (boundsHeight === h) {
                        scaledWidth = w;
                    } else {
                        scaledWidth = (boundsHeight * w) / h;
                    }
                    if (boundsWidth > scaledWidth) {
                        boundsWidth = scaledWidth;
                    }
                    w = boundsWidth | 0;
                    h = boundsHeight | 0;
                    this.tag.style.maxWidth = `${w}px`;
                    this.tag.style.maxHeight = `${h}px`;
                }
            }
            const realScreen = new ScreenInfo(new Rect(0, 0, videoWidth, videoHeight), new Size(w, h), 0);
            this.emit('input-video-resize', realScreen);
            this.setScreenInfo(new ScreenInfo(new Rect(0, 0, w, h), new Size(w, h), 0));
        }
    }

    protected static isIFrame(frame: Uint8Array): boolean {
        // last 5 bits === 5: Coded slice of an IDR picture

        // https://www.ietf.org/rfc/rfc3984.txt
        // 1.3.  Network Abstraction Layer Unit Types
        // https://www.itu.int/rec/T-REC-H.264-201906-I/en
        // Table 7-1 – NAL unit type codes, syntax element categories, and NAL unit type classes
        return frame && frame.length > 4 && (frame[4]! & 31) === 5;
    }

    private static getStorageKey(storageKeyPrefix: string, udid: string): string {
        const { innerHeight, innerWidth } = window;
        return `${storageKeyPrefix}:${udid}:${innerWidth}x${innerHeight}`;
    }

    private static getFullStorageKey(storageKeyPrefix: string, udid: string, displayInfo?: DisplayInfo): string {
        const { innerHeight, innerWidth } = window;
        let base = `${storageKeyPrefix}:${udid}:${innerWidth}x${innerHeight}`;
        if (displayInfo) {
            const { displayId, size } = displayInfo;
            base = `${base}:${displayId}:${size.width}x${size.height}`;
        }
        return base;
    }

    public static getFromStorageCompat(prefix: string, udid: string, displayInfo?: DisplayInfo): string | null {
        const shortKey = this.getStorageKey(prefix, udid);
        const savedInShort = window.localStorage.getItem(shortKey);
        if (!displayInfo) {
            return savedInShort;
        }
        const isDefaultDisplay = displayInfo.displayId === DisplayInfo.DEFAULT_DISPLAY;
        const fullKey = this.getFullStorageKey(prefix, udid, displayInfo);
        const savedInFull = window.localStorage.getItem(fullKey);
        if (savedInFull) {
            if (savedInShort && isDefaultDisplay) {
                window.localStorage.removeItem(shortKey);
            }
            return savedInFull;
        }
        if (isDefaultDisplay) {
            return savedInShort;
        }
        return null;
    }

    public static getFitToScreenFromStorage(
        storageKeyPrefix: string,
        udid: string,
        displayInfo?: DisplayInfo,
    ): boolean {
        if (!window.localStorage) {
            return false;
        }
        let parsedValue = false;
        const key = `${this.getFullStorageKey(storageKeyPrefix, udid, displayInfo)}:fit`;
        const saved = window.localStorage.getItem(key);
        if (!saved) {
            return false;
        }
        try {
            parsedValue = JSON.parse(saved);
        } catch (_error: any) {
            console.error(`[${this.name}]`, 'Failed to parse', saved);
        }
        return parsedValue;
    }

    public static getVideoSettingFromStorage(
        preferred: VideoSettings,
        storageKeyPrefix: string,
        udid: string,
        displayInfo?: DisplayInfo,
    ): VideoSettings {
        if (!window.localStorage) {
            return preferred;
        }
        const saved = this.getFromStorageCompat(storageKeyPrefix, udid, displayInfo);
        if (!saved) {
            return preferred;
        }
        const parsed = JSON.parse(saved);
        const {
            displayId,
            crop,
            bitrate,
            iFrameInterval,
            sendFrameMeta,
            lockedVideoOrientation,
            codecOptions,
            encoderName,
        } = parsed;

        // REMOVE `frameRate`
        // parsed.* come from JSON.parse and may be undefined / strings; wrap in
        // Number() so Number.isNaN replicates the old isNaN coercion (undefined -> NaN
        // -> fall back to the preferred default), which a bare Number.isNaN would not.
        const maxFps = Number.isNaN(Number(parsed.maxFps)) ? parsed.frameRate : parsed.maxFps;
        // REMOVE `maxSize`
        let bounds: Size | null = null;
        if (
            typeof parsed.bounds !== 'object' ||
            Number.isNaN(Number(parsed.bounds.width)) ||
            Number.isNaN(Number(parsed.bounds.height))
        ) {
            if (!Number.isNaN(Number(parsed.maxSize))) {
                bounds = new Size(parsed.maxSize, parsed.maxSize);
            }
        } else {
            bounds = new Size(parsed.bounds.width, parsed.bounds.height);
        }
        return new VideoSettings({
            displayId: typeof displayId === 'number' ? displayId : 0,
            crop: crop ? new Rect(crop.left, crop.top, crop.right, crop.bottom) : preferred.crop,
            bitrate: !Number.isNaN(Number(bitrate)) ? bitrate : preferred.bitrate,
            bounds: bounds !== null ? bounds : preferred.bounds,
            maxFps: !Number.isNaN(Number(maxFps)) ? maxFps : preferred.maxFps,
            iFrameInterval: !Number.isNaN(Number(iFrameInterval)) ? iFrameInterval : preferred.iFrameInterval,
            sendFrameMeta: typeof sendFrameMeta === 'boolean' ? sendFrameMeta : preferred.sendFrameMeta,
            lockedVideoOrientation: !Number.isNaN(Number(lockedVideoOrientation))
                ? lockedVideoOrientation
                : preferred.lockedVideoOrientation,
            codecOptions,
            encoderName,
        });
    }

    protected static putVideoSettingsToStorage(
        storageKeyPrefix: string,
        udid: string,
        videoSettings: VideoSettings,
        fitToScreen: boolean,
        displayInfo?: DisplayInfo,
    ): void {
        if (!window.localStorage) {
            return;
        }
        const key = this.getFullStorageKey(storageKeyPrefix, udid, displayInfo);
        window.localStorage.setItem(key, JSON.stringify(videoSettings));
        const fitKey = `${key}:fit`;
        window.localStorage.setItem(fitKey, JSON.stringify(fitToScreen));
    }

    public abstract getImageDataURL(): string;

    public createScreenshot(deviceName: string): void {
        const a = document.createElement('a');
        a.href = this.getImageDataURL();
        a.download = `${deviceName} ${new Date().toLocaleString()}.png`;
        a.click();
    }

    public play(): void {
        if (this.needScreenInfoBeforePlay() && !this.screenInfo) {
            return;
        }
        this.state = BasePlayer.STATE['PLAYING']!;
    }

    public pause(): void {
        this.state = BasePlayer.STATE['PAUSED']!;
    }

    public stop(): void {
        this.state = BasePlayer.STATE['STOPPED']!;
        // Cancel any pending stats frame so the loop cannot run after stop (no leak).
        this.qualityStatsRaf.stop();
    }

    public getState(): number {
        return this.state;
    }

    // `isKeyframe` is accepted so subclasses (BaseCanvasBasedPlayer) and callers
    // can plumb the demuxer's real keyframe flag through a single signature; the
    // base stats path itself does not need it.
    public pushFrame(frame: Uint8Array, _isKeyframe?: boolean): void {
        if (!this.receivedFirstFrame) {
            this.receivedFirstFrame = true;
            // Guarded: a no-op if a stats frame is already pending (no double-start).
            this.scheduleQualityStats();
        }
        this.inputBytes.push({
            timestamp: Date.now(),
            bytes: frame.byteLength,
        });
    }

    /** Start the quality-stats rAF loop, unless one is already pending. */
    private scheduleQualityStats(): void {
        this.qualityStatsRaf.start(this.updateQualityStats);
    }

    public abstract getPreferredVideoSetting(): VideoSettings;
    protected abstract calculateMomentumStats(): void;

    public getTouchableElement(): HTMLCanvasElement {
        return this.touchableCanvas;
    }

    public setParent(parent: HTMLElement): void {
        this.parentElement = parent;
        parent.appendChild(this.tag);
        parent.appendChild(this.touchableCanvas);
    }

    protected needScreenInfoBeforePlay(): boolean {
        return true;
    }

    public getVideoSettings(): VideoSettings {
        return this.videoSettings;
    }

    public setVideoSettings(videoSettings: VideoSettings, fitToScreen: boolean, saveToStorage: boolean): void {
        this.videoSettings = videoSettings;
        if (saveToStorage) {
            BasePlayer.putVideoSettingsToStorage(
                this.storageKeyPrefix,
                this.udid,
                videoSettings,
                fitToScreen,
                this.displayInfo,
            );
        }
        this.resetStats();
        this.emit('video-settings', VideoSettings.copy(videoSettings));
    }

    public getScreenInfo(): ScreenInfo | undefined {
        return this.screenInfo;
    }

    public setScreenInfo(screenInfo: ScreenInfo): void {
        if (this.needScreenInfoBeforePlay()) {
            this.pause();
        }
        this.receivedFirstFrame = false;
        this.screenInfo = screenInfo;
        const { width, height } = screenInfo.videoSize;
        this.touchableCanvas.width = width;
        this.touchableCanvas.height = height;
        if (this.parentElement) {
            // Expose the device resolution as custom properties rather than an
            // inline width/height: `.video` is grid-auto-sized (capped by the
            // canvas max-width/height), so an inline width/height would only have
            // to be overridden back to auto with `!important`. (#106)
            this.parentElement.style.setProperty('--video-width', `${width}px`);
            this.parentElement.style.setProperty('--video-height', `${height}px`);
        }
        const size = new Size(width, height);
        this.emit('video-view-resize', size);
    }

    public getName(): string {
        return this.name;
    }

    protected resetStats(): void {
        this.receivedFirstFrame = false;
        // Cancel the pending stats frame; clearing receivedFirstFrame lets the next
        // pushFrame re-arm the loop cleanly without a second concurrent loop (#44).
        this.qualityStatsRaf.stop();
        this.totalStatsCounter = 0;
        this.totalStats = {
            droppedFrames: 0,
            decodedFrames: 0,
            inputFrames: 0,
            inputBytes: 0,
            timestamp: 0,
        };
        this.perSecondQualityStats = {
            avgDecoded: 0,
            avgDropped: 0,
            avgInput: 0,
            avgSize: 0,
        };
    }

    private updateQualityStats = (): void => {
        const now = Date.now();
        const oneSecondBefore = now - 1000;
        this.calculateMomentumStats();
        if (!this.momentumQualityStats) {
            return;
        }
        if (this.totalStats.timestamp < oneSecondBefore) {
            this.totalStats = {
                timestamp: now,
                decodedFrames: this.totalStats.decodedFrames + this.momentumQualityStats.decodedFrames,
                droppedFrames: this.totalStats.droppedFrames + this.momentumQualityStats.droppedFrames,
                inputFrames: this.totalStats.inputFrames + this.momentumQualityStats.inputFrames,
                inputBytes: this.totalStats.inputBytes + this.momentumQualityStats.inputBytes,
            };

            if (this.totalStatsCounter !== 0) {
                this.perSecondQualityStats = {
                    avgDecoded: this.totalStats.decodedFrames / this.totalStatsCounter,
                    avgDropped: this.totalStats.droppedFrames / this.totalStatsCounter,
                    avgInput: this.totalStats.inputFrames / this.totalStatsCounter,
                    avgSize: this.totalStats.inputBytes / this.totalStatsCounter,
                };
            }
            this.totalStatsCounter++;
        }
        this.drawStats();
        if (this.state !== BasePlayer.STATE['STOPPED']!) {
            this.scheduleQualityStats();
        }
    };

    private drawStats(): void {
        if (!this.showQualityStats) {
            return;
        }
        const ctx = this.touchableCanvas.getContext('2d');
        if (!ctx) {
            return;
        }
        const newStats = [];
        // Session info: resolution, codec, encoder, bitrate
        if (this.screenInfo) {
            const { width, height } = this.screenInfo.videoSize;
            newStats.push(`Resolution:  ${width}x${height}`);
        }
        if (this.sessionVideoCodec) {
            newStats.push(`Video codec: ${this.sessionVideoCodec.toUpperCase()}`);
        }
        if (this.sessionEncoder) {
            newStats.push(`Encoder:     ${this.sessionEncoder}`);
        }
        if (this.videoSettings.bitrate) {
            newStats.push(`Bitrate:     ${Util.prettyBytes(this.videoSettings.bitrate)}/s`);
        }
        // Per-frame stats
        if (this.perSecondQualityStats && this.momentumQualityStats) {
            const { decodedFrames, droppedFrames, inputBytes, inputFrames } = this.momentumQualityStats;
            const { avgDecoded, avgDropped, avgSize, avgInput } = this.perSecondQualityStats;
            const padInput = inputFrames.toString().padStart(3, ' ');
            const padDecoded = decodedFrames.toString().padStart(3, ' ');
            const padDropped = droppedFrames.toString().padStart(3, ' ');
            const padAvgDecoded = avgDecoded.toFixed(1).padStart(5, ' ');
            const padAvgDropped = avgDropped.toFixed(1).padStart(5, ' ');
            const padAvgInput = avgInput.toFixed(1).padStart(5, ' ');
            const prettyBytes = Util.prettyBytes(inputBytes).padStart(8, ' ');
            const prettyAvgBytes = Util.prettyBytes(avgSize).padStart(8, ' ');

            newStats.push(`Input bytes: ${prettyBytes} (avg: ${prettyAvgBytes}/s)`);
            newStats.push(`Input   FPS: ${padInput} (avg: ${padAvgInput})`);
            newStats.push(`Dropped FPS: ${padDropped} (avg: ${padAvgDropped})`);
            newStats.push(`Decoded FPS: ${padDecoded} (avg: ${padAvgDecoded})`);
        } else {
            newStats.push('Not supported');
        }
        const changed = stringArraysDiffer(this.statLines, newStats);

        if (changed) {
            this.statLines = newStats;
            this.updateCanvas(false);
        }
    }

    private updateCanvas(onlyClear: boolean): void {
        const ctx = this.touchableCanvas.getContext('2d');
        if (!ctx) {
            return;
        }

        // Scale font relative to canvas height so stats are readable at any resolution
        const height = Math.max(BasePlayer.STATS_HEIGHT, Math.round(this.touchableCanvas.height / 40));
        const lines = this.statLines.length;
        const p = height / 2;
        const d = p * 2;
        const totalHeight = height * lines + p * (lines + 1);

        ctx.clearRect(0, 0, this.dirtyStatsWidth + d, totalHeight);
        this.dirtyStatsWidth = 0;

        if (onlyClear) {
            return;
        }
        ctx.save();
        ctx.font = `${height}px monospace`;
        this.statLines.forEach((text) => {
            const textMetrics = ctx.measureText(text);
            const dirty = Math.abs(textMetrics.actualBoundingBoxLeft) + Math.abs(textMetrics.actualBoundingBoxRight);
            this.dirtyStatsWidth = Math.max(dirty, this.dirtyStatsWidth);
        });
        ctx.fillStyle = BasePlayer.STAT_BACKGROUND;
        ctx.fillRect(0, 0, this.dirtyStatsWidth + d, totalHeight);
        ctx.fillStyle = BasePlayer.STAT_TEXT_COLOR;
        this.statLines.forEach((text, line) => {
            ctx.fillText(text, p, p + height + line * (height + p));
        });
        ctx.restore();
    }

    public setShowQualityStats(value: boolean): void {
        this.showQualityStats = value;
        if (!value) {
            this.updateCanvas(true);
        } else {
            this.drawStats();
        }
    }

    public getShowQualityStats(): boolean {
        return this.showQualityStats;
    }

    public setSessionInfo(videoCodec: string, audioCodec: string, encoder?: string): void {
        this.sessionVideoCodec = videoCodec;
        this.sessionAudioCodec = audioCodec;
        this.sessionEncoder = encoder;
    }

    public setBounds(bounds: Size): void {
        this.bounds = Size.copy(bounds);
    }

    public getDisplayInfo(): DisplayInfo | undefined {
        return this.displayInfo;
    }

    public setDisplayInfo(displayInfo: DisplayInfo): void {
        this.displayInfo = displayInfo;
    }

    public abstract getFitToScreenStatus(): boolean;

    public abstract loadVideoSettings(): VideoSettings;

    public static loadVideoSettings(udid: string, displayInfo?: DisplayInfo): VideoSettings {
        return this.getVideoSettingFromStorage(this.preferredVideoSettings, this.storageKeyPrefix, udid, displayInfo);
    }

    public static getFitToScreenStatus(udid: string, displayInfo?: DisplayInfo): boolean {
        return this.getFitToScreenFromStorage(this.storageKeyPrefix, udid, displayInfo);
    }

    public static getPreferredVideoSetting(): VideoSettings {
        return this.preferredVideoSettings;
    }

    public static saveVideoSettings(
        udid: string,
        videoSettings: VideoSettings,
        fitToScreen: boolean,
        displayInfo?: DisplayInfo,
    ): void {
        this.putVideoSettingsToStorage(this.storageKeyPrefix, udid, videoSettings, fitToScreen, displayInfo);
    }
}
