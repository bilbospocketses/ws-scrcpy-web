/**
 * Windows ServiceClient implementation backed by the Servy CLI (v8.2).
 *
 * Servy is a tiny single-binary service manager bundled by
 * `scripts/fetch-servy.mjs`. Servy CLI requires admin to register
 * services with SCM, and Velopack installs ws-scrcpy-web per-user under
 * %LocalAppData% without elevation, so we cannot call servy-cli
 * directly from this Node server process.
 *
 * v0.1.7 elevation strategy:
 *   - install / uninstall / start / stop / restart go through the
 *     `runElevated` helper in elevatedRunner.ts. That helper spawns our
 *     own launcher binary with `--elevate-and-run` argv via
 *     PowerShell's Start-Process -Verb RunAs, which fires the UAC
 *     prompt. The launcher's elevated_runner.rs handler does the
 *     actual servy-cli invocation in the elevated context.
 *   - status() does NOT need admin (read-only SCM query) and is
 *     implemented via `sc.exe query <name>` directly. No UAC prompt
 *     for routine status polling, which is what Settings + the
 *     home-page header poll regularly.
 *
 * v0.1.4 attempted `--account currentUser` and `--binPath`/`--startType`/
 * `--logPath` — none of those are real Servy 8.2 flags; the install
 * wizard hard-failed with "Option 'binPath' is unknown." v0.1.5 used the
 * correct flags. v0.1.6 added --startupDir, --recoveryAction, and the
 * post-install start call. v0.1.7 keeps all of that argv shape (now
 * lives in launcher/src/elevated_runner.rs) and adds elevation.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { Logger } from '../Logger';
import { resolveLauncherPath, runElevated } from './elevatedRunner';
import { fileExists } from '../util/fsExists';
import { resolveSystemTool } from './systemTools';
import type {
    ServiceClient,
    ServiceInstallOptions,
    ServiceStatus,
} from './ServiceClient';

const log = Logger.for('ServyClient');

const execFileAsync = promisify(execFile);

/**
 * Resolve the absolute path of `servy-cli.exe`.
 *
 * Two layouts:
 *   1. Installed (Velopack): `servy-cli.exe` sits next to the launcher in
 *      the install root, which is also `process.cwd()` when the launcher
 *      spawns Node — so `path.join(process.cwd(), 'servy-cli.exe')` works.
 *   2. Dev / from-source: when running out of a `dist/` checkout there's no
 *      Velopack staging, but lead may have hand-staged a publish/ folder.
 *      Fall back to `<repoRoot>/publish/servy-cli.exe`.
 *
 * If neither exists, fall back to the bare name `servy-cli.exe` so the error
 * surface from execFileAsync is "ENOENT: spawn servy-cli.exe" rather than a
 * silent miss — easier to triage.
 */
export async function resolveServyPath(
    cwd: string = process.cwd(),
    moduleDir: string = __dirname,
    exists: (p: string) => Promise<boolean> = fileExists,
): Promise<string> {
    const installedCandidate = path.join(cwd, 'servy-cli.exe');
    if (await exists(installedCandidate)) return installedCandidate;
    // dev / from-source: most reliable is cwd/publish/servy-cli.exe (npm start
    // runs from repo root, fetch-servy.mjs writes there).
    const cwdPublishCandidate = path.join(cwd, 'publish', 'servy-cli.exe');
    if (await exists(cwdPublishCandidate)) return cwdPublishCandidate;
    // Source-layout fallback (only useful when running un-bundled): src/server/service/ -> ../../../publish/
    const sourceCandidate = path.resolve(moduleDir, '..', '..', '..', 'publish', 'servy-cli.exe');
    if (await exists(sourceCandidate)) return sourceCandidate;
    return 'servy-cli.exe';
}

/** Format envVars as Servy --envVars expects: KEY1=VAL1;KEY2=VAL2. */
function formatEnvVars(envVars: Record<string, string>): string {
    return Object.entries(envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
}

/**
 * Parse `sc.exe query <name>` output for the SERVICE_STATE field.
 *
 * Real output looks like:
 *   SERVICE_NAME: WsScrcpyWeb
 *           TYPE               : 10  WIN32_OWN_PROCESS
 *           STATE              : 4  RUNNING
 *           WIN32_EXIT_CODE    : 0  (0x0)
 *           ...
 *
 * SCM state codes (from winsvc.h):
 *   1 = STOPPED, 2 = START_PENDING, 3 = STOP_PENDING, 4 = RUNNING,
 *   5 = CONTINUE_PENDING, 6 = PAUSE_PENDING, 7 = PAUSED.
 *
 * For our 3-state UI we collapse everything that isn't RUNNING to
 * 'stopped'. Pending states are brief and indistinguishable from a
 * useful UX perspective.
 */
export function parseScQueryStatus(output: string): ServiceStatus {
    // Match either the textual STATE name or the numeric code.
    // Pattern: "STATE              : 4  RUNNING"
    const stateLine = output.match(/STATE\s*:\s*(\d+)\s+([A-Z_]+)/i);
    if (!stateLine) return 'stopped';
    const code = Number(stateLine[1]);
    if (code === 4) return 'running'; // SERVICE_RUNNING
    return 'stopped';
}

export class ServyClient implements ServiceClient {
    private readonly servyPathOverride: string | undefined;
    private servyPathPromise: Promise<string> | undefined;

    constructor(servyPath?: string) {
        this.servyPathOverride = servyPath;
    }

    /**
     * Resolve `servy-cli.exe` lazily + memoize. `resolveServyPath` is async
     * (#32 — non-blocking existence checks) so the path can't be resolved in
     * the constructor; install/uninstall await this instead of reading a field.
     */
    private getServyPath(): Promise<string> {
        if (this.servyPathOverride !== undefined) {
            return Promise.resolve(this.servyPathOverride);
        }
        if (!this.servyPathPromise) {
            this.servyPathPromise = resolveServyPath();
        }
        return this.servyPathPromise;
    }

    public async install(opts: ServiceInstallOptions): Promise<void> {
        // v0.1.7: install routes through the elevate-and-run helper.
        // The helper handles all argv translation + post-install start
        // + tray Run-key registration + tray spawn in the elevated
        // process. We just hand it the abstract operation params.
        if (!(await fileExists(resolveLauncherPath()))) {
            throw new Error(
                `service install requires the packaged launcher binary at ${resolveLauncherPath()}, ` +
                    `which is not present (likely a dev/from-source run)`,
            );
        }
        const trayHelperPath = await this.tryResolveTrayHelperPath();
        const result = await runElevated('install-service', {
            servyPath: await this.getServyPath(),
            name: opts.name,
            displayName: opts.displayName,
            description: opts.description,
            binPath: opts.binPath,
            startupDir: opts.startupDir,
            startupType: opts.startType,
            maxRestartAttempts: opts.maxRestartAttempts,
            envVars: formatEnvVars(opts.envVars),
            logPath: opts.logPath,
            trayHelperPath,
            // §32 Part 4: elevated installer writes <dataRoot>/post-stop/post-stop.bat
            // and registers it as Servy's --postStopPath via cmd.exe.
            dataRoot: opts.dataRoot,
        });
        if (!result.ok) {
            throw new ServiceInstallError(
                result.errorMessage ?? 'service install failed',
                result,
            );
        }
        if (result.stderr) {
            log.warn(`service install completed with warnings: ${result.stderr.trim()}`);
        }
    }

    public async uninstall(name: string): Promise<void> {
        // v0.1.7: uninstall routes through the elevate-and-run helper too.
        // The helper stops the service first, then uninstalls, then
        // cleans up the tray Run-key, all in the elevated process.
        if (!(await fileExists(resolveLauncherPath()))) {
            throw new Error(
                `service uninstall requires the packaged launcher binary at ${resolveLauncherPath()}, ` +
                    `which is not present (likely a dev/from-source run)`,
            );
        }
        const result = await runElevated('uninstall-service', {
            servyPath: await this.getServyPath(),
            name,
        });
        if (!result.ok) {
            throw new ServiceInstallError(
                result.errorMessage ?? 'service uninstall failed',
                result,
            );
        }
    }

    /**
     * Read-only SCM query — does NOT need admin elevation. We use
     * `sc.exe query <name>` rather than `servy-cli status` because:
     *   1. sc.exe is a Windows built-in, available unelevated.
     *   2. servy-cli's status subcommand also requires admin; using
     *      it would mean a UAC prompt every time the home page or
     *      Settings panel polls service status, which would be
     *      maddening.
     *   3. SCM is the source of truth for SCM state — going through
     *      Servy is one indirection too many for a read-only check.
     */
    public async status(name: string): Promise<ServiceStatus> {
        try {
            const { stdout } = await execFileAsync(resolveSystemTool('sc'), ['query', name], {
                encoding: 'utf8',
                timeout: 5_000,
            });
            return parseScQueryStatus(stdout);
        } catch (err) {
            // sc.exe returns exit 1060 (ERROR_SERVICE_DOES_NOT_EXIST)
            // when the named service isn't registered. Surfaced via
            // execFileSync's thrown Error with `code` numeric. Map that
            // to 'not-installed'; rethrow other errors so genuine
            // failures (sc.exe missing, etc.) surface to the API layer.
            const e = err as Error & {
                stderr?: Buffer | string;
                stdout?: Buffer | string;
                code?: number | string;
                status?: number | null;
            };
            const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
            const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
            // sc.exe returns 1060 ERROR_SERVICE_DOES_NOT_EXIST. execFileSync
            // surfaces this as `error.status` (numeric) on the thrown error.
            const exitCode = typeof e.status === 'number' ? e.status : (typeof e.code === 'number' ? e.code : null);
            if (
                exitCode === 1060 ||
                /service.*does not exist/i.test(stderr) ||
                /service.*does not exist/i.test(stdout)
            ) {
                return 'not-installed';
            }
            throw new Error(`sc.exe query ${name} failed: ${stderr || e.message}`);
        }
    }

    public async restart(_name: string): Promise<void> {
        // restart = stop + start, but Servy's `restart` is one round-trip.
        // Routes through elevation since it touches SCM control.
        if (!(await fileExists(resolveLauncherPath()))) {
            throw new Error(
                `service restart requires the packaged launcher binary at ${resolveLauncherPath()}`,
            );
        }
        // We don't have a dedicated `restart-service` command in the
        // elevate-and-run helper today; the welcome-modal + Settings UI
        // doesn't expose restart as a primitive (port-change uses the
        // .restart marker / exit-75 path through the Node side, not
        // SCM-restart). If/when we add that UI, we'll add the helper
        // command. For now, fail loudly so it's not silently broken.
        throw new Error(
            'restart is not yet wired through the elevation helper in v0.1.7. ' +
                'Use stop + start, or restart from services.msc.',
        );
    }

    public async stop(_name: string): Promise<void> {
        // Stop is part of uninstall, but a standalone stop also requires
        // SCM control. Same pattern as restart — not yet exposed because
        // no UI calls it today (UninstallService stops as part of its
        // flow). Fail loudly rather than silently break.
        throw new Error(
            'standalone stop is not yet wired through the elevation helper in v0.1.7. ' +
                'Use uninstall, or stop from services.msc.',
        );
    }

    /**
     * Find the tray helper exe if present, returning `undefined` when
     * absent. The elevated helper handles tray Run-key registration
     * itself; we just hand it the path (or null) so it can no-op when
     * the helper isn't installed.
     */
    private async tryResolveTrayHelperPath(): Promise<string | undefined> {
        const installedCandidate = path.join(process.cwd(), 'ws-scrcpy-web-tray.exe');
        if (await fileExists(installedCandidate)) return installedCandidate;
        const cwdPublishCandidate = path.join(process.cwd(), 'publish', 'ws-scrcpy-web-tray.exe');
        if (await fileExists(cwdPublishCandidate)) return cwdPublishCandidate;
        return undefined;
    }
}

/**
 * Error thrown by ServyClient install/uninstall when the elevated helper
 * returns ok=false. Carries the structured result so callers can render
 * UAC-denied vs servy-failure differently in the UI.
 */
export class ServiceInstallError extends Error {
    constructor(
        message: string,
        public readonly result: import('./elevatedRunner').ElevatedResult,
    ) {
        super(message);
        this.name = 'ServiceInstallError';
    }

    /**
     * Heuristic: did the user decline the UAC prompt? Distinguishable
     * from servy-failures because the elevated helper never wrote a
     * result file in that case, so the runner synthesizes a result with
     * `errorMessage` matching this pattern.
     */
    public isUacDeclined(): boolean {
        return /declined elevation/i.test(this.result.errorMessage ?? '');
    }
}
