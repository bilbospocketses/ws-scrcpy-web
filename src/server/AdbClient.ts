import { type ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AdbDevice {
    serial: string;
    state: string;
}

export interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
}

export type AdbExecErrorKind = 'timeout' | 'spawn' | 'exit' | 'unknown';

/**
 * Typed error thrown by AdbClient on any failure path. Carries the resolved
 * adb path and the args so log readers can spot wrong-binary or timing
 * issues without grepping the stack.
 */
export class AdbExecError extends Error {
    constructor(
        public readonly kind: AdbExecErrorKind,
        public readonly adbPath: string,
        public readonly args: readonly string[],
        public readonly cause?: unknown,
    ) {
        const argsPreview = args.join(' ');
        const causeMsg = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : '';
        const detail = causeMsg ? ` — ${causeMsg}` : '';
        super(`adb ${kind} (path=${adbPath}, args="${argsPreview}")${detail}`);
        this.name = 'AdbExecError';
    }
}

interface AdbExecOptions {
    /** Hard timeout in ms. 0 / undefined = unbounded. */
    timeoutMs?: number;
}

// Default timeouts for short-lived control-plane commands. Anything not on
// this list (push/pull, arbitrary shell) stays unbounded — caller decides.
const DEFAULT_TIMEOUT_MS = {
    devices: 5_000,
    mdnsServices: 8_000,
    connect: 8_000,
    disconnect: 5_000,
    forwardOps: 5_000,
} as const;

export function parseMdnsOutput(output: string): MdnsDevice[] {
    const results: MdnsDevice[] = [];
    for (const line of output.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [name, service, addressPort] = parts;
        const colonIdx = addressPort.lastIndexOf(':');
        if (colonIdx === -1) continue;
        const address = addressPort.substring(0, colonIdx);
        const port = parseInt(addressPort.substring(colonIdx + 1), 10);
        if (isNaN(port)) continue;
        results.push({ name: name.trim(), service: service.trim(), address, port });
    }
    return results;
}

export function parseSerialFromMdnsName(name: string, service: string): string {
    // Strip 'adb-' prefix
    let serial = name.startsWith('adb-') ? name.slice(4) : name;
    // For TLS connect services, strip the instance suffix (last -segment, 6-8 alphanumeric chars)
    if (service.includes('tls-connect') && serial.includes('-')) {
        serial = serial.substring(0, serial.lastIndexOf('-'));
    }
    return serial;
}

export class AdbClient {
    /**
     * Working directory for spawned adb processes. Set to the adb binary's
     * own directory so the long-lived `adb start-server` daemon — which
     * inherits its parent's CWD and survives our process tree — never
     * holds a handle on `<installRoot>\current\` (which would block
     * Velopack's in-app updater rename during apply).
     *
     * Diagnosed v0.1.23-beta.11 → beta.12 VM testing 2026-04-29: handle.exe
     * showed adb.exe holding C:\Program Files\WsScrcpyWeb\current as a
     * persistent file handle across multiple apply attempts. Daemon
     * inherited cwd from Node, which inherited from launcher, which ran
     * from current/. The bundled adb directory is `<dataRoot>\dependencies\adb\`
     * (per CLAUDE.md Local-Dependencies-Only) — not under install root —
     * so anchoring the daemon there decouples its CWD lock from the swap
     * target.
     */
    public readonly cwd: string;

    /**
     * `adbPath` is required. Callers MUST pass `Config.getInstance().adbPath`
     * (or an explicit override). The previous default of `'adb'` masked
     * packaging bugs by silently falling through to whatever adb happened
     * to be on the system PATH.
     */
    constructor(public readonly adbPath: string) {
        this.cwd = path.dirname(adbPath);
    }

    private async exec(args: string[], opts: AdbExecOptions = {}): Promise<string> {
        const execOpts: { maxBuffer: number; timeout?: number; killSignal?: NodeJS.Signals; cwd?: string } = {
            maxBuffer: 10 * 1024 * 1024,
            cwd: this.cwd,
        };
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            execOpts.timeout = opts.timeoutMs;
            execOpts.killSignal = 'SIGKILL';
        }
        try {
            const { stdout } = await execFileAsync(this.adbPath, args, execOpts);
            return stdout;
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
            if (e?.killed && (e.signal === 'SIGKILL' || e.signal === 'SIGTERM')) {
                throw new AdbExecError('timeout', this.adbPath, args, err);
            }
            if (e?.code === 'ENOENT' || e?.code === 'EACCES') {
                throw new AdbExecError('spawn', this.adbPath, args, err);
            }
            if (typeof e?.code === 'number') {
                throw new AdbExecError('exit', this.adbPath, args, err);
            }
            throw new AdbExecError('unknown', this.adbPath, args, err);
        }
    }

    async devices(): Promise<AdbDevice[]> {
        const output = await this.exec(['devices'], { timeoutMs: DEFAULT_TIMEOUT_MS.devices });
        return output
            .split('\n')
            .slice(1) // skip "List of devices attached" header
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, state] = line.trim().split(/\s+/);
                return { serial, state };
            });
    }

    async shell(serial: string, command: string): Promise<string> {
        const { stdout } = await execFileAsync(this.adbPath, ['-s', serial, 'shell', command], {
            maxBuffer: 10 * 1024 * 1024,
            cwd: this.cwd,
        });
        return stdout.trim();
    }

    async push(serial: string, local: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'push', local, remote]);
    }

    async pull(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'pull', remote, local]);
    }

    async forward(serial: string, local: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', local, remote], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async listForwards(serial: string): Promise<{ serial: string; local: string; remote: string }[]> {
        const output = await this.exec(['-s', serial, 'forward', '--list'], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
        return output
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, local, remote] = line.trim().split(/\s+/);
                return { serial, local, remote };
            });
    }

    async removeForward(serial: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', '--remove', local], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async reverse(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', remote, local], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async removeReverse(serial: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', '--remove', remote], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async getProperties(serial: string): Promise<Record<string, string>> {
        const output = await this.shell(serial, 'getprop');
        const props: Record<string, string> = {};
        const regex = /\[(.+?)\]: \[(.*)]/g;
        let match;
        while ((match = regex.exec(output)) !== null) {
            props[match[1]] = match[2];
        }
        return props;
    }

    /** Long-running shell command using spawn (doesn't wait for completion) */
    shellSpawn(serial: string, command: string): ChildProcess {
        return spawn(this.adbPath, ['-s', serial, 'shell', command], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: this.cwd,
        });
    }

    /**
     * Returns mDNS-discovered services. Throws AdbExecError on failure
     * (timeout, ENOENT, non-zero exit). Callers wanting silent degradation
     * must wrap. Previously this swallowed errors and returned [], which
     * masked packaging bugs (notably bare 'adb' falling through to whatever
     * adb happened to be on the system PATH).
     */
    async mdnsServices(): Promise<MdnsDevice[]> {
        const output = await this.exec(['mdns', 'services'], { timeoutMs: DEFAULT_TIMEOUT_MS.mdnsServices });
        return parseMdnsOutput(output);
    }

    async connect(address: string): Promise<string> {
        return this.exec(['connect', address], { timeoutMs: DEFAULT_TIMEOUT_MS.connect });
    }

    async disconnect(address: string): Promise<string> {
        return this.exec(['disconnect', address], { timeoutMs: DEFAULT_TIMEOUT_MS.disconnect });
    }

    /**
     * Starts the long-lived adb daemon explicitly so subsequent adb invocations
     * find it warm. Without this pre-warm, the first batch of parallel adb
     * calls (e.g. NetworkScanner's worker pool fired off by a Quick Scan on a
     * wiped ProgramData) all race to spawn the daemon — losers report
     * "protocol fault: connection reset" or time out, the winning client's
     * daemon child may get orphaned, and no daemon survives.
     *
     * `waitForBinaryMs` covers the first-launch case where adb.exe isn't yet
     * on disk because autoInstallMissing is still downloading it. Caller
     * picks: short (~5s default) for scan-time defense; long (~5min) for the
     * server-startup background warmup. After the binary appears, the actual
     * start invocation gets a 30s budget — generous for cold-start.
     *
     * Idempotent: a no-op when the daemon is already running, so repeat calls
     * are cheap. `this.adbPath` resolves to the configured local-deps path
     * (Config.adbPath → resolveAdbPath → <dependenciesPath>/adb/adb.exe), per
     * the Local-Dependencies-Only architecture.
     */
    async startServer(opts: { waitForBinaryMs?: number; daemonStartTimeoutMs?: number } = {}): Promise<void> {
        const waitMs = opts.waitForBinaryMs ?? 5_000;
        const pollIntervalMs = 250;
        const deadline = Date.now() + waitMs;
        while (!fs.existsSync(this.adbPath)) {
            if (Date.now() >= deadline) {
                throw new AdbExecError(
                    'spawn',
                    this.adbPath,
                    ['start-server'],
                    new Error(`adb binary not present after ${waitMs}ms wait`),
                );
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        await this.spawnDetachedDaemon(opts.daemonStartTimeoutMs ?? 30_000);
    }

    /**
     * Spawn `adb start-server` with `detached: true` so the daemon escapes
     * Node's Windows job object. Without detach, Node's child_process puts
     * adb in a job with kill-on-job-close — when `adb start-server` returns
     * (or times out), the OS kills every descendant including the daemon
     * `adb fork-server` child. Result: daemon NEVER survives our spawn, and
     * `ControlCenter`'s 5s poll re-spawns the doomed dance forever (verified
     * via `C:\Temp\watch-adb.ps1` capture 2026-05-15: parent + would-be
     * daemon child died at the same millisecond every 5s cycle).
     *
     * The user's manual `adb start-server` from PowerShell works because
     * PowerShell doesn't create a job object — adb is free to fork-and-
     * detach normally. `detached: true` on Windows uses
     * CREATE_NEW_PROCESS_GROUP which excludes the spawned process from
     * Node's job, matching the PowerShell behavior.
     *
     * Watches exit code: 0 = daemon spawned and parent exited normally,
     * non-zero = adb reported failure (stderr appended to error message).
     * Safety timeout kills the parent if adb hangs.
     */
    private spawnDetachedDaemon(timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const proc = spawn(this.adbPath, ['start-server'], {
                cwd: this.cwd,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let stderrBuf = '';
            let stdoutBuf = '';
            let settled = false;
            const settleOk = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // Release Node's reference to the child so its stdio pipes
                // don't keep our event loop alive. The detached daemon
                // grandchild continues running in its own process group.
                proc.unref();
                resolve();
            };
            const settleErr = (err: AdbExecError) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            };

            proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString(); });
            proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

            proc.on('error', (err) => {
                settleErr(new AdbExecError('spawn', this.adbPath, ['start-server'], err));
            });

            proc.on('exit', (code) => {
                if (code === 0) {
                    settleOk();
                } else {
                    const detail = (stderrBuf + stdoutBuf).trim() || `adb start-server exited with code ${code}`;
                    settleErr(new AdbExecError('exit', this.adbPath, ['start-server'], new Error(detail)));
                }
            });

            const timer = setTimeout(() => {
                try { proc.kill(); } catch { /* best-effort */ }
                settleErr(new AdbExecError('timeout', this.adbPath, ['start-server'], new Error(`${timeoutMs}ms deadline`)));
            }, timeoutMs);
            timer.unref();
        });
    }

    /**
     * Terminates the long-lived `adb start-server` daemon. Used as pre-apply
     * hygiene before Velopack's in-app updater so the daemon's CWD-lock on
     * the install dir is released and the rename of `current\` can proceed.
     *
     * Idempotent — `adb kill-server` is a no-op when the daemon isn't
     * running, and the underlying `exec` call still succeeds. Bounded by
     * a 5s timeout so a stuck daemon doesn't hang the apply path; if
     * timeout fires, the caller's belt-and-braces taskkill will catch it.
     */
    async killServer(): Promise<void> {
        await this.exec(['kill-server'], { timeoutMs: 5_000 });
    }
}
