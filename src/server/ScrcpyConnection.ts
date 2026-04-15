// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import crypto from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import net from 'net';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
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
import '../../assets/scrcpy-server';

const TAG = '[ScrcpyConnection]';
const SERVER_FILE = path.join(__dirname, 'assets', 'scrcpy-server');

interface SessionMetadata {
    deviceName: string;
    videoCodec: string;
    screenWidth: number;
    screenHeight: number;
    audioCodec: string;
    videoEncoder?: string;
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
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.close(4005, err.message.slice(0, 123));
                }
            } catch (closeErr) {
                console.error(TAG, `Failed to close WebSocket for ${serial}:`, closeErr);
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

        const videoCodec = this.queryParams.get('videoCodec');
        if (videoCodec === 'h265' || videoCodec === 'av1') {
            options.videoCodec = videoCodec;
        }

        const audioCodec = this.queryParams.get('audioCodec');
        if (audioCodec === 'aac' || audioCodec === 'flac' || audioCodec === 'raw') {
            options.audioCodec = audioCodec;
        }

        const videoEncoder = this.queryParams.get('videoEncoder');
        if (videoEncoder) {
            options.videoEncoder = videoEncoder;
        }

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
        if (options.videoEncoder) {
            metadata.videoEncoder = options.videoEncoder;
        }
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

    private static readonly PTS_FLAG_CONFIG = 0x8000000000000000n;
    private static readonly PTS_FLAG_KEYFRAME = 0x4000000000000000n;

    private startForwarding(): void {
        // Video: TCP → channel 0 → WS
        this.videoReader = new FrameReader(this.videoSocket!);
        this.videoReader.onFrame((frame) => {
            let pts = frame.pts;
            if (frame.type === 'config') pts |= ScrcpyConnection.PTS_FLAG_CONFIG;
            else if (frame.type === 'keyframe') pts |= ScrcpyConnection.PTS_FLAG_KEYFRAME;
            const header = Buffer.alloc(12);
            header.writeBigUInt64BE(pts, 0);
            header.writeUInt32BE(frame.data.length, 8);
            this.sendChannel(ChannelId.VIDEO, Buffer.concat([header, frame.data]));
        });
        this.videoReader.onEnd(() => this.release());

        // Audio: TCP → channel 1 → WS
        this.audioReader = new FrameReader(this.audioSocket!);
        this.audioReader.onFrame((frame) => {
            let pts = frame.pts;
            if (frame.type === 'config') pts |= ScrcpyConnection.PTS_FLAG_CONFIG;
            const header = Buffer.alloc(12);
            header.writeBigUInt64BE(pts, 0);
            header.writeUInt32BE(frame.data.length, 8);
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
