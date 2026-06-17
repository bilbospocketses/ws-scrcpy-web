// Node-side counterpart to launcher/src/elevated_runner.rs.
//
// When the user clicks "yes install service" in the welcome modal, the
// Node server can't call servy-cli directly because Servy needs admin
// and Velopack installs us per-user without elevation. Instead we
// re-launch our own launcher binary with `--elevate-and-run` argv,
// using PowerShell's `Start-Process -Verb RunAs -Wait` to fire the UAC
// prompt and block until the elevated child exits. The Rust launcher's
// elevate-and-run handler does the actual servy-cli + reg.exe + tray-
// spawn work, then writes a structured result JSON we read back here.
//
// Why this design instead of an embedded UAC manifest on the launcher:
//   - Manifest-elevation prompts UAC EVERY launch, even for users who
//     never enable service mode. This approach only prompts when service
//     mode is actually being installed/uninstalled.
//   - Keeps Velopack's per-user install model intact. No need to switch
//     to ProgramFiles + machine-wide install.
//   - The "what flags to pass servy-cli" knowledge lives in Rust (in
//     elevated_runner.rs) — Node only knows the abstract operation
//     (install / uninstall) and the params. Single source of truth for
//     servy-cli argv shape per the v0.1.5 + v0.1.6 fixes.
//
// Failure modes the caller needs to handle:
//   - User clicks "No" / "Cancel" on the UAC prompt → PowerShell exits
//     non-zero, no result file gets written. We surface this as
//     `{ ok: false, errorMessage: 'user declined elevation' }`.
//   - Launcher crashes mid-execution → result file may be missing or
//     partial. We surface as `{ ok: false, errorMessage: '...' }`.
//   - servy-cli succeeds but post-actions fail → result.ok is true,
//     errorMessage is null, but combined stderr may have warnings.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../Logger';
import { tempDir } from '../util/disposable';
import { fileExists } from '../util/fsExists';

const execFileAsync = promisify(execFile);

const log = Logger.for('ElevatedRunner');

/**
 * Result shape mirrors `ElevatedResult` in launcher/src/elevated_runner.rs.
 * Field names use camelCase here (idiomatic TS) and snake_case in Rust;
 * the Rust side serializes with `#[serde(rename_all = "camelCase")]` —
 * wait, it doesn't. Rust serializes as snake_case by default. Update if
 * the Rust struct adds rename_all later. For now we read both keys.
 */
export interface ElevatedResult {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    errorMessage?: string | undefined;
    /** Per-call nonce echoed by the elevated helper; verified by pollForResultFile (#28). */
    nonce?: string | undefined;
}

/**
 * Args shape for `install-service`. Mirrors `InstallServiceArgs` in
 * launcher/src/elevated_runner.rs (snake_case on the wire because that's
 * Rust's default serde format). Caller passes camelCase; we translate.
 */
export interface InstallServiceArgs {
    servyPath: string;
    name: string;
    displayName: string;
    description: string;
    binPath: string;
    startupDir: string;
    startupType: string;
    maxRestartAttempts: number;
    /** Pre-formatted as `KEY=VAL;KEY2=VAL2` per Servy's --envVars syntax. */
    envVars: string;
    logPath: string;
    /** Optional tray helper exe; null/undefined when not present. */
    trayHelperPath?: string;
    /**
     * Writable data root for the install (e.g., C:\ProgramData\WsScrcpyWeb).
     * The elevated installer uses this to write the post-stop bat file at
     * `<dataRoot>/post-stop/post-stop.bat` (§32 Part 4 architecture —
     * post-stop runs from a Velopack-untouchable location via cmd.exe).
     * Omitting this skips post-stop wiring; Servy then has no post-stop
     * hook and the synchronous --veloapp-updated bridge handles recovery
     * (the legacy path, less reliable).
     */
    dataRoot?: string | undefined;
}

export interface UninstallServiceArgs {
    servyPath: string;
    name: string;
}

/**
 * Args for the `spawn-user-launcher` command (v0.1.8 uninstall Path A).
 *
 * Used ONLY when the caller is running as Local System (the
 * service-instance Node process). The Rust handler does the WTS-API
 * dance (WTSGetActiveConsoleSessionId + WTSQueryUserToken +
 * CreateProcessAsUserW) to spawn the launcher in the active user's
 * interactive session. The new launcher is unprivileged user-session
 * — same as a normal user-side launch.
 */
export interface SpawnUserLauncherArgs {
    launcherPath: string;
    /**
     * Argv passed to the spawned user-session launcher. v0.1.23 §1c bug
     * 1.c uses `['--local-takeover']` so the new launcher overrides its
     * is_service_mode decision (config.json still says service mode at
     * spawn time; the resume-uninstall flow flips it after) and spawns
     * the local tray.
     */
    launcherArgs?: string[];
}

/**
 * Resolve the absolute path of the launcher binary that should be
 * elevated. In a Velopack install this is `<install>/ws-scrcpy-web-launcher.exe`.
 * In dev runs we don't have a packaged launcher; callers should check
 * with `launcherIsAvailable()` first before invoking `runElevated`.
 */
export function resolveLauncherPath(): string {
    const exeName = process.platform === 'win32' ? 'ws-scrcpy-web-launcher.exe' : 'ws-scrcpy-web-launcher';
    return path.join(process.cwd(), exeName);
}

export async function launcherIsAvailable(): Promise<boolean> {
    return fileExists(resolveLauncherPath());
}

/**
 * Run an elevate-and-run command via the launcher binary. Returns the
 * structured result the launcher emits; throws only for harness-level
 * failures (PowerShell missing, temp dir not writable, etc.). Operation
 * failures are encoded as `{ ok: false, errorMessage: ... }` in the
 * returned result so callers can render UAC-denied vs servy-failure
 * differently.
 */
export async function runElevated(
    command: 'install-service' | 'uninstall-service' | 'spawn-user-launcher',
    args: InstallServiceArgs | UninstallServiceArgs | SpawnUserLauncherArgs,
): Promise<ElevatedResult> {
    if (process.platform !== 'win32') {
        throw new Error('runElevated is Windows-only');
    }
    const launcherPath = resolveLauncherPath();
    if (!(await fileExists(launcherPath))) {
        throw new Error(
            `runElevated requires the packaged launcher at ${launcherPath}, ` +
                'which is not present (likely a dev/from-source run rather than a Velopack install)',
        );
    }

    // Convert camelCase JS field names to snake_case for the Rust side.
    const wireArgs = toSnakeCase(args as unknown as Record<string, unknown>);

    using td = tempDir('ws-scrcpy-elev-');
    const argsPath = path.join(td.path, 'args.json');
    const resultPath = path.join(td.path, 'result.json');
    // Per-call nonce: embedded in args.json (the elevated helper echoes it into
    // result.json) so pollForResultFile can reject a spoofed/stale result. (#28)
    const nonce = randomBytes(16).toString('hex');

    // The `spawn-user-launcher` command is only invoked from the
    // SERVICE-instance Node process, which is already running as Local
    // System and so doesn't need UAC. PowerShell Start-Process
    // -Verb RunAs from Local System is also problematic — there's no
    // interactive desktop to show a UAC dialog on. Skip the PS wrapper
    // entirely for this command and direct-spawn the launcher.
    const useDirect = command === 'spawn-user-launcher';

    await fs.promises.writeFile(argsPath, JSON.stringify({ ...wireArgs, nonce }, null, 2), 'utf8');

    // v0.1.8: switched from `Start-Process -Wait -PassThru` to a
    // result-file polling pattern. The previous design hung in
    // production: PowerShell's -Wait is unreliable for
    // -Verb RunAs because the elevated process runs in a different
    // logon session and -Wait can't always track cross-session
    // children.
    log.info(`runElevated(${command}) launching ${launcherPath} (direct=${useDirect}, file-poll)`);

    if (useDirect) {
        // Direct spawn — caller is already privileged (Local
        // System service-instance invoking spawn-user-launcher).
        // No UAC needed. We don't await the child; we just kick
        // it off and rely on the result-file polling for sync.
        try {
            const child = spawn(launcherPath, ['--elevate-and-run', command, argsPath, resultPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
        } catch (err) {
            return {
                ok: false,
                exitCode: -1,
                stdout: '',
                stderr: (err as Error).message ?? '',
                errorMessage: `direct elevated spawn failed: ${(err as Error).message ?? ''}`,
            };
        }
    } else {
        // §30 — Standard elevation path: spawn this launcher binary with
        // `--request-uac`, which calls ShellExecuteExW(verb="runas") on
        // itself to fire the UAC prompt + re-spawn elevated with
        // `--elevate-and-run`. Replaces the prior
        // `powershell.exe Start-Process -Verb RunAs` path that resolved
        // PowerShell via system PATH (local-dependencies-only violation).
        // The launcher binary is SHA-pinned-to-release
        // and lives in `current/` alongside this Node process, so no
        // external binary discovery is needed.
        //
        // Exit-code contract from `--request-uac`:
        //   0    = UAC accepted; elevated launcher is being spawned.
        //   1223 = UAC declined by the user (Windows ERROR_CANCELLED).
        //   other = unexpected ShellExecuteExW failure.
        let uacFailed = false;
        let uacErrorMessage = '';
        try {
            await execFileAsync(launcherPath, ['--request-uac', command, argsPath, resultPath], {
                windowsHide: true,
                maxBuffer: 1024 * 1024,
            });
        } catch (err) {
            uacFailed = true;
            uacErrorMessage = (err as Error).message ?? '(no message)';
            log.warn(`runElevated request-uac failed: ${uacErrorMessage}`);
        }

        if (uacFailed) {
            return {
                ok: false,
                exitCode: -1,
                stdout: '',
                stderr: uacErrorMessage,
                errorMessage:
                    'user declined elevation. Service install requires Administrator privileges; ' +
                    'click Yes on the UAC prompt to continue.',
            };
        }
    }

    const result = await pollForResultFile(resultPath, ELEVATION_TIMEOUT_MS, undefined, undefined, nonce);
    if (result === null) {
        return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: '',
            errorMessage:
                `elevated helper did not complete within ${ELEVATION_TIMEOUT_MS / 1000}s. ` +
                'The UAC prompt may have been dismissed without action, or the helper may have crashed.',
        };
    }
    // `using td = tempDir(...)` above disposes the temp dir on scope exit
    // (return or throw) — replaces the prior try/finally + fs.rmSync pair.
    return result;
}

/** 5 minutes — UAC dialog can legitimately stay up this long. */
const ELEVATION_TIMEOUT_MS = 5 * 60 * 1000;
/** Polling cadence for the result file. 200ms is fast enough that the
 *  user-perceived latency between the elevated helper finishing and our
 *  resolve is < 200ms, while not hammering the filesystem. */
const POLL_INTERVAL_MS = 200;

/**
 * Poll for the elevated helper's result file. Returns the parsed result
 * once the file appears, or `null` after the timeout. We tolerate the
 * file briefly being written-but-not-yet-flushed: parseResult handles
 * malformed JSON by returning a structured error, but we wait for at
 * least one consecutive successful parse before returning to avoid
 * racing the helper's write.
 */
export async function pollForResultFile(
    resultPath: string,
    timeoutMs: number,
    intervalMs: number = POLL_INTERVAL_MS,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    expectedNonce?: string,
): Promise<ElevatedResult | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fileExists(resultPath)) {
            // File exists. Try to read+parse. If the helper is still
            // mid-write, parse may produce a malformed-JSON error; if
            // so, wait one more tick and try again. Once the file is
            // fully written and reads cleanly, return the parsed
            // result.
            try {
                const raw = await fs.promises.readFile(resultPath, 'utf8');
                const parsed = parseResult(raw);
                // Heuristic: if parseResult returned a "could not
                // parse" error AND the file is < 1KB, it's probably
                // mid-write. Wait a tick and re-read. If it's > 1KB
                // and still malformed, the helper produced bad JSON —
                // surface that.
                if (parsed.ok === false && /could not parse/i.test(parsed.errorMessage ?? '') && raw.length < 1024) {
                    await sleep(intervalMs);
                    continue;
                }
                // #28: reject a result whose nonce doesn't match this call — a
                // spoofed or stale file. Keep polling so the real helper's write
                // (which carries the correct nonce) is still picked up.
                if (expectedNonce !== undefined && parsed.nonce !== expectedNonce) {
                    log.warn(
                        `pollForResultFile: result nonce mismatch (expected ${expectedNonce}, got ${parsed.nonce ?? 'none'}); ignoring`,
                    );
                    await sleep(intervalMs);
                    continue;
                }
                return parsed;
            } catch {
                // File disappeared between the access check and readFile,
                // or some other I/O error. Treat as still-in-progress.
            }
        }
        await sleep(intervalMs);
    }
    return null;
}

/**
 * Recursively rename camelCase keys to snake_case on a plain JSON-shaped
 * object. Doesn't try to be clever about edge cases — values that are
 * arrays or nested objects are passed through untouched (we don't have
 * any in the current schema).
 */
export function toSnakeCase(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
        const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        out[snake] = v;
    }
    return out;
}

/**
 * Parse the launcher's result JSON. Tolerates both snake_case (Rust default)
 * and camelCase keys so we don't break if either side changes serialization
 * settings later.
 */
export function parseResult(raw: string): ElevatedResult {
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const get = (snake: string, camel: string): unknown => (obj[snake] !== undefined ? obj[snake] : obj[camel]);
        return {
            ok: Boolean(get('ok', 'ok')),
            exitCode: Number(get('exit_code', 'exitCode') ?? 0),
            stdout: String(get('stdout', 'stdout') ?? ''),
            stderr: String(get('stderr', 'stderr') ?? ''),
            errorMessage: (get('error_message', 'errorMessage') as string | null | undefined) ?? undefined,
            nonce: (get('nonce', 'nonce') as string | null | undefined) ?? undefined,
        };
    } catch (err) {
        return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: raw,
            errorMessage: `could not parse elevated runner result: ${(err as Error).message}`,
        };
    }
}

// §30: removed `buildPsRunAsCommand` + `PsRunAsParams` (was the PowerShell
// Start-Process -Verb RunAs command-builder). The PS-spawn path was replaced
// by the launcher's own `--request-uac` subcommand (see `launcher/src/uac_requester.rs`),
// which calls `ShellExecuteExW(verb="runas")` directly. The launcher is
// SHA-pinned to release and lives in `current/` alongside this Node process —
// no system-PATH binary discovery, no PowerShell layer, no Local-Dependencies-Only
// rule violation. Argv is passed via execFileAsync's array form (no shell escaping).
