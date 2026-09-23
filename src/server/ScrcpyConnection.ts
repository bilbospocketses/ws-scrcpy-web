import crypto from 'crypto';
import net from 'net';
import path from 'path';
import type WS from 'ws';
import { ACTION } from '../common/Action';
import { ChannelId } from '../common/ChannelId';
import { DEVICE_SERVER_PATH, SERVER_PACKAGE } from '../common/Constants';
import { AUDIO_DISABLED, AUDIO_ERROR, codecName } from '../common/ScrcpyCodec';
import { AdbClient } from './AdbClient';
import { chooseAudioCodec, parseAudioEncodersFromDumpsys } from './audioCodecFallback';
import { Config } from './Config';
import { ensureScrcpyServerPushed } from './ensureScrcpyServerPushed';
import { FrameReader } from './FrameReader';
import { ControlCenter } from './goog-device/services/ControlCenter';
import { Logger } from './Logger';
import { Mw, type RequestParameters } from './mw/Mw';
import { describeEffectiveOptions, type ScrcpyOptions, serializeOptions } from './ScrcpyOptions';
import { StreamDiagnostics } from './StreamDiagnostics';
import { scrcpyOptionsFromQuery } from './scrcpyOptionsFromQuery';
import { getInstalledScrcpyServerVersion } from './scrcpyServerVersion';
import {
    assembleReverseTunnelSockets,
    createAudioDisabledSocket,
    expectedTunnelSocketCount,
} from './scrcpyTunnelSockets';

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
    /** #703 frame-path instrumentation. Pure counter; this class owns the timer. */
    private readonly diagnostics = new StreamDiagnostics();
    private stallTimer?: NodeJS.Timeout | undefined;
    private keyframeTimer?: NodeJS.Timeout | undefined;

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
        // Both probes are single `adb shell` round trips and neither depends on
        // the other, so they run together — the audio check costs no extra wall
        // time on the path to first frame.
        const [sdkInt, audioEncoders] = await Promise.all([
            this.getSdkInt(),
            options.audio === false ? Promise.resolve<string[]>([]) : this.listAudioEncoders(),
        ]);
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

        // A codec the device cannot encode does not produce silence — it kills
        // scrcpy-server, and VIDEO with it (see audioCodecFallback for the
        // measurement). Applied after the SDK gates above so an explicit
        // audio=false there is never re-enabled here.
        if (options.audio !== false) {
            const decision = chooseAudioCodec(options.audioCodec ?? 'opus', audioEncoders);
            if (decision.disable) {
                options.audio = false;
            } else if (decision.codec) {
                options.audioCodec = decision.codec;
            }
            // Logged on EVERY session, including the no-change case: "audio is
            // missing" and "audio was never attempted" look identical after the
            // fact, and this line is what tells them apart.
            log.info(`audio codec: ${decision.reason}`);
        }
        log.info(
            `Starting session for ${this.serial} (scid=${options.scid}, sdk=${sdkInt || '?'}, tunnel=${useTunnelForward ? 'forward' : 'reverse'}, audio=${options.audio ?? 'default'}, cleanup=${options.cleanup ?? 'default'})`,
        );
        this.diagnostics.start();
        // #703: the EXACT argument list handed to scrcpy-server. One of the two
        // live hypotheses for the black screen is "our launch options differ
        // from desktop scrcpy's", and until now a reporter's log could not
        // answer it — the line above names five settings out of a dozen and
        // omits every one that reaches the encoder (codec, bit rate, max fps,
        // encoder name, codec options). Logged as scrcpy's own `key=value`
        // form so it can be diffed against a working `scrcpy --verbosity=debug`
        // run directly.
        //
        // BOTH lines, deliberately. The literal args are what the device
        // received; the effective line is what they MEAN, and only the second
        // is comparable — `serializeOptions` omits anything left at its default,
        // so a default session's argument list is just `scid=<hex>` and answers
        // nothing. `*` marks a value this session set explicitly.
        log.info(`scrcpy-server args: ${serializeOptions(options).join(' ')}`);
        log.info(`scrcpy-server effective: ${describeEffectiveOptions(options)}`);

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
        // #703: the codec and the chosen encoder were never logged, so "the
        // device negotiated something we cannot decode" could not be checked.
        log.info(this.diagnostics.noteMetadata(metadata));

        // 4. Send metadata to browser
        this.sendChannel(ChannelId.METADATA, Buffer.from(JSON.stringify(metadata)));

        // 5. Start forwarding
        this.startForwarding();

        // 6. #703 watchdog. A black screen is silent by nature: the session is
        //    up, the sockets are connected, and nothing says the picture never
        //    started. One shot — a stall is a state, not an event, and
        //    repeating it every tick would drown the session it describes.
        //    `unref` so a diagnostic timer can never hold the process open.
        this.stallTimer = setTimeout(() => {
            const line = this.diagnostics.stallReport(ScrcpyConnection.STALL_AFTER_MS);
            if (line) log.warn(`${this.serial}: ${line}`);
            this.requestKeyframeIfConfigMissing(1);
        }, ScrcpyConnection.STALL_AFTER_MS);
        this.stallTimer.unref?.();
    }

    /**
     * Ask the device for a fresh keyframe when no config packet has arrived
     * (#703).
     *
     * WHY THE SERVER AND NOT THE BROWSER. There is already a keyframe-recovery
     * path in `WebCodecsPlayer`, but it hangs off the DECODE watchdog — and a
     * decoder that never received SPS/PPS was never configured, so nothing
     * decodes, nothing faults, and that watchdog never fires. The reporter of
     * #703 observed exactly this. The server is the only party that can tell
     * "no config has arrived" from "the decoder is unhappy".
     *
     * WHY IT WORKS. `TYPE_RESET_VIDEO` makes scrcpy-server produce a new config
     * packet together with the keyframe, which is what an unconfigured decoder
     * needs — not merely another frame.
     *
     * Measured 2026-09-23 on redroid 13: 5 of 8 sessions produced media frames
     * and never a single SPS/PPS or IDR. A client NAL scan agreed with the
     * server's own counter, which is what established the packets were never
     * sent rather than lost in forwarding.
     *
     * BOUNDED, and deliberately so. A device that will not produce config after
     * a few asks is not going to produce it on the hundredth, and an unbounded
     * retry becomes a packet generator aimed at a device that is already
     * struggling.
     */
    private requestKeyframeIfConfigMissing(attempt: number): void {
        if (this.released) return;
        if (!this.diagnostics.canRecoverWithKeyframeRequest()) return;
        if (attempt > ScrcpyConnection.KEYFRAME_REQUEST_ATTEMPTS) {
            log.warn(
                `${this.serial}: still no config packet after ${ScrcpyConnection.KEYFRAME_REQUEST_ATTEMPTS} ` +
                    'keyframe requests; the device is not producing one for this session.',
            );
            return;
        }
        const socket = this.controlSocket;
        if (!socket || socket.destroyed) {
            // control=false is a legitimate configuration, not a fault — say so
            // once rather than retrying against a socket that does not exist.
            log.warn(
                `${this.serial}: no config packet and no control socket, so a keyframe cannot be requested ` +
                    '(control is disabled for this session).',
            );
            return;
        }
        try {
            socket.write(Buffer.from([ScrcpyConnection.CONTROL_MSG_RESET_VIDEO]));
            log.info(
                `${this.serial}: no config packet yet — requested a keyframe (TYPE_RESET_VIDEO), ` +
                    `attempt ${attempt}/${ScrcpyConnection.KEYFRAME_REQUEST_ATTEMPTS}.`,
            );
        } catch (err) {
            log.warn(`${this.serial}: keyframe request failed: ${(err as Error).message}`);
            return;
        }
        const timer = setTimeout(
            () => this.requestKeyframeIfConfigMissing(attempt + 1),
            ScrcpyConnection.KEYFRAME_RETRY_MS,
        );
        timer.unref?.();
        this.keyframeTimer = timer;
    }

    /**
     * The device's audio encoder names, via `dumpsys media.player`.
     *
     * FAILS OPEN, deliberately. A probe that throws — adb hiccup, a device that
     * does not implement this dumpsys section, a timeout — returns an EMPTY
     * list, and `chooseAudioCodec` treats empty as "unknown" and changes
     * nothing. The alternative, treating a failed probe as "no encoders", would
     * silently switch audio off on a healthy device because a diagnostic
     * command misbehaved: a fault in the detector becoming a fault in the
     * product.
     */
    private async listAudioEncoders(): Promise<string[]> {
        try {
            const output = await this.adbClient.shell(this.serial, 'dumpsys media.player');
            return parseAudioEncodersFromDumpsys(output);
        } catch (err) {
            log.warn(`could not list audio encoders for ${this.serial}: ${(err as Error).message}`);
            return [];
        }
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

        // scrcpy-server skips the audio connect when audio is off, so only video
        // and control come back. Waiting for three regardless closed the socket
        // with `4005 Timeout waiting for 3 TCP connections (got 2)` and the
        // stream never started — on the tunnel the app prefers. The forward path
        // below has always derived this correctly.
        const audioEnabled = options.audio !== false;
        const accepted = await this.acceptSockets(server, expectedTunnelSocketCount(audioEnabled), 10000);
        return assembleReverseTunnelSockets(accepted, audioEnabled);
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
            audioSocket = createAudioDisabledSocket();
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

    /**
     * How long a session may produce no decodable video before the fact is
     * stated in the log (#703). Long enough that a slow cold start on an
     * older device is not called a fault — `ensureScrcpyServerPushed` plus
     * dexopt can cost seconds — and short enough that the line is already
     * written by the time someone thinks to look.
     */
    private static readonly STALL_AFTER_MS = 8000;

    /**
     * scrcpy's `SC_CONTROL_MSG_TYPE_RESET_VIDEO`, matching the browser's
     * `ControlMessage.TYPE_RESET_VIDEO`. The message is the type byte alone —
     * it carries no payload.
     */
    private static readonly CONTROL_MSG_RESET_VIDEO = 17;

    /** How many times to ask for a keyframe before accepting the device will not send one. */
    private static readonly KEYFRAME_REQUEST_ATTEMPTS = 3;

    /**
     * Gap between keyframe requests. Comfortably longer than the ~190ms in
     * which a healthy device answered a reset on hardware, so a slow-but-working
     * device is never asked twice for the same thing.
     */
    private static readonly KEYFRAME_RETRY_MS = 2000;

    private startForwarding(): void {
        // Video: TCP → channel 0 → WS
        this.videoReader = new FrameReader(this.videoSocket!);
        this.videoReader.onFrame((frame) => {
            // #703 instrumentation. Logs the FIRST of each kind only; the
            // first config and the first keyframe are the two events that gate
            // first paint, and per-frame logging would bury them.
            const line = this.diagnostics.noteFrame(frame.type, frame.data.length);
            if (line) log.info(line);
            let pts = frame.pts;
            if (frame.type === 'config') pts |= ScrcpyConnection.PTS_FLAG_CONFIG;
            else if (frame.type === 'keyframe') pts |= ScrcpyConnection.PTS_FLAG_KEYFRAME;
            const header = Buffer.alloc(12);
            header.writeBigUInt64BE(pts, 0);
            header.writeUInt32BE(frame.data.length, 8);
            this.sendChannel(ChannelId.VIDEO, Buffer.concat([header, frame.data]));
        });
        // Rotation / resize: session packet → channel 5 → WS (item 24).
        //
        // Only the video socket carries these. The browser needs them because
        // its display geometry comes from the opening METADATA, which is a
        // snapshot of the capture at connect time — without this the canvas and
        // the touch mapping stay pinned to the pre-rotation size for the life of
        // the session, and the only cure was disconnect-and-reconnect.
        this.videoReader.onSessionChange(({ width, height }) => {
            log.info(`Session changed: ${width}x${height}`);
            this.sendChannel(ChannelId.SESSION, Buffer.from(JSON.stringify({ width, height })));
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
        if (this.ws.readyState !== this.ws.OPEN) {
            // Was a bare `return` (#703). Frames produced and discarded with no
            // trace is indistinguishable from frames never produced, and both
            // present as a black screen — so count it and say so once.
            const line = this.diagnostics.noteDropped(this.ws.readyState);
            if (line) log.warn(line);
            return;
        }
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
        // #703: written on EVERY session, not only broken ones. A healthy
        // summary is what makes a broken one legible — without a normal
        // reading to compare against, "config=0" is just a number.
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = undefined;
        }
        if (this.keyframeTimer) {
            clearTimeout(this.keyframeTimer);
            this.keyframeTimer = undefined;
        }
        log.info(`${this.serial}: ${this.diagnostics.summary()}`);

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
