// src/app/ScrcpyDemuxer.ts
import { ChannelId } from '../common/ChannelId';
import type { ControlMessage } from './controlMessage/ControlMessage';

const FRAME_HEADER_SIZE = 12; // 8 (PTS) + 4 (size)
const PTS_FLAG_CONFIG = 0x8000000000000000n;
const PTS_FLAG_KEYFRAME = 0x4000000000000000n;
const PTS_CLEAR_FLAGS = 0x3fffffffffffffffn;

export interface SessionMetadata {
    deviceName: string;
    videoCodec: string;
    screenWidth: number;
    screenHeight: number;
    audioCodec: string;
}

export type VideoFrameCallback = (data: Uint8Array, pts: bigint, isConfig: boolean, isKeyframe: boolean) => void;

export type AudioFrameCallback = (data: Uint8Array, pts: bigint, isConfig: boolean) => void;

export type DeviceMessageCallback = (data: Uint8Array) => void;
export type MetadataCallback = (meta: SessionMetadata) => void;
export type DisconnectCallback = (ev: CloseEvent) => void;

export class ScrcpyDemuxer {
    private ws: WebSocket;
    private videoCallback?: VideoFrameCallback;
    private audioCallback?: AudioFrameCallback;
    private deviceMsgCallback?: DeviceMessageCallback;
    private metadataCallback?: MetadataCallback;
    private disconnectCallback?: DisconnectCallback;
    private pendingControl: Uint8Array[] = [];

    constructor(url: string) {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onmessage = this.onMessage;
        this.ws.onopen = () => this.flushPending();
        this.ws.onclose = (ev) => this.disconnectCallback?.(ev);
        this.ws.onerror = () => {};
    }

    onVideoFrame(cb: VideoFrameCallback): void {
        this.videoCallback = cb;
    }

    onAudioFrame(cb: AudioFrameCallback): void {
        this.audioCallback = cb;
    }

    onDeviceMessage(cb: DeviceMessageCallback): void {
        this.deviceMsgCallback = cb;
    }

    onMetadata(cb: MetadataCallback): void {
        this.metadataCallback = cb;
    }

    onDisconnect(cb: DisconnectCallback): void {
        this.disconnectCallback = cb;
    }

    sendControl(message: ControlMessage): void {
        const payload = message.toBuffer();
        const msg = new Uint8Array(1 + payload.length);
        msg[0] = ChannelId.CONTROL;
        msg.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.length), 1);
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        } else {
            this.pendingControl.push(msg);
        }
    }

    close(): void {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close();
        }
    }

    private flushPending(): void {
        for (const msg of this.pendingControl) {
            this.ws.send(msg);
        }
        this.pendingControl.length = 0;
    }

    private onMessage = (event: MessageEvent): void => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const raw = new Uint8Array(event.data);
        if (raw.length < 1) return;

        const channel = raw[0];
        const payload = raw.subarray(1);

        switch (channel) {
            case ChannelId.VIDEO:
                this.handleMediaFrame(payload, true);
                break;
            case ChannelId.AUDIO:
                this.handleMediaFrame(payload, false);
                break;
            case ChannelId.DEVICE_MSG:
                this.deviceMsgCallback?.(payload);
                break;
            case ChannelId.METADATA:
                this.handleMetadata(payload);
                break;
        }
    };

    private handleMediaFrame(payload: Uint8Array, isVideo: boolean): void {
        if (payload.length < FRAME_HEADER_SIZE) return;

        const view = new DataView(payload.buffer, payload.byteOffset);
        const rawPts = view.getBigUint64(0);
        const size = view.getUint32(8);
        const data = payload.subarray(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + size);

        const isConfig = (rawPts & PTS_FLAG_CONFIG) !== 0n;
        const isKeyframe = (rawPts & PTS_FLAG_KEYFRAME) !== 0n;
        const pts = rawPts & PTS_CLEAR_FLAGS;

        if (isVideo) {
            this.videoCallback?.(data, pts, isConfig, isKeyframe);
        } else {
            this.audioCallback?.(data, pts, isConfig);
        }
    }

    private handleMetadata(payload: Uint8Array): void {
        try {
            const text = new TextDecoder().decode(payload);
            const meta: SessionMetadata = JSON.parse(text);
            this.metadataCallback?.(meta);
        } catch {
            console.error('[ScrcpyDemuxer] Failed to parse metadata');
        }
    }
}
