import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { AdbExecError } from './AdbClient';

const execFileAsync = promisify(execFile);

type State = 'idle' | 'starting' | 'ready' | 'killed';

const WAIT_FOR_BINARY_MS = 5 * 60 * 1000;
const DAEMON_START_TIMEOUT_MS = 30_000;
const KILL_SERVER_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

export interface EnsureReadyOpts {
    /**
     * Per-call max wait. If undefined, wait indefinitely up to the manager's
     * internal binary-wait + daemon-start budget. If set, the call rejects
     * with AdbExecError(timeout) after `waitMs` without disturbing the
     * underlying in-flight spawn (a subsequent caller without a timeout can
     * still pick up the same in-flight).
     */
    waitMs?: number;
}

/**
 * Owns the lifecycle of a single `adb start-server` daemon for a given
 * adbPath. All AdbClient instances delegate to this singleton for
 * daemon-readiness, so 7+ production call sites that previously could race
 * independent spawn invocations now cooperatively await one coordinated
 * spawn.
 *
 * State machine: idle → starting → ready → (kill) → killed → starting → ready
 *  - idle: no spawn attempted yet, or last spawn failed (retryable).
 *  - starting: spawn in flight.
 *  - ready: daemon believed up; ensureReady() returns immediately.
 *  - killed: kill() invoked; next ensureReady() re-spawns.
 *
 * Single-flight: concurrent ensureReady() callers share one in-flight spawn
 * via the `inflight` field.
 */
export class AdbDaemonManager {
    private static instances = new Map<string, AdbDaemonManager>();

    private state: State = 'idle';
    private inflight: Promise<void> | null = null;
    public readonly cwd: string;

    protected constructor(public readonly adbPath: string) {
        this.cwd = path.dirname(adbPath);
    }

    static getInstance(adbPath: string): AdbDaemonManager {
        let inst = AdbDaemonManager.instances.get(adbPath);
        if (!inst) {
            inst = new AdbDaemonManager(adbPath);
            AdbDaemonManager.instances.set(adbPath, inst);
        }
        return inst;
    }

    /** Test-only: clear instance cache so each test starts fresh. */
    static _resetForTest(): void {
        AdbDaemonManager.instances.clear();
    }

    isReady(): boolean {
        return this.state === 'ready';
    }

    getState(): State {
        return this.state;
    }

    async ensureReady(opts: EnsureReadyOpts = {}): Promise<void> {
        if (this.state === 'ready') return;
        if (!this.inflight) {
            this.inflight = this.spawnLifecycle();
            // Suppress unhandled-rejection on the stored inflight: every
            // consumer attaches its own awaits/handlers via the returned
            // promise (or the race below). The stored field exists only so
            // concurrent callers share the work — it's not awaited directly.
            this.inflight.catch(() => {
                /* tracked by callers */
            });
        }
        const inflight = this.inflight;
        if (opts.waitMs === undefined) {
            return inflight;
        }
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    new AdbExecError(
                        'timeout',
                        this.adbPath,
                        ['start-server'],
                        new Error(`adb daemon not ready within ${opts.waitMs}ms`),
                    ),
                );
            }, opts.waitMs);
        });
        // §25 — using-declaration replaces the prior try/finally clearTimeout.
        // Captures `timer` by reference; the setTimeout callback above assigns
        // it synchronously inside the Promise executor (executors run sync),
        // so dispose sees the populated handle on every exit path.
        using _timerCleanup = {
            [Symbol.dispose](): void {
                if (timer) clearTimeout(timer);
            },
        };
        await Promise.race([inflight, timeoutPromise]);
    }

    /**
     * Terminate the daemon via `adb kill-server`. No-op when state is `idle`
     * or `killed`. Used by clean-shutdown paths (SIGINT/SIGTERM) so the
     * daemon doesn't outlive our process tree and hold port 5037 / file
     * handles on the install dir.
     *
     * If kill() races an in-flight spawn (Ctrl+C during cold-start), the
     * state transitions to `killed` immediately; the in-flight spawn's
     * settle path checks the state and won't overwrite `killed` back to
     * `ready`. The kill-server exec itself is best-effort — fires regardless
     * of whether the daemon actually came up, since kill-server is a no-op
     * against a non-running daemon on a present binary.
     */
    async kill(): Promise<void> {
        if (this.state === 'idle' || this.state === 'killed') return;
        this.state = 'killed';
        this.inflight = null;
        await this.executeKillServer();
    }

    private async spawnLifecycle(): Promise<void> {
        this.state = 'starting';
        try {
            await this.waitForBinary(WAIT_FOR_BINARY_MS);
            await this.spawnDetachedDaemon(DAEMON_START_TIMEOUT_MS);
            // If kill() ran during the in-flight spawn, state is already
            // 'killed' — don't overwrite it back to 'ready'.
            if (this.state === 'starting') {
                this.state = 'ready';
            }
            this.inflight = null;
        } catch (err) {
            if (this.state === 'starting') {
                this.state = 'idle';
            }
            this.inflight = null;
            throw err;
        }
    }

    /**
     * Polls for the adb binary to appear on disk. The dep manager downloads
     * adb in the background on first launch; this loop bridges the gap so
     * the daemon spawn doesn't fail with ENOENT during a cold install.
     */
    protected async waitForBinary(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!fs.existsSync(this.adbPath)) {
            if (Date.now() >= deadline) {
                throw new AdbExecError(
                    'spawn',
                    this.adbPath,
                    ['start-server'],
                    new Error(`adb binary not present after ${timeoutMs}ms wait`),
                );
            }
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    }

    /**
     * Spawn `adb start-server` with `detached: true` so the daemon escapes
     * Node's Windows job object. Without detach, Node's child_process puts
     * adb in a job with kill-on-job-close — when `adb start-server` returns
     * (or times out), the OS kills every descendant including the daemon
     * `adb fork-server` child. Result: daemon NEVER survives our spawn.
     *
     * `detached: true` on Windows uses CREATE_NEW_PROCESS_GROUP which
     * excludes the spawned process from Node's job, matching what
     * PowerShell's `adb start-server` does (it works flawlessly there).
     *
     * Watches exit code: 0 = daemon spawned and parent exited normally;
     * non-zero = adb reported failure (stderr appended to error message).
     * Safety timeout kills the parent if adb hangs.
     */
    protected spawnDetachedDaemon(timeoutMs: number): Promise<void> {
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
            const settleOk = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // Release Node's reference to the child so its stdio pipes
                // don't keep our event loop alive. The detached daemon
                // grandchild continues running in its own process group.
                proc.unref();
                resolve();
            };
            const settleErr = (err: AdbExecError): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            };

            proc.stdout?.on('data', (chunk: Buffer) => {
                stdoutBuf += chunk.toString();
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
                stderrBuf += chunk.toString();
            });

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
                try {
                    proc.kill();
                } catch {
                    /* best-effort */
                }
                settleErr(
                    new AdbExecError('timeout', this.adbPath, ['start-server'], new Error(`${timeoutMs}ms deadline`)),
                );
            }, timeoutMs);
            timer.unref();
        });
    }

    /**
     * Fires `adb kill-server`. Direct execFile (not through AdbClient) to
     * avoid recursing into ensureReady() during teardown. Classifies the
     * error so AdbClient's existing AdbExecError surface stays intact.
     */
    protected async executeKillServer(): Promise<void> {
        try {
            await execFileAsync(this.adbPath, ['kill-server'], {
                maxBuffer: 1024 * 1024,
                cwd: this.cwd,
                timeout: KILL_SERVER_TIMEOUT_MS,
                killSignal: 'SIGKILL',
            });
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
            if (e?.killed && (e.signal === 'SIGKILL' || e.signal === 'SIGTERM')) {
                throw new AdbExecError('timeout', this.adbPath, ['kill-server'], err);
            }
            if (e?.code === 'ENOENT' || e?.code === 'EACCES') {
                throw new AdbExecError('spawn', this.adbPath, ['kill-server'], err);
            }
            if (typeof e?.code === 'number') {
                throw new AdbExecError('exit', this.adbPath, ['kill-server'], err);
            }
            throw new AdbExecError('unknown', this.adbPath, ['kill-server'], err);
        }
    }
}
