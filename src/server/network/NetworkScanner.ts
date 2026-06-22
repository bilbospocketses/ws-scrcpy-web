import type WS from 'ws';
import type { ScanProgressMessage, ScanServerMessage, ScanStartedMessage } from '../../common/ScanMessage';
import type { ParsedSubnet } from '../../common/SubnetParser';
import { parseSerialFromMdnsName } from '../AdbClient';
import type { AdbHandshakeResult } from './AdbHandshakeProbe';

export interface NetworkScannerDeps {
    adbDevices: () => Promise<{ serial: string; state: string }[]>;
    adbMdnsServices: () => Promise<{ name: string; service: string; address: string; port: number }[]>;
    /** Single-connection ADB CNXN handshake probe. Takes two timeouts — the first
     *  is for the TCP connect phase (fast-fail on closed ports), the second for
     *  the CNXN/AUTH reply after connect succeeds. Returns { isAdb, model? }.
     *  Using one socket instead of separate tcpProbe + handshake avoids a race
     *  with embedded adbd stacks that reject back-to-back connections. */
    adbHandshakeProbe: (
        host: string,
        port: number,
        connectTimeoutMs: number,
        replyTimeoutMs: number,
    ) => Promise<AdbHandshakeResult>;
    /** Optional pre-warm hook: ensure the adb daemon is running before workers
     *  fire off parallel probes. Without it, the first batch of concurrent
     *  probes against a cold daemon race to spawn it and most fail. Provided
     *  by index.ts wiring as `() => adbClient.startServer()`. If not supplied
     *  (e.g. unit tests), pre-warm is skipped. */
    adbStartServer?: () => Promise<void>;
    /** Resolve an IPv4 to its MAC via ARP cache. Returns null when ARP has no entry. */
    resolveMac?: (ip: string) => Promise<string | null>;
    /** Look up a saved label by userId and device identifier (serial OR MAC).
     *  The userId ensures each user sees only their own labels. */
    labelFor?: (userId: number, key: string) => string | undefined;
    concurrency: number;
    progressInterval: number;
    /** TCP connect timeout for the probe (fast-fail on closed port). Default 300ms. */
    tcpTimeoutMs?: number;
    /** Reply timeout after CNXN is sent, for the device's CNXN/AUTH response. Default 5000ms. */
    handshakeTimeoutMs?: number;
}

type State = 'idle' | 'scanning' | 'draining';

/** Internal extension of ScanServerMessage that carries raw hit metadata for
 *  per-spectator label resolution. The `_hitMeta` field is stripped before the
 *  message is sent on the wire — it never reaches clients. */
interface ScanHitInternal {
    type: 'scan.hit';
    source: 'mdns' | 'tcp';
    address: string;
    serial: string;
    name: string;
    /** Explicit label (from caller); takes precedence over DB lookup. */
    label?: string;
    /** Internal only — carries raw hit data so emit() can resolve labels per-spectator. */
    _hitMeta: { mac: string | null; serial: string };
}

type InternalMessage = Exclude<ScanServerMessage, { type: 'scan.hit' }> | ScanHitInternal;

export class NetworkScanner {
    private state: State = 'idle';
    private cancelFlag = false;
    // Resolves `cancelSignal` (created per scan in start()) the moment cancel()
    // fires, so the drain watcher reacts to an event instead of polling. (#77)
    private resolveCancel: (() => void) | null = null;
    /** Map of ws → userId so each spectator gets labels resolved for their own user. */
    private spectators = new Map<WS | any, number>();
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

    attachSpectator(ws: WS | any, userId: number): void {
        if (this.state === 'idle') return;
        this.spectators.set(ws, userId);
        // Send snapshot of current state so new spectators aren't stuck on empty chip
        if (this.lastStartedMsg && ws.readyState === ws.OPEN) {
            try {
                ws.send(JSON.stringify(this.lastStartedMsg));
            } catch {}
        }
        if (this.lastProgressMsg && ws.readyState === ws.OPEN) {
            try {
                ws.send(JSON.stringify(this.lastProgressMsg));
            } catch {}
        }
        if (this.state === 'draining' && ws.readyState === ws.OPEN) {
            try {
                ws.send(JSON.stringify({ type: 'scan.draining' }));
            } catch {}
        }
        // Clean up on close to avoid accumulating dead entries during long scans
        if (typeof ws.once === 'function') {
            ws.once('close', () => this.spectators.delete(ws));
        }
    }

    cancel(): void {
        if (this.state !== 'scanning') return;
        this.cancelFlag = true;
        this.resolveCancel?.();
    }

    async start(
        subnets: ParsedSubnet[],
        ws: WS | any,
        userId: number,
        options?: { mdnsOnly?: boolean },
    ): Promise<void> {
        if (this.state !== 'idle') {
            throw new Error('scanner already scanning');
        }
        const mdnsOnly = options?.mdnsOnly === true;
        this.state = 'scanning';
        this.cancelFlag = false;
        let resolveCancel!: () => void;
        const cancelSignal = new Promise<void>((resolve) => {
            resolveCancel = resolve;
        });
        this.resolveCancel = resolveCancel;
        this.emittedAddresses.clear();
        this.foundSoFar = 0;
        this.lastStartedMsg = null;
        this.lastProgressMsg = null;
        this.spectators.clear();
        this.spectators.set(ws, userId);
        if (typeof (ws as any).once === 'function') {
            (ws as any).once('close', () => this.spectators.delete(ws));
        }

        // §25 — using-declaration replaces the prior try/finally that restored
        // scanner state on every exit. Captures `this` lexically so the dispose
        // resets the class invariants (state + cancelFlag) regardless of
        // whether the scan path returns, throws, or hits an early-return below.
        using _scanStateReset = {
            [Symbol.dispose]: (): void => {
                this.state = 'idle';
                this.cancelFlag = false;
                this.resolveCancel = null;
            },
        };

        try {
            // Pre-warm the adb daemon before workers fire. Without this, the
            // first batch of parallel adb probes against a cold daemon race
            // to spawn it (each loses, no daemon survives). Idempotent on a
            // warm daemon — adb start-server is a no-op when the daemon is
            // already running. If the binary isn't yet on disk
            // (autoInstallMissing in flight), this throws AdbExecError(spawn)
            // and we surface a clear scan.error instead of N parallel
            // spawn-failures from the worker pool.
            if (this.deps.adbStartServer) {
                try {
                    await this.deps.adbStartServer();
                } catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    this.emit({
                        type: 'scan.error',
                        reason: `Scan blocked: adb daemon not ready (${detail}). If this is a first launch, wait for the first-run setup to finish, then retry.`,
                    });
                    return;
                }
            }

            const totalHosts = mdnsOnly ? 0 : subnets.reduce((sum, s) => sum + s.hostCount, 0);
            this.emit({
                type: 'scan.started',
                totalHosts,
                totalSubnets: mdnsOnly ? 0 : subnets.length,
                startedAt: Date.now(),
            });

            const runPromise = this.runTracks(mdnsOnly ? [] : subnets, totalHosts, mdnsOnly);

            // Emit scan.draining as soon as cancel fires, while workers are still in
            // flight. Event-driven: race the run against the cancel signal rather than
            // polling a flag on a fixed interval. (#77)
            const drainWatcher = (async () => {
                // `.catch` here only gives the race a non-rejecting view — runPromise's
                // real rejection is still surfaced by `await runPromise` below.
                await Promise.race([runPromise.catch(() => {}), cancelSignal]);
                if (this.cancelFlag && this.state === 'scanning') {
                    this.state = 'draining';
                    this.emit({ type: 'scan.draining' });
                }
            })();

            await runPromise;
            // Snapshot cancel state BEFORE awaiting drainWatcher — any late cancel() after
            // workers completed shouldn't retroactively turn a successful scan into cancelled.
            const wasCancelled = this.cancelFlag;
            await drainWatcher;

            if (wasCancelled) {
                this.emit({ type: 'scan.cancelled', found: this.foundSoFar });
            } else {
                this.emit({ type: 'scan.complete', found: this.foundSoFar });
            }
        } catch (err) {
            // Without this, ScanMw's `.catch(() => {})` swallows the error and the
            // client waits forever on an open WS for messages that never come.
            // Surface the failure so the chip / info box displays a real reason.
            const reason = err instanceof Error ? err.message : String(err);
            this.emit({ type: 'scan.error', reason });
        }
    }

    protected async runTracks(subnets: ParsedSubnet[], totalHosts: number, mdnsOnly = false): Promise<void> {
        const connectedAddresses = new Set((await this.deps.adbDevices()).map((d) => d.serial));

        // Track A: mDNS — synchronous (adb returns all at once)
        const mdnsPromise = (async () => {
            try {
                const hits = await this.deps.adbMdnsServices();
                for (const hit of hits) {
                    if (this.cancelFlag) break;
                    if (!hit.service.includes('_adb') || hit.service.includes('pairing')) continue;
                    const address = `${hit.address}:${hit.port}`;
                    if (connectedAddresses.has(address)) continue;
                    const serial = parseSerialFromMdnsName(hit.name, hit.service);
                    this.emitHit({
                        source: 'mdns',
                        address,
                        serial,
                        name: `adb-${serial}`,
                    });
                }
            } catch {
                // mDNS track failed — silent; TCP track continues
            }
        })();

        if (mdnsOnly) {
            await mdnsPromise;
            return;
        }

        // Track B: TCP (existing pool logic)
        const hostList: string[] = [];
        for (const subnet of subnets) {
            for (const host of subnet.hosts()) hostList.push(host);
        }

        let checked = 0;
        const tcpTimeout = this.deps.tcpTimeoutMs ?? 300;
        const handshakeTimeout = this.deps.handshakeTimeoutMs ?? 2000;

        let cursor = 0;
        const nextHost = (): string | null => {
            if (this.cancelFlag) return null;
            if (cursor >= hostList.length) return null;
            return hostList[cursor++] ?? null;
        };

        const probeOne = async (host: string): Promise<void> => {
            const address = `${host}:5555`;
            try {
                if (connectedAddresses.has(address)) return;
                if (this.emittedAddresses.has(address)) return; // mDNS already claimed
                // Single-connection probe: TCP connect + CNXN handshake in one socket.
                // Returns isAdb=false on connect timeout (closed port) or reply timeout,
                // isAdb=true when the device's CNXN or AUTH reply arrives.
                const handshake = await this.deps.adbHandshakeProbe(host, 5555, tcpTimeout, handshakeTimeout);
                if (!handshake.isAdb) return;
                // ARP cache is freshly populated from the handshake's TCP traffic.
                const mac = this.deps.resolveMac ? await this.deps.resolveMac(host) : null;
                this.emitHit({
                    source: 'tcp',
                    address,
                    serial: address,
                    name: handshake.model ?? '',
                    mac,
                });
            } catch {
                // Silent probe failure
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

    private emitHit(partial: {
        source: 'mdns' | 'tcp';
        address: string;
        serial: string;
        name: string;
        mac?: string | null;
        label?: string;
    }): void {
        if (this.emittedAddresses.has(partial.address)) return;
        this.emittedAddresses.add(partial.address);
        this.foundSoFar++;
        // Pass an internal hit message with raw metadata so emit() can resolve
        // labels per-spectator. `_hitMeta` is stripped before sending on the wire.
        const internalMsg: ScanHitInternal = {
            type: 'scan.hit',
            source: partial.source,
            address: partial.address,
            serial: partial.serial,
            name: partial.name,
            ...(partial.label !== undefined ? { label: partial.label } : {}),
            _hitMeta: { mac: partial.mac ?? null, serial: partial.serial },
        };
        this.emit(internalMsg);
    }

    protected emit(msg: InternalMessage): void {
        if (msg.type === 'scan.started') {
            this.lastStartedMsg = msg;
        } else if (msg.type === 'scan.progress') {
            this.lastProgressMsg = msg;
        }

        if (msg.type === 'scan.hit') {
            // Per-spectator label resolution: each user sees their own saved labels.
            const { _hitMeta, label: explicitLabel, ...hitBase } = msg;
            for (const [ws, userId] of this.spectators) {
                if (ws.readyState !== ws.OPEN) continue;
                // Label precedence: explicit > MAC lookup > serial lookup > ''
                let label = explicitLabel;
                if (label === undefined && this.deps.labelFor) {
                    if (_hitMeta.mac) label = this.deps.labelFor(userId, _hitMeta.mac);
                    if (label === undefined) label = this.deps.labelFor(userId, _hitMeta.serial);
                }
                const wireMsg = { ...hitBase, label: label ?? '' };
                try {
                    ws.send(JSON.stringify(wireMsg));
                } catch {
                    // Dropped spectator — silent
                }
            }
        } else {
            // Non-hit messages (scan.started, scan.progress, scan.complete, etc.)
            // are sent identically to all spectators — no per-user data.
            const wireMsg = msg as ScanServerMessage;
            for (const ws of this.spectators.keys()) {
                if (ws.readyState !== ws.OPEN) continue;
                try {
                    ws.send(JSON.stringify(wireMsg));
                } catch {
                    // Dropped spectator — silent
                }
            }
        }
    }
}
