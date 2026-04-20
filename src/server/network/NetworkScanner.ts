import type WS from 'ws';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage, ScanStartedMessage, ScanProgressMessage } from '../../common/ScanMessage';
import { parseSerialFromMdnsName } from '../AdbClient';

export interface NetworkScannerDeps {
    adbDevices: () => Promise<{ serial: string; state: string }[]>;
    adbMdnsServices: () => Promise<{ name: string; service: string; address: string; port: number }[]>;
    adbConnect: (address: string) => Promise<string>;
    adbDisconnect: (address: string) => Promise<string>;
    tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    /** Look up a saved label by device serial. Returns undefined when no label stored. */
    labelFor?: (serial: string) => string | undefined;
    concurrency: number;
    progressInterval: number;
    tcpTimeoutMs?: number;
    adbConnectTimeoutMs?: number;
}

type State = 'idle' | 'scanning' | 'draining';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export class NetworkScanner {
    private state: State = 'idle';
    private cancelFlag = false;
    private spectators = new Set<WS | any>();
    private emittedAddresses = new Set<string>();
    private foundSoFar = 0;
    private lastStartedMsg: ScanStartedMessage | null = null;
    private lastProgressMsg: ScanProgressMessage | null = null;

    constructor(private readonly deps: NetworkScannerDeps) {}

    isScanning(): boolean {
        return this.state !== 'idle';
    }

    getState(): 'idle' | 'scanning' | 'draining' {
        return this.state;
    }

    attachSpectator(ws: WS | any): void {
        if (this.state === 'idle') return;
        this.spectators.add(ws);
        // Send snapshot of current state so new spectators aren't stuck on empty chip
        if (this.lastStartedMsg && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify(this.lastStartedMsg)); } catch {}
        }
        if (this.lastProgressMsg && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify(this.lastProgressMsg)); } catch {}
        }
        if (this.state === 'draining' && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify({ type: 'scan.draining' })); } catch {}
        }
        // Clean up on close to avoid accumulating dead entries during long scans
        if (typeof ws.once === 'function') {
            ws.once('close', () => this.spectators.delete(ws));
        }
    }

    cancel(): void {
        if (this.state !== 'scanning') return;
        this.cancelFlag = true;
    }

    async start(subnets: ParsedSubnet[], ws: WS | any): Promise<void> {
        if (this.state !== 'idle') {
            throw new Error('scanner already scanning');
        }
        this.state = 'scanning';
        this.cancelFlag = false;
        this.emittedAddresses.clear();
        this.foundSoFar = 0;
        this.lastStartedMsg = null;
        this.lastProgressMsg = null;
        this.spectators.clear();
        this.spectators.add(ws);
        if (typeof (ws as any).once === 'function') {
            (ws as any).once('close', () => this.spectators.delete(ws));
        }

        try {
            const totalHosts = subnets.reduce((sum, s) => sum + s.hostCount, 0);
            this.emit({
                type: 'scan.started',
                totalHosts,
                totalSubnets: subnets.length,
                startedAt: Date.now(),
            });

            const runPromise = this.runTracks(subnets, totalHosts);

            // Watch for cancel flag: emit scan.draining as soon as it's set, while workers still in flight.
            let drainWatcherDone = false;
            const drainWatcher = (async () => {
                while (!this.cancelFlag) {
                    // Exit as soon as runTracks finishes (normal completion path)
                    if (drainWatcherDone) return;
                    await new Promise((r) => setTimeout(r, 10));
                }
                if (this.cancelFlag && this.state === 'scanning') {
                    this.state = 'draining';
                    this.emit({ type: 'scan.draining' });
                }
            })();

            await runPromise;
            // Snapshot cancel state BEFORE awaiting drainWatcher — any late cancel() after
            // workers completed shouldn't retroactively turn a successful scan into cancelled.
            const wasCancelled = this.cancelFlag;
            drainWatcherDone = true;
            await drainWatcher;

            if (wasCancelled) {
                this.emit({ type: 'scan.cancelled', found: this.foundSoFar });
            } else {
                this.emit({ type: 'scan.complete', found: this.foundSoFar });
            }
        } finally {
            this.state = 'idle';
            this.cancelFlag = false;
        }
    }

    protected async runTracks(subnets: ParsedSubnet[], totalHosts: number): Promise<void> {
        const connectedAddresses = new Set(
            (await this.deps.adbDevices()).map((d) => d.serial),
        );

        // Track A: mDNS — synchronous (adb returns all at once)
        const mdnsPromise = (async () => {
            try {
                const hits = await this.deps.adbMdnsServices();
                for (const hit of hits) {
                    if (this.cancelFlag) break;
                    if (!hit.service.includes('_adb') || hit.service.includes('pairing')) continue;
                    const address = `${hit.address}:${hit.port}`;
                    if (connectedAddresses.has(address)) continue;
                    this.emitHit({
                        source: 'mdns',
                        address,
                        serial: parseSerialFromMdnsName(hit.name, hit.service),
                        name: hit.name,
                    });
                }
            } catch {
                // mDNS track failed — silent; TCP track continues
            }
        })();

        // Track B: TCP (existing pool logic)
        const hostList: string[] = [];
        for (const subnet of subnets) {
            for (const host of subnet.hosts()) hostList.push(host);
        }

        let checked = 0;
        const tcpTimeout = this.deps.tcpTimeoutMs ?? 300;
        const adbTimeout = this.deps.adbConnectTimeoutMs ?? 3000;

        let cursor = 0;
        const nextHost = (): string | null => {
            if (this.cancelFlag) return null;
            if (cursor >= hostList.length) return null;
            return hostList[cursor++];
        };

        const probeOne = async (host: string): Promise<void> => {
            const address = `${host}:5555`;
            try {
                if (connectedAddresses.has(address)) return;
                if (this.emittedAddresses.has(address)) return; // mDNS already claimed
                const open = await this.deps.tcpProbe(host, 5555, tcpTimeout);
                if (!open) return;
                const connectOutput = await withTimeout(this.deps.adbConnect(address), adbTimeout);
                if (!connectOutput.toLowerCase().includes('connected')) return;
                await withTimeout(this.deps.adbDisconnect(address), 2000).catch(() => {});
                this.emitHit({
                    source: 'tcp',
                    address,
                    serial: address,
                    name: address,
                });
            } catch {
                // Silent
            }
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                const host = nextHost();
                if (host === null) return;
                await probeOne(host);
                checked++;
                if (checked % this.deps.progressInterval === 0 || checked === totalHosts) {
                    this.emit({
                        type: 'scan.progress',
                        checked,
                        total: totalHosts,
                        foundSoFar: this.foundSoFar,
                    });
                }
            }
        };

        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.min(this.deps.concurrency, Math.max(hostList.length, 1)); i++) {
            workers.push(worker());
        }
        await Promise.all([mdnsPromise, ...workers]);
    }

    private emitHit(partial: { source: 'mdns' | 'tcp'; address: string; serial: string; name: string; label?: string }): void {
        if (this.emittedAddresses.has(partial.address)) return;
        this.emittedAddresses.add(partial.address);
        this.foundSoFar++;
        // Prefer explicit label, then label-store lookup by serial (only meaningful for
        // mDNS hits where serial is authoritative; TCP hits currently pass IP:port as
        // serial, which won't match stored entries until Connect fires and persists).
        const label = partial.label ?? (this.deps.labelFor ? this.deps.labelFor(partial.serial) : undefined) ?? '';
        this.emit({
            type: 'scan.hit',
            source: partial.source,
            address: partial.address,
            serial: partial.serial,
            name: partial.name,
            label,
        });
    }

    protected emit(msg: ScanServerMessage): void {
        if (msg.type === 'scan.started') {
            this.lastStartedMsg = msg;
        } else if (msg.type === 'scan.progress') {
            this.lastProgressMsg = msg;
        }
        for (const ws of this.spectators) {
            if (ws.readyState !== ws.OPEN) continue;
            try {
                ws.send(JSON.stringify(msg));
            } catch {
                // Dropped spectator — silent
            }
        }
    }
}
