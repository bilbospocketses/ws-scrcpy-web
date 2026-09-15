import { type ChildProcess, execFile, spawn } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { AdbDaemonManager } from './AdbDaemonManager';
import { assertSerial } from './security/deviceInput';

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
        public override readonly cause?: unknown,
    ) {
        const argsPreview = args.join(' ');
        const causeMsg = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : '';
        const detail = causeMsg ? ` — ${causeMsg}` : '';
        super(`adb ${kind} (path=${adbPath}, args="${argsPreview}")${detail}`);
        this.name = 'AdbExecError';
    }
}

/**
 * Error thrown by `AdbClient.pair`. Deliberately carries NO args and NO cause
 * chain: `AdbExecError` interpolates `args.join(' ')` into its message, and the
 * pairing args contain the one-time pairing password. See `AdbClient.pair`.
 */
export class PairingError extends Error {
    constructor(
        public readonly kind: 'timeout' | 'refused' | 'unknown',
        message: string,
    ) {
        super(message);
        this.name = 'PairingError';
    }
}

interface AdbExecOptions {
    /** Hard timeout in ms. 0 / undefined = unbounded. */
    timeoutMs?: number;
}

// Default timeouts for short-lived control-plane commands. push/pull stay
// unbounded (large transfers); a one-shot arbitrary `shell` is bounded so a
// hung device command can't pin the server forever (#23) — genuinely
// long-running / streaming commands go through shellSpawn instead.
export const DEFAULT_TIMEOUT_MS = {
    devices: 5_000,
    mdnsServices: 8_000,
    // Pairing involves a TLS handshake and user-paced input, so it gets a
    // longer budget than `connect`.
    pair: 20_000,
    connect: 8_000,
    disconnect: 5_000,
    forwardOps: 5_000,
    shell: 30_000,
} as const;

export function parseMdnsOutput(output: string): MdnsDevice[] {
    const results: MdnsDevice[] = [];
    for (const line of output.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [name, service, addressPort] = parts as [string, string, string];
        const colonIdx = addressPort.lastIndexOf(':');
        if (colonIdx === -1) continue;
        const address = addressPort.substring(0, colonIdx);
        const port = parseInt(addressPort.substring(colonIdx + 1), 10);
        if (Number.isNaN(port)) continue;
        // The service type is normalised to its UNDOTTED form here, at the one
        // place adb's output enters the process. DNS-SD names are fully
        // qualified and may carry a trailing root dot (`_adb-tls-pairing._tcp.`),
        // and the two consumers disagree about it: the scan path asks
        // `service.includes('_adb')`, which tolerates either, while the pairing
        // path compares `service === '_adb-tls-pairing._tcp'`, which does not.
        // An adb that emits the dot would therefore break QR discovery SILENTLY
        // — no error, just a device that is never found — while the scan went on
        // working. Normalising once here is what makes the two agree.
        results.push({ name: name.trim(), service: service.trim().replace(/\.$/, ''), address, port });
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

/**
 * Parse `adb shell getprop` output (`[key]: [value]` lines) into a map. Uses a
 * null-prototype object so device-controlled property names cannot collide with
 * `Object.prototype` members — a plain `{}` would report inherited keys such as
 * `toString` as present and is a prototype-pollution surface. (#78)
 */
export function parseGetProp(output: string): Record<string, string> {
    const props: Record<string, string> = Object.create(null);
    const regex = /\[(.+?)\]: \[(.*)]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
        if (match[1] !== undefined && match[2] !== undefined) {
            props[match[1]] = match[2];
        }
    }
    return props;
}

/**
 * Pull the guid out of a successful `adb pair` line, e.g.
 * `Successfully paired to 192.168.86.190:41415 [guid=adb-5C061JEA327610-bo0E0q]`.
 * Callers match it against an `_adb-tls-connect._tcp` mDNS service name to find
 * the connect port the freshly-paired device came up on. Returns undefined when
 * adb printed no guid.
 */
export function parsePairGuid(output: string): string | undefined {
    return /\[guid=([^\]]+)\]/.exec(output)?.[1];
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
     * (local-dependencies-only architecture) — not under install root —
     * so anchoring the daemon there decouples its CWD lock from the swap
     * target.
     */
    public readonly cwd: string;

    /**
     * Singleton manager for the adb daemon's lifecycle. All public methods
     * await `daemon.ensureReady()` before invoking adb, so 7+ AdbClient
     * instances scattered across the server can no longer race independent
     * `adb start-server` invocations.
     */
    private readonly daemon: AdbDaemonManager;

    /**
     * `adbPath` is required. Callers MUST pass `Config.getInstance().adbPath`
     * (or an explicit override). The previous default of `'adb'` masked
     * packaging bugs by silently falling through to whatever adb happened
     * to be on the system PATH.
     */
    constructor(public readonly adbPath: string) {
        this.cwd = path.dirname(adbPath);
        this.daemon = AdbDaemonManager.getInstance(adbPath);
    }

    private async exec(args: string[], opts: AdbExecOptions = {}): Promise<string> {
        // Validate the target serial (argument injection: a leading "-" would be
        // parsed by adb as an option, e.g. -L/-H to redirect to another server).
        if (args[0] === '-s') {
            assertSerial(args[1]);
        }
        // Daemon coordination first — propagate any AdbExecError from the
        // manager (binary-missing, spawn-timeout) unchanged. Inside the try
        // block, the catch's err-classifier would unhelpfully rewrap an
        // already-classified error as ('unknown', args=<this method's args>).
        await this.daemon.ensureReady();
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
                const [serial = '', state = ''] = line.trim().split(/\s+/);
                return { serial, state };
            });
    }

    async shell(serial: string, command: string, timeoutMs: number = DEFAULT_TIMEOUT_MS.shell): Promise<string> {
        // Route through exec so a one-shot `adb shell` inherits the daemon
        // coordination, the maxBuffer output cap, error classification, and a
        // default timeout — it must not be able to hang the server forever (#23).
        const output = await this.exec(['-s', serial, 'shell', command], { timeoutMs });
        return output.trim();
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
        const output = await this.exec(['-s', serial, 'forward', '--list'], {
            timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps,
        });
        return output
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial = '', local = '', remote = ''] = line.trim().split(/\s+/);
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
            if (match[1] !== undefined && match[2] !== undefined) {
                props[match[1]] = match[2];
            }
        }
        return props;
    }

    /**
     * Long-running shell command using spawn (doesn't wait for completion).
     *
     * NOTE: This is the one public method that does NOT await
     * `daemon.ensureReady()` — spawn() returns a ChildProcess synchronously
     * and the callers (`ScrcpyConnection.launchServer`, `Device.runShellCommandSpawn`)
     * are sync too. Making them async would cascade through the streaming
     * lifecycle. The implicit invariant: callers only reach shellSpawn after
     * Device exists, which means `adbClient.devices()` already ran and
     * coordinated the daemon. If we ever add a code path that hits shellSpawn
     * pre-enumeration, this comment is the trip-wire to revisit the API.
     */
    shellSpawn(serial: string, command: string): ChildProcess {
        assertSerial(serial);
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

    /**
     * Pair with a device. NEVER lets the pairing code escape.
     *
     * AdbExecError builds its message from `args.join(' ')`, so letting one
     * propagate from here would put the pairing password into every log that
     * catches it. This method is the redaction boundary: it swallows the
     * original error entirely — no args, no cause chain — and throws a
     * PairingError whose message names only the failure kind.
     */
    async pair(address: string, code: string): Promise<string> {
        let out: string;
        try {
            out = await this.exec(['pair', address, code], { timeoutMs: DEFAULT_TIMEOUT_MS.pair });
        } catch (e) {
            // Only a timeout on OUR `pair` argv is a pairing timeout. `exec`
            // awaits `daemon.ensureReady()` first, which throws its own
            // AdbExecError('timeout', …, ['start-server']) when adb itself
            // never came up (AdbDaemonManager) — reporting that as
            // PairingError('timeout') would tell the user pairing timed out
            // and send them back to the phone for a fresh code against a
            // daemon that is not running. Anything not ours is 'unknown'.
            const isPairTimeout = e instanceof AdbExecError && e.kind === 'timeout' && e.args[0] === 'pair';
            const kind = isPairTimeout ? 'timeout' : 'unknown';
            throw new PairingError(kind, `adb pair failed (${kind})`);
        }
        // adb exits 0 while printing a failure for a wrong code, so the exit
        // code is not the success signal — the text is.
        if (!/successfully paired/i.test(out)) {
            // Deliberately does NOT say the code was wrong. This fires whenever
            // adb failed to report success, which includes adb-side failures
            // like "Unable to start pairing client" — and in QR mode the user
            // never typed a code at all, so telling them to check it names
            // something that does not exist on their screen.
            throw new PairingError(
                'refused',
                'Pairing did not complete. Make sure the phone is still showing its pairing screen — and, if you typed a pairing code, that it was entered correctly — then try again.',
            );
        }
        return out;
    }

    async disconnect(address: string): Promise<string> {
        return this.exec(['disconnect', address], { timeoutMs: DEFAULT_TIMEOUT_MS.disconnect });
    }

    /**
     * Ensures the long-lived `adb start-server` daemon is up. Delegates to
     * the AdbDaemonManager singleton — see AdbDaemonManager for the
     * single-flight + state-machine semantics that prevent the multi-spawn
     * race for port 5037.
     *
     * Idempotent: a no-op when the daemon is already ready. Callers needing
     * a per-call timeout (e.g. scan-time short-circuit) should reach for the
     * manager directly via `AdbDaemonManager.getInstance(adbPath).ensureReady({ waitMs })`.
     */
    async startServer(): Promise<void> {
        return this.daemon.ensureReady();
    }

    /**
     * Terminates the long-lived `adb start-server` daemon. Delegates to the
     * AdbDaemonManager singleton's kill(). Used as pre-apply hygiene before
     * Velopack's in-app updater so the daemon's CWD-lock on the install dir
     * is released, and during clean SIGINT/SIGTERM so the daemon doesn't
     * outlive our process tree.
     */
    async killServer(): Promise<void> {
        return this.daemon.kill();
    }
}
