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
import { Logger } from './Logger';
import { Mw, type RequestParameters } from './mw/Mw';
import { type ScrcpyOptions, serializeOptions } from './ScrcpyOptions';
import '../../assets/scrcpy-server';

const log = Logger.for('ScrcpyConnection');
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
    private forwardTunnel?: string;
    private serverProcess?: import('child_process').ChildProcess;
    private released = false;

    public static processRequest(ws: WS, params: RequestParameters): ScrcpyConnection | undefined {
        const { action, url } = params;
        if (action !== ACTION.STREAM_SCRCPY) {
            return;
        }
        const udid = url.searchParams.get('udid');
        if (!udid) {
            ws.close(4003, '[ScrcpyConnection] Missing "udid" parameter');
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
            log.error(`Failed to start session for ${serial}:`, err.message);
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.close(4005, err.message.slice(0, 123));
                }
            } catch (closeErr) {
                log.error(`Failed to close WebSocket for ${serial}:`, closeErr);
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

        // SDK-gated behavior for older Android devices:
        //  - Reverse-over-TCP is unreliable on pre-9 (SDK 28); those devices need
        //    tunnel_forward=true with host-initiated connections instead.
        //  - scrcpy audio forwarding requires Android 11+ (SDK 30); force audio off
        //    on older devices so the server doesn't refuse to start.
        //  - scrcpy-server self-deletes its own JAR at startup by default. On pre-8
        //    Android (ART class loading is lazier), the JAR vanishes before the
        //    server class fully resolves and app_process aborts with
        //    ClassNotFoundException. cleanup=false keeps the JAR around.
        const sdkInt = await this.getSdkInt();
        const useTunnelForward = sdkInt > 0 && sdkInt < 28;
        if (sdkInt > 0 && sdkInt < 30 && options.audio === undefined) {
            options.audio = false;
        }
        if (useTunnelForward) {
            options.tunnelForward = true;
            options.cleanup = false;
        }
        log.info(
            `Starting session for ${this.serial} (scid=${options.scid}, sdk=${sdkInt || '?'}, tunnel=${useTunnelForward ? 'forward' : 'reverse'}, audio=${options.audio ?? 'default'}, cleanup=${options.cleanup ?? 'default'})`,
        );

        // 1. Push scrcpy-server binary
        await this.adbClient.push(this.serial, SERVER_FILE, DEVICE_SERVER_PATH);

        // 2. Set up tunnel + launch scrcpy-server + collect 3 sockets.
        const sockets = useTunnelForward
            ? await this.startWithForwardTunnel(options)
            : await this.startWithReverseTunnel(options);
        this.videoSocket = sockets[0];
        this.audioSocket = sockets[1];
        this.controlSocket = sockets[2];

        // 3. Parse initial metadata
        log.info(`Parsing stream metadata for ${this.serial}`);
        const metadata = await this.parseMetadata();
        if (options.videoEncoder) {
            metadata.videoEncoder = options.videoEncoder;
        }
        log.info(`Session ready: ${metadata.deviceName} ${metadata.screenWidth}x${metadata.screenHeight}`);

        // 4. Send metadata to browser
        this.sendChannel(ChannelId.METADATA, Buffer.from(JSON.stringify(metadata)));

        // 5. Start forwarding
        this.startForwarding();
    }

    private async getSdkInt(): Promise<number> {
        try {
            const out = await this.adbClient.shell(this.serial, 'getprop ro.build.version.sdk');
            const n = Number.parseInt(out.trim(), 10);
            return Number.isFinite(n) ? n : 0;
        } catch {
            return 0;
        }
    }

    private async startWithReverseTunnel(options: ScrcpyOptions): Promise<net.Socket[]> {
        // Host listens on an ephemeral port; adb reverses device's localabstract
        // socket to that port. scrcpy-server connects out (3 sockets) — we accept.
        const { server, port } = await this.createTcpServer();
        this.tcpServer = server;
        this.reverseTunnel = `localabstract:scrcpy_${options.scid}`;
        await this.adbClient.reverse(this.serial, this.reverseTunnel, `tcp:${port}`);

        this.launchServer(options);

        return this.acceptSockets(server, 3, 10000);
    }

    private async startWithForwardTunnel(options: ScrcpyOptions): Promise<net.Socket[]> {
        // adb forwards a host port to scrcpy-server's localabstract socket. The
        // server binds and listens (because tunnel_forward=true); host initiates
        // the 3 client connections through the forward.
        const localPort = await this.reserveLocalPort();
        this.forwardTunnel = `tcp:${localPort}`;
        const remote = `localabstract:scrcpy_${options.scid}`;
        await this.adbClient.forward(this.serial, this.forwardTunnel, remote);

        this.launchServer(options);

        // Older / slower devices can take a long time to app_process the server
        // and bind the localabstract socket — the SM-T550 (API 25) needs >60s.
        // Give the first connect generous runway; later connects resolve fast
        // once scrcpy-server is accepting.
        log.info(`Waiting for scrcpy-server to bind localabstract on ${this.serial} (up to 120s)...`);
        const first = await this.connectLocalRetry(localPort, 120000);
        log.info(`scrcpy-server bound on ${this.serial}; collecting audio + control sockets`);
        // Brief pause between connects so scrcpy-server has a chance to accept
        // each socket and write its per-connection handshake byte before the next
        // client connection arrives at the device-side server socket. Back-to-back
        // connects overwhelm the accept loop on slow devices and at least one
        // connection silently doesn't get its dummy byte.
        await new Promise((r) => setTimeout(r, 500));
        const second = await this.connectLocal(localPort, 15000);
        await new Promise((r) => setTimeout(r, 500));
        const third = await this.connectLocal(localPort, 15000);

        // In forward-tunnel mode scrcpy-server writes a single dummy 0x00 byte on
        // each socket before real traffic, to flush adb's forward buffer. Consume
        // those bytes sequentially; if the server version doesn't emit one on a
        // given socket we log and move on rather than hang.
        await this.consumeDummyByte(first, 'video');
        await this.consumeDummyByte(second, 'audio');
        await this.consumeDummyByte(third, 'control');

        return [first, second, third];
    }

    private async consumeDummyByte(socket: net.Socket, label: string): Promise<void> {
        try {
            const byte = await this.readExactWithTimeout(socket, 1, 10000);
            log.info(`Consumed dummy byte 0x${byte[0].toString(16).padStart(2, '0')} on ${label} socket for ${this.serial}`);
        } catch (e: any) {
            log.info(`No dummy byte on ${label} socket within 10s for ${this.serial} (${e?.message || e}) — proceeding`);
        }
    }

    private readExactWithTimeout(socket: net.Socket, size: number, timeoutMs: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                reject(new Error(`readExact timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            let buffer = Buffer.alloc(0);
            const onData = (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                if (buffer.length >= size) {
                    clearTimeout(timer);
                    socket.removeListener('data', onData);
                    socket.removeListener('error', onError);
                    if (buffer.length > size) socket.unshift(buffer.subarray(size));
                    resolve(buffer.subarray(0, size));
                }
            };
            const onError = (err: Error) => {
                clearTimeout(timer);
                socket.removeListener('data', onData);
                reject(err);
            };
            socket.on('data', onData);
            socket.once('error', onError);
        });
    }

    private launchServer(options: ScrcpyOptions): void {
        const args = serializeOptions(options);
        const cmd = `CLASSPATH=${DEVICE_SERVER_PATH} app_process / ${SERVER_PACKAGE} ${SERVER_VERSION} ${args.join(' ')}`;
        this.serverProcess = this.adbClient.shellSpawn(this.serial, cmd);
        // Tee scrcpy-server's stdout/stderr into our log so its failure reason is visible.
        const logLine = (stream: 'stdout' | 'stderr', data: Buffer) => {
            const text = data.toString('utf-8').trimEnd();
            if (text) log.info(`[scrcpy-server:${stream}] ${this.serial}: ${text}`);
        };
        this.serverProcess.stdout?.on('data', (d) => logLine('stdout', d));
        this.serverProcess.stderr?.on('data', (d) => logLine('stderr', d));
        this.serverProcess.on('exit', (code, signal) => {
            log.info(`Server process exited for ${this.serial} (code=${code}, signal=${signal})`);
            if (!this.released) {
                this.release();
            }
        });
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

    private async reserveLocalPort(): Promise<number> {
        // Bind briefly to learn a free port, release it so adb forward can take it.
        // Brief race on localhost is acceptable — ephemeral ports rarely collide.
        const { server, port } = await this.createTcpServer();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return port;
    }

    private connectLocal(port: number, timeoutMs: number): Promise<net.Socket> {
        return new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: '127.0.0.1', port });
            const timer = setTimeout(() => {
                sock.destroy();
                reject(new Error(`Timeout connecting to 127.0.0.1:${port}`));
            }, timeoutMs);
            sock.once('connect', () => {
                clearTimeout(timer);
                resolve(sock);
            });
            sock.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    private async connectLocalRetry(port: number, maxWaitMs: number): Promise<net.Socket> {
        const deadline = Date.now() + maxWaitMs;
        let lastErr: Error | null = null;
        while (Date.now() < deadline) {
            try {
                return await this.connectLocal(port, 1000);
            } catch (e) {
                lastErr = e as Error;
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw lastErr ?? new Error(`Timeout connecting to 127.0.0.1:${port}`);
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
        log.info(`Releasing session for ${this.serial}`);

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
        if (this.forwardTunnel) {
            this.adbClient.removeForward(this.serial, this.forwardTunnel).catch(() => {});
        }

        this.tcpServer?.close();
        super.release();
    }
}
