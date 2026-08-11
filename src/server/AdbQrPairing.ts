import { randomBytes as nodeRandomBytes } from 'crypto';
import * as net from 'net';
import qrcode from 'qrcode-generator';
import type { AdbClient, MdnsDevice } from './AdbClient';
import { type AdbHandshakeResult, probeAdb } from './network/AdbHandshakeProbe';

export type QrPairingMode = 'lan' | 'tailscale';
export type QrPairingState = 'waiting' | 'pairing' | 'connecting' | 'complete' | 'expired' | 'cancelled';

export interface QrPairingStatus {
    id: string;
    mode: QrPairingMode;
    state: QrPairingState;
    message: string;
    expiresAt: number;
    address?: string;
}

export interface StartedQrPairing extends QrPairingStatus {
    qrSvg: string;
}

type QrAdb = Pick<AdbClient, 'mdnsServices' | 'pairQr' | 'connect'>;
type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
type AdbProbe = (
    host: string,
    port: number,
    connectTimeoutMs: number,
    replyTimeoutMs: number,
) => Promise<AdbHandshakeResult>;

interface Options {
    now?: () => number;
    randomBytes?: (size: number) => Buffer;
    sleep?: (ms: number) => Promise<void>;
    renderQr?: (payload: string) => string;
    tcpProbe?: TcpProbe;
    adbProbe?: AdbProbe;
    portStart?: number;
    portEnd?: number;
    concurrency?: number;
    autoRun?: boolean;
}

interface Session extends QrPairingStatus {
    host?: string;
    serviceName: string;
    password: string;
    pairPort?: number;
    paired: boolean;
    openPorts: Set<number>;
    pairTried: Set<number>;
    connectTried: Set<number>;
}

const PAIR_SERVICE = '_adb-tls-pairing._tcp';
const CONNECT_SERVICE = '_adb-tls-connect._tcp';
const TTL_MS = 180_000;
const PORT_START = 32_768;
const PORT_END = 61_000;
const CONCURRENCY = 1_024;
const FAST_CONNECT_TIMEOUT_MS = 200;
const SLOW_CONNECT_TIMEOUT_MS = 500;

function isTailscaleIpv4(host: string): boolean {
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
    const octets = parts.map(Number);
    return (
        octets.every((n) => n >= 0 && n <= 255) &&
        octets.join('.') === host &&
        octets[0] === 100 &&
        octets[1]! >= 64 &&
        octets[1]! <= 127
    );
}

function token(size: number, randomBytes: (size: number) => Buffer): string {
    return randomBytes(size).toString('base64url');
}

function renderQr(payload: string): string {
    const qr = qrcode(0, 'M');
    qr.addData(payload, 'Byte');
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true });
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        let done = false;
        const finish = (open: boolean) => {
            if (done) return;
            done = true;
            socket.removeAllListeners();
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

function pairSucceeded(output: string): boolean {
    return /(?:successfully|already) paired/i.test(output);
}

function connectSucceeded(output: string): boolean {
    return /(?:already )?connected to/i.test(output);
}

export class AdbQrPairingManager {
    private current?: Session;
    private readonly now: () => number;
    private readonly randomBytes: (size: number) => Buffer;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly render: (payload: string) => string;
    private readonly tcpProbe: TcpProbe;
    private readonly adbProbe: AdbProbe;
    private readonly portStart: number;
    private readonly portEnd: number;
    private readonly concurrency: number;
    private readonly autoRun: boolean;

    constructor(
        private readonly adb: QrAdb,
        options: Options = {},
    ) {
        this.now = options.now ?? Date.now;
        this.randomBytes = options.randomBytes ?? nodeRandomBytes;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.render = options.renderQr ?? renderQr;
        this.tcpProbe = options.tcpProbe ?? tcpProbe;
        this.adbProbe = options.adbProbe ?? probeAdb;
        this.portStart = options.portStart ?? PORT_START;
        this.portEnd = options.portEnd ?? PORT_END;
        this.concurrency = options.concurrency ?? CONCURRENCY;
        this.autoRun = options.autoRun ?? true;
    }

    start(options: { mode: QrPairingMode; host?: string }): StartedQrPairing {
        this.cancelCurrent();
        const host = options.host?.trim();
        if (options.mode === 'tailscale' && (!host || !isTailscaleIpv4(host))) {
            throw new Error('Tailscale QR requires a 100.64.0.0/10 IPv4 address');
        }
        const serviceName = `studio-wssw-${token(8, this.randomBytes)}`;
        const password = token(12, this.randomBytes);
        const payload = `WIFI:T:ADB;S:${serviceName};P:${password};;`;
        const session: Session = {
            id: token(16, this.randomBytes),
            mode: options.mode,
            state: 'waiting',
            message:
                options.mode === 'lan'
                    ? 'Waiting for Android to scan the QR code…'
                    : 'Waiting for Android QR pairing over Tailscale…',
            expiresAt: this.now() + TTL_MS,
            ...(host ? { host } : {}),
            serviceName,
            password,
            paired: false,
            openPorts: new Set(),
            pairTried: new Set(),
            connectTried: new Set(),
        };
        this.current = session;
        if (this.autoRun) void this.run(session);
        return { ...this.publicStatus(session), qrSvg: this.render(payload) };
    }

    getStatus(id: string): QrPairingStatus | null {
        const session = this.current;
        if (!session || session.id !== id) return null;
        this.expire(session);
        return this.publicStatus(session);
    }

    cancel(id: string): boolean {
        const session = this.current;
        if (!session || session.id !== id || this.terminal(session)) return false;
        this.finish(session, 'cancelled', 'QR pairing cancelled.');
        return true;
    }

    async runCurrent(): Promise<void> {
        if (!this.current || this.terminal(this.current)) return;
        await this.run(this.current);
    }

    private async run(session: Session): Promise<void> {
        if (session.mode === 'lan') return this.runLan(session);
        return this.runTailscale(session);
    }

    private async runLan(session: Session): Promise<void> {
        while (this.active(session)) {
            const services = await this.mdns();
            const match = services.find(
                (s) => s.name === session.serviceName && s.service.replace(/\.$/, '') === PAIR_SERVICE,
            );
            if (match) {
                await this.tryPair(session, match.port, match.address);
                if (session.paired && this.active(session)) {
                    this.finish(session, 'complete', 'Paired successfully. Android should connect automatically.');
                }
                return;
            }
            await this.sleep(500);
        }
    }

    private async runTailscale(session: Session): Promise<void> {
        const host = session.host!;
        let cycle = 0;
        while (this.active(session)) {
            const services = await this.mdns();
            const pairMdns = services.find(
                (s) => s.name === session.serviceName && s.service.replace(/\.$/, '') === PAIR_SERVICE,
            );
            if (pairMdns && !session.paired) await this.tryPair(session, pairMdns.port, host);
            if (session.paired) await this.tryMdnsConnectPorts(session, services);
            if (!this.active(session)) return;

            const timeout = cycle++ % 3 === 2 ? SLOW_CONNECT_TIMEOUT_MS : FAST_CONNECT_TIMEOUT_MS;
            await this.scanPass(session, timeout);
            if (!this.active(session)) return;
            await this.sleep(250);
        }
    }

    private async scanPass(session: Session, timeoutMs: number): Promise<void> {
        const host = session.host!;
        let cursor = this.portStart;
        const pairTasks = new Set<Promise<void>>();
        const next = () => (cursor <= this.portEnd ? cursor++ : undefined);
        const worker = async () => {
            while (this.active(session)) {
                const port = next();
                if (port === undefined) return;
                if (!(await this.tcpProbe(host, port, timeoutMs))) continue;
                session.openPorts.add(port);
                if (!session.paired && !session.pairTried.has(port)) {
                    session.pairTried.add(port);
                    const task = this.tryPair(session, port, host).finally(() => pairTasks.delete(task));
                    pairTasks.add(task);
                } else if (session.paired) {
                    await this.tryConnect(session, port);
                }
            }
        };
        const workers = Array.from({ length: Math.min(this.concurrency, this.portEnd - this.portStart + 1) }, () =>
            worker(),
        );
        await Promise.all(workers);
        await Promise.allSettled(pairTasks);
        if (session.paired && this.active(session)) {
            for (const port of session.openPorts) {
                await this.tryConnect(session, port);
                if (!this.active(session)) return;
            }
        }
    }

    private async tryPair(session: Session, port: number, host: string): Promise<void> {
        if (!this.active(session) || session.paired) return;
        session.state = 'pairing';
        session.message = 'Android endpoint found. Pairing…';
        try {
            const output = await this.adb.pairQr(`${host}:${port}`, session.password, 5_000);
            if (!this.active(session) || session.paired) return;
            if (!pairSucceeded(output)) {
                session.state = 'waiting';
                session.message = 'Searching for the QR pairing endpoint…';
                return;
            }
            session.paired = true;
            session.pairPort = port;
            session.state = 'connecting';
            session.message = session.mode === 'tailscale' ? 'Paired. Finding the secure ADB connection…' : 'Paired.';
            if (session.mode === 'tailscale') {
                for (const candidate of session.openPorts) {
                    if (candidate !== port) await this.tryConnect(session, candidate);
                    if (!this.active(session)) return;
                }
            }
        } catch {
            if (this.active(session) && !session.paired) {
                session.state = 'waiting';
                session.message = 'Searching for the QR pairing endpoint…';
            }
        } finally {
            if (this.active(session) && !session.paired) session.pairTried.delete(port);
        }
    }

    private async tryMdnsConnectPorts(session: Session, services: MdnsDevice[]): Promise<void> {
        for (const service of services) {
            if (service.service.replace(/\.$/, '') !== CONNECT_SERVICE) continue;
            await this.tryConnect(session, service.port);
            if (!this.active(session)) return;
        }
    }

    private async tryConnect(session: Session, port: number): Promise<void> {
        if (!this.active(session) || !session.paired || port === session.pairPort || session.connectTried.has(port))
            return;
        session.connectTried.add(port);
        const host = session.host!;
        try {
            const probe = await this.adbProbe(host, port, 500, 750);
            if (!probe.isAdb || !this.active(session)) return;
            const address = `${host}:${port}`;
            const output = await this.adb.connect(address);
            if (this.active(session) && connectSucceeded(output)) {
                session.address = address;
                this.finish(session, 'complete', `Paired and connected over Tailscale at ${address}.`);
            }
        } catch {
            // Retry on a later pass if the VPN path or TLS listener was not ready yet.
        } finally {
            if (this.active(session)) session.connectTried.delete(port);
        }
    }

    private async mdns(): Promise<MdnsDevice[]> {
        try {
            return await this.adb.mdnsServices();
        } catch {
            return [];
        }
    }

    private active(session: Session): boolean {
        return this.current === session && !this.terminal(session) && !this.expire(session);
    }

    private expire(session: Session): boolean {
        if (!this.terminal(session) && this.now() >= session.expiresAt) {
            this.finish(session, 'expired', 'QR pairing expired. Generate a new code and retry.');
            return true;
        }
        return session.state === 'expired';
    }

    private terminal(session: Session): boolean {
        return ['complete', 'failed', 'expired', 'cancelled'].includes(session.state);
    }

    private finish(session: Session, state: QrPairingState, message: string): void {
        session.state = state;
        session.message = message;
        session.password = '';
    }

    private cancelCurrent(): void {
        if (this.current && !this.terminal(this.current))
            this.finish(this.current, 'cancelled', 'QR pairing replaced.');
    }

    private publicStatus(session: Session): QrPairingStatus {
        return {
            id: session.id,
            mode: session.mode,
            state: session.state,
            message: session.message,
            expiresAt: session.expiresAt,
            ...(session.address ? { address: session.address } : {}),
        };
    }
}
