import { execFileSync } from 'node:child_process';
import { type Dirent, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Stop whatever is still running FROM a spec's data root, so the root can be
 * removed (item 170). Pure on purpose -- no Playwright import -- so
 * `tests/unit/rootProcesses.test.ts` can run it on every build.
 *
 * Why it exists: on Windows the harness stops a spec-owned server with
 * `child.kill()`, which is TerminateProcess, so the server's own graceful
 * shutdown (`adb kill-server`, src/server/index.ts) never runs. The server
 * pre-warms an adb daemon at boot, detached and unref'd, from the adb it
 * installed under `<root>/WsScrcpyWeb/dependencies/adb`. That daemon outlives
 * the kill and holds adb.exe open, so removing the root threw EPERM -- in
 * teardown (settings-dialog 13.9's afterAll), and again at the NEXT run's
 * setup, when `seedPrivateDataRoot` tried to wipe the leftover.
 *
 * Scoped by EXECUTABLE PATH, strictly inside `root`: a developer's own adb on
 * 5037, or the shared e2e server's daemon under its own root, is never matched.
 * The current process is never stopped.
 */

/** How long to wait for a stopped process to be gone before giving up quietly. */
const EXIT_WAIT_MS = 5_000;

/** Windows PowerShell 5.1 ships with every Windows; pwsh may not be installed. */
const POWERSHELL = 'powershell.exe';

/**
 * Read the root and the image names from the environment rather than splicing
 * them into the script, so no path can change what the script does. `.Path`
 * throws (or reads empty) for a process this user may not open; such a process
 * cannot be running from a temp folder this user just created, so it is
 * skipped. `Get-CimInstance Win32_Process` is deliberately not used: it throws
 * in sandboxed and headless hosts and is clamped on EDR-hardened machines.
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$prefix = $env:WS_E2E_STOP_ROOT_PREFIX
$self = [int]$env:WS_E2E_STOP_SELF_PID
$names = $env:WS_E2E_STOP_NAMES -split '\\|'
foreach ($p in @(Get-Process)) {
    if ($names -notcontains $p.ProcessName) { continue }
    if ($p.Id -eq $self) { continue }
    $exe = $null
    try { $exe = $p.Path } catch { continue }
    if (-not $exe) { continue }
    if (-not $exe.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        Write-Output ("STOPPED\`t{0}\`t{1}" -f $p.Id, $exe)
    } catch {
        Write-Output ("FAILED\`t{0}\`t{1}\`t{2}" -f $p.Id, $exe, $_.Exception.Message)
    }
}
`;

/** `root` as the OS reports a running image's path: absolute, symlinks and 8.3 names resolved. */
function canonicalRoot(root: string): string {
    try {
        return realpathSync.native(root);
    } catch {
        return path.resolve(root);
    }
}

/**
 * The image names (without extension) of every executable file under `root`.
 * Only processes with one of these names can be running from it, so
 * the script reads `.Path` for those alone: reading it for every process on a
 * developer's box (~500) took 2.7 s, against 0.27 s for the name-filtered query.
 */
function windowsImageNames(root: string): string[] {
    const names = new Set<string>();
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop() as string;
        let entries: Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.isDirectory()) stack.push(path.join(dir, e.name));
            else if (/\.(exe|com)$/i.test(e.name)) names.add(e.name.replace(/\.(exe|com)$/i, ''));
        }
    }
    return [...names];
}

function stopUnderWindows(prefix: string, root: string): { stopped: string[]; pids: number[] } {
    const names = windowsImageNames(root);
    if (names.length === 0) return { stopped: [], pids: [] };
    let out: string;
    try {
        // -EncodedCommand, so no quote in the script meets the command-line parser.
        const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
        out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            encoding: 'utf8',
            timeout: 30_000,
            windowsHide: true,
            // stderr captured, not inherited: PowerShell writes progress records
            // there as CLIXML, which would land in the test output as noise.
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                // Without PSModulePath: one inherited from a pwsh 7 shell sends
                // Windows PowerShell's module auto-load through pwsh's modules
                // first, and Get-Process took 2.6 s instead of 0.24 s (measured).
                ...Object.fromEntries(
                    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
                ),
                WS_E2E_STOP_ROOT_PREFIX: prefix,
                WS_E2E_STOP_SELF_PID: String(process.pid),
                WS_E2E_STOP_NAMES: names.join('|'),
            },
        });
    } catch (err) {
        // Not fatal by itself: if something IS still running from the root, the
        // removal that follows fails with its own EPERM and says so.
        console.warn('stopProcessesUnder: the process query failed:', root, String(err));
        return { stopped: [], pids: [] };
    }
    const stopped: string[] = [];
    const pids: number[] = [];
    for (const line of out.split(/\r?\n/)) {
        const [kind, pid, exe, message] = line.split('\t');
        if (kind === 'STOPPED' && pid && exe) {
            stopped.push(`${pid} ${exe}`);
            pids.push(Number(pid));
        } else if (kind === 'FAILED') {
            console.warn('stopProcessesUnder: could not stop a process:', pid, exe, message);
        }
    }
    return { stopped, pids };
}

function stopUnderProc(prefix: string): { stopped: string[]; pids: number[] } {
    let entries: string[];
    try {
        entries = readdirSync('/proc');
    } catch {
        // No /proc (macOS): nothing to scan. A running binary can be unlinked
        // there anyway, so it never blocks the removal.
        return { stopped: [], pids: [] };
    }
    const stopped: string[] = [];
    const pids: number[] = [];
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid === process.pid) continue;
        let exe: string;
        try {
            exe = readlinkSync(`/proc/${entry}/exe`);
        } catch {
            continue; // EACCES (another user's process), ENOENT (already gone), or a kernel thread
        }
        // An unlinked image reads `<path> (deleted)`; it still ran from here.
        exe = exe.replace(/ \(deleted\)$/, '');
        if (!exe.startsWith(prefix)) continue;
        try {
            process.kill(pid, 'SIGKILL');
            stopped.push(`${pid} ${exe}`);
            pids.push(pid);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
                console.warn('stopProcessesUnder: could not stop a process:', pid, exe, String(err));
            }
        }
    }
    return { stopped, pids };
}

/**
 * Whether `pid` is a running process. `kill(pid, 0)` alone is not enough on Linux:
 * a killed CHILD of this process stays a zombie until its parent reaps it, and a
 * zombie still answers signal 0. The parent here is often this very Node process
 * (the unit tests spawn their stand-in), whose event loop cannot reap while a
 * synchronous wait blocks it, so the zombie read as alive for the whole wait and
 * every Linux CI run failed (2026-10-06, #880). A process in state `Z` is dead.
 */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (process.platform === 'linux') {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            // `<pid> (<comm>) <state> ...`; comm may contain spaces or parens.
            const state = stat
                .slice(stat.lastIndexOf(')') + 1)
                .trim()
                .charAt(0);
            if (state === 'Z' || state === 'X') return false;
        } catch {
            return false; // gone between the signal and the read
        }
    }
    return true;
}

const isAlive = isProcessAlive;

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Force-stop every process whose executable lives inside `root`, then wait (at
 * most EXIT_WAIT_MS) until they are gone. Returns `"<pid> <executable>"` for
 * each one stopped. A root that does not exist has nothing running from it.
 */
export function stopProcessesUnder(root: string): string[] {
    if (!existsSync(root)) return [];
    const canonical = canonicalRoot(root);
    // The separator makes `<root>-sibling` a non-match.
    const prefix = canonical.endsWith(path.sep) ? canonical : canonical + path.sep;
    const { stopped, pids } =
        process.platform === 'win32' ? stopUnderWindows(prefix, canonical) : stopUnderProc(prefix);
    const deadline = Date.now() + EXIT_WAIT_MS;
    while (pids.some(isAlive) && Date.now() < deadline) sleepSync(50);
    return stopped;
}

/** Retries for `removeTree`: linear backoff, 200 ms longer each time, about 11 s in all. */
const RM_RETRIES = 10;
const RM_RETRY_DELAY_MS = 200;

/**
 * `rmSync(dir, { recursive: true, force: true })`, retried on EPERM / EBUSY /
 * ENOTEMPTY with a linear backoff, then throwing the last error.
 *
 * The retry is done here because `rmSync`'s own `maxRetries` does not do it:
 * measured on Node 24.19 (Windows), `rmSync` with `maxRetries: 5, retryDelay:
 * 300` threw EPERM after 0 ms on a held executable. And the hold outlives the
 * process: in 10 of 10 trials a delete straight after the holder had exited
 * failed EPERM and succeeded ~10 ms later.
 */
export function removeTree(dir: string): void {
    for (let attempt = 1; ; attempt++) {
        try {
            rmSync(dir, { recursive: true, force: true });
            return;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            const transient = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY';
            if (!transient || attempt > RM_RETRIES) throw err;
            sleepSync(RM_RETRY_DELAY_MS * attempt);
        }
    }
}
