import { execFile } from 'child_process';
import * as path from 'path';
import { Logger } from '../Logger';

/**
 * Stop the adb processes running the APP'S OWN adb binary -- and nothing else.
 *
 * **Why this exists.** Graceful shutdown and the Windows pre-update hygiene
 * both follow `adb kill-server` with a forced kill, because kill-server alone
 * can leave the app's daemon behind: one spawned detached escapes the Node job
 * object, and one with stuck transports or in-flight forwards ignores the
 * request. Before an update that survivor matters -- it held a cwd handle on
 * `<installRoot>\current\` and blocked Velopack's swap.
 *
 * Both used to do it with `taskkill /F /IM adb.exe /T`, which kills EVERY
 * adb.exe on the machine: Android Studio's, a developer's own daemon from
 * another platform-tools install, another app's. Quitting ws-scrcpy-web or
 * applying an update dropped every device those tools had connected. The app
 * only ever spawns one adb -- `Config.adbPath` (a user override, else
 * `<dependencies>/adb/adb.exe`) -- so the kill is narrowed to processes whose
 * executable path IS that file.
 *
 * **How.** List adb processes with their executable paths, compare each path
 * with `adbPath` in Node (resolved, and case-insensitively, because Windows
 * paths are), and `taskkill /F /PID <n> /T` each match. The listing script
 * takes no input at all: nothing from config or the environment is spliced
 * into it, so there is nothing to inject through.
 *
 * Every failure is logged at warn and swallowed. Shutdown and update apply must
 * never fail because the reaper did; the worst case is the old pre-reaper
 * behaviour of relying on kill-server alone.
 *
 * Windows-only; a no-op elsewhere, where kill-server has proved sufficient.
 */

const log = Logger.for('AdbReaper');

/**
 * A LITERAL Windows root, never `%SystemRoot%`: an env var is caller- and
 * attacker-controlled in exactly the way `%PATH%` is. Mirrors the private
 * `WINDOWS_ROOT` in `service/systemTools.ts` (not exported there), which
 * documents the convention and the review that set it.
 */
const WINDOWS_ROOT = 'C:\\Windows';

/** Windows PowerShell 5.1 -- present on every supported Windows, unlike pwsh 7. */
export const POWERSHELL_EXE = `${WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
export const TASKKILL_EXE = `${WINDOWS_ROOT}\\System32\\taskkill.exe`;

/** PowerShell can take a second or more to start on a loaded, scanned box. */
const LIST_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;

/**
 * Prints `<pid>TAB<executable path>` per adb process, the path empty when it
 * cannot be read (another user's process without elevation). UTF-8 without a
 * BOM so a non-ASCII install path survives the trip; the encoding switch is in
 * a try because it throws when the host has no console.
 */
export const LIST_ADB_PROCESSES_SCRIPT = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }',
    'foreach ($p in @(Get-Process -Name adb -ErrorAction SilentlyContinue)) {',
    "    $exe = ''",
    "    try { $exe = [string]$p.Path } catch { $exe = '' }",
    '    [Console]::Out.WriteLine(([string]$p.Id) + "`t" + $exe)',
    '}',
].join('\n');

export interface AdbProcessInfo {
    pid: number;
    /** Executable path, or '' when the OS would not tell us. */
    path: string;
}

export interface ReapOwnAdbDeps {
    listProcesses?: () => Promise<AdbProcessInfo[]>;
    killTree?: (pid: number) => Promise<void>;
    platform?: NodeJS.Platform;
}

/**
 * Parse the listing script's output. Anything that is not `<positive int>TAB…`
 * is dropped -- a PowerShell warning or a stray blank line must not become a
 * pid to kill.
 */
export function parseAdbProcessList(stdout: string): AdbProcessInfo[] {
    const out: AdbProcessInfo[] = [];
    for (const raw of stdout.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const match = /^(\d+)\t(.*)$/.exec(raw);
        if (!match) continue;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        out.push({ pid, path: (match[2] ?? '').trim() });
    }
    return out;
}

function run(file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { ...options, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
            if (err) reject(err);
            else resolve(String(stdout ?? ''));
        });
    });
}

/**
 * The child's environment without `PSModulePath`. Inherited from a pwsh 7
 * parent it points 5.1 at pwsh 7's module tree, and `Get-Process` was measured
 * ~10x slower with it set.
 */
export function envWithoutPsModulePath(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.toLowerCase() === 'psmodulepath') continue;
        env[key] = value;
    }
    return env;
}

export async function defaultListAdbProcesses(): Promise<AdbProcessInfo[]> {
    const encoded = Buffer.from(LIST_ADB_PROCESSES_SCRIPT, 'utf16le').toString('base64');
    const stdout = await run(POWERSHELL_EXE, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: LIST_TIMEOUT_MS,
        env: envWithoutPsModulePath(),
    });
    return parseAdbProcessList(stdout);
}

/** `/T` so anything the daemon itself spawned goes with it. */
export async function defaultKillTree(pid: number): Promise<void> {
    await run(TASKKILL_EXE, ['/F', '/PID', String(pid), '/T'], { timeout: KILL_TIMEOUT_MS });
}

/** Windows paths compare resolved and case-insensitively. */
function sameWindowsPath(a: string, b: string): boolean {
    return path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();
}

/**
 * Kill every process running `adbPath`, each with its tree. Returns how many
 * were killed. Never throws.
 */
export async function reapOwnAdbOnWindows(adbPath: string, deps: ReapOwnAdbDeps = {}): Promise<number> {
    const platform = deps.platform ?? process.platform;
    if (platform !== 'win32') return 0;
    if (!adbPath) {
        log.warn('no adb path configured; nothing to reap');
        return 0;
    }
    const listProcesses = deps.listProcesses ?? defaultListAdbProcesses;
    const killTree = deps.killTree ?? defaultKillTree;

    let processes: AdbProcessInfo[];
    try {
        processes = await listProcesses();
    } catch (err) {
        log.warn(`could not list adb processes; skipping the reap: ${(err as Error).message}`);
        return 0;
    }

    let killed = 0;
    for (const proc of processes) {
        if (!proc.path || !sameWindowsPath(proc.path, adbPath)) continue;
        try {
            await killTree(proc.pid);
            killed += 1;
        } catch (err) {
            // Commonly "not found": kill-server finished it between list and kill.
            log.warn(`could not stop adb pid ${proc.pid} (${proc.path}): ${(err as Error).message}`);
        }
    }
    return killed;
}
