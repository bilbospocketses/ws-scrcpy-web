import { ACTION } from '../../../common/Action';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { Attribute } from '../../Attribute';
import type { DisplayInfo } from '../../DisplayInfo';
import { ScrcpyDemuxer, type SessionMetadata } from '../../ScrcpyDemuxer';
import Size from '../../Size';
import Util from '../../Util';
import VideoSettings from '../../VideoSettings';
import { AudioPlayer } from '../../audio/AudioPlayer';
import { BaseClient } from '../../client/BaseClient';
import { HostTracker } from '../../client/HostTracker';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import type { ControlMessage } from '../../controlMessage/ControlMessage';
import type { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import {
    FeaturedInteractionHandler,
    type InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import { BasePlayer, type PlayerClass } from '../../player/BasePlayer';
import type { WebCodecsPlayer } from '../../player/WebCodecsPlayer';
import { html } from '../../ui/HtmlTag';
import DeviceMessage from '../DeviceMessage';
import { type KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { GoogMoreBox } from '../toolbox/GoogMoreBox';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import { UhidManager } from '../UhidManager';
import { UhidKeyboardHandler } from '../UhidKeyboardHandler';
import { UhidMouseHandler } from '../UhidMouseHandler';
import { ConfigureScrcpy } from './ConfigureScrcpy';
import { DeviceTracker } from './DeviceTracker';

type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
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
    params: { hostname?: string; port?: number; secure?: boolean },
): Promise<{ videoCodec: string; encoderName?: string }> {
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
        console.warn(TAG, `Device probe failed, falling back to browser-only detection:`, (err as Error).message);
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
    for (const codec of ['h265', 'av1', 'h264'] as const) {
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

    private controlButtons?: HTMLElement;
    private deviceName = '';
    private touchHandler?: FeaturedInteractionHandler;
    private uhidManager?: UhidManager;
    private uhidKeyboard?: UhidKeyboardHandler;
    private uhidMouse?: UhidMouseHandler;
    private moreBox?: GoogMoreBox;
    private player?: BasePlayer;
    private fitToScreen?: boolean;
    private demuxer?: ScrcpyDemuxer;
    private audioPlayer?: AudioPlayer;

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
    ): StreamClientScrcpy {
        const params = query instanceof URLSearchParams ? StreamClientScrcpy.parseParameters(query) : query;
        return new StreamClientScrcpy(params, player, fitToScreen, videoSettings);
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ) {
        super(params);
        const { udid, player: playerName } = this.params;
        this.startStream({ udid, player, playerName, fitToScreen: fitToScreen ?? params.fitToScreen, videoSettings });
        this.setBodyClass('stream');
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        const embed = params.get('embed') === 'true';
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws') || '',
            ...(embed ? { fitToScreen: true } : {}),
        };
    }

    private buildStreamUrl(): string {
        const { hostname, port, secure } = this.params;
        const protocol = secure ? 'wss' : 'ws';
        const host = hostname || window.location.hostname;
        const p = port || Number.parseInt(window.location.port, 10) || (secure ? 443 : 80);
        const url = new URL(`${protocol}://${host}:${p}/`);
        url.searchParams.set('action', ACTION.STREAM_SCRCPY);
        url.searchParams.set('udid', this.params.udid);

        // Pass video settings as query params for server-side ScrcpyOptions
        if (this.player) {
            const vs = this.player.getVideoSettings();
            if (vs.bitrate) url.searchParams.set('bitrate', vs.bitrate.toString());
            if (vs.maxFps) url.searchParams.set('maxFps', vs.maxFps.toString());
            if (vs.bounds) {
                const maxDim = Math.max(vs.bounds.width, vs.bounds.height);
                if (maxDim > 0) url.searchParams.set('maxSize', maxDim.toString());
            }
            if (vs.displayId) url.searchParams.set('displayId', vs.displayId.toString());
        }

        // Pass codec selections from ConfigureScrcpy
        const videoCodec = this.params.videoCodec;
        if (videoCodec && videoCodec !== 'h264') {
            url.searchParams.set('videoCodec', videoCodec);
        }

        const audioCodec = this.params.audioCodec;
        if (audioCodec && audioCodec !== 'opus') {
            url.searchParams.set('audioCodec', audioCodec);
        }

        const encoderName = this.params.encoderName;
        if (encoderName) {
            url.searchParams.set('videoEncoder', encoderName);
        }

        return url.toString();
    }

    public OnDeviceMessage = (data: Uint8Array): void => {
        const message = DeviceMessage.fromRaw(data);
        if (this.moreBox) {
            this.moreBox.OnDeviceMessage(message);
        }
    };

    public onVideoFrame = (data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean): void => {
        if (!this.player) return;
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE.PAUSED) {
            this.player.play();
        }
        if (this.player.getState() === STATE.PLAYING) {
            (this.player as WebCodecsPlayer).pushVideoFrame(data, pts, isConfig, isKeyframe);
        }
    };

    public onAudioFrame = (data: Uint8Array, pts: bigint, isConfig: boolean): void => {
        this.audioPlayer?.pushFrame(data, pts, isConfig);
    };

    public onMetadata = (meta: SessionMetadata): void => {
        this.deviceName = meta.deviceName;
        this.setTitle(`Stream ${this.deviceName}`);
        console.log(TAG, `Connected: ${meta.deviceName} ${meta.screenWidth}x${meta.screenHeight} video=${meta.videoCodec} audio=${meta.audioCodec}`);

        // Pass metadata dimensions to player as fallback (AV1 config doesn't include dimensions)
        if (this.player && 'setMetadataSize' in this.player) {
            (this.player as any).setMetadataSize(meta.screenWidth, meta.screenHeight);
        }

        // Pass session info for quality stats overlay
        if (this.player) {
            this.player.setSessionInfo(meta.videoCodec, meta.audioCodec, meta.videoEncoder || this.params.encoderName);
        }

        if (meta.audioCodec !== 'disabled' && meta.audioCodec !== 'error') {
            this.audioPlayer = new AudioPlayer(meta.audioCodec);
            this.audioPlayer.start().catch((err) => {
                console.error(TAG, 'Failed to start audio:', err.message);
            });
        }
    };

    public onDisconnected = (): void => {
        this.audioPlayer?.stop();
        this.uhidKeyboard?.detach();
        this.uhidMouse?.detach();
        this.uhidManager?.stop();
        this.touchHandler?.release();
        this.touchHandler = undefined;
    };

    public async startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): Promise<void> {
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
            let parent: HTMLElement | null;
            parent = deviceView.parentElement;
            if (parent) parent.removeChild(deviceView);
            parent = moreBox.parentElement;
            if (parent) parent.removeChild(moreBox);
            this.demuxer?.close();
            this.audioPlayer?.stop();
            if (this.player) this.player.stop();
        };

        const googMoreBox = (this.moreBox = new GoogMoreBox(udid, player, this));
        const moreBox = googMoreBox.getHolderElement();
        googMoreBox.setOnStop(stop);
        const googToolBox = GoogToolBox.createToolBox(udid, player, this, moreBox);
        this.controlButtons = googToolBox.getHolderElement();
        deviceView.appendChild(this.controlButtons);
        const video = document.createElement('div');
        video.className = 'video';
        deviceView.appendChild(video);
        deviceView.appendChild(moreBox);
        player.setParent(video);
        player.pause();

        document.body.appendChild(deviceView);
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

        // Auto-detect best codec + encoder if not specified (direct link without ConfigureScrcpy)
        if (!this.params.videoCodec) {
            const detected = await detectBestCodecAndEncoder(udid, {
                hostname: this.params.hostname,
                port: this.params.port,
                secure: this.params.secure,
            });
            this.params.videoCodec = detected.videoCodec;
            if (detected.encoderName) {
                this.params.encoderName = detected.encoderName;
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

        // In embed mode, also add click-to-focus
        if (document.body.classList.contains('embed')) {
            video.addEventListener('click', () => video.focus(), { once: true });
        }

        console.log(TAG, player.getName(), udid);
    }

    public sendMessage(message: ControlMessage): void {
        this.demuxer?.sendControl(message);
    }

    public getDeviceName(): string {
        return this.deviceName;
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
        const body = document.body;
        const width = (body.clientWidth - this.controlButtons.clientWidth) & ~15;
        const height = body.clientHeight & ~15;
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
                    Configure stream
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
        const fullName = button.getAttribute(Attribute.FULL_NAME);
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
        const elements = document.getElementsByName(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`);
        if (!elements || !elements.length) return;
        const select = elements[0] as HTMLSelectElement;
        const optionElement = select.options[select.selectedIndex];
        const ws = optionElement.getAttribute(Attribute.URL) || '';
        const name = optionElement.getAttribute(Attribute.NAME);
        if (!name) return;
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
        const dialog = new ConfigureScrcpy(tracker, descriptor, options);
        dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);
    };

    private static onConfigureDialogClosed = (event: { dialog: ConfigureScrcpy; result: boolean }): void => {
        event.dialog.off('closed', StreamClientScrcpy.onConfigureDialogClosed);
        if (event.result) {
            HostTracker.getInstance().destroy();
        }
    };
}
