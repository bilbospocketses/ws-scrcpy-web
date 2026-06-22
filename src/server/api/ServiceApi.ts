import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'child_process';
import type { IncomingMessage, ServerResponse } from 'http';
import type { InstallMode } from '../../common/ConfigEvents';
import {
    type AppUninstallRequest,
    type ServiceActionFailure,
    type ServiceActionSuccess,
    type ServiceInstallRequest,
    type ServiceStatusResponse,
    WS_SCRCPY_SERVICE_DESCRIPTION,
    WS_SCRCPY_SERVICE_DISPLAY_NAME,
    WS_SCRCPY_SERVICE_NAME,
} from '../../common/ServiceEvents';
import { getAppVersion } from '../appVersion';
import { Config } from '../Config';
import { detectInstallScope } from '../InstallScope';
import { Logger } from '../Logger';
import { getServiceClient, type ServiceClientFactoryResult } from '../service';
import { consumeToken } from '../service/resumeToken';
import { ServiceInstallError } from '../service/ServyClient';
import {
    buildMachineWideInstallScript,
    buildServiceUnitEnv,
    DECLINE_MARKER_NAME,
    runPkexec,
    STAGED_SYSTEM_APPIMAGE,
    STAGED_SYSTEM_DIR,
    SYSTEM_STATE_DIR,
} from '../service/SystemdClient';
import type { CommandRunner } from '../service/systemServiceCli';
import { resolveSystemTool } from '../service/systemTools';
import { requireAdmin } from '../auth/requireAdmin';
import { readJsonBody } from './utils';

const log = Logger.for('ServiceApi');

/**
 * Build the `systemd-run` arg vector that spawns the detached Rust app-uninstall
 * helper (`--linux-app-uninstall`). Pure so the spawn shape is unit-testable
 * without mocking process/systemd.
 *
 * Transient-unit scope mirrors the service-teardown handoff: as root we target
 * the SYSTEM manager (`--collect`, no `--user`); unprivileged we target the
 * per-user manager (`--user --collect`). The helper then self-elevates as needed
 * (root → direct; non-root → pkexec; declined → relaunch local), so the spawn
 * itself stays unelevated regardless.
 *
 * The helper flags forwarded:
 *   --scope <user|system|none>  installed service scope to tear down (none = no service)
 *   --machine-wide <0|1>        whether the shared /opt machine-wide AppImage exists
 *   --keep | --wipe             preserve config.json + logs/ vs. remove all state
 *   --data-root <abs>           writable-state root to wipe/preserve
 *   --relaunch <abs>            home AppImage to re-launch in local mode ('' = none)
 */
export function buildUninstallHelperArgs(o: {
    isRoot: boolean;
    unit: string;
    helper: string;
    scope: 'user' | 'system' | 'none';
    machineWide: boolean;
    keep: boolean;
    dataRoot: string;
    relaunch: string;
}): string[] {
    // root → system transient unit (`--collect`); non-root → user manager (`--user --collect`).
    const prefix = o.isRoot ? ['--collect'] : ['--user', '--collect'];
    return [
        ...prefix,
        o.unit,
        o.helper,
        '--linux-app-uninstall',
        '--scope',
        o.scope,
        '--machine-wide',
        o.machineWide ? '1' : '0',
        o.keep ? '--keep' : '--wipe',
        '--data-root',
        o.dataRoot,
        '--relaunch',
        o.relaunch,
    ];
}

/**
 * F3: poll the service's is-active state until it reports `running`, up to ~15s
 * (the old blind-exit cap). Returns true as soon as it's up; false if it never
 * becomes active. `install()` does NOT throw on a failed start (systemd
 * `Type=simple` reports "started" on fork, before `execve` fails), so this poll
 * is the only signal that the service actually came up before the install-flow
 * sacrifices the local instance.
 */
async function defaultVerifyServiceActive(
    client: ServiceClientFactoryResult['client'],
    name: string,
): Promise<boolean> {
    const ATTEMPTS = 30;
    const INTERVAL_MS = 500;
    for (let i = 0; i < ATTEMPTS; i++) {
        if ((await client.status(name)) === 'running') return true;
        await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
    return (await client.status(name)) === 'running';
}

/**
 * Default elevated runner: runs argv[0] with the rest as args via execFile,
 * AWAITED, with NO timeout option (no kill = no EPERM class).
 * Resolves with the exit code regardless of success/failure — never throws.
 */
export const defaultRunElevated: CommandRunner = (argv) =>
    new Promise((resolve) => {
        const [cmd, ...rest] = argv;
        // The elevated runner refuses anything but an absolute, existing argv[0]:
        // execFile would otherwise resolve a bare/relative command via $PATH / cwd,
        // a binary-hijack surface in this privileged context (#26). Also covers
        // resolveSystemTool's bare-name fallback — a non-absolute pkexec is rejected
        // here rather than PATH-resolved.
        if (!cmd || !path.isAbsolute(cmd) || !fs.existsSync(cmd)) {
            resolve({
                code: 127,
                stdout: '',
                stderr: `refusing to run elevated: argv[0] is not an absolute, existing path: ${JSON.stringify(cmd)}`,
            });
            return;
        }
        execFile(cmd, rest, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { code?: number; status?: number }) | null;
            const code = e ? (typeof e.code === 'number' ? e.code : (e.status ?? 1)) : 0;
            resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
        });
    });

/**
 * HTTP API for SP3 P3 service-mode operations.
 *
 *   GET  /api/service/status     -> ServiceStatusResponse (always 200)
 *   POST /api/service/install    -> ServiceActionSuccess | 501/500 ServiceActionFailure
 *   POST /api/service/uninstall  -> ServiceActionSuccess | 501/500 ServiceActionFailure
 *
 * All non-error responses use HTTP 200; "service mode unsupported on this
 * platform" is communicated through the body's `supported`/`ok` flag, not the
 * status code, because it's a normal first-class state for non-Windows hosts.
 *
 * `ServiceApi` is wired as an `addApiHandler` consumer in src/server/index.ts
 * alongside the P2 ConfigApi.
 */
export class ServiceApi {
    /**
     * Optional override of the factory and install-scope detector — wired in
     * for unit tests so we don't need to vi.mock the entire service module.
     * Production callers omit both args and the API uses the real factory +
     * `detectInstallScope()`.
     */
    constructor(
        private readonly factory: () => ServiceClientFactoryResult = () => getServiceClient(),
        private readonly scope: () => 'user' | 'system' = () => detectInstallScope(),
        private readonly existsCheck: (p: string) => boolean = (p: string) => fs.existsSync(p),
        private readonly spawnDetached: (cmd: string, args: string[]) => void = (cmd, args) => {
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
            child.on('error', (err) => log.warn(`spawnDetached ${cmd} error: ${err.message}`));
            child.unref();
        },
        private scheduleExit: (fn: () => void, ms: number) => void = (fn, ms) => {
            setTimeout(fn, ms).unref();
        },
        private readonly runPkexecFn: (shellCmd: string, label: string) => Promise<string> = runPkexec,
        // F3: injectable so tests can force the verify outcome without a real
        // 15s poll. Default polls is-active; tests pass async () => true|false.
        private readonly verifyServiceActive: (
            client: ServiceClientFactoryResult['client'],
            name: string,
        ) => Promise<boolean> = defaultVerifyServiceActive,
        // Linux SYSTEM scope install: awaited pkexec elevation (no timeout/kill).
        // Injectable so tests can assert argv without spawning a real pkexec.
        private readonly runElevated: CommandRunner = defaultRunElevated,
    ) {}

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/service/')) return false;

        res.setHeader('Content-Type', 'application/json');

        if (!requireAdmin(req, res)) return true;

        try {
            if (req.method === 'GET' && url === '/api/service/status') {
                return await this.handleStatus(res);
            }
            if (req.method === 'POST' && url === '/api/service/install') {
                return await this.handleInstall(req, res);
            }
            if (req.method === 'POST' && url === '/api/service/uninstall') {
                return await this.handleUninstall(req, res);
            }
            if (req.method === 'POST' && url === '/api/service/install-system-wide') {
                return await this.handleInstallSystemWide(res);
            }
            if (req.method === 'POST' && url === '/api/service/decline-system-wide') {
                return await this.handleDeclineSystemWide(res);
            }
            if (req.method === 'POST' && url === '/api/service/uninstall-app') {
                return await this.handleAppUninstall(req, res);
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error)?.message ?? String(err)}`);
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'unknown' };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }
    }

    /**
     * Read config.json from disk and return the current webPort + file mtime.
     * Returns null fields on any read/parse/stat failure (caller treats as "not ready").
     */
    private readDiskConfig(): { diskWebPort: number | null; configMtime: number | null } {
        try {
            const cfgPath = Config.getInstance().getConfigFilePath();
            const stat = fs.statSync(cfgPath);
            const raw = fs.readFileSync(cfgPath, 'utf-8');
            const parsed = JSON.parse(raw) as { webPort?: unknown };
            const port = typeof parsed.webPort === 'number' ? parsed.webPort : null;
            return { diskWebPort: port, configMtime: stat.mtimeMs };
        } catch {
            return { diskWebPort: null, configMtime: null };
        }
    }

    private async handleStatus(res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceStatusResponse = {
                supported: false,
                platform: result.platform,
                unsupportedReason: result.unsupportedReason,
            };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }
        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const disk = this.readDiskConfig();
        const installMode = Config.getInstance().getAppConfig().installMode;
        // Authoritative installed scope from the filesystem (which systemd unit
        // exists), independent of the mutable installMode. Only SystemdClient
        // implements getInstalledScope; Windows omits it (scope auto-detected
        // from execPath there, and the scope radios are Linux-only in the UI).
        const scope = result.client.getInstalledScope
            ? await result.client.getInstalledScope(WS_SCRCPY_SERVICE_NAME)
            : undefined;
        // Linux-only machine-wide-install signals the frontend reads off status:
        //   - machineWideInstalled gates the system-scope service-install button
        //     (the root service execs the shared /opt binary, which must exist).
        //   - systemInstallDeclined suppresses the first-run "install for all
        //     users" modal once the user has declined it (persistent marker).
        // Both go through the injected existsCheck so the API stays unit-testable.
        // Spread conditionally (like scope/diskWebPort) so they're Linux-only.
        let machineWide: {
            machineWideInstalled: boolean;
            systemInstallDeclined: boolean;
            optUpdateAvailable: boolean;
        } | null = null;
        if (result.platform === 'linux') {
            const cfg = Config.getInstance();
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            machineWide = {
                machineWideInstalled: this.existsCheck(`${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`),
                systemInstallDeclined: this.existsCheck(path.join(dataRoot, 'control', DECLINE_MARKER_NAME)),
                optUpdateAvailable: process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'] === '1',
            };
        }
        const body: ServiceStatusResponse = {
            supported: true,
            platform: result.platform,
            status,
            installMode,
            // True only inside the installed service process (its unit sets
            // WS_SCRCPY_SERVICE=1); the transient local instance that triggers the
            // install never has it. The post-install poll keys hand-off completion
            // off this positive signal (no mtime-change / dead-window race).
            servedByService: process.env['WS_SCRCPY_SERVICE'] === '1',
            ...(scope !== undefined ? { scope } : {}),
            ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
            ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
            ...(machineWide ?? {}),
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
                reason: 'unsupported',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        const cfg = Config.getInstance();

        // Scope resolution differs by platform:
        //   - Windows: ignore the request body, use the injected scope detector
        //     (auto-detects from execPath via detectInstallScope()).
        //   - Linux:   read `scope` from the request body, default to 'user'
        //     when absent. System-scope install from a non-root process is
        //     elevated inside SystemdClient.install() via pkexec (PR #211);
        //     the API stays unelevated and just forwards the requested scope.
        //     A pre-#211 API-boundary 403 guard short-circuited the pkexec
        //     path and was removed — the user saw "Relaunch the AppImage with
        //     sudo" instead of a password prompt.
        let scope: 'user' | 'system';
        if (result.platform === 'linux') {
            const body = await readJsonBody(req);
            const requested = (body as ServiceInstallRequest).scope;
            scope = requested === 'system' ? 'system' : 'user';
        } else {
            scope = this.scope();
        }

        // Windows ServyClient ignores scope and always installs as Local System
        // (no `--user` flag). Linux SystemdClient consumes scope to decide
        // user-systemd vs system-systemd unit placement.
        const newInstallMode: InstallMode = scope === 'user' ? 'user-service' : 'system-service';

        // v0.1.7: the v0.1.6 admin-elevation guard at this boundary is
        // gone. ServyClient's install() now invokes a separate elevated
        // helper process (via PowerShell Start-Process -Verb RunAs); the
        // UAC prompt happens at that elevation step, not here. This API
        // remains unelevated.
        //
        // Resolve the service binary. On Windows we point Servy at the
        // packaged launcher, NOT process.execPath. process.execPath is the
        // currently-running Node binary, which (a) in dev resolves to
        // whatever Node is on PATH (same architectural failure as the
        // v0.1.4 bare-'adb' bug), and (b) even when bundled, Servy would
        // launch Node with no script argument and Node would idle in REPL
        // mode. The launcher is a local-deps binary in the install root,
        // takes no args, and already knows how to supervise Node +
        // dist/index.js — exactly what we want SCM to invoke.
        //
        // startupDir pins the SCM-launched child's CWD to the install
        // root so the launcher's relative seed/, dependencies/, dist/
        // resolution works. Without it, Servy falls back to the dir of
        // the executable and the launcher's path resolution silently
        // breaks (root of the v0.1.5 "service runs but app unreachable"
        // bug — Servy log showed "Working directory fallback applied:
        // C:\nvm4w\nodejs").
        let binPath: string;
        let startupDir: string;
        if (result.platform === 'win32') {
            const installRoot = process.cwd();
            const launcherExe = path.join(installRoot, 'ws-scrcpy-web-launcher.exe');
            if (!this.existsCheck(launcherExe)) {
                const failure: ServiceActionFailure = {
                    ok: false,
                    error:
                        `service mode requires the packaged launcher binary at ${launcherExe}, ` +
                        'which is not present (likely a dev/from-source run rather than a Velopack install). ' +
                        'Install ws-scrcpy-web via the MSI and retry.',
                    reason: 'unknown',
                };
                res.writeHead(500);
                res.end(JSON.stringify(failure));
                return true;
            }
            binPath = launcherExe;
            startupDir = installRoot;
        } else {
            // Linux: the systemd unit must point at a STABLE entry that
            // launches the WHOLE app. The server runs as a Node CHILD of the
            // launcher (launcher/src/spawn.rs spawns `node dist/index.js`), so
            // process.execPath here is the Node binary — using it as ExecStart
            // would start Node with no script (REPL; under systemd's /dev/null
            // stdin it reads EOF and exits immediately), the exact failure the
            // win32 branch above warns about. The service would never bind or
            // auto-shift a web port, the install-flow redirect poll would never
            // see a config change, and status would read "stopped".
            //
            // For an AppImage the stable entry is the .AppImage file itself,
            // exposed by the runtime as $APPIMAGE (the same env UpdateService
            // keys production-mode detection off). Running it re-mounts and runs
            // the launcher, which spawns the server and binds the web port,
            // auto-shifting +1 on collision (PortPicker / reconcileWebPort) and
            // persisting the new port to config.json — which is what the
            // frontend's post-install poll watches. Fall back to
            // process.execPath for non-AppImage / from-source runs where
            // $APPIMAGE is unset.
            const appImagePath = process.env['APPIMAGE'];
            binPath = appImagePath && appImagePath.length > 0 ? appImagePath : process.execPath;
            startupDir = path.dirname(binPath);
        }

        // Record the home AppImage path so a later USER-scope uninstall can
        // relaunch the app in local mode. System scope runs the /opt copy and
        // won't know the user's home AppImage otherwise. Best-effort: a failed
        // marker write logs + continues (it only degrades the post-uninstall
        // relaunch, not the install).
        if (result.platform === 'linux') {
            const appImage = process.env['APPIMAGE'];
            if (appImage && appImage.length > 0) {
                const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
                const markerPath = path.join(dataRoot, 'control', 'local-appimage');
                try {
                    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
                    fs.writeFileSync(markerPath, appImage, 'utf8');
                } catch (err) {
                    log.warn(`could not write local-appimage marker: ${(err as Error).message}`);
                }
            }
        }

        // v0.1.24-beta.7: service.log moves under <dataRoot>/logs/ to
        // colocate with launcher.log + server.log + ws-scrcpy-web.log.
        // Pre-beta.7 it lived at <dataRoot>/dependencies/service.log,
        // which was unintuitive (Servy's stdio capture isn't a
        // dependency artifact). dataRoot derives from dependenciesPath
        // since the launcher always sets DEPS_PATH=<dataRoot>/dependencies/.
        const logsDir = path.join(path.dirname(cfg.dependenciesPath), 'logs');
        try {
            fs.mkdirSync(logsDir, { recursive: true });
        } catch {
            // Servy will fail with a clearer error than we can synthesize
            // if the directory truly can't be created.
        }
        const logPath = path.join(logsDir, 'service.log');
        // Scope-aware unit env (#36): linux system-scope points DATA_ROOT +
        // DEPS_PATH at the app's own /opt tree (not the installing user's home,
        // and not the /tmp the root service would otherwise fall back to).
        const envVars = buildServiceUnitEnv(result.platform, scope, cfg.dependenciesPath);

        // Persist installMode to disk BEFORE invoking the install. The
        // service-instance's Node process loads Config from config.json
        // synchronously at startup; if we write installMode AFTER Servy
        // has already started the service, there's a race where the
        // service-Node loads the OLD installMode, and the redirect-target
        // page sees `installMode: 'user'` and renders WelcomeModal instead
        // of ServiceFirstRunModal. Writing first closes that race.
        //
        // Hard-fail: if we can't persist the mode, abort before installing
        // — we'd otherwise have a real service running while the UI thinks
        // we're in user mode, which is worse than a clean 500.
        const previousMode = cfg.getAppConfig().installMode;
        try {
            cfg.updateAppConfig({ installMode: newInstallMode });
        } catch (err) {
            const body: ServiceActionFailure = {
                ok: false,
                error: `could not persist installMode before install: ${(err as Error).message}`,
                reason: 'unknown',
            };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Linux SYSTEM scope: elevate the whole app ONCE via an awaited pkexec
        // (no timeout, no kill — the kill-EPERM class is gone by construction).
        // The root core (installSystemService) stages /opt, writes the unit,
        // enables+starts it; the unit's Restart=on-failure handles the port
        // takeover while this local copy exits to free the port. Headless installs
        // never reach here — they enter via the Rust CLI, not this HTTP API.
        if (result.platform === 'linux' && scope === 'system') {
            const port = cfg.getAppConfig().webPort;
            const pkexec = resolveSystemTool('pkexec');
            // binPath here is the app's own AppImage ($APPIMAGE). From-source runs
            // (where $APPIMAGE is unset and binPath falls back to process.execPath,
            // i.e. bare Node) are NOT a supported system-scope install scenario —
            // $APPIMAGE is always set in packaged installs, which is the only way
            // this branch is reached from the desktop GUI.
            // The app binary is handed to pkexec to run as ROOT, so it must be an
            // absolute path — a relative value would be resolved via the elevated
            // process's cwd/$PATH (a hijack surface). Existence is NOT checked here:
            // $APPIMAGE is the trusted path of the already-running AppImage, which
            // packaged installs always set absolute (the supported entry to this
            // branch). (#26)
            if (!path.isAbsolute(binPath)) {
                try {
                    cfg.updateAppConfig({ installMode: previousMode ?? null });
                } catch (e) {
                    log.warn(`installMode revert failed after binPath validation: ${(e as Error).message}`);
                }
                const body: ServiceActionFailure = {
                    ok: false,
                    error: `service mode requires an absolute app binary path; got ${JSON.stringify(binPath)} (a relative $APPIMAGE is not a supported packaged install).`,
                    reason: 'unknown',
                };
                res.writeHead(500);
                res.end(JSON.stringify(body));
                return true;
            }
            const r = await this.runElevated([pkexec, binPath, '--install-system-service', '--port', String(port)]);
            if (r.code !== 0) {
                // revert installMode so the next load doesn't see a phantom service mode
                try {
                    cfg.updateAppConfig({ installMode: previousMode ?? null });
                } catch (e) {
                    log.warn(`installMode revert failed after pkexec install: ${(e as Error).message}`);
                }
                // pkexec exit 126 == polkit auth dismissed/declined → UAC-style retry prompt
                if (r.code === 126) {
                    const body: ServiceActionFailure = {
                        ok: false,
                        error: 'install was cancelled at the authentication prompt',
                        reason: 'uac-declined',
                    };
                    res.writeHead(403);
                    res.end(JSON.stringify(body));
                    return true;
                }
                const body: ServiceActionFailure = {
                    ok: false,
                    error: (r.stderr || 'system-service install failed').trim(),
                    reason: 'servy-failure',
                };
                res.writeHead(500);
                res.end(JSON.stringify(body));
                return true;
            }
            // success: the unit is enabled+started (or queued via Restart). Exit local
            // to free the port; the frontend's /api/service/status poll reconnects.
            this.scheduleExit(() => {
                log.info('install-flow: local instance exiting (handoff to system service via pkexec)');
                process.exit(0);
            }, 1_500);
            const disk = this.readDiskConfig();
            const body: ServiceActionSuccess = {
                ok: true,
                status: 'shutting-down',
                installMode: newInstallMode,
                ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
                ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
            };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }

        try {
            await result.client.install({
                name: WS_SCRCPY_SERVICE_NAME,
                displayName: WS_SCRCPY_SERVICE_DISPLAY_NAME,
                description: WS_SCRCPY_SERVICE_DESCRIPTION,
                binPath,
                startupDir,
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars,
                logPath,
                // §32 Part 4: pass dataRoot so the elevated installer can write
                // <dataRoot>/post-stop/post-stop.bat and register it as Servy's
                // --postStopPath via cmd.exe (Velopack-untouchable location).
                // F1: Linux user-scope install also uses it to stage a stable
                // binary under <dataRoot>/bin — so guarantee it's defined.
                dataRoot: cfg.dataRoot ?? path.dirname(cfg.dependenciesPath),
                // Linux SystemdClient consumes scope; Windows ServyClient ignores it.
                scope,
            });
        } catch (err) {
            // Install failed — revert installMode so the next page load
            // doesn't see a phantom service-mode config without an actual
            // service. Best-effort; if the revert itself fails we log and
            // surface the original install error.
            try {
                cfg.updateAppConfig({ installMode: previousMode ?? null });
            } catch (revertErr) {
                log.warn(`installMode revert failed after install error: ${(revertErr as Error).message}`);
            }
            // ServiceInstallError carries a structured result from the
            // elevated helper. UAC-declined gets its own 403 status so
            // the frontend can render a UAC-aware retry prompt; other
            // failures get 500.
            if (err instanceof ServiceInstallError && err.isUacDeclined()) {
                const body: ServiceActionFailure = { ok: false, error: err.message, reason: 'uac-declined' };
                res.writeHead(403);
                res.end(JSON.stringify(body));
                return true;
            }
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'servy-failure' };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // F4: Linux user-scope can't start the service while THIS local instance
        // holds the per-user single-instance lock — the service would exit
        // "already running" before binding. install() above only `enable`d the
        // unit (no --now); hand off to a detached, out-of-cgroup helper that
        // starts it AFTER we exit (freeing the lock), verifies it stays up, and
        // rolls back + relaunches local on failure. Mirror of the uninstall
        // teardown spawn. (Windows + Linux system scope keep the in-handler
        // verify/rollback below — they don't share the user's lock.)
        if (result.platform === 'linux' && scope === 'user') {
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            const systemdRun = resolveSystemTool('systemd-run');
            const handoffUnit = `--unit=wsscrcpy-install-${Date.now()}`;
            this.spawnDetached(systemdRun, [
                '--user',
                '--collect',
                handoffUnit,
                helper,
                '--linux-service-install-handoff',
                '--scope',
                'user',
                '--unit',
                WS_SCRCPY_SERVICE_NAME,
            ]);
            log.info('install-flow(linux user): spawned install-handoff helper; exiting local to free the lock');
            // Exit promptly so the helper can start the service (release lock + port).
            this.scheduleExit(() => {
                log.info('install-flow: local instance exiting (handoff to service)');
                process.exit(0);
            }, 1_500);
            const disk = this.readDiskConfig();
            const body: ServiceActionSuccess = {
                ok: true,
                status: 'shutting-down',
                installMode: newInstallMode,
                ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
                ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
            };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }

        // F3: verify the service actually started before sacrificing this local
        // instance. install() does NOT throw on a failed start (systemd
        // Type=simple reports "started" on fork, before execve fails), so a
        // blind exit here would strand the user with a dead app + no fallback.
        // (Windows + Linux system scope; Linux user scope returns above.)
        const active = await this.verifyServiceActive(result.client, WS_SCRCPY_SERVICE_NAME);
        if (!active) {
            log.warn('install-flow: service did not become active; rolling back the failed install');
            // Roll back the dead unit + restore the prior installMode so the
            // user lands back in a working local app. Best-effort; surface the
            // failure regardless. Crucially do NOT scheduleExit — keep this
            // local instance alive.
            try {
                await result.client.uninstall(WS_SCRCPY_SERVICE_NAME);
            } catch (err) {
                log.warn(`rollback uninstall failed: ${(err as Error).message}`);
            }
            try {
                cfg.updateAppConfig({ installMode: previousMode ?? null });
            } catch (err) {
                log.warn(`rollback installMode revert failed: ${(err as Error).message}`);
            }
            const failBody: ServiceActionFailure = {
                ok: false,
                error:
                    'the service was installed but did not start, so it was removed; ' +
                    'the app is still running locally. check the service logs and try again.',
                reason: 'service-start-failed',
            };
            res.writeHead(500);
            res.end(JSON.stringify(failBody));
            return true;
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const disk = this.readDiskConfig();

        // Schedule local-Node exit (win32 only — both Linux scopes hand off + return
        // above: user scope at the F4 branch, system scope at the pkexec branch). This
        // instance is useless once the service is running; it also holds the web port.
        // The frontend navigates to the service port once it detects config.json mtime
        // change — this timer is a safety cap, not a timing mechanism.
        if (result.platform === 'win32') {
            this.scheduleExit(() => {
                log.info('install-flow: local instance exiting (service is running)');
                process.exit(0);
            }, 15_000);
        }

        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newInstallMode,
            ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
            ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleUninstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
                reason: 'unsupported',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        const cfg = Config.getInstance();

        if (result.platform === 'linux') {
            // Item 32: do NOT run `systemctl disable --now` from here — this Node
            // process is inside the service unit's cgroup, so stopping the unit
            // would kill us mid-call (no clean teardown, no relaunch). Instead
            // hand off to an OUT-OF-CGROUP helper via systemd-run: it runs in its
            // own transient unit, survives stopping our unit, then tears down +
            // (user scope) relaunches local. Mirrors the Windows operation-server
            // handoff. We do NOT call client.uninstall() on Linux.
            const scope = result.client.getInstalledScope
                ? await result.client.getInstalledScope(WS_SCRCPY_SERVICE_NAME)
                : null;
            if (scope === null) {
                const body: ServiceActionSuccess = { ok: true, status: 'not-installed', installMode: 'user' };
                res.writeHead(200);
                res.end(JSON.stringify(body));
                return true;
            }

            // Revert installMode to local BEFORE the teardown so the relaunched
            // local instance reads local mode (mirrors the Windows revert-first ordering).
            const newMode: InstallMode = scope === 'system' ? 'system' : 'user';
            try {
                cfg.updateAppConfig({ installMode: newMode });
            } catch (err) {
                log.warn(`uninstall(linux): installMode revert failed (continuing): ${(err as Error).message}`);
            }

            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const systemdRun = resolveSystemTool('systemd-run');
            const teardownUnit = `--unit=wsscrcpy-teardown-${Date.now()}`;
            let cmd: string;
            let sdArgs: string[];
            if (scope === 'system') {
                // System scope: exec the /opt-staged AppImage (bin_t — init_t may exec
                // it, unlike the data_home_t home copy SELinux blocks), out-of-cgroup
                // via systemd-run --system, elevated by pkexec when the serving process
                // isn't already root (the system service itself runs as root). The new
                // install stages the AppImage (not a separate launcher helper), so we
                // exec the bin_t-labeled staged AppImage directly.
                const optAppImage = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
                const runArgs = [
                    '--system',
                    '--collect',
                    teardownUnit,
                    // DATA_ROOT is MANDATORY: a `systemd-run --system` transient unit has no
                    // HOME/XDG either, so without it the launcher panics in data_root_for_linux
                    // (config.rs) at startup — before running ANY teardown command (the beta.60
                    // #9 5.1 core-dump that made uninstall a silent no-op). Mirrors the install
                    // handoff's --setenv.
                    `--setenv=DATA_ROOT=${SYSTEM_STATE_DIR}`,
                    optAppImage,
                    '--linux-service-teardown',
                    '--scope',
                    'system',
                    '--unit',
                    WS_SCRCPY_SERVICE_NAME,
                ];
                if (process.getuid?.() === 0) {
                    cmd = systemdRun;
                    sdArgs = runArgs;
                } else {
                    cmd = resolveSystemTool('pkexec');
                    sdArgs = [systemdRun, ...runArgs];
                }
            } else {
                // User scope: UNCHANGED — home helper, user manager, includes relaunch.
                // Same staged out-of-mount helper UpdateService.applyUpdate uses — note
                // the `.exe` suffix is the fixed staged name even on Linux.
                const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
                cmd = systemdRun;
                sdArgs = [
                    '--user',
                    '--collect',
                    teardownUnit,
                    helper,
                    '--linux-service-teardown',
                    '--scope',
                    'user',
                    '--unit',
                    WS_SCRCPY_SERVICE_NAME,
                ];
            }
            this.spawnDetached(cmd, sdArgs);
            log.info(`uninstall(linux): spawned teardown helper via systemd-run (${scope} scope)`);

            const body: ServiceActionSuccess = { ok: true, status: 'shutting-down', installMode: newMode };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }

        // v0.1.8: if a resume token is present in the request headers,
        // validate it before doing anything else. The token comes from
        // the service-instance handoff (frontend reads it from the
        // URL params and forwards it as `X-Resume-Token`). Valid
        // token → consume + proceed with uninstall. Invalid → 401
        // (don't proceed; the request is unauthenticated for this
        // sensitive action). Absent → normal uninstall click from a
        // local instance, no token required.
        const headerToken = req.headers?.['x-resume-token'];
        const tokenStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (typeof tokenStr === 'string' && tokenStr.length > 0) {
            const consumed = consumeToken(cfg.dependenciesPath, tokenStr, 'uninstall-service');
            if (!consumed) {
                const body: ServiceActionFailure = {
                    ok: false,
                    error: 'invalid or expired resume token',
                    reason: 'invalid-token',
                };
                res.writeHead(401);
                res.end(JSON.stringify(body));
                return true;
            }
            // Valid resume token → caller is the redirected local
            // instance from the service-context handoff. Proceed
            // directly with the uninstall (no second handoff).
        } else {
            const installMode = cfg.getAppConfig().installMode;
            const runningAsService = installMode === 'user-service' || installMode === 'system-service';
            const isWindows = result.platform === 'win32';

            if (isWindows && runningAsService && this.isLikelyLocalSystem()) {
                // Revert installMode BEFORE exiting so the freshly spawned
                // launcher (from --spawn-user-launcher in post-stop.bat)
                // reads local mode from config.json, not the stale service
                // mode. Without this, the fresh launcher enters service mode,
                // its tray supervisor tries WTSQueryUserToken (needs
                // SeTcbPrivilege), but the launcher runs as the regular user
                // → tray spawn fails forever with 0x80070522.
                let newMode: InstallMode = 'user';
                if (installMode === 'system-service') newMode = 'system';
                try {
                    cfg.updateAppConfig({ installMode: newMode });
                    log.info(`uninstall: reverted installMode ${installMode} → ${newMode}`);
                } catch (err) {
                    log.warn(`uninstall: installMode revert failed (continuing): ${(err as Error).message}`);
                }

                try {
                    await fs.promises.mkdir(path.dirname(cfg.uninstallPendingMarkerPath), { recursive: true });
                    await fs.promises.writeFile(cfg.uninstallPendingMarkerPath, '', 'utf8');
                    log.info(`uninstall: wrote uninstall-pending marker at ${cfg.uninstallPendingMarkerPath}`);
                } catch (err) {
                    log.error(`uninstall: failed to write uninstall-pending marker: ${(err as Error).message}`);
                    const body: ServiceActionFailure = {
                        ok: false,
                        error: `failed to write uninstall-pending marker: ${(err as Error).message}`,
                        reason: 'unknown',
                    };
                    res.writeHead(500);
                    res.end(JSON.stringify(body));
                    return true;
                }

                const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
                const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
                try {
                    const child = spawn(helperPath, ['--operation-server'], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true,
                        env: { ...process.env, WS_SCRCPY_DATA_ROOT: dataRoot },
                    });
                    // Absorb the async 'error' event (e.g. ENOENT when the helper
                    // isn't yet on disk) so it doesn't become an unhandled rejection.
                    child.on('error', (err) => {
                        log.warn(`uninstall: operation-server child error (bat will handle it): ${err.message}`);
                    });
                    child.unref();
                    log.info(`uninstall: spawned operation-server at ${helperPath}`);
                } catch (err) {
                    log.warn(
                        `uninstall: failed to spawn operation-server (bat will handle it): ${(err as Error).message}`,
                    );
                }

                setTimeout(() => {
                    log.info('uninstall: scheduled exit firing (post-stop.bat takes over)');
                    process.exit(0);
                }, 5000).unref();

                const disk = this.readDiskConfig();
                const body: ServiceActionSuccess = {
                    ok: true,
                    status: 'shutting-down',
                    installMode: newMode,
                    ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
                };
                res.writeHead(200);
                res.end(JSON.stringify(body));
                return true;
            }
        }

        try {
            await result.client.uninstall(WS_SCRCPY_SERVICE_NAME);
        } catch (err) {
            if (err instanceof ServiceInstallError && err.isUacDeclined()) {
                const body: ServiceActionFailure = { ok: false, error: err.message, reason: 'uac-declined' };
                res.writeHead(403);
                res.end(JSON.stringify(body));
                return true;
            }
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message, reason: 'servy-failure' };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Revert installMode: drop the '-service' suffix.
        const current = cfg.getAppConfig().installMode;
        let newMode: InstallMode = 'user';
        if (current === 'system-service' || current === 'system') newMode = 'system';
        try {
            cfg.updateAppConfig({ installMode: newMode });
        } catch (err) {
            log.warn(`installMode revert failed (service uninstall succeeded): ${(err as Error).message}`);
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newMode,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleInstallSystemWide(res: ServerResponse): Promise<boolean> {
        if (process.platform !== 'linux') {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: false, error: 'machine-wide install is linux-only', reason: 'unsupported' }));
            return true;
        }
        const appImage = process.env['APPIMAGE'];
        if (!appImage) {
            res.writeHead(400);
            res.end(
                JSON.stringify({
                    ok: false,
                    error: 'not running from an AppImage ($APPIMAGE unset)',
                    reason: 'unknown',
                }),
            );
            return true;
        }
        const version = getAppVersion();
        // Launcher icon for the system .desktop entry (Icon=ws-scrcpy-web). It ships
        // BUNDLED next to package.json (stage-publish.mjs → publish/tray-icon.png),
        // resolved like getAppVersion() finds package.json: path.resolve(__dirname, '..').
        //
        // CRITICAL: the install runs as ROOT (pkexec), but we run from a per-user
        // FUSE-mounted AppImage — and root CANNOT read that mount (mounts are private
        // to the mounting user; no allow_other/allow_root). Handing root a mount-path
        // iconSource makes the privileged `cp` fail silently → blank menu icon (item 51,
        // confirmed in the smoke: `sudo test -r <mount>/usr/bin/tray-icon.png` → cannot
        // read). Fix: WE (the mounting user) copy the icon to a root-readable temp in
        // os.tmpdir() first; the install script copies from there into the hicolor theme.
        // Removed in `finally`. Best-effort throughout — a miss never fails the install.
        const bundledIcon = path.resolve(__dirname, '..', 'tray-icon.png');
        let iconSource: string | undefined;
        if (fs.existsSync(bundledIcon)) {
            try {
                const stagedIcon = path.join(os.tmpdir(), `ws-scrcpy-web-menu-icon-${process.pid}.png`);
                fs.copyFileSync(bundledIcon, stagedIcon);
                iconSource = stagedIcon;
            } catch {
                iconSource = undefined;
            }
        }
        const script = buildMachineWideInstallScript({ sourceAppImage: appImage, version, iconSource });
        try {
            await this.runPkexecFn(script, 'install-system-wide');
            this.refreshDesktopCaches();
            // F5: the running instance launched from the home AppImage (now
            // deleted by the install) and never re-execs to /opt — it lingers on
            // the deleted FUSE mount and holds the per-user lock. Hand off to the
            // relaunch-only helper (waits for our launcher to exit → flock free →
            // runs /opt) and exit promptly so the app comes back from /opt, not the
            // deleted mount. Reuses the linux_apply relaunch-only path.
            const cfg = Config.getInstance();
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const relaunchHelper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            const optBin = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
            if (this.existsCheck(relaunchHelper)) {
                // process.ppid is the launcher (the flock holder); the helper waits
                // for it to exit before relaunching /opt.
                this.spawnDetached(relaunchHelper, [
                    '--linux-apply',
                    '--target',
                    optBin,
                    '--wait-pid',
                    String(process.ppid),
                ]);
                this.scheduleExit(() => {
                    log.info('install-system-wide: local instance exiting → relaunch from /opt');
                    process.exit(0);
                }, 1_500);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, status: 'shutting-down' }));
            } else {
                log.warn(
                    'install-system-wide: relaunch helper not found; app keeps running from the home mount until next launch',
                );
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, status: 'installed' }));
            }
        } catch (err) {
            const msg = (err as Error).message;
            const declined = /dismissed/i.test(msg);
            res.writeHead(declined ? 403 : 500);
            res.end(JSON.stringify({ ok: false, error: msg, reason: declined ? 'uac-declined' : 'unknown' }));
        } finally {
            // Remove the root-readable temp icon (best-effort; the privileged install
            // script has already copied it into the hicolor theme by now).
            if (iconSource) {
                try {
                    fs.rmSync(iconSource, { force: true });
                } catch {
                    /* best-effort */
                }
            }
        }
        return true;
    }

    /**
     * Best-effort: refresh KDE's per-user desktop caches after a machine-wide install
     * so the new menu entry + icon appear immediately. The root install already
     * refreshed the SYSTEM icon-theme cache (gtk-update-icon-cache) + the .desktop db,
     * but KDE's launcher keeps a stale PER-USER icon cache (~/.cache/icon-cache.kcache)
     * that survives reinstalls — clearing it + rebuilding ksycoca is what makes the
     * icon show without a re-login (item 51, confirmed in the beta.55 smoke). Runs as
     * us (the Node server is the user's process). KDE-only (gated on kbuildsycoca); a
     * no-op on GNOME/others, where the system gtk-update-icon-cache already covers it.
     */
    private refreshDesktopCaches(): void {
        if (process.platform !== 'linux') return;
        const kbuildsycoca = ['kbuildsycoca6', 'kbuildsycoca5']
            .map((t) => `/usr/bin/${t}`)
            .find((p) => this.existsCheck(p));
        if (!kbuildsycoca) return; // not KDE — the system icon-cache refresh covers it
        try {
            const iconCache = path.join(os.homedir(), '.cache', 'icon-cache.kcache');
            if (this.existsCheck(iconCache)) fs.rmSync(iconCache, { force: true });
        } catch {
            /* best-effort */
        }
        try {
            this.spawnDetached(kbuildsycoca, []);
        } catch {
            /* best-effort */
        }
    }

    private async handleDeclineSystemWide(res: ServerResponse): Promise<boolean> {
        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const marker = path.join(dataRoot, 'control', DECLINE_MARKER_NAME);
        try {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, '', 'utf8');
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, status: 'declined' }));
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: (err as Error).message, reason: 'unknown' }));
        }
        return true;
    }

    /**
     * POST /api/service/uninstall-app — Linux + win32. Spawn the detached Rust
     * uninstall helper and sacrifice the local instance so the out-of-process
     * helper can tear the app down from underneath us.
     *
     * Linux (`--linux-app-uninstall`, via systemd-run): forwards scope /
     * machine-wide / relaunch so the helper tears down the right pieces; the
     * helper self-elevates (root → direct; non-root → pkexec; declined →
     * relaunch local), so this spawn stays unelevated.
     *
     * win32 (`--windows-app-uninstall`): the helper runs
     * `<installRoot>\Update.exe --uninstall` (fires Velopack's --veloapp-uninstall
     * hook → service/tray teardown + ARP cleanup) then removes the dataRoot
     * targets. Elevation is delegated to Update.exe (a PerMachine install's
     * Update.exe self-elevates via UAC) — the same "elevation lives in the
     * launcher binary" model as the §30 --request-uac path; this spawn itself
     * stays unelevated. Both branches mirror the detached teardown handoff in
     * handleUninstall.
     *
     * `keep` (request body) preserves config.json + logs/ (`--keep`) vs. wiping
     * all state (`--wipe`). On keep we ALSO reset installMode to null up front so
     * the preserved config.json boots in local mode next time rather than a
     * phantom service mode with no backing service.
     */
    private async handleAppUninstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const result = this.factory();

        // win32: spawn the detached Rust uninstall helper (--windows-app-uninstall)
        // and sacrifice the local instance so it can remove the running install.
        if (result.platform === 'win32') {
            const winBody = await readJsonBody(req);
            const keep = Boolean((winBody as Partial<AppUninstallRequest>).keep);

            const cfg = Config.getInstance();
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            // Staged operation-server launcher copy: lives under dataRoot
            // (Velopack-untouchable) so it survives the Program Files removal —
            // the same copy the win32 service-uninstall handoff + UpdateService
            // spawn. The current/ launcher would be deleted mid-uninstall.
            const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            if (!this.existsCheck(helper)) {
                const failure: ServiceActionFailure = {
                    ok: false,
                    error: `uninstall helper not found at ${helper}`,
                    reason: 'unknown',
                };
                res.writeHead(500);
                res.end(JSON.stringify(failure));
                return true;
            }

            // Velopack install root = parent of current/ (where Update.exe lives).
            // Resolved the same way UpdateService anchors installRoot: at the
            // webpack bundle location (__dirname = <installRoot>/current/dist), NOT
            // process.cwd()/execPath (which point inside current/ or the deps tree).
            const installRoot = path.resolve(__dirname, '..', '..');
            const updateExe = path.join(installRoot, 'Update.exe');

            // keep=true: reset installMode to null BEFORE spawning so the preserved
            // config.json comes back up in local mode, not a phantom service mode.
            // Best-effort — log and proceed; the teardown still goes ahead.
            if (keep) {
                try {
                    cfg.updateAppConfig({ installMode: null });
                } catch (err) {
                    log.warn(`app-uninstall(win32): installMode reset failed (continuing): ${(err as Error).message}`);
                }
            }

            // Detached spawn of the staged launcher with the raw uninstall argv
            // (absolute paths only — Local-Dependencies-Only: no PATH/env binary
            // resolution). Elevation is delegated to Update.exe; this spawn stays
            // unelevated, mirroring the linux helper's pkexec self-elevation, and
            // reuses the same spawnDetached seam the linux teardown uses.
            this.spawnDetached(helper, [
                '--windows-app-uninstall',
                keep ? '--keep' : '--wipe',
                '--data-root',
                dataRoot,
                '--update-exe',
                updateExe,
            ]);
            this.scheduleExit(() => {
                log.info('app-uninstall(win32): local instance exiting → detached teardown');
                process.exit(0);
            }, 1_500);

            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, status: 'uninstalling' }));
            return true;
        }

        if (result.platform !== 'linux') {
            res.writeHead(200);
            res.end(
                JSON.stringify({
                    ok: false,
                    reason: 'unsupported',
                    error: 'app uninstall is not supported on this platform',
                }),
            );
            return true;
        }

        const reqBody = await readJsonBody(req);
        const keep = Boolean((reqBody as Partial<AppUninstallRequest>).keep);

        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        // Same staged out-of-mount helper UpdateService.applyUpdate uses — note
        // the `.exe` suffix is the fixed staged name even on Linux.
        const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
        if (!this.existsCheck(helper)) {
            const failure: ServiceActionFailure = {
                ok: false,
                error: `uninstall helper not found at ${helper}`,
                reason: 'unknown',
            };
            res.writeHead(500);
            res.end(JSON.stringify(failure));
            return true;
        }

        // Installed service scope (Linux-only getInstalledScope; SystemdClient
        // implements it). null → no service unit on disk → 'none'.
        const svc = result.client.getInstalledScope
            ? await result.client.getInstalledScope(WS_SCRCPY_SERVICE_NAME)
            : null;
        const scope: 'user' | 'system' | 'none' = svc === 'system' ? 'system' : svc === 'user' ? 'user' : 'none';

        const machineWide = this.existsCheck(`${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`);
        const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
        const relaunch = process.env['APPIMAGE'] ?? '';

        // keep=true: reset installMode to null BEFORE spawning so the preserved
        // config.json comes back up in local mode, not a phantom service mode.
        // Best-effort — log and proceed; the teardown still goes ahead.
        if (keep) {
            try {
                cfg.updateAppConfig({ installMode: null });
            } catch (err) {
                log.warn(`app-uninstall: installMode reset failed (continuing): ${(err as Error).message}`);
            }
        }

        const systemdRun = resolveSystemTool('systemd-run');
        const unit = `--unit=wsscrcpy-uninstall-${Date.now()}`;
        this.spawnDetached(
            systemdRun,
            buildUninstallHelperArgs({ isRoot, unit, helper, scope, machineWide, keep, dataRoot, relaunch }),
        );
        this.scheduleExit(() => {
            log.info('app-uninstall: local instance exiting → detached teardown');
            process.exit(0);
        }, 1_500);

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, status: 'uninstalling' }));
        return true;
    }

    /**
     * Best-effort detection of "are we running as Local System (i.e.
     * inside the service)?". Returns true when `os.userInfo().username`
     * is `SYSTEM` (the canonical username for the LocalSystem account
     * on Windows). Returns false on any other identity, including the
     * user's own account when they're running locally.
     *
     * Not bulletproof — a user could theoretically be logged in as
     * `SYSTEM` (extremely unusual), and `os.userInfo()` can fail in
     * some edge cases. The downside of a false positive is we attempt
     * the WTS handoff and it fails, then we fall through to direct
     * uninstall. The downside of a false negative is the user's tab
     * disconnects on uninstall (the v0.1.7 behavior). Acceptable.
     */
    private isLikelyLocalSystem(): boolean {
        try {
            const info = require('node:os').userInfo() as { username: string };
            return info.username.toLowerCase() === 'system';
        } catch {
            return false;
        }
    }
}
