# SP2 — Vanilla scrcpy v3.x Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the patched scrcpy-server v1.19-ws7 with vanilla Genymobile scrcpy-server v3.3.4, implementing the v3.x protocol in TypeScript with a Node.js TCP→WebSocket bridge and browser-side audio playback.

**Architecture:** Node.js server becomes a protocol bridge — it pushes the vanilla scrcpy-server to the device, launches it via ADB, accepts 3 TCP sockets (video, audio, control), and multiplexes them onto a single WebSocket to the browser. The browser demuxes channels and feeds video to WebCodecsPlayer, audio to a new AudioPlayer, and routes control messages back through the same WebSocket.

**Tech Stack:** TypeScript 5.5, Node.js `net` (TCP server), `ws` (WebSocket), WebCodecs API (VideoDecoder, AudioDecoder), Web Audio API (AudioWorklet), scrcpy-server v3.3.4

**Spec:** `docs/specs/2026-04-10-sp2-scrcpy-v3-protocol.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/common/ChannelId.ts` | Channel ID constants (0-4) for multiplexed WebSocket |
| `src/common/ScrcpyCodec.ts` | Codec ID constants (H.264 = 0x68323634, Opus = 0x6F707573) |
| `src/server/ScrcpyOptions.ts` | Version-aware options builder, serializes to `key=value` format |
| `src/server/FrameReader.ts` | Parses scrcpy v3.x frame format (PTS+size+data) from TCP stream |
| `src/server/ScrcpyConnection.ts` | Mw subclass: TCP↔WS bridge, 3-socket management, session lifecycle |
| `src/app/ScrcpyDemuxer.ts` | Browser-side channel demuxer, routes multiplexed WS messages |
| `src/app/audio/AudioPlayer.ts` | WebCodecs AudioDecoder + Web Audio playback with AudioWorklet |
| `src/app/audio/PcmWorklet.ts` | Exports AudioWorkletProcessor source code as string for Blob URL loading |

### Modified Files

| File | Change |
|------|--------|
| `src/common/Constants.ts` | Version → 3.3.4, new server launch args, remove old constants |
| `src/common/Action.ts` | No change needed — ACTION.STREAM_SCRCPY already exists |
| `src/server/AdbClient.ts` | Add `removeReverse()` method |
| `src/server/goog-device/ScrcpyServer.ts` | Rewrite: push vanilla binary, launch with key=value args, no PID file |
| `src/server/goog-device/Device.ts` | Remove server auto-start/PID tracking, simplify to device info only |
| `src/server/index.ts` | Register ScrcpyConnection middleware, remove WebsocketProxy imports |
| `src/app/controlMessage/ControlMessage.ts` | Add new v3.x type constants (12-17) |
| `src/app/controlMessage/TouchControlMessage.ts` | Add actionButton field (28→32 byte payload) |
| `src/app/controlMessage/ScrollControlMessage.ts` | Add buttons field, SignedFloat encoding (20→25 byte payload) |
| `src/app/controlMessage/CommandControlMessage.ts` | Update SetClipboard with sequence(u64) + paste(u8) fields |
| `src/app/googDevice/DeviceMessage.ts` | Add AckClipboard (type 1) and UHidOutput (type 2) |
| `src/app/player/WebCodecsPlayer.ts` | Accept PTS/config/keyframe from demuxer, remove manual NALU buffering |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | Use ScrcpyDemuxer + AudioPlayer, remove old StreamReceiver events |
| `THIRD-PARTY-NOTICES.md` | Update scrcpy version to v3.3.4 |
| `webpack/ws-scrcpy-web.common.ts` | Update asset rule for new binary filename |

### Deleted Files

| File | Reason |
|------|--------|
| `src/server/mw/WebsocketProxy.ts` | Replaced by ScrcpyConnection |
| `src/server/goog-device/mw/WebsocketProxyOverAdb.ts` | Replaced by ScrcpyConnection |
| `src/app/client/StreamReceiver.ts` | Replaced by ScrcpyDemuxer |
| `src/app/googDevice/client/StreamReceiverScrcpy.ts` | Replaced by ScrcpyDemuxer |
| `src/server/goog-device/ServerVersion.ts` | Only v3.3.4+ supported, no version compat needed |
| `assets/scrcpy-server.jar` | Replaced by `assets/scrcpy-server` (vanilla v3.3.4) |

---

### Task 1: Protocol Constants

**Files:**
- Create: `src/common/ChannelId.ts`
- Create: `src/common/ScrcpyCodec.ts`
- Modify: `src/common/Constants.ts`

- [ ] **Step 1: Create ChannelId.ts**

```typescript
// src/common/ChannelId.ts
export const enum ChannelId {
    VIDEO = 0,
    AUDIO = 1,
    CONTROL = 2,
    DEVICE_MSG = 3,
    METADATA = 4,
}
```

- [ ] **Step 2: Create ScrcpyCodec.ts**

```typescript
// src/common/ScrcpyCodec.ts
export const CODEC_ID = {
    H264: 0x68323634,
    H265: 0x68323635,
    AV1: 0x00617631,
    OPUS: 0x6f707573,
    AAC: 0x00616163,
    FLAC: 0x666c6163,
    RAW: 0x00726177,
} as const;

export const AUDIO_DISABLED = 0x00000000;
export const AUDIO_ERROR = 0x00000001;

export function codecName(id: number): string {
    switch (id) {
        case CODEC_ID.H264: return 'h264';
        case CODEC_ID.H265: return 'h265';
        case CODEC_ID.AV1: return 'av1';
        case CODEC_ID.OPUS: return 'opus';
        case CODEC_ID.AAC: return 'aac';
        case CODEC_ID.FLAC: return 'flac';
        case CODEC_ID.RAW: return 'raw';
        default: return `unknown(0x${id.toString(16)})`;
    }
}
```

- [ ] **Step 3: Update Constants.ts**

Replace the entire contents of `src/common/Constants.ts` with:

```typescript
// src/common/Constants.ts
export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_VERSION = '3.3.4';
export const SERVER_PROCESS_NAME = 'app_process';
export const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
```

- [ ] **Step 4: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds (new files are unused so far; Constants.ts consumers still compile because `SERVER_PACKAGE` and `SERVER_PROCESS_NAME` still exist).

Note: `ARGS_STRING`, `SERVER_PORT`, `SERVER_TYPE`, `LOG_LEVEL` are removed. ScrcpyServer.ts (Task 9) and any other importers will be updated before they're needed.

- [ ] **Step 5: Commit**

```bash
git add src/common/ChannelId.ts src/common/ScrcpyCodec.ts src/common/Constants.ts
git commit -m "feat: add v3.x protocol constants (ChannelId, ScrcpyCodec, Constants)"
```

---

### Task 2: ScrcpyOptions

**Files:**
- Create: `src/server/ScrcpyOptions.ts`

- [ ] **Step 1: Create ScrcpyOptions.ts**

```typescript
// src/server/ScrcpyOptions.ts
export interface ScrcpyOptions {
    scid: string;
    videoCodec?: 'h264';
    audioCodec?: 'opus';
    maxSize?: number;
    videoBitRate?: number;
    maxFps?: number;
    audio?: boolean;
    control?: boolean;
    displayId?: number;
    sendDeviceMeta?: boolean;
    sendCodecMeta?: boolean;
    sendFrameMeta?: boolean;
    tunnelForward?: boolean;
}

const DEFAULTS: Omit<Required<ScrcpyOptions>, 'scid'> = {
    videoCodec: 'h264',
    audioCodec: 'opus',
    maxSize: 0,
    videoBitRate: 8000000,
    maxFps: 0,
    audio: true,
    control: true,
    displayId: 0,
    sendDeviceMeta: true,
    sendCodecMeta: true,
    sendFrameMeta: true,
    tunnelForward: false,
};

function toSnakeCase(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function serializeOptions(options: ScrcpyOptions): string[] {
    const args: string[] = [];
    for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
        const value = (options as Record<string, unknown>)[key];
        if (value !== undefined && value !== defaultValue) {
            args.push(`${toSnakeCase(key)}=${value}`);
        }
    }
    // scid is always emitted
    args.push(`scid=${options.scid}`);
    return args;
}
```

- [ ] **Step 2: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds (new file, no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add src/server/ScrcpyOptions.ts
git commit -m "feat: add ScrcpyOptions builder with key=value serialization"
```

---

### Task 3: FrameReader

**Files:**
- Create: `src/server/FrameReader.ts`

- [ ] **Step 1: Create FrameReader.ts**

```typescript
// src/server/FrameReader.ts
import type net from 'net';

const PTS_FLAG_CONFIG = 0x8000000000000000n;
const PTS_FLAG_KEYFRAME = 0x4000000000000000n;
const PTS_CLEAR_FLAGS = 0x3fffffffffffffffn;
const HEADER_SIZE = 12; // 8 (PTS) + 4 (size)

export interface ScrcpyFrame {
    type: 'config' | 'keyframe' | 'frame';
    pts: bigint;
    data: Buffer;
}

export class FrameReader {
    private buffer = Buffer.alloc(0);
    private frameCallback?: (frame: ScrcpyFrame) => void;
    private endCallback?: () => void;

    constructor(private readonly socket: net.Socket) {
        socket.on('data', this.onData);
        socket.on('end', () => this.endCallback?.());
        socket.on('error', () => this.endCallback?.());
    }

    onFrame(callback: (frame: ScrcpyFrame) => void): void {
        this.frameCallback = callback;
    }

    onEnd(callback: () => void): void {
        this.endCallback = callback;
    }

    private onData = (chunk: Buffer): void => {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        this.drain();
    };

    private drain(): void {
        while (this.buffer.length >= HEADER_SIZE) {
            const rawPts = this.buffer.readBigUInt64BE(0);
            const size = this.buffer.readUInt32BE(8);
            const totalSize = HEADER_SIZE + size;

            if (this.buffer.length < totalSize) {
                break; // wait for more data
            }

            const isConfig = (rawPts & PTS_FLAG_CONFIG) !== 0n;
            const isKeyframe = (rawPts & PTS_FLAG_KEYFRAME) !== 0n;
            const pts = rawPts & PTS_CLEAR_FLAGS;

            const data = this.buffer.subarray(HEADER_SIZE, totalSize);
            this.buffer = this.buffer.subarray(totalSize);

            const type = isConfig ? 'config' : isKeyframe ? 'keyframe' : 'frame';
            this.frameCallback?.({ type, pts, data });
        }
    }

    destroy(): void {
        this.socket.removeListener('data', this.onData);
        this.frameCallback = undefined;
        this.endCallback = undefined;
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/server/FrameReader.ts
git commit -m "feat: add FrameReader for scrcpy v3.x frame format parsing"
```

---

### Task 4: ScrcpyConnection

**Files:**
- Create: `src/server/ScrcpyConnection.ts`
- Modify: `src/server/AdbClient.ts`

- [ ] **Step 1: Add removeReverse to AdbClient.ts**

In `src/server/AdbClient.ts`, add this method after the existing `reverse()` method (after line 67):

```typescript
    async removeReverse(serial: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', '--remove', remote]);
    }
```

- [ ] **Step 2: Create ScrcpyConnection.ts**

```typescript
// src/server/ScrcpyConnection.ts
import crypto from 'crypto';
import net from 'net';
import path from 'path';
import type WS from 'ws';
import { ACTION } from '../common/Action';
import { ChannelId } from '../common/ChannelId';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE, SERVER_VERSION } from '../common/Constants';
import { AUDIO_DISABLED, AUDIO_ERROR, codecName } from '../common/ScrcpyCodec';
import { AdbClient } from './AdbClient';
import { FrameReader } from './FrameReader';
import { type ScrcpyOptions, serializeOptions } from './ScrcpyOptions';
import { Mw, type RequestParameters } from './mw/Mw';

const TAG = '[ScrcpyConnection]';
const SERVER_FILE = path.join(__dirname, 'assets', 'scrcpy-server');

interface SessionMetadata {
    deviceName: string;
    videoCodec: string;
    screenWidth: number;
    screenHeight: number;
    audioCodec: string;
}

export class ScrcpyConnection extends Mw {
    private adbClient = new AdbClient();
    private tcpServer?: net.Server;
    private videoSocket?: net.Socket;
    private audioSocket?: net.Socket;
    private controlSocket?: net.Socket;
    private videoReader?: FrameReader;
    private audioReader?: FrameReader;
    private reverseTunnel?: string;
    private serverProcess?: import('child_process').ChildProcess;
    private released = false;

    public static processRequest(ws: WS, params: RequestParameters): ScrcpyConnection | undefined {
        const { action, url } = params;
        if (action !== ACTION.STREAM_SCRCPY) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, `${TAG} Missing "udid" parameter`);
            return;
        }
        const connection = new ScrcpyConnection(ws, udid, url.searchParams);
        return connection;
    }

    private constructor(
        ws: WS,
        private readonly serial: string,
        private readonly queryParams: URLSearchParams,
    ) {
        super(ws);
        this.start().catch((err) => {
            console.error(TAG, `Failed to start session for ${serial}:`, err.message);
            if (ws.readyState === ws.OPEN) {
                ws.close(4005, err.message);
            }
        });
    }

    private buildOptions(): ScrcpyOptions {
        const scid = crypto.randomInt(0, 0x7fffffff).toString(16).padStart(8, '0');
        const options: ScrcpyOptions = { scid };

        const maxSize = this.queryParams.get('maxSize');
        if (maxSize) options.maxSize = Number.parseInt(maxSize, 10);

        const bitrate = this.queryParams.get('bitrate');
        if (bitrate) options.videoBitRate = Number.parseInt(bitrate, 10);

        const maxFps = this.queryParams.get('maxFps');
        if (maxFps) options.maxFps = Number.parseInt(maxFps, 10);

        const displayId = this.queryParams.get('displayId');
        if (displayId) options.displayId = Number.parseInt(displayId, 10);

        return options;
    }

    private async start(): Promise<void> {
        const options = this.buildOptions();
        console.log(TAG, `Starting session for ${this.serial} (scid=${options.scid})`);

        // 1. Push scrcpy-server binary
        await this.adbClient.push(this.serial, SERVER_FILE, DEVICE_SERVER_PATH);

        // 2. Start local TCP server on ephemeral port
        const { server, port } = await this.createTcpServer();
        this.tcpServer = server;

        // 3. Set up ADB reverse tunnel
        this.reverseTunnel = `localabstract:scrcpy_${options.scid}`;
        await this.adbClient.reverse(this.serial, this.reverseTunnel, `tcp:${port}`);

        // 4. Launch scrcpy-server
        const args = serializeOptions(options);
        const cmd = `CLASSPATH=${DEVICE_SERVER_PATH} app_process / ${SERVER_PACKAGE} ${SERVER_VERSION} ${args.join(' ')}`;
        this.serverProcess = this.adbClient.shellSpawn(this.serial, cmd);
        this.serverProcess.on('exit', () => {
            console.log(TAG, `Server process exited for ${this.serial}`);
            if (!this.released) {
                this.release();
            }
        });

        // 5. Accept 3 TCP connections (video, audio, control) in order
        const sockets = await this.acceptSockets(server, 3, 10000);
        this.videoSocket = sockets[0];
        this.audioSocket = sockets[1];
        this.controlSocket = sockets[2];

        // 6. Parse initial metadata
        const metadata = await this.parseMetadata();
        console.log(TAG, `Session ready: ${metadata.deviceName} ${metadata.screenWidth}x${metadata.screenHeight}`);

        // 7. Send metadata to browser
        this.sendChannel(ChannelId.METADATA, Buffer.from(JSON.stringify(metadata)));

        // 8. Start forwarding
        this.startForwarding();
    }

    private createTcpServer(): Promise<{ server: net.Server; port: number }> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address() as net.AddressInfo;
                resolve({ server, port: addr.port });
            });
            server.on('error', reject);
        });
    }

    private acceptSockets(server: net.Server, count: number, timeoutMs: number): Promise<net.Socket[]> {
        return new Promise((resolve, reject) => {
            const sockets: net.Socket[] = [];
            const timeout = setTimeout(() => {
                server.removeAllListeners('connection');
                reject(new Error(`Timeout waiting for ${count} TCP connections (got ${sockets.length})`));
            }, timeoutMs);

            server.on('connection', (socket) => {
                sockets.push(socket);
                if (sockets.length === count) {
                    clearTimeout(timeout);
                    resolve(sockets);
                }
            });
        });
    }

    private async parseMetadata(): Promise<SessionMetadata> {
        // Video socket: 64 bytes device name + 4 bytes codec ID + 4 bytes width + 4 bytes height
        const videoMeta = await this.readExact(this.videoSocket!, 76);
        const deviceNameBytes = videoMeta.subarray(0, 64);
        const nullIdx = deviceNameBytes.indexOf(0);
        const deviceName = deviceNameBytes.subarray(0, nullIdx === -1 ? 64 : nullIdx).toString('utf-8');
        const videoCodecId = videoMeta.readUInt32BE(64);
        const screenWidth = videoMeta.readUInt32BE(68);
        const screenHeight = videoMeta.readUInt32BE(72);

        // Audio socket: 4 bytes codec ID or status
        const audioMeta = await this.readExact(this.audioSocket!, 4);
        const audioCodecId = audioMeta.readUInt32BE(0);

        let audioCodec: string;
        if (audioCodecId === AUDIO_DISABLED) {
            audioCodec = 'disabled';
        } else if (audioCodecId === AUDIO_ERROR) {
            audioCodec = 'error';
        } else {
            audioCodec = codecName(audioCodecId);
        }

        return {
            deviceName,
            videoCodec: codecName(videoCodecId),
            screenWidth,
            screenHeight,
            audioCodec,
        };
    }

    private readExact(socket: net.Socket, size: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            let buffer = Buffer.alloc(0);
            const onData = (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length >= size) {
                    socket.removeListener('data', onData);
                    socket.removeListener('error', onError);
                    // Put back any extra bytes
                    if (buffer.length > size) {
                        socket.unshift(buffer.subarray(size));
                    }
                    resolve(buffer.subarray(0, size));
                }
            };
            const onError = (err: Error) => {
                socket.removeListener('data', onData);
                reject(err);
            };
            socket.on('data', onData);
            socket.once('error', onError);
        });
    }

    private startForwarding(): void {
        // Video: TCP → channel 0 → WS
        this.videoReader = new FrameReader(this.videoSocket!);
        this.videoReader.onFrame((frame) => {
            const header = Buffer.alloc(12);
            header.writeBigUInt64BE(frame.pts, 0);
            header.writeUInt32BE(frame.data.length, 8);
            // Restore flags in PTS for browser-side parsing
            if (frame.type === 'config') {
                const hi = header.readUInt32BE(0);
                header.writeUInt32BE(hi | 0x80000000, 0);
            } else if (frame.type === 'keyframe') {
                const hi = header.readUInt32BE(0);
                header.writeUInt32BE(hi | 0x40000000, 0);
            }
            this.sendChannel(ChannelId.VIDEO, Buffer.concat([header, frame.data]));
        });
        this.videoReader.onEnd(() => this.release());

        // Audio: TCP → channel 1 → WS
        this.audioReader = new FrameReader(this.audioSocket!);
        this.audioReader.onFrame((frame) => {
            const header = Buffer.alloc(12);
            header.writeBigUInt64BE(frame.pts, 0);
            header.writeUInt32BE(frame.data.length, 8);
            if (frame.type === 'config') {
                const hi = header.readUInt32BE(0);
                header.writeUInt32BE(hi | 0x80000000, 0);
            }
            this.sendChannel(ChannelId.AUDIO, Buffer.concat([header, frame.data]));
        });

        // Control socket: device messages → channel 3 → WS
        this.controlSocket!.on('data', (data) => {
            this.sendChannel(ChannelId.DEVICE_MSG, data);
        });
    }

    private sendChannel(channel: ChannelId, payload: Buffer): void {
        if (this.ws.readyState !== this.ws.OPEN) return;
        const msg = Buffer.allocUnsafe(1 + payload.length);
        msg[0] = channel;
        payload.copy(msg, 1);
        this.ws.send(msg);
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        // Browser → server: control messages on channel 2
        if (event.data instanceof Buffer || event.data instanceof ArrayBuffer) {
            const data = Buffer.from(event.data as ArrayBuffer);
            if (data.length < 2) return;
            const channel = data[0];
            const payload = data.subarray(1);
            if (channel === ChannelId.CONTROL && this.controlSocket && !this.controlSocket.destroyed) {
                this.controlSocket.write(payload);
            }
        }
    }

    public release(): void {
        if (this.released) return;
        this.released = true;
        console.log(TAG, `Releasing session for ${this.serial}`);

        this.videoReader?.destroy();
        this.audioReader?.destroy();
        this.videoSocket?.destroy();
        this.audioSocket?.destroy();
        this.controlSocket?.destroy();

        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill();
        }

        if (this.reverseTunnel) {
            this.adbClient.removeReverse(this.serial, this.reverseTunnel).catch(() => {});
        }

        this.tcpServer?.close();
        super.release();
    }
}
```

- [ ] **Step 3: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds (ScrcpyConnection imports Mw which is a valid server-side module; all imports resolve).

- [ ] **Step 4: Commit**

```bash
git add src/server/ScrcpyConnection.ts src/server/AdbClient.ts
git commit -m "feat: add ScrcpyConnection TCP-to-WebSocket bridge"
```

---

### Task 5: ScrcpyDemuxer

**Files:**
- Create: `src/app/ScrcpyDemuxer.ts`

- [ ] **Step 1: Create ScrcpyDemuxer.ts**

```typescript
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

export type VideoFrameCallback = (
    data: Uint8Array,
    pts: bigint,
    isConfig: boolean,
    isKeyframe: boolean,
) => void;

export type AudioFrameCallback = (
    data: Uint8Array,
    pts: bigint,
    isConfig: boolean,
) => void;

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
```

- [ ] **Step 2: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/ScrcpyDemuxer.ts
git commit -m "feat: add ScrcpyDemuxer for browser-side channel routing"
```

---

### Task 6: Audio Pipeline

**Files:**
- Create: `src/app/audio/PcmWorklet.ts`
- Create: `src/app/audio/AudioPlayer.ts`

- [ ] **Step 1: Create PcmWorklet.ts**

This file exports the AudioWorkletProcessor source as a string, loaded at runtime via Blob URL.

```typescript
// src/app/audio/PcmWorklet.ts
export const PCM_WORKLET_NAME = 'pcm-worklet';

export const PCM_WORKLET_SOURCE = `
class PcmWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._queue = [];
        this.port.onmessage = (e) => {
            this._queue.push({
                channels: e.data.channels,
                numFrames: e.data.numFrames,
                offset: 0,
            });
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output.length) return true;
        const frameCount = output[0].length;
        const outChannels = output.length;
        let written = 0;

        while (written < frameCount && this._queue.length > 0) {
            const block = this._queue[0];
            const remaining = block.numFrames - block.offset;
            const toWrite = Math.min(frameCount - written, remaining);

            for (let ch = 0; ch < outChannels; ch++) {
                const src = ch < block.channels.length ? block.channels[ch] : block.channels[0];
                output[ch].set(src.subarray(block.offset, block.offset + toWrite), written);
            }

            written += toWrite;
            block.offset += toWrite;

            if (block.offset >= block.numFrames) {
                this._queue.shift();
            }
        }

        // Fill remaining with silence (underrun)
        if (written < frameCount) {
            for (let ch = 0; ch < outChannels; ch++) {
                output[ch].fill(0, written);
            }
        }

        return true;
    }
}

registerProcessor('${PCM_WORKLET_NAME}', PcmWorkletProcessor);
`;
```

- [ ] **Step 2: Create AudioPlayer.ts**

```typescript
// src/app/audio/AudioPlayer.ts
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from './PcmWorklet';

export class AudioPlayer {
    private audioContext?: AudioContext;
    private decoder?: AudioDecoder;
    private workletNode?: AudioWorkletNode;
    private gainNode?: GainNode;
    private started = false;
    private workletReady = false;

    constructor(private readonly codec: 'opus' = 'opus') {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        this.audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });

        // Load worklet via Blob URL
        const blob = new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);

        this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME, {
            outputChannelCount: [2],
        });
        this.gainNode = this.audioContext.createGain();
        this.workletNode.connect(this.gainNode);
        this.gainNode.connect(this.audioContext.destination);
        this.workletReady = true;

        // Configure audio decoder
        this.decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
                if (!this.workletReady) {
                    audioData.close();
                    return;
                }
                const numChannels = audioData.numberOfChannels;
                const numFrames = audioData.numberOfFrames;
                const channels: Float32Array[] = [];
                for (let ch = 0; ch < numChannels; ch++) {
                    const channelData = new Float32Array(numFrames);
                    audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
                    channels.push(channelData);
                }
                audioData.close();
                this.workletNode!.port.postMessage(
                    { channels, numFrames },
                    channels.map((c) => c.buffer),
                );
            },
            error: (err: DOMException) => {
                console.error('[AudioPlayer] Decoder error:', err.message);
            },
        });

        this.decoder.configure({
            codec: this.codec,
            sampleRate: 48000,
            numberOfChannels: 2,
        });
    }

    pushFrame(data: Uint8Array, pts: bigint, isConfig: boolean): void {
        if (isConfig || !this.decoder || this.decoder.state !== 'configured') {
            return; // Skip config packets; Opus frames are self-contained
        }
        this.decoder.decode(
            new EncodedAudioChunk({
                type: 'key', // All Opus frames are independent
                timestamp: Number(pts),
                data,
            }),
        );
    }

    /** Resume AudioContext after user interaction (autoplay policy). */
    async resume(): Promise<void> {
        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    setVolume(volume: number): void {
        if (this.gainNode) {
            this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    stop(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.workletNode?.disconnect();
        this.gainNode?.disconnect();
        this.audioContext?.close();
        this.started = false;
        this.workletReady = false;
    }
}
```

- [ ] **Step 3: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/audio/PcmWorklet.ts src/app/audio/AudioPlayer.ts
git commit -m "feat: add AudioPlayer with WebCodecs AudioDecoder and AudioWorklet playback"
```

---

### Task 7: Update Control Messages for v3.x

**Files:**
- Modify: `src/app/controlMessage/ControlMessage.ts`
- Modify: `src/app/controlMessage/TouchControlMessage.ts`
- Modify: `src/app/controlMessage/ScrollControlMessage.ts`
- Modify: `src/app/controlMessage/CommandControlMessage.ts`
- Modify: `src/app/googDevice/DeviceMessage.ts`

- [ ] **Step 1: Add new type constants to ControlMessage.ts**

In `src/app/controlMessage/ControlMessage.ts`, add after `TYPE_ROTATE_DEVICE = 11` (line 17):

```typescript
    public static TYPE_UHID_CREATE = 12;
    public static TYPE_UHID_INPUT = 13;
    public static TYPE_UHID_DESTROY = 14;
    public static TYPE_OPEN_HARD_KEYBOARD_SETTINGS = 15;
    public static TYPE_START_APP = 16;
    public static TYPE_RESET_VIDEO = 17;
```

- [ ] **Step 2: Update TouchControlMessage.ts**

In `src/app/controlMessage/TouchControlMessage.ts`, make these changes:

Change `PAYLOAD_LENGTH` from 28 to 32:
```typescript
    public static PAYLOAD_LENGTH = 32;
```

Add `actionButton` to the constructor (after `pressure`, before `buttons`):
```typescript
    constructor(
        readonly action: number,
        readonly pointerId: number,
        readonly position: Position,
        readonly pressure: number,
        readonly actionButton: number,
        readonly buttons: number,
    ) {
        super(ControlMessage.TYPE_TOUCH);
    }
```

Replace the `toBuffer()` method body:
```typescript
    public toBuffer(): Buffer {
        const buffer: Buffer = Buffer.alloc(TouchControlMessage.PAYLOAD_LENGTH + 1);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt8(this.action, offset);
        offset = buffer.writeUInt32BE(0, offset); // pointerId high 32 bits
        offset = buffer.writeUInt32BE(this.pointerId, offset);
        offset = buffer.writeUInt32BE(this.position.point.x, offset);
        offset = buffer.writeUInt32BE(this.position.point.y, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
        offset = buffer.writeUInt16BE(this.pressure * TouchControlMessage.MAX_PRESSURE_VALUE, offset);
        offset = buffer.writeUInt32BE(this.actionButton, offset);
        buffer.writeUInt32BE(this.buttons, offset);
        return buffer;
    }
```

Update `toString()` and `toJSON()` to include `actionButton`:
```typescript
    public toString(): string {
        return `TouchControlMessage{action=${this.action}, pointerId=${this.pointerId}, position=${this.position}, pressure=${this.pressure}, actionButton=${this.actionButton}, buttons=${this.buttons}}`;
    }

    public toJSON(): TouchControlMessageInterface {
        return {
            type: this.type,
            action: this.action,
            pointerId: this.pointerId,
            position: this.position.toJSON(),
            pressure: this.pressure,
            actionButton: this.actionButton,
            buttons: this.buttons,
        };
    }
```

Update the interface at the top of the file to include `actionButton`:
```typescript
export interface TouchControlMessageInterface extends ControlMessageInterface {
    type: number;
    action: number;
    pointerId: number;
    position: PositionInterface;
    pressure: number;
    actionButton: number;
    buttons: number;
}
```

- [ ] **Step 3: Update ScrollControlMessage.ts**

In `src/app/controlMessage/ScrollControlMessage.ts`:

Change `PAYLOAD_LENGTH` from 20 to 25:
```typescript
    public static PAYLOAD_LENGTH = 25;
```

Update constructor to add `buttons` parameter:
```typescript
    constructor(
        readonly position: Position,
        readonly hScroll: number,
        readonly vScroll: number,
        readonly buttons: number,
    ) {
        super(ControlMessage.TYPE_SCROLL);
    }
```

The scroll values use **i16 fixed-point** encoding (matches scrcpy's `sc_float_to_i16fp`): normalize by dividing by 16, clamp to [-1, 1], then map to int16 range. Message is 21 bytes (PAYLOAD_LENGTH = 20). Replace `toBuffer()`:
```typescript
    // NOTE: This plan originally specified int32 SignedFloat (25 bytes).
    // Verified against scrcpy source: actual format is int16 i16fp (21 bytes).
    // See control_msg.c: sc_control_msg_serialize_inject_scroll_event.
```

Update `toString()` and `toJSON()`:
```typescript
    public toString(): string {
        return `ScrollControlMessage{hScroll=${this.hScroll}, vScroll=${this.vScroll}, buttons=${this.buttons}, position=${this.position}}`;
    }

    public toJSON(): ScrollControlMessageInterface {
        return {
            type: this.type,
            position: this.position.toJSON(),
            hScroll: this.hScroll,
            vScroll: this.vScroll,
            buttons: this.buttons,
        };
    }
```

Update the interface:
```typescript
export interface ScrollControlMessageInterface extends ControlMessageInterface {
    position: PositionInterface;
    hScroll: number;
    vScroll: number;
    buttons: number;
}
```

- [ ] **Step 4: Update CommandControlMessage.ts SetClipboard**

In `src/app/controlMessage/CommandControlMessage.ts`, replace the `createSetClipboardCommand` method:

```typescript
    public static createSetClipboardCommand(text: string, paste = false, sequence = 0n): CommandControlMessage {
        const event = new CommandControlMessage(ControlMessage.TYPE_SET_CLIPBOARD);
        const textBytes: Uint8Array | null = text ? Util.stringToUtf8ByteArray(text) : null;
        const textLength = textBytes ? textBytes.length : 0;
        let offset = 0;
        // type(1) + sequence(8) + paste(1) + textLength(4) + text
        const buffer = Buffer.alloc(1 + 8 + 1 + 4 + textLength);
        offset = buffer.writeInt8(event.type, offset);
        buffer.writeBigUInt64BE(BigInt(sequence), offset);
        offset += 8;
        offset = buffer.writeUInt8(paste ? 1 : 0, offset);
        offset = buffer.writeInt32BE(textLength, offset);
        if (textBytes) {
            textBytes.forEach((byte: number, index: number) => {
                buffer.writeUInt8(byte, index + offset);
            });
        }
        event.buffer = buffer;
        return event;
    }
```

- [ ] **Step 5: Update DeviceMessage.ts**

In `src/app/googDevice/DeviceMessage.ts`, add new type constants and parsing:

After `TYPE_CLIPBOARD = 0` (line 4):
```typescript
    public static TYPE_ACK_CLIPBOARD = 1;
    public static TYPE_UHID_OUTPUT = 2;
```

Change `TYPE_PUSH_RESPONSE` from 101 to keep it (it's a custom type, unused with vanilla scrcpy but still referenced by FilePushHandler):
```typescript
    public static TYPE_PUSH_RESPONSE = 101; // custom, not used with vanilla scrcpy v3.x
```

Replace the `fromBuffer` method to handle raw binary (no more magic bytes prefix):
```typescript
    public static fromRaw(data: Uint8Array): DeviceMessage {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const type = buffer.readUInt8(0);
        return new DeviceMessage(type, buffer);
    }
```

Add methods for new message types:
```typescript
    public getAckSequence(): bigint {
        if (this.type !== DeviceMessage.TYPE_ACK_CLIPBOARD) {
            throw TypeError(`Wrong message type: ${this.type}`);
        }
        return this.buffer.readBigUInt64BE(1);
    }
```

- [ ] **Step 6: Fix TouchControlMessage callers**

Search for `new TouchControlMessage(` in the codebase. The callers are in interaction handlers. They need the new `actionButton` parameter (0 for most cases):

In `src/app/interactionHandler/InteractionHandler.ts`, find all `new TouchControlMessage(` calls and add `0` (actionButton) before the `buttons` argument. For example, if a call looks like:
```typescript
new TouchControlMessage(action, pointerId, position, pressure, buttons)
```
Change it to:
```typescript
new TouchControlMessage(action, pointerId, position, pressure, 0, buttons)
```

Similarly in `src/app/interactionHandler/FeaturedInteractionHandler.ts` and `src/app/interactionHandler/SimpleInteractionHandler.ts`.

In `src/app/interactionHandler/InteractionHandler.ts`, find all `new ScrollControlMessage(` calls and add `0` (buttons) as the 4th argument:
```typescript
// Old:
new ScrollControlMessage(position, hScroll, vScroll)
// New:
new ScrollControlMessage(position, hScroll, vScroll, 0)
```

- [ ] **Step 7: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -20`

Expected: Build succeeds. All control message callers compile with updated signatures.

- [ ] **Step 8: Commit**

```bash
git add src/app/controlMessage/ src/app/googDevice/DeviceMessage.ts src/app/interactionHandler/
git commit -m "feat: update control messages and DeviceMessage for scrcpy v3.x protocol"
```

---

### Task 8: Update WebCodecsPlayer

**Files:**
- Modify: `src/app/player/WebCodecsPlayer.ts`

- [ ] **Step 1: Rewrite WebCodecsPlayer for v3.x frame format**

Replace the entire contents of `src/app/player/WebCodecsPlayer.ts` with:

```typescript
import type { DisplayInfo } from '../DisplayInfo';
import Rect from '../Rect';
import ScreenInfo from '../ScreenInfo';
import Size from '../Size';
import VideoSettings from '../VideoSettings';
import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import { BasePlayer } from './BasePlayer';
import { parseSPS } from './h264-utils';

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
            // Config packet contains SPS + PPS NAL units
            // Find SPS NAL (type 7) to extract codec string and dimensions
            const spsOffset = this.findNaluOffset(data, 7);
            if (spsOffset >= 0) {
                const { codec, width, height } = WebCodecsPlayer.parseSPSCodecString(data.subarray(spsOffset));
                this.scaleCanvas(width, height);
                if (this.decoder.state === 'configured') {
                    this.decoder.flush().catch(() => {});
                }
                this.decoder.configure({
                    codec,
                    optimizeForLatency: true,
                } as VideoDecoderConfig);
            }
            this.configData = new Uint8Array(data);
            return;
        }

        if (this.decoder.state !== 'configured') return;

        if (isKeyframe && this.configData) {
            // Prepend SPS/PPS config to keyframe for decoder
            const fullData = new Uint8Array(this.configData.length + data.length);
            fullData.set(this.configData);
            fullData.set(data, this.configData.length);

            if (!this.receivedFirstFrame) {
                this.receivedFirstFrame = true;
            }

            this.decoder.decode(
                new EncodedVideoChunk({
                    type: 'key',
                    timestamp: Number(pts),
                    data: fullData,
                }),
            );
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
    }
}
```

- [ ] **Step 2: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -5`

Expected: Build succeeds. WebCodecsPlayer still extends BaseCanvasBasedPlayer unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/app/player/WebCodecsPlayer.ts
git commit -m "feat: update WebCodecsPlayer for v3.x PTS-based frame decoding"
```

---

### Task 9: Server Pipeline Switchover

**Files:**
- Modify: `src/server/goog-device/ScrcpyServer.ts`
- Modify: `src/server/goog-device/Device.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Rewrite ScrcpyServer.ts**

Replace the entire contents of `src/server/goog-device/ScrcpyServer.ts`:

```typescript
import path from 'path';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE, SERVER_PROCESS_NAME, SERVER_VERSION } from '../../common/Constants';
import type { Device } from './Device';

const FILE_DIR = path.join(__dirname, 'assets');
const FILE_NAME = 'scrcpy-server';

export class ScrcpyServer {
    /** Push the scrcpy-server binary to the device. */
    public static async pushServer(device: Device): Promise<void> {
        const src = path.join(FILE_DIR, FILE_NAME);
        return device.push(src, DEVICE_SERVER_PATH);
    }

    /** Check if scrcpy-server (app_process) is running on the device. */
    public static async getServerPid(device: Device): Promise<number | undefined> {
        if (!device.isConnected()) return;
        const list = await device.getPidOf(SERVER_PROCESS_NAME);
        if (!Array.isArray(list) || !list.length) return;

        for (const pid of list) {
            const output = await device.runShellCommand(`cat /proc/${pid}/cmdline`);
            const args = output.split('\0');
            if (args.includes(SERVER_PACKAGE)) {
                return pid;
            }
        }
        return;
    }
}
```

- [ ] **Step 2: Simplify Device.ts**

In `src/server/goog-device/Device.ts`:

**Remove these imports** (line 5-6):
```typescript
// DELETE: import { ScrcpyServer } from './ScrcpyServer';
// DELETE: import Timeout = NodeJS.Timeout;
```

Wait — `Timeout` is used elsewhere in Device. Keep it. Only remove ScrcpyServer import.

Actually, `Timeout` is used for `updateTimeoutId` and `throttleTimeoutId`. Keep it.

**Remove the `ScrcpyServer` import** (line 6):
```typescript
// DELETE this line:
import { ScrcpyServer } from './ScrcpyServer';
```

**Remove these fields** from the class:
- `private spawnServer = true;` (line 28)

**Remove these methods entirely:**
- `private async getServerPid()` (lines 360-377)
- `public async killServer(pid: number)` (lines 400-419)
- `public async startServer()` (lines 422-438)

**Simplify `fetchDeviceInfo`** — remove the server PID tracking. Replace the `fetchDeviceInfo` method (starting at line 286) with:

```typescript
    private fetchDeviceInfo = (): void => {
        if (this.connected) {
            const propsPromise = this.getProperties().then((props) => {
                if (!props) return false;
                let changed = false;
                Properties.forEach((propName: keyof GoogDeviceDescriptor) => {
                    if (props[propName] !== this.descriptor[propName]) {
                        changed = true;
                        (this.descriptor[propName] as any) = props[propName];
                    }
                });
                if (changed) this.emitUpdate();
                return true;
            });
            const netIntPromise = this.updateInterfaces().then((interfaces) => {
                return !!interfaces.length;
            });
            Promise.all([propsPromise, netIntPromise])
                .then((results) => {
                    this.updateTimeoutId = undefined;
                    const failedCount = results.filter((result) => !result).length;
                    if (!failedCount) {
                        this.updateCount = 0;
                        this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
                    } else {
                        this.scheduleInfoUpdate();
                    }
                })
                .catch(() => {
                    this.updateTimeoutId = undefined;
                    this.scheduleInfoUpdate();
                });
        } else {
            this.updateCount = 0;
            this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
            this.updateTimeoutId = undefined;
            this.emitUpdate();
        }
    };
```

**In the `setState` method** — the `descriptor.pid` field no longer tracks server PID. Set it to 0 for connected devices so the device list always shows stream buttons:

In `setState()`:
```typescript
    public setState(state: string): void {
        if (state === 'device') {
            this.connected = true;
            this.properties = undefined;
            this.descriptor.pid = 0; // No persistent server — stream buttons always shown
        } else {
            this.connected = false;
            this.descriptor.pid = -1;
        }
        this.descriptor.state = state;
        this.emitUpdate();
        this.fetchDeviceInfo();
    }
```

- [ ] **Step 3: Rewire server index.ts**

In `src/server/index.ts`:

Replace the `WebsocketProxy` import and add ScrcpyConnection:

```typescript
// Replace line 6:
// OLD: import { WebsocketProxy } from './mw/WebsocketProxy';
// NEW:
import { ScrcpyConnection } from './ScrcpyConnection';
```

Update the `mwList` to replace WebsocketProxy with ScrcpyConnection:

```typescript
// Replace line 14:
// OLD: const mwList: MwFactory[] = [WebsocketProxy, WebsocketMultiplexer];
// NEW:
const mwList: MwFactory[] = [ScrcpyConnection, WebsocketMultiplexer];
```

In the `loadGoogModules` function, **remove the WebsocketProxyOverAdb import and registration** (lines 26-27 and the last line `mwList.push(WebsocketProxyOverAdb)`):

```typescript
async function loadGoogModules() {
    const { ControlCenter } = await import('./goog-device/services/ControlCenter');
    const { DeviceTracker } = await import('./goog-device/mw/DeviceTracker');
    // REMOVED: const { WebsocketProxyOverAdb } = await import('./goog-device/mw/WebsocketProxyOverAdb');

    if (config.runLocalGoogTracker) {
        mw2List.push(DeviceTracker);
    }

    if (config.announceLocalGoogTracker) {
        HostTracker.registerLocalTracker(DeviceTracker);
    }

    servicesToStart.push(ControlCenter);

    const { RemoteShell } = await import('./goog-device/mw/RemoteShell');
    mw2List.push(RemoteShell);

    const { FileListing } = await import('./goog-device/mw/FileListing');
    mw2List.push(FileListing);

    // REMOVED: mwList.push(WebsocketProxyOverAdb);
}
```

- [ ] **Step 4: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -20`

Expected: Build succeeds. ScrcpyConnection is now wired as middleware. Old WebSocket proxy files still exist but are no longer imported.

- [ ] **Step 5: Commit**

```bash
git add src/server/goog-device/ScrcpyServer.ts src/server/goog-device/Device.ts src/server/index.ts
git commit -m "feat: wire ScrcpyConnection as stream handler, simplify Device"
```

---

### Task 10: Browser Pipeline Switchover

**Files:**
- Modify: `src/app/googDevice/client/StreamClientScrcpy.ts`

- [ ] **Step 1: Rewrite StreamClientScrcpy**

Replace the entire contents of `src/app/googDevice/client/StreamClientScrcpy.ts`:

```typescript
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

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private controlButtons?: HTMLElement;
    private deviceName = '';
    private touchHandler?: FeaturedInteractionHandler;
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
        this.startStream({ udid, player, playerName, fitToScreen, videoSettings });
        this.setBodyClass('stream');
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
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
            ws: Util.parseString(params, 'ws', true),
        };
    }

    private buildStreamUrl(): string {
        const { hostname, port, secure } = this.params;
        const protocol = secure ? 'wss' : 'ws';
        const host = hostname || window.location.hostname;
        const p = port || (secure ? 443 : 80);
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
            // Use the v3.x frame path with metadata
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

        // Start audio if available
        if (meta.audioCodec === 'opus' && this.audioPlayer) {
            this.audioPlayer.start().catch((err) => {
                console.error(TAG, 'Failed to start audio:', err.message);
            });
        }
    };

    public onDisconnected = (): void => {
        this.audioPlayer?.stop();
        this.touchHandler?.release();
        this.touchHandler = undefined;
    };

    public startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): void {
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
        this.audioPlayer = new AudioPlayer('opus');
        const resumeAudio = () => {
            this.audioPlayer?.resume();
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('keydown', resumeAudio);
        };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('keydown', resumeAudio, { once: true });

        // Connect via ScrcpyDemuxer
        const streamUrl = this.buildStreamUrl();
        this.demuxer = new ScrcpyDemuxer(streamUrl);
        this.demuxer.onVideoFrame(this.onVideoFrame);
        this.demuxer.onAudioFrame(this.onAudioFrame);
        this.demuxer.onDeviceMessage(this.OnDeviceMessage);
        this.demuxer.onMetadata(this.onMetadata);
        this.demuxer.onDisconnect(this.onDisconnected);

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

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        // In v3.x, changing video settings requires restarting the connection.
        // For now, just update the player locally.
        if (this.player) {
            this.player.setVideoSettings(videoSettings, !!this.fitToScreen, true);
        }
    }

    public getClientId(): number {
        return -1; // No client ID in vanilla scrcpy
    }

    public getClientsCount(): number {
        return 1; // Always 1 client per scrcpy session
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
        // Show stream button for any connected device (no PID check needed)
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
```

- [ ] **Step 2: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -20`

Expected: Build succeeds. StreamClientScrcpy no longer imports StreamReceiverScrcpy or StreamReceiver types. Old files still exist but are now unreferenced.

- [ ] **Step 3: Commit**

```bash
git add src/app/googDevice/client/StreamClientScrcpy.ts
git commit -m "feat: rewire StreamClientScrcpy to use ScrcpyDemuxer and AudioPlayer"
```

---

### Task 11: Delete Old Files and Swap Assets

**Files:**
- Delete: `src/server/mw/WebsocketProxy.ts`
- Delete: `src/server/goog-device/mw/WebsocketProxyOverAdb.ts`
- Delete: `src/app/client/StreamReceiver.ts`
- Delete: `src/app/googDevice/client/StreamReceiverScrcpy.ts`
- Delete: `src/server/goog-device/ServerVersion.ts`
- Delete: `assets/scrcpy-server.jar`
- Create: `assets/scrcpy-server` (download from GitHub)
- Modify: `webpack/ws-scrcpy-web.common.ts`

- [ ] **Step 1: Delete old streaming files**

```bash
cd <repo>
git rm src/server/mw/WebsocketProxy.ts
git rm src/server/goog-device/mw/WebsocketProxyOverAdb.ts
git rm src/app/client/StreamReceiver.ts
git rm src/app/googDevice/client/StreamReceiverScrcpy.ts
git rm src/server/goog-device/ServerVersion.ts
git rm assets/scrcpy-server.jar
```

- [ ] **Step 2: Download vanilla scrcpy-server v3.3.4**

```bash
cd <repo>
curl -L -o assets/scrcpy-server "https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4"
```

Verify the download:
```bash
ls -la assets/scrcpy-server
file assets/scrcpy-server
```

Expected: File exists, ~60KB, identified as Java archive or Zip data.

- [ ] **Step 3: Update webpack asset rule**

In `webpack/ws-scrcpy-web.common.ts`, replace the `.jar` asset rule (around line 80) with a rule that handles both the old `.jar` extension and the new extensionless binary:

Replace:
```typescript
                {
                    test: /\.jar$/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'assets/[name][ext]',
                    },
                },
```

With:
```typescript
                {
                    test: /[\\/]assets[\\/]scrcpy-server/,
                    type: 'asset/resource',
                    generator: {
                        filename: 'assets/scrcpy-server',
                    },
                },
```

- [ ] **Step 4: Update scrcpy-server import in ScrcpyConnection.ts**

In `src/server/ScrcpyConnection.ts`, add the webpack asset import near the top imports:

```typescript
import '../../../assets/scrcpy-server';
```

This triggers webpack to copy the file to `dist/assets/scrcpy-server`.

Note: The `SERVER_FILE` constant in ScrcpyConnection already points to `path.join(__dirname, 'assets', 'scrcpy-server')` which matches the webpack output path.

- [ ] **Step 5: Remove old asset import from ScrcpyServer.ts**

In `src/server/goog-device/ScrcpyServer.ts`, remove the old import (if still present):

```typescript
// DELETE this line if present:
import '../../../assets/scrcpy-server.jar';
```

- [ ] **Step 6: Verify build**

Run: `npx webpack --config webpack/ws-scrcpy-web.prod.ts 2>&1 | tail -20`

Expected: Build succeeds. No references to deleted files remain. Asset is copied to dist.

Verify the asset was copied:
```bash
ls -la dist/assets/scrcpy-server
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace patched scrcpy-server v1.19 with vanilla v3.3.4, delete old streaming code"
```

---

### Task 12: Documentation and Final Build Verification

**Files:**
- Modify: `THIRD-PARTY-NOTICES.md`

- [ ] **Step 1: Update THIRD-PARTY-NOTICES.md**

In `THIRD-PARTY-NOTICES.md`, update the scrcpy section description. Replace:

```
This project uses the [scrcpy](https://github.com/Genymobile/scrcpy) server component by Genymobile, licensed under the Apache License 2.0.
```

With:

```
This project bundles the [scrcpy](https://github.com/Genymobile/scrcpy) server component (v3.3.4) by Genymobile, licensed under the Apache License 2.0. The vanilla, unmodified scrcpy-server binary is included in `assets/scrcpy-server`.
```

- [ ] **Step 2: Full build verification**

```bash
cd <repo>
npm run build
```

Expected: Clean build with no errors.

- [ ] **Step 3: Lint check**

```bash
cd <repo>
npm run lint
```

Expected: No errors (warnings are OK for pre-existing issues).

- [ ] **Step 4: Verify dist output**

```bash
ls -la dist/
ls -la dist/assets/
ls -la dist/public/
```

Expected:
- `dist/index.js` — server bundle
- `dist/assets/scrcpy-server` — vanilla v3.3.4 binary
- `dist/public/bundle.js` — client bundle
- `dist/public/bundle.css` — styles
- `dist/public/index.html` — entry page

- [ ] **Step 5: Commit**

```bash
git add THIRD-PARTY-NOTICES.md
git commit -m "docs: update THIRD-PARTY-NOTICES for scrcpy-server v3.3.4"
```

---

## Notes

### What Changed from the Spec

1. **ScrcpyConnection is a Mw subclass** — registered as middleware in `mwList`, handles `ACTION.STREAM_SCRCPY` directly. The spec described it as standalone; this fits the existing middleware pattern.

2. **Device.ts no longer tracks server PID** — `descriptor.pid` is set to `0` for connected devices so the UI always shows stream buttons. The old approach (auto-start server, track PID) doesn't apply with vanilla scrcpy where the server is started per-session.

3. **File push through scrcpy is disabled** — `ScrcpyFilePushStream` and `FilePushHandler` are NOT wired in the new `StreamClientScrcpy`. File push used custom control message types (101/102) that vanilla scrcpy doesn't support. File transfers still work via ADB directly (file listing middleware is unchanged).

4. **PcmWorklet as inline string** — Instead of a separate entry point, the worklet source is exported as a string from `PcmWorklet.ts` and loaded via Blob URL in `AudioPlayer.ts`. This avoids webpack config complexity.

5. **AdbClient.removeReverse() added** — Minor addition for cleanup when ScrcpyConnection releases.

### Smoke Testing Checklist

After all tasks complete:

1. `npm run build` — succeeds
2. `node dist/index.js` — server starts, shows port
3. Open browser to `http://localhost:8000` — device list appears
4. Connect Android device via USB — device shows in list
5. Click "Configure stream" → select player → Start
6. Verify: video streams in browser
7. Verify: audio plays (may need to click page first for autoplay policy)
8. Verify: touch/click sends input to device
9. Verify: keyboard input works
10. Verify: scroll works
