import crypto from 'crypto';
import net from 'net';
import path from 'path';
import type WS from 'ws';
import { ACTION } from '../common/Action';
import { ChannelId } from '../common/ChannelId';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE } from '../common/Constants';
import { AUDIO_DISABLED, AUDIO_ERROR, codecName } from '../common/ScrcpyCodec';
import { AdbClient } from './AdbClient';
import { Config } from './Config';
import { ensureScrcpyServerPushed } from './ensureScrcpyServerPushed';
import { FrameReader } from './FrameReader';
import { ControlCenter } from './goog-device/services/ControlCenter';
import { Logger } from './Logger';
import { Mw, type RequestParameters } from './mw/Mw';
import { type ScrcpyOptions, serializeOptions } from './ScrcpyOptions';
import { scrcpyOptionsFromQuery } from './scrcpyOptionsFromQuery';
import { getInstalledScrcpyServerVersion } from './scrcpyServerVersion';

const log = Logger.for('ScrcpyConnection');

/**
 * v0.1.9: scrcpy-server lives in <deps>/scrcpy-server/, managed by
 * DependencyManager. See DeviceProbe.serverFile() for the full
 * rationale.
 */
function serverFile(): string {
    return path.join(Config.getInstance().dependenciesPath, 'scrcpy-server', 'scrcpy-server');
}

function installedVersion(): string {
    return getInstalledScrcpyServerVersion(Config.getInstance().dependenciesPath);
}

interface SessionMetadata {
    deviceName: string;
    videoCodec: string;
    screenWidth: number;
    screenHeight: number;
    audioCodec: string;
    videoEncoder?: string;
}

export class ScrcpyConnection extends Mw {
    private adbClient = new AdbClient(Config.getInstance().adbPath);
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

    public static override processRequest(ws: WS, params: RequestParameters): ScrcpyConnection | undefined {
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
        return scrcpyOptionsFromQuery(this.queryParams, scid);
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
        // Audio-capture gates:
        //  * SDK<30: scrcpy can't capture audio at all.
        //  * SDK<33 with explicit audio_source=playback: --audio-dup requires
        //    Android 13+; without it the device would be silenced anyway so the
        //    user's opt-in to "keep device audio" can't be honored — force off
        //    rather than surprise them with silence.
        //  (Default source is `output`, which works on every audio-capable SDK.)
        if (sdkInt > 0 && sdkInt < 30) {
            options.audio = false;
        } else if (sdkInt > 0 && sdkInt < 33 && options.audioSource === 'playback') {
            options.audio = false;
        }
        if (useTunnelForward) {
            options.tunnelForward = true;
            options.cleanup = false;
        }
        log.info(
            `Starting session for ${this.serial} (scid=${options.scid}, sdk=${sdkInt || '?'}, tunnel=${useTunnelForward ? 'forward' : 'reverse'}, audio=${options.audio ?? 'default'}, cleanup=${options.cleanup ?? 'default'})`,
        );

        // 1. Push scrcpy-server binary only when the remote copy is missing or
        //    a different size. Keeping the JAR in place between sessions keeps
        //    Android's dexopt cache warm and drops ~15s off cold-start on older
        //    devices.
        await ensureScrcpyServerPushed(this.adbClient, this.serial, serverFile());

        // 2. Set up tunnel + launch scrcpy-server + collect 3 sockets.
        const sockets = useTunnelForward
            ? await this.startWithForwardTunnel(options)
            : await this.startWithReverseTunnel(options);
        this.videoSocket = sockets[0]!;
        this.audioSocket = sockets[1]!;
        this.controlSocket = sockets[2]!;

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
        // Prefer the value cached on the descriptor by ControlCenter's poll —
        // saves an adb-shell round-trip per session start.
        if (ControlCenter.hasInstance()) {
            const device = ControlCenter.getInstance().getDevice(this.serial);
            const raw = device?.descriptor['ro.build.version.sdk'];
            if (raw) {
                const n = Number.parseInt(raw, 10);
                if (Number.isFinite(n) && n > 0) return n;
            }
        }
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
        // the 2 or 3 client connections through the forward.
        //
        // IMPORTANT: adb-forward accepts host-side TCP connections eagerly even
        // before the device-side socket is bound. A successful connect() does
        // NOT mean scrcpy-server is actually ready. We detect real readiness by
        // waiting for scrcpy's dummy 0x00 byte on the first socket (scrcpy v3
        // writes it on exactly one socket, video-first). If no byte arrives in
        // a short window, the connection is stale — close it and retry. This
        // matches what the upstream scrcpy client does.
        const localPort = await this.reserveLocalPort();
        this.forwardTunnel = `tcp:${localPort}`;
        const remote = `localabstract:scrcpy_${options.scid}`;
        await this.adbClient.forward(this.serial, this.forwardTunnel, remote);

        this.launchServer(options);

        log.info(`Waiting for scrcpy-server handshake on ${this.serial} (up to 120s)...`);
        const videoSocket = await this.connectAndAwaitDummy(localPort, 120000);
        log.info(`scrcpy-server is live on ${this.serial}; opening remaining sockets`);

        // scrcpy accepts in order: video → audio (if enabled) → control. Give it
        // a brief beat between connects so each accept/return cycle completes.
        const audioEnabled = options.audio !== false;
        await new Promise((r) => setTimeout(r, 100));
        let audioSocket: net.Socket;
        if (audioEnabled) {
            audioSocket = await this.connectLocal(localPort, 15000);
            await new Promise((r) => setTimeout(r, 100));
        } else {
            // audio=false means scrcpy-server skips the audio accept. Feed
            // parseMetadata a synthetic AUDIO_DISABLED 4-byte status so the rest
            // of the pipeline keeps the same shape without needing a special case.
            audioSocket = new net.Socket();
            audioSocket.unshift(Buffer.from([0x00, 0x00, 0x00, 0x00])); // AUDIO_DISABLED (0x00000000) sentinel
        }
        const controlSocket = await this.connectLocal(localPort, 15000);

        return [videoSocket, audioSocket, controlSocket];
    }

    private async connectAndAwaitDummy(port: number, maxWaitMs: number): Promise<net.Socket> {
        // Open a TCP connection to the adb-forward, then try to read 1 byte
        // with a short per-attempt timeout. If the byte arrives, scrcpy-server
        // is alive and this is the video socket. If the read times out, adb
        // accepted us but the device side isn't bound yet — close the socket
        // and retry. The per-attempt timeout is deliberate on Windows: adb
        // forward silently holds the TCP connection when device-side isn't
        // bound (no error surfaces), so we can't rely on scrcpy's "just block
        // on recv" pattern; we need to recycle sockets to kick adb into
        // re-attempting the device-side connection.
        const deadline = Date.now() + maxWaitMs;
        let lastErr: Error | null = null;
        while (Date.now() < deadline) {
            let sock: net.Socket | undefined;
            try {
                sock = await this.connectLocal(port, 2000);
                const byte = await this.readExactWithTimeout(sock, 1, 2000);
                log.info(`Received handshake byte 0x${byte[0]!.toString(16).padStart(2, '0')} on ${this.serial}`);
                return sock;
            } catch (e) {
                lastErr = e as Error;
                try {
                    sock?.destroy();
                } catch {
                    // ignore
                }
                await new Promise((r) => setTimeout(r, 150));
            }
        }
        throw lastErr ?? new Error(`scrcpy-server did not emit handshake byte within ${maxWaitMs}ms`);
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
        const cmd = `CLASSPATH=${DEVICE_SERVER_PATH} app_process / ${SERVER_PACKAGE} ${installedVersion()} ${args.join(' ')}`;
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
        // Video socket (scrcpy v4+):
        //   @0-63:  device name (64 bytes, null-padded UTF-8) — unchanged from v3
        //   @64-67: video codec ID (4 bytes BE) — unchanged from v3
        //   @68-79: SESSION PACKET (12 bytes, NEW in v4) — replaces v3's bare
        //                                                    width+height fields
        //     @68-71: flags — MSB = session-packet flag (must be set,
        //                     = 0x80000000); LSB of @71 = "client resized" flag
        //                     (0 on initial capture)
        //     @72-75: video width (4 bytes BE)
        //     @76-79: video height (4 bytes BE)
        //   @80+:   media packets (each with 12-byte header — see FrameReader)
        //
        // Pre-v4 layout was 76 bytes: device(64) + codec(4) + width(4) + height(4)
        // with no session-packet wrapper. v4 added the session-packet wrapper
        // AND shifted all media-packet flag bits down by one position to make
        // room for the new session-packet flag at MSB (see FrameReader for the
        // matching media-packet header constant updates).
        // Source: scrcpy v4.0 Streamer.java PACKET_FLAG_SESSION = 1L << 63.
        const videoMeta = await this.readExact(this.videoSocket!, 80);
        const deviceNameBytes = videoMeta.subarray(0, 64);
        const nullIdx = deviceNameBytes.indexOf(0);
        const deviceName = deviceNameBytes.subarray(0, nullIdx === -1 ? 64 : nullIdx).toString('utf-8');
        const videoCodecId = videoMeta.readUInt32BE(64);
        const sessionFlags = videoMeta.readUInt32BE(68);
        if ((sessionFlags & 0x80000000) === 0) {
            // Sanity: session-packet flag MSB must be set. If not, scrcpy-server
            // sent an unexpected layout — either too-old scrcpy (pre-v4) or a
            // future-protocol-change. Surface clearly rather than silently using
            // bogus dimensions.
            throw new Error(
                `scrcpy stream metadata: expected session-packet flag MSB at offset 68, got 0x${sessionFlags.toString(16).padStart(8, '0')}`,
            );
        }
        const screenWidth = videoMeta.readUInt32BE(72);
        const screenHeight = videoMeta.readUInt32BE(76);

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
        this.controlSocket!.on('data', (data: Buffer) => {
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

    public override release(): void {
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
