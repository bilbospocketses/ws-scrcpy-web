import { ACTION } from '../../../common/Action';
import { applyStreamParams } from '../../../common/StreamUrlParams';
import { SERVER_PORT } from '../../../common/Constants';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { Attribute } from '../../Attribute';
import { AudioPlayer } from '../../audio/AudioPlayer';
import { BaseClient } from '../../client/BaseClient';
import type { ControlMessage } from '../../controlMessage/ControlMessage';
import type { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import type { DisplayInfo } from '../../DisplayInfo';
import {
    FeaturedInteractionHandler,
    type InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import { BasePlayer, type PlayerClass } from '../../player/BasePlayer';
import type { WebCodecsPlayer } from '../../player/WebCodecsPlayer';
import { ScrcpyDemuxer, type SessionMetadata } from '../../ScrcpyDemuxer';
import Size from '../../Size';
import Util from '../../Util';
import { html } from '../../ui/HtmlTag';
import VideoSettings from '../../VideoSettings';
import DeviceMessage from '../DeviceMessage';
import { type KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import { UhidKeyboardHandler } from '../UhidKeyboardHandler';
import { UhidManager } from '../UhidManager';
import { UhidMouseHandler } from '../UhidMouseHandler';
import { ConfigureScrcpy } from './ConfigureScrcpy';
import { DeviceTracker } from './DeviceTracker';

type StartParams = {
    udid: string;
    playerName?: string | undefined;
    player?: BasePlayer | undefined;
    fitToScreen?: boolean | undefined;
    videoSettings?: VideoSettings | undefined;
    deviceKind?: 'phone' | 'tablet' | 'tv' | undefined;
};

const TAG = '[StreamClientScrcpy]';

const CODEC_WEBCODEC_MAP: Record<string, string> = {
    h264: 'avc1.42E01E',
    h265: 'hev1.1.6.L93.B0',
    av1: 'av01.0.04M.08',
};

// Maps codec names to patterns that identify them in encoder names
const CODEC_ENCODER_PATTERN: Record<string, string> = {
    h264: '.avc.',
    h265: '.hevc.',
    av1: '.av1.',
};

// Hardware encoder vendor prefixes (preferred over software c2.android.* encoders)
const HW_ENCODER_RE = /\.mtk\.|\.qcom\.|\.exynos\.|\.intel\.|\.nvidia\./i;

async function browserSupportsCodec(codec: string): Promise<boolean> {
    // H.264 is universally supported — skip the check (Firefox isConfigSupported
    // returns false for some H.264 profile strings despite decoding fine)
    if (codec === 'h264') return true;
    if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
        return false;
    }
    const webCodecStr = CODEC_WEBCODEC_MAP[codec];
    if (!webCodecStr) return false;
    try {
        const result = await VideoDecoder.isConfigSupported({ codec: webCodecStr });
        return !!result.supported;
    } catch {
        return false;
    }
}

async function detectBestCodecAndEncoder(
    udid: string,
    params: { hostname?: string | undefined; port?: number | undefined; secure?: boolean | undefined },
): Promise<{ videoCodec: string; encoderName?: string | undefined }> {
    // 1. Probe the device for available encoders
    let videoEncoders: string[] = [];
    try {
        const { DeviceProbeClient } = await import('../../client/DeviceProbeClient');
        const probe = await DeviceProbeClient.probe(udid, {
            hostname: params.hostname || window.location.hostname,
            port: params.port || Number.parseInt(window.location.port, 10) || 80,
            secure: params.secure || false,
        });
        videoEncoders = probe.videoEncoders;
        console.log(TAG, `Probe returned encoders: ${videoEncoders.join(', ')}`);
    } catch (err) {
        console.warn(TAG, 'Device probe failed, falling back to browser-only detection:', (err as Error).message);
        // Fall back to browser-only detection without device info
        for (const codec of ['h265', 'h264', 'av1']) {
            if (await browserSupportsCodec(codec)) {
                console.log(TAG, `Auto-detected best codec (no probe): ${codec}`);
                return { videoCodec: codec };
            }
        }
        return { videoCodec: 'h264' };
    }

    // 2. For each codec in preference order, check device has encoder AND browser can decode
    const joined = videoEncoders.join(' ').toLowerCase();
    for (const codec of ['h265', 'h264', 'av1'] as const) {
        const pattern = CODEC_ENCODER_PATTERN[codec];
        if (!joined.includes(pattern)) continue;
        if (!(await browserSupportsCodec(codec))) {
            console.log(TAG, `Device has ${codec} encoder but browser cannot decode it`);
            continue;
        }

        // 3. Pick the best encoder for this codec (prefer hardware)
        const matchingEncoders = videoEncoders.filter((e) => e.toLowerCase().includes(pattern));
        const hwEncoder = matchingEncoders.find((e) => HW_ENCODER_RE.test(e));
        const encoder = hwEncoder || matchingEncoders[0];
        console.log(TAG, `Auto-detected: codec=${codec}, encoder=${encoder}`);
        return { videoCodec: codec, encoderName: encoder };
    }

    return { videoCodec: 'h264' };
}

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private controlButtons?: HTMLElement | undefined;
    private deviceName = '';
    private touchHandler?: FeaturedInteractionHandler | undefined;
    private uhidManager?: UhidManager | undefined;
    private uhidKeyboard?: UhidKeyboardHandler | undefined;
    private uhidMouse?: UhidMouseHandler | undefined;
    private player?: BasePlayer | undefined;
    private fitToScreen?: boolean | undefined;
    private demuxer?: ScrcpyDemuxer | undefined;
    private audioPlayer?: AudioPlayer | undefined;
    private frameSizes: number[] = [];
    private baselineFrameSize = 0;
    private degradationCount = 0;
    private lastRefreshTime = 0;
    private stopFn?: (() => void) | undefined;

    /** Public hook — fires after session metadata is parsed. Used by the public startStream API. */
    public onMetadataReceived?: ((info: { codec: string; encoder: string; resolution: string }) => void) | undefined;

    /** Public hook — fires on async stream errors (WebSocket refused, probe failure, etc.). */
    public onErrorReceived?: ((err: Error) => void) | undefined;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    private static getPlayerClass(playerName: string): PlayerClass | undefined {
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                return value;
            }
        }
        return;
    }

    public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) return;
        return new playerClass(udid, displayInfo);
    }

    public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) return false;
        return playerClass.getFitToScreenStatus(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
        container?: HTMLElement,
        onDisconnect?: () => void,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ): { instance: StreamClientScrcpy; stop: () => void } {
        const params = query instanceof URLSearchParams ? StreamClientScrcpy.parseParameters(query) : query;
        const instance = new StreamClientScrcpy(params, player, fitToScreen, videoSettings, container, onDisconnect, deviceKind);
        return { instance, stop: () => instance.stopStream() };
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
        private readonly container?: HTMLElement,
        private readonly onDisconnectCallback?: () => void,
        deviceKind?: 'phone' | 'tablet' | 'tv',
    ) {
        super(params);
        const { udid, player: playerName } = this.params;
        this.startStream({ udid, player, playerName, fitToScreen: fitToScreen ?? params.fitToScreen, videoSettings, deviceKind });
    }

    public static override parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws') || '',
        };
    }

    private buildStreamUrl(): string {
        const { hostname, port, secure } = this.params;
        const protocol = secure ? 'wss' : 'ws';
        const host = hostname || window.location.hostname;
        const p = port || Number.parseInt(window.location.port, 10) || (secure ? 443 : 80);
        const url = new URL(`${protocol}://${host}:${p}/`);
        const vs = this.player?.getVideoSettings();
        applyStreamParams(
            url,
            {
                udid: this.params.udid,
                videoCodec: this.params.videoCodec,
                audioCodec: this.params.audioCodec,
                audioEnabled: this.params.audioEnabled,
                audioSource: this.params.audioSource,
                encoderName: this.params.encoderName,
            },
            vs
                ? {
                      bitrate: vs.bitrate,
                      maxFps: vs.maxFps,
                      bounds: vs.bounds ? { width: vs.bounds.width, height: vs.bounds.height } : undefined,
                      displayId: vs.displayId,
                  }
                : undefined,
        );
        return url.toString();
    }

    public OnDeviceMessage = (data: Uint8Array): void => {
        const message = DeviceMessage.fromRaw(data);
        if (message.type === DeviceMessage.TYPE_CLIPBOARD) {
            const text = message.getText();
            if (text && navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).catch((err) => {
                    console.error('[StreamClientScrcpy] clipboard write failed:', err);
                });
            }
        }
    };

    public onVideoFrame = (data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void => {
        if (!this.player) return;
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE['PAUSED']) {
            this.player.play();
        }
        if (this.player.getState() === STATE['PLAYING']) {
            (this.player as WebCodecsPlayer).pushVideoFrame(data, pts, isConfig, isKeyframe);
        }

        // Track frame sizes for degradation detection (skip config frames)
        if (!isConfig && data.length > 0) {
            this.frameSizes.push(data.length);
            // Build baseline from first 30 frames
            if (this.frameSizes.length === 30) {
                this.baselineFrameSize = this.frameSizes.reduce((a, b) => a + b, 0) / 30;
            }
            // Keep rolling window of 30 frames
            if (this.frameSizes.length > 30) {
                this.frameSizes.shift();
                this.checkForDegradation();
            }
        }
    };

    public onAudioFrame = (data: Uint8Array, pts: bigint, isConfig: boolean): void => {
        this.audioPlayer?.pushFrame(data, pts, isConfig);
    };

    public onMetadata = (meta: SessionMetadata): void => {
        this.deviceName = meta.deviceName;
        console.log(
            TAG,
            `Connected: ${meta.deviceName} ${meta.screenWidth}x${meta.screenHeight} video=${meta.videoCodec} audio=${meta.audioCodec}`,
        );

        // Pass metadata dimensions to player as fallback (AV1 config doesn't include dimensions)
        if (this.player && 'setMetadataSize' in this.player) {
            (this.player as any).setMetadataSize(meta.screenWidth, meta.screenHeight);
        }

        // Pass session info for quality stats overlay
        if (this.player) {
            this.player.setSessionInfo(meta.videoCodec, meta.audioCodec, meta.videoEncoder || this.params.encoderName);
        }

        // Public hook — fire after session metadata is parsed. Mirrors the
        // fields used by the stats overlay above so there is a single source
        // of truth for codec/encoder/resolution.
        this.onMetadataReceived?.({
            codec: meta.videoCodec ?? '',
            encoder: meta.videoEncoder ?? this.params.encoderName ?? '',
            resolution: `${meta.screenWidth ?? 0}x${meta.screenHeight ?? 0}`,
        });

        if (meta.audioCodec !== 'disabled' && meta.audioCodec !== 'error') {
            this.audioPlayer = new AudioPlayer(meta.audioCodec);
            this.audioPlayer.start().catch((err) => {
                console.error(TAG, 'Failed to start audio:', err.message);
            });
        }
    };

    private isRefreshing = false;
    private isStopping = false;

    public onDisconnected = (ev?: CloseEvent): void => {
        this.audioPlayer?.stop();
        this.uhidKeyboard?.detach();
        this.uhidMouse?.detach();
        this.uhidManager?.stop();
        // Don't destroy touch handler during refresh — refreshStream manages it
        if (!this.isRefreshing) {
            this.touchHandler?.release();
            this.touchHandler = undefined;
            this.onDisconnectCallback?.();
        }
        // Public hook — fire on abnormal WebSocket closures. ScrcpyDemuxer does
        // not expose a separate onError callback (its ws.onerror is a no-op),
        // so close codes are our only signal for async stream errors.
        // 1000 = normal closure, 1001 = going away (tab close/refresh).
        // Skip during user-initiated stop/refresh — those are not errors.
        const cleanCodes = new Set([1000, 1001, 1005]);
        if (!this.isStopping && ev && !cleanCodes.has(ev.code)) {
            const reason = ev.reason || `WebSocket closed with code ${ev.code}`;
            this.onErrorReceived?.(new Error(reason));
        }
    };

    public async startStream({ udid, player, playerName, videoSettings, fitToScreen, deviceKind }: StartParams): Promise<void> {
        this.isStopping = false;
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        this.fitToScreen = fitToScreen;
        if (!player) {
            if (typeof playerName !== 'string') {
                throw Error('Must provide BasePlayer instance or playerName');
            }
            const p = StreamClientScrcpy.createPlayer(playerName, udid);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            if (typeof fitToScreen !== 'boolean') {
                fitToScreen = StreamClientScrcpy.getFitToScreen(playerName, udid);
            }
            player = p;
        }
        this.player = player;
        this.setTouchListeners(player);

        if (!videoSettings) {
            videoSettings = player.getVideoSettings();
        }

        const deviceView = document.createElement('div');
        deviceView.className = 'device-view';
        const stop = (ev?: string | Event) => {
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(TAG, ev);
            }
            // Mark that the upcoming WebSocket close is user-initiated so
            // onDisconnected does not fire the public onErrorReceived hook.
            this.isStopping = true;
            const parent = deviceView.parentElement;
            if (parent) parent.removeChild(deviceView);
            this.setHandleKeyboardEvents(false);
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('keydown', resumeAudio);
            this.demuxer?.close();
            this.audioPlayer?.stop();
            if (this.player) this.player.stop();
        };

        this.stopFn = () => stop();

        const googToolBox = GoogToolBox.createToolBox(udid, player, this, deviceKind);
        this.controlButtons = googToolBox.getHolderElement();
        deviceView.appendChild(this.controlButtons);
        const video = document.createElement('div');
        video.className = 'video';
        deviceView.appendChild(video);
        player.setParent(video);
        player.pause();

        const target = this.container ?? document.body;
        target.appendChild(deviceView);
        if (fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                videoSettings = new VideoSettings({
                    ...videoSettings.toJSON(),
                    bounds: newBounds,
                });
            }
        }
        player.setVideoSettings(videoSettings, !!fitToScreen, false);

        // Resume audio on first user interaction (autoplay policy)
        const resumeAudio = () => {
            this.audioPlayer?.resume();
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('keydown', resumeAudio);
        };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('keydown', resumeAudio, { once: true });

        if (this.params.videoCodec) {
            // Caller supplied a codec — verify the browser can actually decode it
            if (!(await browserSupportsCodec(this.params.videoCodec))) {
                console.warn(
                    TAG,
                    `Requested codec "${this.params.videoCodec}" is not supported by this browser, falling back to h264`,
                );
                this.params.videoCodec = 'h264';
                this.params.encoderName = undefined;
            }
        } else {
            // Auto-detect best codec + encoder (direct link without ConfigureScrcpy)
            try {
                const detected = await detectBestCodecAndEncoder(udid, {
                    hostname: this.params.hostname,
                    port: this.params.port,
                    secure: this.params.secure,
                });
                this.params.videoCodec = detected.videoCodec;
                if (detected.encoderName) {
                    this.params.encoderName = detected.encoderName;
                }
            } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err));
                this.onErrorReceived?.(e);
                throw e;
            }
        }

        // Connect via ScrcpyDemuxer
        const streamUrl = this.buildStreamUrl();
        this.demuxer = new ScrcpyDemuxer(streamUrl);
        this.demuxer.onVideoFrame(this.onVideoFrame);
        this.demuxer.onAudioFrame(this.onAudioFrame);
        this.demuxer.onDeviceMessage(this.OnDeviceMessage);
        this.demuxer.onMetadata(this.onMetadata);
        this.demuxer.onDisconnect(this.onDisconnected);

        // Always enable keyboard capture
        this.setHandleKeyboardEvents(true);

        console.log(TAG, player.getName(), udid);
    }

    public stopStream(): void {
        if (this.stopFn) {
            this.stopFn();
            this.stopFn = undefined;
        }
    }

    public sendMessage(message: ControlMessage): void {
        this.demuxer?.sendControl(message);
    }

    private checkForDegradation(): void {
        if (this.baselineFrameSize === 0) return;
        const now = Date.now();
        // Don't check within 30s of a refresh (was 10s — too aggressive)
        if (now - this.lastRefreshTime < 30000) return;
        // Need at least 10 samples for a reliable average
        if (this.frameSizes.length < 10) return;

        const avg = this.frameSizes.reduce((a, b) => a + b, 0) / this.frameSizes.length;
        // If average frame size drops below 10% of baseline for sustained period
        // (was 25% — too sensitive for static content like screensavers)
        if (avg < this.baselineFrameSize * 0.1) {
            this.degradationCount++;
            if (this.degradationCount >= 5) {
                console.log(
                    TAG,
                    `Quality degradation detected (avg=${Math.round(avg)} vs baseline=${Math.round(this.baselineFrameSize)}), refreshing stream`,
                );
                this.degradationCount = 0;
                this.frameSizes = [];
                this.baselineFrameSize = 0;
                this.refreshStream();
            }
        } else {
            this.degradationCount = 0;
        }
    }

    public refreshStream(): void {
        console.log(TAG, 'Refreshing stream (reconnect for fresh keyframe)');
        this.lastRefreshTime = Date.now();
        this.frameSizes = [];
        this.baselineFrameSize = 0;
        this.degradationCount = 0;

        // Detach disconnect callback from old demuxer BEFORE closing it.
        // The old WebSocket's onclose fires asynchronously — if we just use
        // isRefreshing as a guard, it races: refreshStream() sets isRefreshing=false
        // synchronously, then the async onclose fires onDisconnected which sees
        // isRefreshing=false and destroys the touch handler.
        if (this.demuxer) {
            this.demuxer.onDisconnect(() => {});
        }
        this.demuxer?.close();
        this.audioPlayer?.stop();
        this.audioPlayer = undefined;

        // Reset player state for fresh frames
        if (this.player) {
            this.player.stop();
            this.player.pause();
        }

        // Reconnect
        const streamUrl = this.buildStreamUrl();
        this.demuxer = new ScrcpyDemuxer(streamUrl);
        this.demuxer.onVideoFrame(this.onVideoFrame);
        this.demuxer.onAudioFrame(this.onAudioFrame);
        this.demuxer.onDeviceMessage(this.OnDeviceMessage);
        this.demuxer.onMetadata(this.onMetadata);
        this.demuxer.onDisconnect(this.onDisconnected);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public setDpadMode(enabled: boolean): void {
        this.touchHandler?.setDpadMode(enabled);
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled) {
            KeyInputHandler.addEventListener(this);
        } else {
            KeyInputHandler.removeEventListener(this);
        }
    }

    public toggleUhid(enabled: boolean): void {
        if (enabled) {
            if (this.uhidManager) return;
            this.uhidManager = new UhidManager((msg) => this.sendMessage(msg));
            this.uhidManager.start();

            this.uhidKeyboard = new UhidKeyboardHandler(this.uhidManager);
            this.uhidKeyboard.attach();

            if (this.player) {
                this.uhidMouse = new UhidMouseHandler(this.uhidManager, this.player.getTouchableElement());
                this.uhidMouse.attach();
            }

            // Disable existing touch handler
            this.touchHandler?.release();
            this.touchHandler = undefined;

            // Disable existing keyboard handler
            KeyInputHandler.removeEventListener(this);
        } else {
            this.uhidKeyboard?.detach();
            this.uhidMouse?.detach();
            this.uhidManager?.stop();
            this.uhidKeyboard = undefined;
            this.uhidMouse = undefined;
            this.uhidManager = undefined;

            // Re-enable touch handler
            if (this.player) {
                this.setTouchListeners(this.player);
            }
        }
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        if (this.player) {
            this.player.setVideoSettings(videoSettings, !!this.fitToScreen, true);
        }
    }

    public getClientId(): number {
        return -1;
    }

    public getClientsCount(): number {
        return 1;
    }

    public getMaxSize(): Size | undefined {
        if (!this.controlButtons) return;
        // Use viewport dimensions, not this.container — at mount time, containers
        // inside fit-content parents (ConnectModal frame) haven't been sized yet
        // and would return 0. Viewport is stable and serves as the upper-bound
        // hint the encoder needs. CSS layout inside .video handles the
        // container-accurate display sizing.
        const width = (window.innerWidth - this.controlButtons.clientWidth) & ~15;
        const height = window.innerHeight & ~15;
        return new Size(width, height);
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) return;
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        fullName: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        const isConnected = descriptor.state === 'device';
        if (isConnected) {
            const configureButtonId = `configure_${Util.escapeUdid(descriptor.udid)}`;
            const e = html`<div class="stream ${blockClass}">
                <button
                    ${Attribute.UDID}="${descriptor.udid}"
                    ${Attribute.COMMAND}="${ControlCenterCommand.CONFIGURE_STREAM}"
                    ${Attribute.FULL_NAME}="${fullName}"
                    ${Attribute.SECURE}="${params.secure}"
                    ${Attribute.HOSTNAME}="${params.hostname}"
                    ${Attribute.PORT}="${params.port}"
                    ${Attribute.PATHNAME}="${params.pathname}"
                    ${Attribute.USE_PROXY}="${params.useProxy}"
                    id="${configureButtonId}"
                    class="active action-button"
                >
                    config stream
                </button>
            </div>`;
            const a = e.content.getElementById(configureButtonId);
            a && (a.onclick = this.onConfigureStreamClick);
            return e.content;
        }
        return;
    }

    private static onConfigureStreamClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLAnchorElement;
        const udid = Util.parseStringEnv(button.getAttribute(Attribute.UDID) || '');
        const secure = Util.parseBooleanEnv(button.getAttribute(Attribute.SECURE) || undefined) || false;
        const hostname = Util.parseStringEnv(button.getAttribute(Attribute.HOSTNAME) || undefined) || '';
        const port = Util.parseIntEnv(button.getAttribute(Attribute.PORT) || undefined);
        const pathname = Util.parseStringEnv(button.getAttribute(Attribute.PATHNAME) || undefined) || '';
        const useProxy = Util.parseBooleanEnv(button.getAttribute(Attribute.USE_PROXY) || undefined);
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }
        if (typeof port !== 'number') {
            throw Error(`Invalid port type: ${typeof port}`);
        }
        const tracker = DeviceTracker.getInstance({
            type: 'android',
            secure,
            hostname,
            port,
            pathname,
            useProxy,
        });
        const descriptor = tracker.getDescriptorByUdid(udid);
        if (!descriptor) return;
        event.preventDefault();

        // Auto-select best interface (same logic as DeviceTracker.buildDeviceRow)
        let ws = '';
        const wifiInterface = descriptor.interfaces?.find((i) => i.name === descriptor['wifi.interface']);
        const bestInterface = wifiInterface || descriptor.interfaces?.[0];
        if (bestInterface) {
            const url = DeviceTracker.buildUrl({
                secure: false,
                hostname: bestInterface.ipv4,
                port: SERVER_PORT,
                pathname,
            });
            ws = url.toString();
        }
        if (!ws) {
            const url = DeviceTracker.buildUrl({ secure, hostname, port, pathname });
            url.searchParams.set('action', ACTION.PROXY_ADB);
            url.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            url.searchParams.set('udid', udid);
            ws = url.toString();
        }

        const options: ParamsStreamScrcpy = {
            udid,
            ws,
            player: '',
            action: ACTION.STREAM_SCRCPY,
            secure,
            hostname,
            port,
            pathname,
            useProxy,
        };
        // Use device label (user-assigned name) for the modal title, falling back to model
        const nameEl = button.closest('.device')?.querySelector('.device-name-text');
        const deviceLabel = nameEl?.textContent || descriptor['ro.product.model'] || udid;
        new ConfigureScrcpy(tracker, descriptor, deviceLabel, options, (_result: boolean) => {
            // ConnectModal opens from ConfigureScrcpy.openStream() — home page stays intact
            // HostTracker.destroy() was removed: in the modal flow, the device list must persist
        });
    };
}
